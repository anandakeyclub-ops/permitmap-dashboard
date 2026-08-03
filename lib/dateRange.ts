// Pure, UTC-safe date-range helpers for the Permits tab's historical filtering. No React, no fetch,
// no hidden clock: presets are anchored to the county's available_date_to (NOT today), so ingestion
// lag can never produce an empty "last 7 days". Calendar-date math only (YYYY-MM-DD, UTC).

export type DatePreset = 'all' | '7d' | '30d' | '90d' | 'custom';
export interface CoverageBounds { from: string | null; to: string | null; }
export interface DateRange { from: string | null; to: string | null; }

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Strict ISO calendar date (rejects e.g. 2026-02-30 and non-ISO formats). */
export function isIsoDate(s: string | null | undefined): s is string {
  if (!s || !ISO.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function fmt(d: Date): string { return d.toISOString().slice(0, 10); }

/** Shift an ISO date by whole days (UTC). */
export function shiftDays(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return fmt(d);
}

/** Clamp an ISO date into [min, max] (either bound may be null = unbounded). */
export function clampDate(iso: string, min: string | null, max: string | null): string {
  let out = iso;
  if (min && out < min) out = min;
  if (max && out > max) out = max;
  return out;
}

const PRESET_DAYS: Record<string, number> = { '7d': 7, '30d': 30, '90d': 90 };

/**
 * Inclusive N-day window ending at `availableTo` (the anchor), clamped to `availableFrom`.
 * `all`/`custom` → {null,null}. No valid availableTo (unknown coverage) → {null,null} (all).
 * Example (Marion, availableTo=2026-07-31): 7d → 2026-07-25..2026-07-31 (inclusive).
 */
export function getPresetRange(preset: DatePreset, availableFrom: string | null, availableTo: string | null): DateRange {
  if (preset === 'all' || preset === 'custom') return { from: null, to: null };
  const n = PRESET_DAYS[preset];
  if (!n || !isIsoDate(availableTo)) return { from: null, to: null };
  const to = availableTo;
  let from = shiftDays(to, -(n - 1)); // inclusive: the window is exactly N calendar days ending at `to`
  if (isIsoDate(availableFrom)) from = clampDate(from, availableFrom, to);
  return { from, to };
}

/** Human label for a UTC ISO date, e.g. "Apr 9, 2026". Empty/invalid → ''. */
export function formatHuman(iso: string | null): string {
  if (!isIsoDate(iso)) return '';
  return new Date(iso + 'T00:00:00Z').toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
}

/** A custom range is valid only when both bounds are ISO and from <= to. */
export function isValidCustomRange(from: string | null, to: string | null): boolean {
  return isIsoDate(from) && isIsoDate(to) && (from as string) <= (to as string);
}

/**
 * Resolve the range to actually send to the API from UI state + coverage.
 * `all` → {null,null} (omit params). presets → getPresetRange. custom → clamped to coverage when
 * valid; INVALID custom → {null,null} (the caller must NOT commit an invalid custom range).
 */
export function effectiveRange(
  preset: DatePreset,
  customFrom: string | null,
  customTo: string | null,
  cov: CoverageBounds | null,
): DateRange {
  if (preset === 'custom') {
    if (!isValidCustomRange(customFrom, customTo)) return { from: null, to: null };
    const from = clampDate(customFrom as string, cov?.from ?? null, cov?.to ?? null);
    const to = clampDate(customTo as string, cov?.from ?? null, cov?.to ?? null);
    return { from, to };
  }
  return getPresetRange(preset, cov?.from ?? null, cov?.to ?? null);
}
