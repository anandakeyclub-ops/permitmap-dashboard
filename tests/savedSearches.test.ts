import { describe, it, expect } from 'vitest';
import {
  SAVED_SEARCHES_KEY, MAX_NAME_LENGTH,
  createSavedSearch, generateId, validateSavedSearchName,
  parseSavedSearches, loadSavedSearches, saveSavedSearches,
  deleteSavedSearch, toAppliedState, resolveSavedSearchCounty,
  type SavedSearch, type SavedSearchInput, type StorageLike,
} from '../lib/savedSearches';

const input: SavedSearchInput = {
  name: 'Marion roofing',
  county: 'marion',
  tradeFilter: 'roofing',
  search: 'reroof',
  sortOption: 'value_desc',
};

// Deterministic factory for tests (fixed now + id).
const make = (over: Partial<SavedSearchInput> = {}, now = 1000, id = 'ss_test_1'): SavedSearch =>
  createSavedSearch({ ...input, ...over }, now, id);

// Minimal in-memory StorageLike; `fail` makes get/set throw to simulate unavailable storage.
function memStorage(seed?: string, fail = false): StorageLike & { data: Record<string, string> } {
  const data: Record<string, string> = {};
  if (seed !== undefined) data[SAVED_SEARCHES_KEY] = seed;
  return {
    data,
    getItem(k) { if (fail) throw new Error('blocked'); return k in data ? data[k] : null; },
    setItem(k, v) { if (fail) throw new Error('blocked'); data[k] = v; },
  };
}

const APPROVED_KEYS = ['id', 'name', 'county', 'tradeFilter', 'search', 'sortOption', 'createdAt'];

const COUNTIES = [{ key: 'marion' }, { key: 'duval' }, { key: 'alachua' }];

describe('createSavedSearch', () => {
  it('creates a saved search from the supplied state', () => {
    const s = make();
    expect(s).toMatchObject({
      id: 'ss_test_1', name: 'Marion roofing', county: 'marion',
      tradeFilter: 'roofing', search: 'reroof', sortOption: 'value_desc', createdAt: 1000,
    });
  });

  it('trims the saved-search name', () => {
    expect(make({ name: '   Marion roofing   ' }).name).toBe('Marion roofing');
  });

  it('rejects an empty name', () => {
    expect(() => make({ name: '   ' })).toThrow(/required/i);
    expect(validateSavedSearchName('   ').error).toMatch(/required/i);
  });

  it('enforces the maximum name length', () => {
    const long = 'x'.repeat(MAX_NAME_LENGTH + 1);
    expect(() => make({ name: long })).toThrow();
    expect(validateSavedSearchName(long).error).toContain(String(MAX_NAME_LENGTH));
    expect(validateSavedSearchName('x'.repeat(MAX_NAME_LENGTH)).error).toBeNull();
  });

  it('generates a unique ID', () => {
    expect(generateId()).not.toBe(generateId());
    // real (non-injected) ids differ across creates
    const a = createSavedSearch(input);
    const b = createSavedSearch(input);
    expect(a.id).not.toBe(b.id);
  });

  it('stores only the approved fields (drops extras)', () => {
    const dirty = { ...input, permits: [{ PERMITNO: 'X' }], allowed_counties: ['duval'], userId: 'u_1', email: 'a@b.co' } as any;
    const s = createSavedSearch(dirty, 1000, 'ss_test_1');
    expect(Object.keys(s).sort()).toEqual([...APPROVED_KEYS].sort());
  });
});

describe('storage: save / load / parse', () => {
  it('saves and loads valid searches', () => {
    const store = memStorage();
    const list = [make(), make({ name: 'Duval solar', county: 'duval', tradeFilter: 'solar' }, 2000, 'ss_test_2')];
    expect(saveSavedSearches(list, store)).toBe(true);
    expect(loadSavedSearches(store)).toEqual(list);
  });

  it('malformed JSON returns an empty safe state', () => {
    expect(loadSavedSearches(memStorage('{not valid json'))).toEqual([]);
    expect(parseSavedSearches('[[[')).toEqual([]);
    expect(parseSavedSearches('null')).toEqual([]);
    expect(parseSavedSearches('{"a":1}')).toEqual([]); // not an array
    expect(parseSavedSearches(null)).toEqual([]);
  });

  it('ignores invalid saved entries safely (keeps only valid)', () => {
    const good = make();
    const raw = JSON.stringify([
      good,
      { id: 'x', name: 'no fields' },                    // missing required fields
      { ...good, id: '', },                              // empty id
      { ...good, sortOption: 'not_a_sort' },             // invalid sort value
      { ...good, createdAt: 'nope' },                    // wrong type
      42, null, 'string',                                // non-objects
    ]);
    expect(parseSavedSearches(raw)).toEqual([good]);
  });

  it('does not crash if localStorage is unavailable / throws', () => {
    expect(loadSavedSearches(memStorage(undefined, true))).toEqual([]); // getItem throws
    expect(loadSavedSearches(null)).toEqual([]);                        // SSR (no storage)
    expect(saveSavedSearches([make()], memStorage(undefined, true))).toBe(false); // setItem throws
    expect(saveSavedSearches([make()], null)).toBe(false);
  });
});

describe('list operations', () => {
  it('deleting removes only the selected search', () => {
    const a = make({}, 1000, 'a');
    const b = make({ name: 'B' }, 2000, 'b');
    const c = make({ name: 'C' }, 3000, 'c');
    expect(deleteSavedSearch([a, b, c], 'b')).toEqual([a, c]);
    expect(deleteSavedSearch([a, b, c], 'missing')).toEqual([a, b, c]);
  });
});

describe('applying a saved search', () => {
  it('restores county, trade, keyword, and sort', () => {
    const s = make();
    const applied = toAppliedState(s);
    expect(applied.county).toBe('marion');
    expect(applied.tradeFilter).toBe('roofing');
    expect(applied.search).toBe('reroof');
    expect(applied.sortOption).toBe('value_desc');
  });

  it('does not mutate the saved object', () => {
    const s = make();
    const snap = JSON.parse(JSON.stringify(s));
    toAppliedState(s);
    resolveSavedSearchCounty(s, COUNTIES, 'starter', ['duval']); // triggers fallback path
    expect(s).toEqual(snap);
  });

  it('applies a valid entitled county unchanged', () => {
    const s = make({ county: 'marion' });
    expect(resolveSavedSearchCounty(s, COUNTIES, 'starter', ['marion'])).toEqual({ county: 'marion', countyChanged: false });
  });

  it('does not apply a no-longer-entitled county (resolves to first entitled)', () => {
    const s = make({ county: 'marion' });
    const r = resolveSavedSearchCounty(s, COUNTIES, 'starter', ['duval']);
    expect(r.countyChanged).toBe(true);
    expect(r.county).toBe('duval');       // first currently entitled county
    expect(r.county).not.toBe('marion');  // the locked saved county is never applied
  });
});

describe('safety invariants', () => {
  it('no stored search can introduce permits or bypass entitlement', () => {
    // Even if storage is tampered with to include permit/entitlement/identity data, parsing strips it.
    const tampered = JSON.stringify([{
      id: 'ss_x', name: 'tampered', county: 'marion', tradeFilter: '', search: '', sortOption: '',
      createdAt: 1, permits: [{ PERMITNO: 'HACK' }], allowed_counties: ['team'], tier: 'team', userId: 'u', email: 'x@y.z',
    }]);
    const parsed = parseSavedSearches(tampered);
    expect(Object.keys(parsed[0]).sort()).toEqual([...APPROVED_KEYS].sort());
    // A locked county in a tampered entry still cannot be applied.
    const r = resolveSavedSearchCounty(parsed[0], COUNTIES, 'starter', ['duval']);
    expect(r.county).toBe('duval');
    expect(r.countyChanged).toBe(true);
  });

  it('uses a distinct versioned key and never references permitmap_county', () => {
    expect(SAVED_SEARCHES_KEY).toBe('permitmap_saved_searches_v1');
    expect(SAVED_SEARCHES_KEY).not.toContain('permitmap_county');
  });
});
