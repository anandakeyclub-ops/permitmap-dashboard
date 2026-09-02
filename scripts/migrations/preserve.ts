// Metadata round-trip preservation (pure). Migration MUST carry public_metadata verbatim: no dropped
// keys, no type coercion, no stringifying arrays/booleans. The app reads booleans (onboarding_complete)
// and arrays (counties_allowed / allowed_counties / selected_counties / selected_trades) directly, so
// a coercion would silently break entitlement / county access.

/** Strict structural deep-equality: same keys, same types, arrays stay arrays, booleans stay booleans,
 *  numbers stay numbers. "true" (string) !== true (boolean); [ "a" ] !== "a". */
export function deepEqualStrict(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqualStrict(v, b[i]));
  }
  if (typeof a === 'object') {
    const ka = Object.keys(a as object).sort();
    const kb = Object.keys(b as object).sort();
    if (ka.length !== kb.length || !ka.every((k, i) => k === kb[i])) return false;
    return ka.every((k) => deepEqualStrict((a as any)[k], (b as any)[k]));
  }
  return false; // primitives that weren't === (and same typeof) → unequal
}

export interface PreservationResult {
  preserved: boolean;
  missingKeys: string[];
  coercedKeys: string[];
}

/** Verify dst preserves src exactly (every src key present with a strictly-equal value). Returns the
 *  specific offending keys so a failed migration can be diagnosed rather than silently accepted. */
export function checkMetadataPreserved(
  src: Record<string, unknown>,
  dst: Record<string, unknown>,
): PreservationResult {
  const missingKeys: string[] = [];
  const coercedKeys: string[] = [];
  for (const k of Object.keys(src)) {
    if (!(k in dst)) { missingKeys.push(k); continue; }
    if (!deepEqualStrict(src[k], dst[k])) coercedKeys.push(k);
  }
  return { preserved: missingKeys.length === 0 && coercedKeys.length === 0, missingKeys, coercedKeys };
}
