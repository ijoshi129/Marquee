function normalizeText(s) {
  if (!s) return '';
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Strip AMC's format/language suffixes from a movie title so reservation titles
// and Thank You titles compare equal. Examples seen in the wild:
//   "Avatar: Fire and Ash in RealD 3D"                       → "Avatar: Fire and Ash"
//   "The Super Mario Galaxy Movie in RealD 3D"               → "The Super Mario Galaxy Movie"
//   "Crime 101 Japanese Spoken with English Subtitles"       → "Crime 101"
const FORMAT_SUFFIX = /\s+(?:in\s+)?(?:RealD\s+3D|IMAX(?:\s+(?:\d{1,2}\.\d+|\d+\s*mm))?|Dolby\s+Cinema|Dolby\s+Atmos|Prime|D-Box|XD|MX4D|3D|2D)\s*$/i;
const LANGUAGE_SUFFIX = /\s+(?:[A-Z][a-z]+\s+Spoken\s+with\s+English\s+Subtitles|with\s+English\s+Subtitles|Open[\s-]Caption(?:ed)?|Closed[\s-]Caption(?:ed)?)\s*$/i;

function cleanTitle(s) {
  if (!s) return s;
  let t = s.trim();
  // Strip stacked suffixes — apply each pattern repeatedly until stable.
  for (let i = 0; i < 4; i++) {
    const before = t;
    t = t.replace(FORMAT_SUFFIX, '').replace(LANGUAGE_SUFFIX, '').trim();
    if (t === before) break;
  }
  return t;
}

// Trailing format suffix with a capture group so we can read which format
// matched. Shape mirrors FORMAT_SUFFIX above; only the inner alternation is
// captured. IMAX is intentionally permissive — AMC tacks on the room variant
// (aspect ratio like "1.43" or film stock like "70mm") which all normalize
// back to plain "IMAX" downstream.
const FORMAT_SUFFIX_CAPTURE = /\s+(?:in\s+)?(RealD\s+3D|IMAX(?:\s+(?:\d{1,2}\.\d+|\d+\s*mm))?|Dolby\s+Cinema|Dolby\s+Atmos|Prime|D-Box|XD|MX4D|3D|2D)\s*$/i;

// Canonical display names for the formats we tag.
function normalizeFormatName(raw) {
  const lower = raw.replace(/\s+/g, ' ').toLowerCase().trim();
  if (lower.startsWith('imax')) return 'IMAX';
  if (lower === 'reald 3d') return 'RealD 3D';
  if (lower === 'dolby cinema') return 'Dolby Cinema';
  if (lower === 'dolby atmos') return 'Dolby Atmos';
  if (lower === 'prime') return 'Prime';
  if (lower === 'd-box') return 'D-Box';
  if (lower === 'xd') return 'XD';
  if (lower === 'mx4d') return 'MX4D';
  if (lower === '3d') return '3D';
  if (lower === '2d') return '2D';
  return raw;
}

// Whitelist of strings that, when found in an <img alt="..."> attribute,
// indicate the AMC format the show was presented in. AMC's email template
// drops a small badge image with one of these alts when the show was a
// premium format. Regex is generous on suffixes (e.g. "BigD Digital",
// "BigD Laser") so we capture variants without re-listing each.
const FORMAT_ALT_RE = /alt="((?:IMAX|RealD\s+3D|Dolby\s+Cinema|Dolby\s+Atmos|Prime|D-Box|XD|MX4D|3D|2D|Laser)[^"]*)"/gi;

// Pull format names out of any <img alt="..."> badge in the supplied HTML.
// Used by the AMC parsers — reservation emails don't carry these, but
// thank-you emails do (sometimes).
function extractFormatsFromHtml(html) {
  if (!html) return [];
  const out = new Set();
  for (const m of html.matchAll(FORMAT_ALT_RE)) {
    out.add(normalizeFormatName(m[1]));
  }
  return [...out];
}

// Extract presentation-format tags from an AMC-style title. Peels trailing
// suffixes one at a time (stacked formats happen — e.g. "Dune Dolby Atmos
// IMAX 70mm") and also flags Screen Unseen / Scream Unseen as tags.
function extractTags(title) {
  if (!title) return [];
  const found = new Set();
  let t = title.trim();
  for (let i = 0; i < 4; i++) {
    const m = FORMAT_SUFFIX_CAPTURE.exec(t);
    if (!m) break;
    found.add(normalizeFormatName(m[1]));
    t = t.slice(0, m.index);
  }
  if (/AMC\s+Screen\s+Unseen/i.test(title)) found.add('Screen Unseen');
  if (/AMC\s+Scream\s+Unseen/i.test(title)) found.add('Scream Unseen');
  return [...found];
}

module.exports = { normalizeText, cleanTitle, extractTags, extractFormatsFromHtml };
