import { describe, it, expect } from 'vitest';
import { nextTrapIndex, FOCUSABLE_SELECTOR } from '../lib/dialogFocus';

// nextTrapIndex(count, activeIndex, shiftKey) → index to focus, or -1 to allow native Tab.
describe('nextTrapIndex — Tab-wrap logic (pure)', () => {
  it('forward wrap: at the last element → first', () => {
    expect(nextTrapIndex(3, 2, false)).toBe(0);
  });

  it('backward wrap: at the first element with Shift → last', () => {
    expect(nextTrapIndex(3, 0, true)).toBe(2);
  });

  it('mid-list forward → -1 (native Tab moves to the next control)', () => {
    expect(nextTrapIndex(3, 1, false)).toBe(-1);
  });

  it('mid-list backward → -1 (native Shift+Tab moves to the previous control)', () => {
    expect(nextTrapIndex(3, 1, true)).toBe(-1);
  });

  it('not at an edge forward (index 0 of 3) → -1 native', () => {
    expect(nextTrapIndex(3, 0, false)).toBe(-1);
  });

  it('not at an edge backward (last of 3) → -1 native', () => {
    expect(nextTrapIndex(3, 2, true)).toBe(-1);
  });

  it('single focusable element: always refocus it (index 0), both directions', () => {
    expect(nextTrapIndex(1, 0, false)).toBe(0);
    expect(nextTrapIndex(1, 0, true)).toBe(0);
    expect(nextTrapIndex(1, -1, false)).toBe(0);
  });

  it('zero focusable elements: -1 (caller keeps focus on the panel)', () => {
    expect(nextTrapIndex(0, -1, false)).toBe(-1);
    expect(nextTrapIndex(0, -1, true)).toBe(-1);
  });

  it('focus escaped the dialog (activeIndex -1): pull to first forward, last backward', () => {
    expect(nextTrapIndex(4, -1, false)).toBe(0);
    expect(nextTrapIndex(4, -1, true)).toBe(3);
  });

  it('two elements wrap correctly at both edges', () => {
    expect(nextTrapIndex(2, 1, false)).toBe(0);  // last → first
    expect(nextTrapIndex(2, 0, true)).toBe(1);   // first (shift) → last
    expect(nextTrapIndex(2, 0, false)).toBe(-1); // first forward → native (to second)
    expect(nextTrapIndex(2, 1, true)).toBe(-1);  // last backward → native (to first)
  });
});

describe('FOCUSABLE_SELECTOR', () => {
  it('excludes disabled controls and tabindex="-1"; includes the standard focusables', () => {
    expect(FOCUSABLE_SELECTOR).toContain('button:not([disabled])');
    expect(FOCUSABLE_SELECTOR).toContain('a[href]');
    expect(FOCUSABLE_SELECTOR).toContain('input:not([disabled])');
    expect(FOCUSABLE_SELECTOR).toContain('select:not([disabled])');
    expect(FOCUSABLE_SELECTOR).toContain('textarea:not([disabled])');
    expect(FOCUSABLE_SELECTOR).toContain('[tabindex]:not([tabindex="-1"])');
  });
});
