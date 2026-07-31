import { describe, it, expect } from 'vitest';
import {
  INITIAL_VISIBLE, LOAD_MORE_STEP,
  shownCount, shouldShowLoadMore, nextVisibleCount,
} from '../lib/tableView';

describe('Load more — view math (pure)', () => {
  it('initial visible count is 50', () => {
    expect(INITIAL_VISIBLE).toBe(50);
    expect(LOAD_MORE_STEP).toBe(50);
  });

  it('each Load more click increases the count by 50', () => {
    expect(nextVisibleCount(50, 300)).toBe(100);
    expect(nextVisibleCount(100, 300)).toBe(150);
  });

  it('the final increment never exceeds the result length', () => {
    expect(nextVisibleCount(50, 60)).toBe(60);    // 50 + 50 clamped to 60
    expect(nextVisibleCount(50, 50)).toBe(50);    // already all
    expect(nextVisibleCount(100, 120)).toBe(120); // clamp
  });

  it('shown count is accurate: min(visibleCount, total), never above total', () => {
    expect(shownCount(50, 300)).toBe(50);
    expect(shownCount(120, 60)).toBe(60);  // clamped to total
    expect(shownCount(50, 50)).toBe(50);
    expect(shownCount(50, 0)).toBe(0);     // empty result
  });

  it('button shows only while rows remain hidden (X < Y)', () => {
    expect(shouldShowLoadMore(50, 300)).toBe(true);   // 50 of 300
    expect(shouldShowLoadMore(50, 50)).toBe(false);   // all shown
    expect(shouldShowLoadMore(300, 300)).toBe(false); // all shown
    expect(shouldShowLoadMore(120, 60)).toBe(false);  // over-count clamps → hidden
    expect(shouldShowLoadMore(50, 0)).toBe(false);    // empty → no button
  });

  it('walks a full result to completion in +50 steps, then hides the button', () => {
    const total = 130;
    let visible = INITIAL_VISIBLE;                 // 50
    expect(shownCount(visible, total)).toBe(50);
    expect(shouldShowLoadMore(visible, total)).toBe(true);
    visible = nextVisibleCount(visible, total);    // 100
    expect(shownCount(visible, total)).toBe(100);
    expect(shouldShowLoadMore(visible, total)).toBe(true);
    visible = nextVisibleCount(visible, total);    // 130 (clamped from 150)
    expect(visible).toBe(130);
    expect(shownCount(visible, total)).toBe(130);
    expect(shouldShowLoadMore(visible, total)).toBe(false);
  });
});
