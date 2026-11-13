// Behind a reverse proxy the socket address is the proxy's, so Express has to
// be told which peers may speak for a client through X-Forwarded-For. Without
// it the rate limiter counts every proxied visitor as one address.
//
// The default trusts peers on loopback and private ranges: a proxy or tunnel
// on the same host or LAN, and nothing reachable from outside. A client that
// connects directly from a public or tailnet address is not trusted, so it
// cannot pick its own address by sending the header.
const DEFAULT = 'loopback, linklocal, uniquelocal';

// TRUST_PROXY overrides the default with a hop count ("1"), a list of
// addresses or ranges, or "false" to trust nothing.
function trustProxySetting(raw) {
  const value = (raw || '').trim();
  if (!value) return DEFAULT;
  if (/^\d+$/.test(value)) return Number(value);
  if (value === 'true' || value === 'false') return value === 'true';
  return value;
}

module.exports = { trustProxySetting, DEFAULT };
