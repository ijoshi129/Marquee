// A-List savings, gated on membership resolved per month. A month-level
// override wins over the year flag, which wins over the default (assumed
// A-List). Films watched in a non-member month are dropped entirely — they
// neither credit ticket value nor bill the fee — so a stretch without A-List
// can't post a meaningless loss. Each member year nets its ticket value against
// the fee for the months it actually went; across all-time these nets sum.
function monthKeyOf(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function isMemberMonth(excludedYears, monthOverride, year, monthKey) {
  if (monthOverride.has(monthKey)) return monthOverride.get(monthKey);
  return !excludedYears.has(year);
}

// watches: [{ watched_at, tags }]. period: 'all' | 'year' | 'month'. start is
// the period's start Date (used to resolve a single-period membership flag).
function computeAlistValue(watches, opts) {
  const { excludedYears, monthOverride, period, start, fee, ticket, premium, premiumFormats } = opts;

  // year -> { films (every watched row), ticketValue + months (member only) }
  const byYear = new Map();
  let creditedTickets = 0;
  let creditedPremiumTickets = 0;
  for (const w of watches) {
    if (!w.watched_at) continue;
    const d = new Date(w.watched_at);
    const yr = d.getUTCFullYear();
    const monthKey = monthKeyOf(d);
    let b = byYear.get(yr);
    if (!b) {
      b = { films: 0, ticketValue: 0, months: new Set() };
      byYear.set(yr, b);
    }
    b.films += 1;
    if (!isMemberMonth(excludedYears, monthOverride, yr, monthKey)) continue;
    const isPremium = (w.tags || []).some((tag) => premiumFormats.has(tag));
    b.ticketValue += ticket + (isPremium ? premium : 0);
    b.months.add(monthKey);
    creditedTickets += 1;
    if (isPremium) creditedPremiumTickets += 1;
  }

  let savingsSum = 0;
  let billedMonths = 0;
  let creditedTicketValue = 0;
  for (const [, b] of byYear) {
    savingsSum += b.ticketValue - fee * b.months.size;
    billedMonths += b.months.size;
    creditedTicketValue += b.ticketValue;
  }

  // Newest year first. A year with no member months carries null savings so the
  // UI can render it as "not a member".
  const byYearBreakdown = [...byYear.entries()]
    .map(([year, b]) => {
      const months = b.months.size;
      const member = months > 0;
      return {
        year,
        films: b.films,
        months,
        ticket_value: b.ticketValue,
        savings: member ? b.ticketValue - fee * months : null,
        is_member: member,
      };
    })
    .sort((a, b) => b.year - a.year);

  const periodYear = period === 'year' || period === 'month' ? start.getUTCFullYear() : null;
  let periodHasAlist;
  if (period === 'month') {
    periodHasAlist = isMemberMonth(excludedYears, monthOverride, periodYear, monthKeyOf(start));
  } else if (period === 'year') {
    periodHasAlist =
      !excludedYears.has(periodYear) ||
      [...monthOverride].some(([k, v]) => v && k.startsWith(`${periodYear}-`));
  } else {
    periodHasAlist = null;
  }
  const isExcludedPeriod = periodYear !== null && !periodHasAlist;

  return {
    creditedTickets,
    creditedPremiumTickets,
    creditedTicketValue,
    billedMonths,
    savings: isExcludedPeriod ? null : savingsSum,
    has_alist: periodHasAlist,
    byYear: byYearBreakdown,
  };
}

module.exports = { computeAlistValue, isMemberMonth };
