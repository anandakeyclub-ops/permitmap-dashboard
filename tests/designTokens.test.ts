import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { COLORS, SPACING, RADIUS, FONT, FONT_SIZE } from '../lib/designTokens';

// ── Exact approved values (the authoritative spec) ──────────────────────────
const APPROVED_COLORS = {
  'background-base':   '#0a0f1e',
  'background-raised': '#111827',
  'background-panel':  '#0d1529',
  'background-hover':  '#172033',
  'border-default':    '#1e293b',
  'border-strong':     '#334155',
  'text-primary':      '#e2e8f0',
  'text-secondary':    '#94a3b8',
  'text-muted':        '#64748b',
  'text-faint':        '#475569',
  'accent-primary':    '#2563eb',
  'accent-hover':      '#3b82f6',
  'accent-soft':       '#1e3a5f',
  'accent-on-soft':    '#93c5fd',
  'success':           '#22c55e',
  'warning':           '#f59e0b',
  'danger':            '#ef4444',
  'danger-soft':       '#7f1d1d',
  'focus-ring':        '#93c5fd',
};

describe('designTokens.ts — approved names & values', () => {
  it('COLORS matches the approved set exactly (names + hex values)', () => {
    expect(COLORS).toEqual(APPROVED_COLORS);
  });

  it('SPACING is exactly the approved compact scale', () => {
    expect(SPACING).toEqual({ xs: 4, sm: 8, md: 12, lg: 16, xl: 20, '2xl': 24 });
    // scale contains ONLY the approved values
    expect([...Object.values(SPACING)].sort((a, b) => a - b)).toEqual([4, 8, 12, 16, 20, 24]);
  });

  it('RADIUS is exactly the approved scale (6/8/12 + full/pill)', () => {
    expect(RADIUS).toEqual({ sm: 6, md: 8, lg: 12, full: '50%', pill: 9999 });
    const numeric = Object.values(RADIUS).filter(v => typeof v === 'number').sort((a: any, b: any) => a - b);
    expect(numeric).toEqual([6, 8, 12, 9999]); // 6/8/12 + pill; no stray 4/10/14/16
  });

  it('FONT is DM Sans with weights 600/700', () => {
    expect(FONT).toEqual({ family: "'DM Sans', system-ui, sans-serif", weightMedium: 600, weightBold: 700 });
  });

  it('FONT_SIZE is exactly the three approved tiers (caption 11 / control 12 / body 13)', () => {
    expect(FONT_SIZE).toEqual({ caption: 11, control: 12, body: 13 });
  });

  it('TypeScript object shape: plain string-keyed maps, hex values are lowercase #rrggbb', () => {
    for (const [k, v] of Object.entries(COLORS)) {
      expect(typeof k).toBe('string');
      expect(v).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

// ── Build the expected --pm-* map from the TS tokens (deterministic naming) ──
function expectedCssVars(): Record<string, string> {
  const m: Record<string, string> = {};
  for (const [k, v] of Object.entries(COLORS)) m[`--pm-${k}`] = v;
  for (const [k, v] of Object.entries(SPACING)) m[`--pm-space-${k}`] = `${v}px`;
  for (const [k, v] of Object.entries(RADIUS)) m[`--pm-radius-${k}`] = typeof v === 'number' ? `${v}px` : v;
  m['--pm-font-family'] = FONT.family;
  m['--pm-weight-medium'] = String(FONT.weightMedium);
  m['--pm-weight-bold'] = String(FONT.weightBold);
  for (const [k, v] of Object.entries(FONT_SIZE)) m[`--pm-font-size-${k}`] = `${v}px`;
  return m;
}

// ── Parse the :root { --pm-*: … } block from app/globals.css ────────────────
function parseRootPmVars(): Record<string, string> {
  const css = readFileSync(resolve(process.cwd(), 'app/globals.css'), 'utf8');
  const root = css.match(/:root\s*\{([\s\S]*?)\}/);
  expect(root, ':root block must exist in app/globals.css').toBeTruthy();
  const map: Record<string, string> = {};
  for (const line of root![1].split('\n')) {
    const m = line.match(/(--pm-[a-z0-9-]+)\s*:\s*([^;]+);/i);
    if (m) map[m[1]] = m[2].trim();
  }
  return map;
}

describe('CSS custom properties mirror designTokens.ts', () => {
  it('the :root --pm-* variables exactly equal the TS tokens (no drift either way)', () => {
    expect(parseRootPmVars()).toEqual(expectedCssVars());
  });

  it('every approved token is present in BOTH representations (counts match)', () => {
    const css = parseRootPmVars();
    const ts = expectedCssVars();
    expect(Object.keys(css).length).toBe(Object.keys(ts).length);
    for (const name of Object.keys(ts)) expect(css).toHaveProperty(name);
  });

  it('no duplicate token names in the CSS :root block', () => {
    const css = readFileSync(resolve(process.cwd(), 'app/globals.css'), 'utf8');
    const root = css.match(/:root\s*\{([\s\S]*?)\}/)![1];
    const names = [...root.matchAll(/(--pm-[a-z0-9-]+)\s*:/gi)].map(m => m[1]);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('token adoption — .pm-btn-secondary (first consumer)', () => {
  const css = () => readFileSync(resolve(process.cwd(), 'app/globals.css'), 'utf8');
  const block = () => css().match(/\.pm-btn-secondary\s*\{([\s\S]*?)\}/)![1];

  it('the canonical secondary button consumes the mapped tokens (not hardcoded hex)', () => {
    const b = block();
    expect(b).toContain('var(--pm-accent-soft)');    // background
    expect(b).toContain('var(--pm-border-strong)');  // border
    expect(b).toContain('var(--pm-focus-ring)');     // text
    expect(b).toContain('var(--pm-radius-md)');       // radius
    expect(b).toContain('var(--pm-weight-medium)');   // weight (600)
  });

  it('hover brightens via accent tokens (bg accent-primary, border accent-hover)', () => {
    const hover = css().match(/\.pm-btn-secondary:not\(:disabled\):hover\s*\{([^}]*)\}/)![1];
    expect(hover).toContain('var(--pm-accent-primary)'); // brighter hover background
    expect(hover).toContain('var(--pm-accent-hover)');   // strengthened hover border
  });

  it('only the preserved disabled color is a raw hex in the secondary-button rules', () => {
    const rules = css().slice(css().indexOf('.pm-btn-secondary {'));
    const hexes = [...rules.matchAll(/#[0-9a-fA-F]{6}/g)].map(m => m[0].toLowerCase());
    expect(hexes).toEqual(['#475569']); // only the documented disabled-color gap
  });
});
