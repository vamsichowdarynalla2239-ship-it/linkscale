/**
 * UTC Date and Timezone Utilities.
 * 
 * BUG #4 ROOT CAUSE ANALYSIS:
 * When an application logs in UTC (e.g. 2025-01-15T23:58:00.000Z) but the database
 * or server evaluates date comparisons using server-local time (e.g. UTC-5), 
 * midnight boundary calculations (e.g. "links created today" or "links active after midnight")
 * evaluate against different moments in time.
 * For a link created at 11:58 PM UTC (6:58 PM local), local midnight is 5 hours away.
 * Queries comparing UTC timestamps against local boundaries drop the link for several
 * hours until the local clock crosses midnight, causing intermittent 404s late at night.
 * 
 * FIX:
 * Strictly normalize all timestamp generation, parsing, serialization, and queries to UTC.
 */

export function toUTCISOString(date: Date = new Date()): string {
  return date.toISOString();
}

export function getUTCMidnight(date: Date = new Date()): Date {
  const d = new Date(date);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
}

export function parseStrictUTC(dateInput: string | Date): Date {
  if (dateInput instanceof Date) return dateInput;
  // Enforce UTC parsing: if no timezone offset is present, append 'Z'
  const trimmed = dateInput.trim();
  const hasTimezone = trimmed.endsWith('Z') || /[+-]\d{2}:?\d{2}$/.test(trimmed);
  const normalized = hasTimezone ? trimmed : `${trimmed}Z`;
  return new Date(normalized);
}

/**
 * Validates whether a link is currently active under strict UTC comparison.
 * Eliminates timezone drift where local-time vs UTC comparisons produce 404 gaps.
 */
export function isLinkActiveUTC(
  createdAt: Date,
  expiresAt: Date | null,
  referenceTime: Date = new Date()
): { active: boolean; reason?: 'FUTURE_CREATED' | 'EXPIRED' } {
  const nowMs = referenceTime.getTime();
  const createdMs = createdAt.getTime();

  // If createdAt was parsed with a local offset making it appear in the future
  if (createdMs > nowMs + 10_000) { // allow 10s skew
    return { active: false, reason: 'FUTURE_CREATED' };
  }

  if (expiresAt && nowMs > expiresAt.getTime()) {
    return { active: false, reason: 'EXPIRED' };
  }

  return { active: true };
}
