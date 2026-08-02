'use client';

// Static, layout-shaped loading placeholder shown INSIDE the existing dashboard `loading` branch
// (replaces the old centered 60vh spinner). Takes NO props and reads no live state, so it can
// never render stale permit or KPI data. Purely decorative skeleton blocks are aria-hidden; a
// single role="status" element announces "Loading permit data" once. Nothing here is focusable.
// The table surface is the shared PermitTableSkeleton (also used by live search) — single source
// of that markup, no duplication.

import PermitTableSkeleton, { SkelBlock as Block, SKELETON_ROWS, TABLE_HEADERS } from './PermitTableSkeleton';

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

      {/* Permits-style table surface: shared with the live-search loading state. */}
      <PermitTableSkeleton />
    </div>
  );
}

export { SKELETON_ROWS, TABLE_HEADERS };
