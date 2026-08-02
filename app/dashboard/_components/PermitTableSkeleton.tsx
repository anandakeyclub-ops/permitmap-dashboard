'use client';

// The permits-table-shaped loading placeholder — the single source of the skeleton table markup.
// Reused by (1) DashboardLoadingSkeleton (initial dashboard load) and (2) the Permits tab's
// live-search loading state. Six columns + 7 rows, matching the real table; decorative blocks are
// aria-hidden and pulse via `pm-skel` (disabled under prefers-reduced-motion, see app/globals.css).
// Uses the same `pm-table-scroll` / `pm-permits-table` classes as the live table (mobile/scroll).

// The six visible permits-table columns (kept in sync with the live table headers).
export const TABLE_HEADERS = ['Score', 'Address', 'Type', 'Trade', 'Value', 'Date'];
export const SKELETON_ROWS = 7;

// A neutral skeleton block; `pm-skel` provides the subtle opacity pulse. Decorative only.
export function SkelBlock({ width, height = 12 }: { width: number | string; height?: number }) {
  return (
    <span
      aria-hidden="true"
      className="pm-skel"
      style={{
        display: 'inline-block', width, height, borderRadius: 4,
        background: '#1e293b', verticalAlign: 'middle',
      }}
    />
  );
}

/**
 * @param announce when true, renders a single visually-hidden role="status" ("Searching permits")
 *        for assistive tech during a live search. DashboardLoadingSkeleton owns its own announcer,
 *        so it renders this without `announce`.
 */
export default function PermitTableSkeleton({ announce = false }: { announce?: boolean }) {
  return (
    <div style={{ background: '#111827', border: '1px solid #1e293b', borderRadius: 12, overflow: 'hidden' }}>
      {announce && (
        <div role="status" aria-live="polite" style={{
          position: 'absolute', width: 1, height: 1, padding: 0, margin: -1,
          overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0,
        }}>
          Searching permits
        </div>
      )}
      <div className="pm-table-scroll">
        <table aria-hidden="true" className="pm-permits-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid #1e293b' }}>
              {TABLE_HEADERS.map(h => (
                <th key={h} style={{
                  padding: '12px 16px', textAlign: 'left', fontSize: 11, color: '#475569',
                  fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em',
                }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: SKELETON_ROWS }).map((_, i) => (
              <tr key={i} style={{ borderBottom: '1px solid #0f172a', background: i % 2 === 0 ? '#111827' : '#0d1529' }}>
                <td style={{ padding: '12px 16px' }}><SkelBlock width={36} height={36} /></td>
                <td style={{ padding: '12px 16px' }}><SkelBlock width={'80%'} /></td>
                <td style={{ padding: '12px 16px' }}><SkelBlock width={90} /></td>
                <td style={{ padding: '12px 16px' }}><SkelBlock width={64} height={18} /></td>
                <td style={{ padding: '12px 16px' }}><SkelBlock width={70} /></td>
                <td style={{ padding: '12px 16px' }}><SkelBlock width={80} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
