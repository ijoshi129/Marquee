// Parse an AMC "Thank You for Visiting" email.
// Required for parse_status='ok': title, theater_name.
//
// Body anchors:
//   "Thank You for Visiting <Theater> We hope you enjoyed seeing <Title>"

const { load, clean, bodyText } = require('./util');
const { extractTags, extractFormatsFromHtml } = require('../utils/normalize');

const THEATER_RE = /Thank\s*You\s+for\s+Visiting\s+(AMC\s+[^.]+?)\s+(?:We\s+hope|Don'?t\s+Miss|This\s+email|$)/i;
const TITLE_RE   = /We\s+hope\s+you\s+(?:enjoyed\s+seeing|liked|loved)\s+(.+?)(?:\s+Don'?t\s+Miss|\s+This\s+email|\s+Sent\s+from|$)/i;

// Fallback: subject "Ishaan, Thank you for seeing X at AMC" → X (often uppercase though)
const SUBJECT_TITLE_RE = /thank\s*you\s+for\s+(?:seeing|visiting|watching)\s+(.+?)\s+at\s+amc\b/i;

function parse({ subject, html, text }) {
  const $ = load(html);
  const body = bodyText($) || clean(text || '');

  const tm = THEATER_RE.exec(body);
  const theater_name = tm ? clean(tm[1]) : null;

  let title = null;
  const mt = TITLE_RE.exec(body);
  if (mt) title = clean(mt[1]);

  // If the body title is fully uppercase or empty, prefer the subject's title (still uppercase
  // sometimes, but at least consistent). Most reliable case the body has proper case.
  if ((!title || title === title.toUpperCase()) && subject) {
    const sm = SUBJECT_TITLE_RE.exec(subject);
    if (sm) {
      const subj = clean(sm[1]);
      // Prefer body title if it has any lowercase letters; otherwise use subject as-is.
      if (!title || /[a-z]/.test(title) === false) {
        title = title && /[a-z]/.test(title) ? title : subj;
      }
    }
  }

  // Format tags from both title and any <img alt="..."> badges. Thank-you
  // emails are the most common carrier for badges (BigD, RealD 3D, etc.).
  const tags = [...new Set([...extractTags(title), ...extractFormatsFromHtml(html)])];

  const ok = !!(title && theater_name);
  return {
    ok,
    error: ok
      ? null
      : `missing required fields: ${[!title && 'title', !theater_name && 'theater_name'].filter(Boolean).join(', ')}`,
    fields: { title, theater_name, tags },
  };
}

module.exports = { parse };
