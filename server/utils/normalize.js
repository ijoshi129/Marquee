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
const FORMAT_SUFFIX = /\s+(?:in\s+)?(?:RealD\s+3D|IMAX(?:\s+\d{1,2}\.\d+)?|Dolby\s+Cinema|Dolby\s+Atmos|Prime|D-Box|XD|MX4D|3D|2D)\s*$/i;
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

module.exports = { normalizeText, cleanTitle };
