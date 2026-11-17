const assert = require('node:assert/strict');
const { test, afterEach } = require('./harness');
const fed = require('../services/federation');
const tailcat = require('../services/tailcat');

const ADDR = 'tcpGFwWCBS_3-UMUZjA5FPYrmgeQHoFJrU-PWpPxeZbKr27WyAbmFrWCAM2lJJeh_ubLc3sERsCYW4qX4YNcItrxD0';
const TOKEN = 'a'.repeat(43);
const savedEnv = { ...process.env };

afterEach(() => {
  for (const k of ['TAILCAT_ENABLED', 'FEDERATION_BASE_URL']) {
    if (k in savedEnv) process.env[k] = savedEnv[k];
    else delete process.env[k];
  }
});

test('parseFriendUrl: takes a tailcat link and keeps the address case', () => {
  assert.equal(
    fed.parseFriendUrl(`  tailcat://${ADDR}/api/federation/${TOKEN}/ `),
    `tailcat://${ADDR}/api/federation/${TOKEN}`
  );
});

test('parseFriendUrl: refuses a tailcat link with a bad address or path', () => {
  assert.equal(fed.parseFriendUrl(`tailcat://evil.example.com/api/federation/${TOKEN}`), null);
  assert.equal(fed.parseFriendUrl(`tailcat://${ADDR}:80/api/federation/${TOKEN}`), null);
  assert.equal(fed.parseFriendUrl(`tailcat://${ADDR}/api/watches`), null);
  assert.equal(fed.parseFriendUrl(`tailcat://${ADDR}/api/federation/short`), null);
});

test('parseFriendUrl: web links behave as before', () => {
  assert.equal(
    fed.parseFriendUrl(`https://fed.example.com/api/federation/${TOKEN}`),
    `https://fed.example.com/api/federation/${TOKEN}`
  );
  assert.equal(fed.parseFriendUrl(`http://169.254.169.254/api/federation/${TOKEN}`), null);
  assert.equal(fed.parseFriendUrl(`ftp://x.example.com/api/federation/${TOKEN}`), null);
});

test('urlForPeer: a friend gets back the same kind of link we reach them by', () => {
  const both = { web: 'https://w/api/federation/t', tailcat: 'tailcat://a/api/federation/t' };
  assert.equal(fed.urlForPeer(both, `tailcat://${ADDR}/api/federation/${TOKEN}`), both.tailcat);
  assert.equal(fed.urlForPeer(both, `https://f.example.com/api/federation/${TOKEN}`), both.web);
  assert.equal(fed.urlForPeer({ web: null, tailcat: both.tailcat }, 'https://f/x'), both.tailcat);
  assert.equal(fed.urlForPeer({ web: both.web, tailcat: null }, `tailcat://${ADDR}/x`), both.web);
});

test('myUrlsFor: no Tailcat link while the helper is not running', () => {
  process.env.FEDERATION_BASE_URL = 'https://fed.example.com/';
  assert.deepEqual(fed.myUrlsFor(TOKEN), {
    web: `https://fed.example.com/api/federation/${TOKEN}`,
    tailcat: null,
  });
  assert.equal(fed.canMint(), true);
  delete process.env.FEDERATION_BASE_URL;
  assert.equal(fed.canMint(), false);
});

test('proxiedUrl: explains why a tailcat link cannot be followed here', () => {
  const url = `tailcat://${ADDR}/api/federation/${TOKEN}/feed`;
  delete process.env.TAILCAT_ENABLED;
  assert.throws(() => tailcat.proxiedUrl(url), /not turned on/);
  process.env.TAILCAT_ENABLED = '1';
  assert.throws(() => tailcat.proxiedUrl(url), /not running/);
  assert.throws(() => tailcat.proxiedUrl('tailcat://bad/x'), /bad tailcat address/);
});

test('fetchWithTimeout: a tailcat link fails as unreachable, not as an HTTP answer', async () => {
  const { fetchWithTimeout } = require('../services/http');
  delete process.env.TAILCAT_ENABLED;
  await assert.rejects(
    fetchWithTimeout(`tailcat://${ADDR}/api/federation/${TOKEN}/feed`),
    /not turned on/
  );
});
