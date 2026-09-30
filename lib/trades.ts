// Canonical trade taxonomy for the dashboard — ONE source of truth for trade order,
// colors, and demand emphasis. Generator + foundation are first-class here. Crucially,
// tradeColor() falls back to a neutral color and tradeOptions() unions in any trade the
// API returns that isn't listed — so a NEW API trade renders WITHOUT a dashboard code
// change (it appears in filters + gets a default color). Extend TRADE_ORDER only to give
// a new trade a preferred position/color.

export const TRADE_ORDER: string[] = [
  'roofing', 'hvac', 'electrical', 'plumbing', 'pool', 'solar',
  'generator', 'foundation', 'general_contractor',
];

export const TRADE_COLORS: Record<string, string> = {
  roofing: '#ef4444', hvac: '#f97316', electrical: '#eab308', plumbing: '#3b82f6',
  pool: '#06b6d4', solar: '#22c55e', generator: '#a855f7', foundation: '#78716c',
  general_contractor: '#8b5cf6',
};

const DEFAULT_TRADE_COLOR = '#94a3b8'; // neutral slate — any unknown/new trade renders safely

export const HIGH_DEMAND = new Set(['roofing', 'hvac', 'pool', 'solar', 'generator']);

/** Color for a trade; unknown/new trades get a neutral default (never undefined). */
export function tradeColor(trade: string | null | undefined): string {
  return TRADE_COLORS[(trade || '').trim()] || DEFAULT_TRADE_COLOR;
}

/** Human label for a trade value (underscores → spaces). */
export function tradeLabel(trade: string | null | undefined): string {
  return (trade || '').replace(/_/g, ' ').trim();
}

/** Dropdown options: '' (All) first, then the canonical order, then any EXTRA trades present
 *  in the data (or a county's /counties trades) that aren't in TRADE_ORDER — so new API trades
 *  appear automatically. Deterministic, de-duplicated. */
export function tradeOptions(present?: Iterable<string | null | undefined>): string[] {
  const extra: string[] = [];
  const seen = new Set(TRADE_ORDER);
  for (const t of present || []) {
    const v = (t || '').trim();
    if (v && !seen.has(v)) { seen.add(v); extra.push(v); }
  }
  return ['', ...TRADE_ORDER, ...extra];
}
