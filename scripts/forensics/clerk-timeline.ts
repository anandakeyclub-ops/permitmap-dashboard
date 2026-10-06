// Pure helper (no side effects on import) so tests can import it without running the probe.
export function timelineSummary(createdAtMs: number[]) {
  const byDay: Record<string, number> = {};
  for (const t of createdAtMs) { const d = new Date(t).toISOString().slice(0, 10); byDay[d] = (byDay[d] || 0) + 1; }
  const sorted = [...createdAtMs].sort((a, b) => a - b);
  return { count: sorted.length, earliest: sorted.length ? new Date(sorted[0]).toISOString() : null, latest: sorted.length ? new Date(sorted[sorted.length - 1]).toISOString() : null, by_day: Object.fromEntries(Object.entries(byDay).sort()) };
}
