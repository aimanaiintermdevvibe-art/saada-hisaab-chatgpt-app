import { config } from "../config.js";

// Saada Hisaab stores timestamps as UTC in `timestamp without time zone` columns.
// Reports must use the business's local calendar days. BUSINESS_TIMEZONE is validated
// as an IANA name in config.ts, so inlining it as a literal is safe.
const TZ = `'${config.BUSINESS_TIMEZONE}'`;

/** A stored UTC timestamp column expressed in local time. */
export const localTs = (col: string) => `((${col} AT TIME ZONE 'UTC') AT TIME ZONE ${TZ})`;

/** Local calendar date of a stored UTC timestamp column. */
export const localDate = (col: string) => `(${localTs(col)})::date`;

/** Local date-time text, e.g. 2026-08-18 15:49. */
export const localDateTime = (col: string) => `to_char(${localTs(col)}, 'YYYY-MM-DD HH24:MI')`;

/** Today's date in the business time zone. */
export const todayLocalSql = `(now() AT TIME ZONE ${TZ})::date`;

/** UTC instant at which local day `dateParam` (+ plusDays) starts. `dateParam` is a $n placeholder. */
const dayStartUtc = (dateParam: string, plusDays = 0) =>
  `((((${dateParam})::date + ${plusDays})::timestamp AT TIME ZONE ${TZ}) AT TIME ZONE 'UTC')`;

/**
 * Index-friendly conditions for "column falls within local days from..to (inclusive)".
 * Returns SQL fragments to AND together.
 */
export function dateRangeConditions(
  col: string,
  add: (value: unknown) => string,
  from?: string,
  to?: string,
): string[] {
  const conds: string[] = [];
  if (from) conds.push(`${col} >= ${dayStartUtc(add(from))}`);
  if (to) conds.push(`${col} < ${dayStartUtc(add(to), 1)}`);
  return conds;
}

/** Today's date (YYYY-MM-DD) in the business time zone. */
export function todayLocal(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: config.BUSINESS_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** First day of the current year in the business time zone. */
export function yearStartLocal(): string {
  return `${todayLocal().slice(0, 4)}-01-01`;
}
