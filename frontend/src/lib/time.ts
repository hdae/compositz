// Compact relative-age formatting for provenance lines ("created 3 days ago").

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

/**
 * An ISO-8601 timestamp as the user's LOCAL date+time (times are always shown
 * local — the stored value is UTC). Verbatim if unparseable.
 */
export function formatLocalTimestamp(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : new Date(t).toLocaleString();
}

/**
 * An ISO-8601 timestamp as a relative age ("3 days ago", "just now"). An
 * unparseable input is returned verbatim — provenance is best-effort display,
 * never worth an exception.
 */
export function formatRelativeAge(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const seconds = Math.max(0, Math.round((now - t) / 1000));
  for (const [unit, size] of UNITS) {
    if (seconds >= size) {
      const format = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
      return format.format(-Math.floor(seconds / size), unit);
    }
  }
  return "just now";
}
