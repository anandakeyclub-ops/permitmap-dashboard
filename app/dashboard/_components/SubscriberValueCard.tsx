'use client';

import { useEffect, useState } from 'react';
import { CreditCard, CheckCircle2, Circle, ArrowRight, ShieldCheck } from 'lucide-react';
import { apiFetch, getSavedLeads, type GetToken } from '../../../lib/api';
import { billingMessage, money, type SubscriptionSnapshot } from '../../../lib/subscription-summary';
import { nextValueAction } from '../../../lib/subscriberValue';

interface ActivationState {
  first_permit_drawer_open_at: string | null;
  first_csv_export_at: string | null;
  first_saved_lead_at: string | null;
  returned_next_day: boolean;
}

export default function SubscriberValueCard({
  getToken, tier, savedLeadCount, onOpportunities, onPermits, onSaved,
}: {
  getToken: GetToken;
  tier: string;
  savedLeadCount: number;
  onOpportunities: () => void;
  onPermits: () => void;
  onSaved: () => void;
}) {
  const [subscription, setSubscription] = useState<SubscriptionSnapshot | null>(null);
  const [activation, setActivation] = useState<ActivationState | null>(null);
  const [portalBusy, setPortalBusy] = useState(false);
  const [roi, setRoi] = useState<{won:number; quoted:number; worked:number} | null>(null);

  useEffect(() => {
    Promise.all([
      fetch('/api/subscription', { cache: 'no-store' }).then(r => r.ok ? r.json() : null),
      apiFetch('/analytics/activation', getToken).then(r => r.ok ? r.json() : null),
      getSavedLeads(getToken).catch(() => null),
    ]).then(([s, a, saved]) => {
      if (s) setSubscription(s);
      if (a) setActivation(a);
      if (saved?.leads) {
        const rows=saved.leads;
        setRoi({
          won: rows.filter((l:any)=>l.status==='won').reduce((n:number,l:any)=>n+(l.won_amount||0),0),
          quoted: rows.filter((l:any)=>l.status==='quoted').reduce((n:number,l:any)=>n+(l.quoted_amount||0),0),
          worked: rows.filter((l:any)=>['called','quoted','won'].includes(l.status)).length,
        });
      }
    }).catch(() => {});
  }, [getToken]);

  async function manageBilling() {
    setPortalBusy(true);
    try {
      const r = await fetch('/api/billing-portal', { method: 'POST' });
      const data = await r.json();
      if (r.ok && data.url) window.location.href = data.url;
    } finally {
      setPortalBusy(false);
    }
  }

  const tasks = [
    { done: !!activation?.first_permit_drawer_open_at, label: 'Review a top opportunity', action: onOpportunities },
    { done: savedLeadCount > 0 || !!activation?.first_saved_lead_at, label: 'Save your first lead', action: onOpportunities },
    { done: !!activation?.first_csv_export_at, label: 'Export a call list', action: onPermits },
    { done: !!activation?.returned_next_day, label: 'Return after your next delivery', action: onSaved },
  ];
  const completed = tasks.filter(t => t.done).length;
  const next = nextValueAction(activation, savedLeadCount);
  const nextAction = next.action === 'saved' ? onSaved : next.action === 'permits' ? onPermits : onOpportunities;

  return (
    <section aria-label="Subscription and value progress" style={{
      background: '#101816', border: '1px solid #23312d', borderRadius: 14,
      padding: '18px 20px', marginBottom: 24,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 20, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 240, flex: '1 1 280px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 8 }}>
            <ShieldCheck size={18} color="#22c55e" />
            <strong style={{ color: '#f1f5f9', textTransform: 'capitalize' }}>
              PermitMap {subscription?.plan || tier}
            </strong>
            {subscription && (
              <span style={{ color: '#94a3b8', fontSize: 12 }}>
                {money(subscription.amount, subscription.currency)}/month
              </span>
            )}
          </div>
          <p style={{ color: '#94a3b8', fontSize: 13, lineHeight: 1.55, margin: '0 0 10px' }}>
            {subscription ? billingMessage(subscription) : 'Your subscription includes dashboard access and recurring permit delivery.'}
          </p>
          <p style={{ color: '#64748b', fontSize: 12, lineHeight: 1.5, margin: '0 0 12px' }}>
            Your email is the weekly summary. The dashboard is where you rank, filter, save,
            export, and track the permits worth working.
          </p>
          {roi && (roi.worked>0 || roi.quoted>0 || roi.won>0) && <div style={{display:'grid',gridTemplateColumns:'repeat(3,minmax(0,1fr))',gap:8,margin:'0 0 14px'}}>
            <div style={{background:'#0c1211',border:'1px solid #23312d',borderRadius:8,padding:'9px 10px'}}><strong style={{display:'block',fontSize:16,color:'#f8fafc'}}>{roi.worked}</strong><span style={{fontSize:10.5,color:'#64748b'}}>Leads worked</span></div>
            <div style={{background:'#0c1211',border:'1px solid #23312d',borderRadius:8,padding:'9px 10px'}}><strong style={{display:'block',fontSize:16,color:'#f8fafc'}}>{'$'}{roi.quoted.toLocaleString()}</strong><span style={{fontSize:10.5,color:'#64748b'}}>Open quotes</span></div>
            <div style={{background:'rgba(34,197,94,.07)',border:'1px solid #22c55e40',borderRadius:8,padding:'9px 10px'}}><strong style={{display:'block',fontSize:16,color:'#86efac'}}>{'$'}{roi.won.toLocaleString()}</strong><span style={{fontSize:10.5,color:'#64748b'}}>Won revenue tracked</span></div>
          </div>}
          {roi && roi.won>0 && subscription?.amount && <div style={{fontSize:11,color:'#94a3b8',lineHeight:1.45,margin:'-4px 0 12px'}}>Tracked won revenue is <strong style={{color:'#86efac'}}>{(roi.won/subscription.amount).toFixed(1)}×</strong> the current monthly subscription amount. This is customer-entered won revenue, not an attribution claim that PermitMap caused the sale.</div>}
          {subscription && (
            <button onClick={manageBilling} disabled={portalBusy} className="pm-btn-secondary">
              <CreditCard size={14} /> {portalBusy ? 'Opening…' : 'Manage billing'}
            </button>
          )}
        </div>

        <div style={{ minWidth: 280, flex: '1 1 360px' }}>
          <div style={{ background: '#0c1211', border: '1px solid #34d39955', borderRadius: 10, padding: '12px 14px', marginBottom: 14 }}>
            <div style={{ color: '#6ee7b7', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 5 }}>Your next move</div>
            <strong style={{ color: '#f1f5f9', fontSize: 14 }}>{next.title}</strong>
            <p style={{ color: '#94a3b8', fontSize: 12, lineHeight: 1.5, margin: '5px 0 9px' }}>{next.detail}</p>
            <button onClick={nextAction} className="pm-btn-secondary">{next.cta} <ArrowRight size={14} /></button>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
            <strong style={{ color: '#e2e8f0', fontSize: 13 }}>Get value from this week</strong>
            <span style={{ color: completed === tasks.length ? '#22c55e' : '#34d399', fontSize: 12 }}>
              {completed}/{tasks.length} complete
            </span>
          </div>
          <div style={{ display: 'grid', gap: 7 }}>
            {tasks.map(task => (
              <button key={task.label} onClick={task.action} style={{
                display: 'flex', alignItems: 'center', gap: 9, width: '100%', textAlign: 'left',
                background: 'transparent', border: 0, padding: '4px 0', cursor: 'pointer',
                color: task.done ? '#94a3b8' : '#e2e8f0', fontSize: 13,
              }}>
                {task.done ? <CheckCircle2 size={16} color="#22c55e" /> : <Circle size={16} color="#475569" />}
                <span style={{ textDecoration: task.done ? 'line-through' : 'none' }}>{task.label}</span>
                {!task.done && <ArrowRight size={14} color="#34d399" style={{ marginLeft: 'auto' }} />}
              </button>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
