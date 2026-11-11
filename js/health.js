// Store health score — same rules as the CSG Store Health dashboard.
// Start at 100; each open issue costs points by category, more if it is a
// repeat or has been open over 60 days. Recently resolved issues cost 1 point,
// a thank-you/compliment adds 3. Issues marked "not valid" (store was wrong) cost nothing.

export const WEIGHTS = {
  Safety: 10, Cleaning: 6, Equipment: 5, Access: 4, Scheduling: 3, Supplies: 2, Other: 1
};

const REPEAT = /repeat|again|3rd time/i;
const THANKS = /thank/i;

export function daysSince(dateStr, now = new Date()) {
  return Math.max(0, Math.floor((now - new Date(dateStr + 'T00:00:00')) / 864e5));
}

export function isOpen(issue) {
  return issue.status !== 'resolved' && issue.status !== 'not valid';
}

// Points one issue costs right now (negative = adds to the score).
export function issuePoints(issue, now = new Date()) {
  if (issue.status === 'not valid') return 0;
  const age = daysSince(issue.date, now);
  if (isOpen(issue)) {
    let p = WEIGHTS[issue.category] ?? 1;
    if (REPEAT.test(issue.description || '')) p *= 1.5;
    if (age > 60) p *= 1.25;
    return p;
  }
  if (age <= 90) return THANKS.test(issue.description || '') ? -3 : 1;
  return 0;
}

export function healthScore(issues, now = new Date()) {
  const pts = issues.reduce((sum, i) => sum + issuePoints(i, now), 0);
  return Math.max(0, Math.min(100, Math.round(100 - pts)));
}

export function band(score) {
  if (score < 50) return 'bad';
  if (score < 80) return 'warn';
  return 'ok';
}
