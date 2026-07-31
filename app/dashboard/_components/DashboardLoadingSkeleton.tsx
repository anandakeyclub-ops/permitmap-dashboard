'use client';

// Static, layout-shaped loading placeholder shown INSIDE the existing dashboard `loading` branch
// (replaces the old centered 60vh spinner). Takes NO props and reads no live state, so it can
// never render stale permit or KPI data. Purely decorative skeleton blocks are aria-hidden; a
// single role="status" element announces "Loading permit data" once. Nothing here is focusable.
// No live controls, no load-more, no empty state, no data. Reuses the existing dark surfaces.

// The six visible permits-table columns (kept in sync with the live table headers).
const TABLE_HEADERS = ['Score', 'Address', 'Type', 'Trade', 'Value', 'Date'];
const SKELETON_ROWS = 7;

// A neutral skeleton block; `pm-skel` provides the subtle opacity pulse (disabled under
// prefers-reduced-motion — see app/globals.css). Decorative only.
function Block({ width, height = 12 }: { width: number | string; height?: number }) {
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

export default function DashboardLoadingSkeleton() {
  return (
    <div>
      {/* One concise, single announcement for assistive tech. */}
      <div role="status" aria-live="polite" style={{
        position: 'absolute', width: 1, height: 1, padding: 0, margin: -1,
        overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0,
      }}>
        Loading permit data
      </div>

      {/* Header / KPI placeholder strip */}
      <div aria-hidden="true" style={{ marginBottom: 24 }}>
        <Block width={220} height={22} />
        <div style={{ marginTop: 8 }}><Block width={320} height={12} /></div>
        <div style={{ display: 'flex', gap: 12, marginTop: 20, flexWrap: 'wrap' }}>
          {[0, 1, 2, 3].map(i => (
            <div key={i} style={{
              flex: '1 1 180px', background: '#111827', border: '1px solid #1e293b',
              borderRadius: 12, padding: '20px 24px', borderTop: '3px solid #1e293b',
            }}>
              <Block width={90} height={11} />
              <div style={{ marginTop: 12 }}><Block width={70} height={22} /></div>
            </div>
          ))}
        </div>
      </div>

      {/* Tab-row placeholder */}
      <div aria-hidden="true" style={{
        display: 'flex', gap: 4, marginBottom: 20, borderBottom: '1px solid #1e293b', paddingBottom: 10,
      }}>
        {[0, 1, 2, 3, 4].map(i => (
          <span key={i} style={{ padding: '0 18px' }}><Block width={64} height={13} /></span>
        ))}
      </div>

      {/* Permits-style table surface: real header labels + 7 skeleton rows */}
      <div style={{ background: '#111827', border: '1px solid #1e293b', borderRadius: 12, overflow: 'hidden' }}>
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
                <td style={{ padding: '12px 16px' }}><Block width={36} height={36} /></td>
                <td style={{ padding: '12px 16px' }}><Block width={'80%'} /></td>
                <td style={{ padding: '12px 16px' }}><Block width={90} /></td>
                <td style={{ padding: '12px 16px' }}><Block width={64} height={18} /></td>
                <td style={{ padding: '12px 16px' }}><Block width={70} /></td>
                <td style={{ padding: '12px 16px' }}><Block width={80} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>
    </div>
  );
}

export { SKELETON_ROWS, TABLE_HEADERS };
