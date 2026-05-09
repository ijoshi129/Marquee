// Subject-line classifier for AMC emails. Returns one of:
//   'reservation' | 'thankyou' | 'cancellation' | 'unknown'
//
// Patterns derived from real AMC subjects:
//   - "Your AMC Entourage Order Number 1148861090 from 5/2/2026"   → reservation
//   - "Ishaan, Thank you for seeing MICHAEL at AMC"                → thankyou
//   - "Your A-List Reservation Cancelation"                        → cancellation
//
// Order matters: cancellation takes priority over reservation (a cancellation
// subject can technically contain "reservation"), and we check thank-you first
// because of how AMC writes its subjects.

const CANCELLATION_PATTERNS = [
  /\b(?:reservation\s+)?cancel(?:l)?ation\b/i,
  /\b(?:order\s+)?refund(?:ed)?\b/i,
];

const THANKYOU_PATTERNS = [
  /\bthank\s*you\s+for\s+(?:visiting|seeing|coming|choosing)\b/i,
  /\bthanks?\s+for\s+(?:visiting|seeing|choosing\s+amc)\b/i,
];

const RESERVATION_PATTERNS = [
  /\bAMC\s+Entourage\s+Order\b/i,
  /\bOrder\s+Number\b/i,
  /\b(?:order|reservation)\s+confirmation\b/i,
  /\bticket(?:s)?\s+confirm(?:ed|ation)\b/i,
];

function classify(subject) {
  if (!subject) return 'unknown';
  for (const re of CANCELLATION_PATTERNS) if (re.test(subject)) return 'cancellation';
  for (const re of THANKYOU_PATTERNS) if (re.test(subject)) return 'thankyou';
  for (const re of RESERVATION_PATTERNS) if (re.test(subject)) return 'reservation';
  return 'unknown';
}

module.exports = { classify };
