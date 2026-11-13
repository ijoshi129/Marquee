const assert = require('node:assert/strict');
const express = require('express');
const { test } = require('./harness');
const { trustProxySetting, DEFAULT } = require('../utils/trust-proxy');

test('trustProxySetting: defaults to private-range peers', () => {
  assert.equal(trustProxySetting(undefined), DEFAULT);
  assert.equal(trustProxySetting(''), DEFAULT);
  assert.equal(trustProxySetting('  '), DEFAULT);
});

test('trustProxySetting: reads a hop count, a boolean or a list', () => {
  assert.equal(trustProxySetting('1'), 1);
  assert.equal(trustProxySetting('2'), 2);
  assert.equal(trustProxySetting('false'), false);
  assert.equal(trustProxySetting('true'), true);
  assert.equal(trustProxySetting('10.0.0.52, 172.16.0.0/12'), '10.0.0.52, 172.16.0.0/12');
});

// What Express makes of the default, for the peers this app actually sees.
function clientIp(peer, forwardedFor) {
  const app = express();
  app.set('trust proxy', trustProxySetting(undefined));
  const trust = app.get('trust proxy fn');
  const hops = forwardedFor ? forwardedFor.split(',').map((s) => s.trim()).reverse() : [];
  const chain = [peer, ...hops];
  // Express walks from the socket outward and stops at the first untrusted address.
  for (let i = 0; i < chain.length; i++) if (!trust(chain[i], i)) return chain[i];
  return chain[chain.length - 1];
}

test('default trust: a proxy on the LAN or the same host speaks for its client', () => {
  assert.equal(clientIp('10.0.0.52', '203.0.113.9'), '203.0.113.9');
  assert.equal(clientIp('172.18.0.1', '203.0.113.9'), '203.0.113.9');
  assert.equal(clientIp('127.0.0.1', '198.51.100.7'), '198.51.100.7');
  // A LAN client behind the LAN proxy is still told apart from the proxy.
  assert.equal(clientIp('10.0.0.52', '10.0.0.77'), '10.0.0.77');
});

test('default trust: a direct client cannot choose its own address', () => {
  // Public and tailnet (100.64.0.0/10) peers are not proxies we know.
  assert.equal(clientIp('203.0.113.50', '1.2.3.4'), '203.0.113.50');
  assert.equal(clientIp('100.99.174.120', '1.2.3.4'), '100.99.174.120');
  // And a trusted proxy does not vouch for what an outside client claimed.
  assert.equal(clientIp('10.0.0.52', '1.2.3.4, 203.0.113.9'), '203.0.113.9');
});
