// fetch with a hard timeout: the shared shape for every outbound federation
// and notification call, so timeout semantics can't drift between call sites.
// A tailcat:// URL is sent through the local Tailcat helper.
async function fetchWithTimeout(url, opts = {}, timeoutMs = 10_000) {
  const tailcat = require('./tailcat');
  const viaTailcat = tailcat.isTailcatUrl(url);
  const target = viaTailcat ? tailcat.proxiedUrl(url) : url;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(target, { ...opts, signal: controller.signal });
    // The helper answers 502 itself when the tunnel can't reach the friend:
    // that is "unreachable", not an HTTP answer from them.
    if (viaTailcat && resp.status === 502 && resp.headers.get('x-tailcat-error')) {
      const text = (await resp.text()).trim();
      throw new Error(`Tailcat: ${text || 'could not reach the friend'}`);
    }
    return resp;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fetchWithTimeout };
