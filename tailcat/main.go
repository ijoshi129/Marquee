// marquee-tailcat carries the friends API over Tailcat for a Marquee server.
//
// Inbound: friends dial our Tailcat address on port 80; only /api/federation/*
// is passed on to the Marquee server, so the owner API is never reachable over
// the tunnel.
//
// Outbound: the Marquee server asks a loopback-only HTTP proxy for
// /peer/<tailcat address>/api/federation/..., and the request goes to that
// friend over Tailcat.
//
// Marquee owns the identity: it writes one JSON config line to stdin and keeps
// whatever identity this process reports back, so the address survives restarts.
package main

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/tailscale/tailcat"
	"tailscale.com/tailcfg"
	"tailscale.com/types/key"
	"tailscale.com/types/logger"
)

const federationPrefix = "/api/federation/"

type config struct {
	Key      string              `json:"key"`
	PSK      string              `json:"psk"`
	Region   *tailcfg.DERPRegion `json:"region"`
	Upstream string              `json:"upstream"`
	Proxy    string              `json:"proxy"`
	Debug    bool                `json:"debug"`
}

var stdout = json.NewEncoder(os.Stdout)
var stdoutMu sync.Mutex

func emit(v map[string]any) {
	stdoutMu.Lock()
	defer stdoutMu.Unlock()
	stdout.Encode(v)
}

func fatal(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	emit(map[string]any{"event": "error", "message": msg})
	log.Fatal(msg)
}

func main() {
	log.SetFlags(0)
	log.SetPrefix("tailcat: ")

	line, err := bufio.NewReader(os.Stdin).ReadBytes('\n')
	if err != nil && len(line) == 0 {
		fatal("no config on stdin: %v", err)
	}
	var cfg config
	if err := json.Unmarshal(line, &cfg); err != nil {
		fatal("bad config: %v", err)
	}
	upstream, err := url.Parse(cfg.Upstream)
	if err != nil || upstream.Host == "" {
		fatal("bad upstream %q", cfg.Upstream)
	}

	logf := logger.Discard
	if cfg.Debug {
		logf = log.Printf
	}

	// The address embeds the relay region, so a saved identity pins its
	// region too; otherwise a restart could pick a nearer one and change it.
	srv := &tailcat.Server{Logf: logf, Region: cfg.Region}
	fresh := cfg.Key == "" || cfg.Region == nil
	if cfg.Key == "" {
		srv.Key = key.NewNode()
		srv.PresharedKey = tailcat.NewPresharedKey()
	} else {
		if err := srv.Key.UnmarshalText([]byte(cfg.Key)); err != nil {
			fatal("bad key: %v", err)
		}
		if err := srv.PresharedKey.UnmarshalText([]byte(cfg.PSK)); err != nil {
			fatal("bad psk: %v", err)
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	ln, err := srv.Listen(ctx, "tcp", ":80")
	cancel()
	if err != nil {
		fatal("listen: %v", err)
	}
	addr := srv.TailcatAddr()
	info, err := tailcat.ParseAddr(addr)
	if err != nil {
		fatal("own address: %v", err)
	}
	if len(info.Region) == 0 {
		fatal("own address has no relay region")
	}
	region := info.Region[0]
	relay := region.RegionName
	if relay == "" && len(region.Nodes) > 0 {
		relay = region.Nodes[0].HostName
	}
	if fresh {
		k, _ := srv.Key.MarshalText()
		p, _ := srv.PresharedKey.MarshalText()
		emit(map[string]any{"event": "identity", "key": string(k), "psk": string(p), "region": region})
	}

	go serveInbound(ln, upstream)

	proxyLn, err := net.Listen("tcp", cfg.Proxy)
	if err != nil {
		fatal("proxy listen: %v", err)
	}
	out := newOutbound(logf)
	mux := http.NewServeMux()
	mux.Handle("/peer/", out)
	mux.HandleFunc("GET /status", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"address": string(addr),
			"relay":   relay,
			"peers":   out.count(),
		})
	})
	emit(map[string]any{"event": "ready", "address": string(addr), "relay": relay})
	log.Fatal(http.Serve(proxyLn, mux))
}

func serveInbound(ln net.Listener, upstream *url.URL) {
	rp := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(upstream)
			pr.SetXForwarded()
			pr.Out.Header.Set("X-Marquee-Transport", "tailcat")
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			http.Error(w, "upstream unavailable", http.StatusBadGateway)
		},
	}
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, federationPrefix) || strings.Contains(r.URL.Path, "..") {
			http.NotFound(w, r)
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
		rp.ServeHTTP(w, r)
	})
	s := &http.Server{
		Handler:           h,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       2 * time.Minute,
		MaxHeaderBytes:    16 << 10,
	}
	log.Fatal(s.Serve(ln))
}

type peer struct {
	addr   tailcat.Addr
	client *tailcat.Client
	used   time.Time
}

// outbound proxies requests to friends. Each friend gets its own host name
// (a hash of its address) so the shared transport never mixes their
// connections. Keep-alive is off: a pooled connection to a friend who has
// since restarted would hang instead of failing.
type outbound struct {
	logf  logger.Logf
	mu    sync.Mutex
	peers map[string]*peer
	rp    *httputil.ReverseProxy
}

func newOutbound(logf logger.Logf) *outbound {
	o := &outbound{logf: logf, peers: map[string]*peer{}}
	tr := &http.Transport{
		DialContext:           o.dial,
		DisableKeepAlives:     true,
		ResponseHeaderTimeout: 30 * time.Second,
	}
	o.rp = &httputil.ReverseProxy{
		Transport: tr,
		Rewrite: func(pr *httputil.ProxyRequest) {
			t := pr.In.Context().Value(targetKey{}).(target)
			pr.SetURL(&url.URL{Scheme: "http", Host: t.host})
			pr.Out.URL.Path = t.path
			pr.Out.URL.RawPath = ""
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			msg := err.Error()
			if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
				msg = "timed out reaching the friend over Tailcat"
			}
			w.Header().Set("X-Tailcat-Error", "1")
			http.Error(w, msg, http.StatusBadGateway)
		},
	}
	return o
}

func (o *outbound) count() int {
	o.mu.Lock()
	defer o.mu.Unlock()
	return len(o.peers)
}

func hostFor(a tailcat.Addr) string {
	sum := sha256.Sum256([]byte(a))
	return hex.EncodeToString(sum[:12]) + ".tailcat"
}

// register remembers which address a host name stands for. A tunnel idle for
// an hour is closed so a removed friend doesn't keep one open forever.
func (o *outbound) register(a tailcat.Addr) string {
	host := hostFor(a)
	o.mu.Lock()
	defer o.mu.Unlock()
	now := time.Now()
	for h, p := range o.peers {
		if h != host && now.Sub(p.used) > time.Hour {
			if p.client != nil {
				p.client.Close()
			}
			delete(o.peers, h)
		}
	}
	if p, ok := o.peers[host]; ok {
		p.used = now
	} else {
		o.peers[host] = &peer{addr: a, used: now}
	}
	return host
}

func (o *outbound) client(host string) (*tailcat.Client, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	p, ok := o.peers[host]
	if !ok {
		return nil, fmt.Errorf("unknown peer %s", host)
	}
	if p.client == nil {
		p.client = tailcat.NewClient(p.addr)
		p.client.Logf = o.logf
	}
	return p.client, nil
}

func (o *outbound) drop(host string, cl *tailcat.Client) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if p, ok := o.peers[host]; ok && p.client == cl {
		p.client = nil
	}
	cl.Close()
}

// The client introduces itself to a server only once, so a friend who has
// restarted since no longer knows it and the dial just hangs. A fresh client
// introduces itself again: give the cached one a few seconds, then start over.
const staleDialTimeout = 3 * time.Second

func (o *outbound) dial(ctx context.Context, _, hostport string) (net.Conn, error) {
	host, _, err := net.SplitHostPort(hostport)
	if err != nil {
		return nil, err
	}
	cl, err := o.client(host)
	if err != nil {
		return nil, err
	}
	dctx, cancel := context.WithTimeout(ctx, staleDialTimeout)
	c, err := cl.DialTCPPort(dctx, 80)
	cancel()
	if err == nil {
		return c, nil
	}
	o.drop(host, cl)
	if ctx.Err() != nil {
		return nil, err
	}
	cl, err = o.client(host)
	if err != nil {
		return nil, err
	}
	c, err = cl.DialTCPPort(ctx, 80)
	if err != nil {
		o.drop(host, cl)
	}
	return c, err
}

type target struct{ host, path string }
type targetKey struct{}

// ServeHTTP handles /peer/<tailcat address>/api/federation/...
func (o *outbound) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/peer/")
	a, path, ok := strings.Cut(rest, "/")
	path = "/" + path
	if !ok || !strings.HasPrefix(path, federationPrefix) || strings.Contains(path, "..") {
		http.NotFound(w, r)
		return
	}
	if _, err := tailcat.ParseAddr(tailcat.Addr(a)); err != nil {
		http.Error(w, "bad tailcat address", http.StatusBadRequest)
		return
	}
	host := o.register(tailcat.Addr(a))
	ctx := context.WithValue(r.Context(), targetKey{}, target{host: host, path: path})
	o.rp.ServeHTTP(w, r.WithContext(ctx))
}
