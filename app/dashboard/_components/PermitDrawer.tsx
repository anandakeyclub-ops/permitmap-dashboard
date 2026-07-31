'use client';

import { Fragment, useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { PERMIT_DETAIL_FIELDS, formatPermitField } from '../../../lib/permitDetail';
import { getContractorName } from '../../../lib/contractorProfile';

// Read-only permit detail drawer. Renders fields already present on the loaded permit object
// (no fetch, no new data source). Reuses the existing modal overlay behavior (overlay-click +
// Escape close, X button); adds focus-in on open. Focus RETURN to the triggering row is handled
// by the parent via onClose. No routing/animation/editing — presentational only.
//
// The Contractor value is a button when a contractor name exists (opens the read-only Contractor
// Profile via onOpenContractor); it stays a plain em dash when absent. When the drawer re-opens
// after the profile closes, `focusContractorOnMount` returns focus to that button.
export default function PermitDrawer({
  permit, onClose, onOpenContractor, focusContractorOnMount,
}: {
  permit: Record<string, any>;
  onClose: () => void;
  onOpenContractor?: (contractorName: string) => void;
  focusContractorOnMount?: boolean;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const contractorBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    // Returning from the Contractor Profile → focus the contractor button; otherwise the panel.
    if (focusContractorOnMount && contractorBtnRef.current) contractorBtnRef.current.focus();
    else panelRef.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, focusContractorOnMount]);

  const contractorName = getContractorName(permit);

  return (
    <div onClick={onClose} className="pm-drawer-overlay">
      <style>{`
        .pm-drawer-overlay { position: fixed; inset: 0; background: rgba(2,6,23,0.72);
          z-index: 1000; display: flex; align-items: stretch; justify-content: flex-end; }
        .pm-drawer-panel { background: #0d1529; border-left: 1px solid #1e293b;
          width: 100%; max-width: 440px; height: 100vh; overflow-y: auto;
          padding: 22px 24px; box-shadow: -24px 0 64px rgba(0,0,0,0.55); outline: none; }
        .pm-drawer-grid { display: grid; grid-template-columns: 132px 1fr; gap: 10px 14px; }
        @media (max-width: 640px) { .pm-drawer-panel { max-width: 100%; } }
      `}</style>
      <div
        ref={panelRef}
        tabIndex={-1}
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Permit details"
        className="pm-drawer-panel"
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 800, color: '#f1f5f9', letterSpacing: '-0.02em' }}>
            Permit details
          </h2>
          <button onClick={onClose} aria-label="Close" style={{
            background: 'transparent', border: 'none', cursor: 'pointer', color: '#475569', padding: 4 }}>
            <X size={20} />
          </button>
        </div>

        <div className="pm-drawer-grid">
          {PERMIT_DETAIL_FIELDS.map(f => {
            const isContractor = f.label === 'Contractor';
            const interactive = isContractor && !!contractorName && !!onOpenContractor;
            return (
              <Fragment key={f.label}>
                <div style={{ fontSize: 11, color: '#64748b', fontWeight: 700,
                  textTransform: 'uppercase', letterSpacing: '0.05em', paddingTop: 2 }}>
                  {f.label}
                </div>
                <div style={{ fontSize: 13, color: '#e2e8f0', wordBreak: 'break-word', lineHeight: 1.5 }}>
                  {interactive ? (
                    <button
                      ref={contractorBtnRef}
                      type="button"
                      onClick={() => onOpenContractor!(formatPermitField(permit, f))}
                      aria-label={`View contractor profile for ${formatPermitField(permit, f)}`}
                      style={{
                        background: 'transparent', border: 'none', padding: 0, cursor: 'pointer',
                        font: 'inherit', color: '#93c5fd', textAlign: 'left',
                        textDecoration: 'underline', textUnderlineOffset: 2, wordBreak: 'break-word',
                      }}>
                      {formatPermitField(permit, f)}
                    </button>
                  ) : (
                    formatPermitField(permit, f)
                  )}
                </div>
              </Fragment>
            );
          })}
        </div>
      </div>
    </div>
  );
}
