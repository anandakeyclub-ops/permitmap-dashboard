// Canonical PermitMap dashboard design tokens (PR #1 — DEFINITIONS ONLY, no consumers yet).
//
// Mirrored 1:1 by the `:root { --pm-* }` custom properties in app/globals.css. Adding, renaming, or
// changing a token here without matching globals.css (or vice-versa) fails tests/designTokens.test.ts.
// Nothing imports this module or references these CSS variables yet — they are introduced so later
// surface-by-surface PRs can adopt them. Because there are no consumers, the rendered UI is
// unchanged by construction.

export const COLORS = {
  'background-base':   '#0a0f1e', // page / app frame (darkest)
  'background-raised': '#111827', // primary content surfaces (cards, table)
  'background-panel':  '#0d1529', // recessed / overlay surfaces (inputs, drawers, modals)
  'background-hover':  '#172033', // NEW — subtle interactive/row hover tone
  'border-default':    '#1e293b', // hairline
  'border-strong':     '#334155', // emphasized divider / secondary-button border
  'text-primary':      '#e2e8f0', // body high-contrast
  'text-secondary':    '#94a3b8', // sub-labels / secondary metadata
  'text-muted':        '#64748b', // captions / muted
  'text-faint':        '#475569', // faintest neutral tone — idle icons, inactive, disabled
  'accent-primary':    '#2563eb', // primary accent (borders / CTA)
  'accent-hover':      '#3b82f6', // brighter accent on hover
  'accent-soft':       '#1e3a5f', // soft accent fill (calm primary button)
  'accent-on-soft':    '#93c5fd', // readable blue text on dark/soft; links
  'success':           '#22c55e', // valuations / won
  'warning':           '#f59e0b', // warnings / staleness
  'danger':            '#ef4444', // destructive border / icon
  'danger-soft':       '#7f1d1d', // destructive button fill
  'focus-ring':        '#93c5fd', // keyboard focus ring (matches merged PR #23)
} as const;

// Compact spacing scale (px).
export const SPACING = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  '2xl': 24,
} as const;

// Radius scale. `full` = circle (avatars); `pill` = fully-rounded chips.
export const RADIUS = {
  sm: 6,        // icon buttons, chips, badges
  md: 8,        // buttons, inputs, selects
  lg: 12,       // cards, table container, drawers/modals
  full: '50%',  // avatars
  pill: 9999,   // trade chips
} as const;

// Typography. Family is preserved (DM Sans, already loaded in app/dashboard). Weights collapse to
// 600 (UI default) / 700 (emphasis, headings, values).
export const FONT = {
  family: "'DM Sans', system-ui, sans-serif",
  weightMedium: 600,
  weightBold: 700,
} as const;

// Minimum-viable font-size scale (px) — the three dominant, stable body/label tiers only.
// Headings and one-off sizes are intentionally left raw pending a future, evidence-backed pass.
export const FONT_SIZE = {
  caption: 11, // labels / metadata / captions
  control: 12, // buttons / controls / secondary table cells
  body: 13,    // body / primary table text
} as const;

export type ColorToken = keyof typeof COLORS;
export type SpacingToken = keyof typeof SPACING;
export type RadiusToken = keyof typeof RADIUS;
export type FontSizeToken = keyof typeof FONT_SIZE;
