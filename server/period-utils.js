'use strict';
// Shared calendar-period helpers — single source of truth for month-window math.
// dashboard.js and kills.js previously had drifted private copies (dashboard's
// nextMonthStart was missing the day component, producing '2026-08T...' which
// string-compares AFTER every real August date and silently widens the window).

/** Current calendar month as 'YYYY-MM' */
function currentPeriod() { return new Date().toISOString().slice(0, 7); }

/** First instant of the month AFTER the given 'YYYY-MM' period, as ISO string */
function nextMonthStart(period) {
  const [y, m] = period.split('-').map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return next + '-01T00:00:00Z';
}

module.exports = { currentPeriod, nextMonthStart };
