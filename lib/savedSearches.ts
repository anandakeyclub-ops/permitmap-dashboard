// Pure + storage helpers for device-local Saved Searches (v1).
//
// Saved searches are CONVENIENCE dashboard preferences, not authoritative data. They persist
// only in the current browser via localStorage under a versioned key — they do NOT sync across
// devices, and they NEVER carry permit data, entitlement, or identity. A saved county is never
// authoritative: applying a saved search re-checks entitlement via lib/entitlement (isCountyLocked)
// and falls back to the first entitled county if the saved one is no longer included.
//
// Storage access is isolated from the pure validation/transform helpers so the core behavior is
// unit-testable without a DOM. Nothing here fetches, mutates inputs, or touches Clerk/Stripe/APIs.

import type { SortOption } from './sort';
import { SORT_OPTIONS } from './sort';
import { isCountyLocked, defaultEntitledCounty } from './entitlement';

/** Versioned, distinct storage key — never reuses `permitmap_county`. */
export const SAVED_SEARCHES_KEY = 'permitmap_saved_searches_v1';
export const MAX_NAME_LENGTH = 60;

/** The ONLY fields a saved search stores. No permits, entitlement, user id, email, or dates. */
export interface SavedSearch {
  id: string;
  name: string;
  county: string;
  tradeFilter: string;
  search: string;
  sortOption: SortOption;
  createdAt: number;
}

export interface SavedSearchInput {
  name: string;
  county: string;
  tradeFilter: string;
  search: string;
  sortOption: SortOption;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const VALID_SORTS = new Set<string>(SORT_OPTIONS.map(o => o.value));

// ── Name validation ────────────────────────────────────────────────────────
// Both fields are always present (error === null when valid) so callers don't rely on
// discriminated-union narrowing — this project's tsconfig has `strict: false`.
export interface NameValidation { value: string; error: string | null }

export function validateSavedSearchName(name: string): NameValidation {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return { value: '', error: 'Name is required.' };
  if (trimmed.length > MAX_NAME_LENGTH) {
    return { value: trimmed, error: `Name must be ${MAX_NAME_LENGTH} characters or fewer.` };
  }
  return { value: trimmed, error: null };
}

// ── ID generation (client-side, no dependency) ───────────────────────────────
export function generateId(): string {
  return `ss_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

// ── Create (pure) ─────────────────────────────────────────────────────────────
/** Build a saved search from the supplied state. Throws on an invalid name. `now`/`id` are
 *  injectable for deterministic tests. Stores ONLY the approved fields (extras are dropped). */
export function createSavedSearch(
  input: SavedSearchInput,
  now: number = Date.now(),
  id: string = generateId(),
): SavedSearch {
  const v = validateSavedSearchName(input.name);
  if (v.error) throw new Error(v.error);
  return {
    id,
    name: v.value,
    county: String(input.county ?? ''),
    tradeFilter: String(input.tradeFilter ?? ''),
    search: String(input.search ?? ''),
    sortOption: (VALID_SORTS.has(input.sortOption as string) ? input.sortOption : '') as SortOption,
    createdAt: now,
  };
}

// ── Parse / validate (strict; unknown fields dropped) ────────────────────────
function isValidSavedSearch(x: any): x is SavedSearch {
  return !!x && typeof x === 'object'
    && typeof x.id === 'string' && x.id.length > 0
    && typeof x.name === 'string' && x.name.trim().length > 0
    && typeof x.county === 'string'
    && typeof x.tradeFilter === 'string'
    && typeof x.search === 'string'
    && typeof x.sortOption === 'string' && VALID_SORTS.has(x.sortOption)
    && typeof x.createdAt === 'number' && Number.isFinite(x.createdAt);
}

/** Keep only the approved fields — no permit/entitlement/identity data can survive parsing. */
function sanitize(x: SavedSearch): SavedSearch {
  return {
    id: x.id,
    name: x.name,
    county: x.county,
    tradeFilter: x.tradeFilter,
    search: x.search,
    sortOption: x.sortOption,
    createdAt: x.createdAt,
  };
}

/** Parse a raw storage string into a safe list. Malformed JSON or a non-array → []. Invalid
 *  entries are dropped. Never throws. */
export function parseSavedSearches(raw: string | null): SavedSearch[] {
  if (!raw) return [];
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(data)) return [];
  return data.filter(isValidSavedSearch).map(sanitize);
}

// ── Storage (isolated; SSR- and failure-safe) ────────────────────────────────
function defaultStorage(): StorageLike | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  } catch { /* access can throw in sandboxed contexts */ }
  return null;
}

/** Load saved searches from storage. SSR / unavailable / malformed → [] (never throws). */
export function loadSavedSearches(storage: StorageLike | null = defaultStorage()): SavedSearch[] {
  if (!storage) return [];
  let raw: string | null = null;
  try { raw = storage.getItem(SAVED_SEARCHES_KEY); } catch { return []; }
  return parseSavedSearches(raw);
}

/** Persist saved searches. Returns false (never throws) if storage is unavailable or write fails. */
export function saveSavedSearches(
  list: SavedSearch[],
  storage: StorageLike | null = defaultStorage(),
): boolean {
  if (!storage) return false;
  try { storage.setItem(SAVED_SEARCHES_KEY, JSON.stringify(list)); return true; }
  catch { return false; }
}

// ── List ops (pure) ───────────────────────────────────────────────────────────
export function deleteSavedSearch(list: SavedSearch[], id: string): SavedSearch[] {
  return list.filter(s => s.id !== id);
}

/** The dashboard state a saved search restores. Pure — does not mutate the saved object. */
export function toAppliedState(saved: SavedSearch): SavedSearchInput {
  return {
    name: saved.name,
    county: saved.county,
    tradeFilter: saved.tradeFilter,
    search: saved.search,
    sortOption: saved.sortOption,
  } as SavedSearchInput; // `name` unused by callers applying state, kept for shape symmetry
}

// ── Entitlement-safe county resolution on apply ──────────────────────────────
export interface ResolvedCounty { county: string; countyChanged: boolean }

/** Never applies a locked county from localStorage. If the saved county is still entitled it is
 *  returned unchanged; otherwise resolve to the first currently entitled county and flag the change
 *  (the UI shows a concise message). The returned county is guaranteed not to be a locked county. */
export function resolveSavedSearchCounty(
  saved: SavedSearch,
  counties: { key: string }[],
  tier: string,
  allowedCounties?: string[],
): ResolvedCounty {
  if (!isCountyLocked(saved.county, tier, allowedCounties)) {
    return { county: saved.county, countyChanged: false };
  }
  return { county: defaultEntitledCounty(counties, tier, allowedCounties), countyChanged: true };
}
