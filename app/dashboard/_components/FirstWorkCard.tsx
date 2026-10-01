'use client';

import { useEffect, useMemo, useState } from 'react';
import { getSavedLeads, updateSavedLead, type GetToken } from '../../../lib/api';
import type { SavedLead } from '../../../lib/types';

export default function FirstWorkCard({getToken}:{getToken:GetToken}) {
  const [leads,setLeads]=useState<SavedLead[]>([]);
  const [working,setWorking]=useState<string|null>(null);
  useEffect(()=>{let dead=false;getSavedLeads(getToken).then(x=>{if(!dead)setLeads(x.leads||[])}).catch(()=>{});return()=>{dead=true}},[getToken]);
  const lead=useMemo(()=>leads.filter(x=>x.status==='saved').slice().sort((a,b)=>(b.score??-1)-(a.score??-1))[0]||null,[leads]);
  if(!lead)return null;
  const markCalled=async()=>{if(working)return;setWorking(lead.id);try{const x=await updateSavedLead(getToken,lead.id,'called');setLeads(rows=>rows.map(r=>r.id===lead.id?x.lead:r));}finally{setWorking(null)}};
  return <section aria-label="First work action" style={{background:'#0c1211',border:'1px solid #34d39955',borderRadius:10,padding:'13px 14px',marginBottom:14,display:'flex',justifyContent:'space-between',gap:14,alignItems:'center',flexWrap:'wrap'}}>
    <div><div style={{fontSize:10,fontWeight:800,color:'#6ee7b7',textTransform:'uppercase',letterSpacing:'.08em',marginBottom:4}}>Work your strongest saved lead</div><strong style={{color:'#f8fafc',fontSize:14}}>{lead.address||lead.county}</strong><div style={{fontSize:11,color:'#94a3b8',marginTop:4}}>{lead.trade||'Permit opportunity'}{lead.score!=null?' · score '+lead.score:''}</div></div>
    <button onClick={markCalled} disabled={!!working} style={{background:'#2563eb',color:'#fff',border:0,borderRadius:8,padding:'9px 13px',fontWeight:800,cursor:working?'wait':'pointer'}}>{working?'Saving…':'I called this lead'}</button>
  </section>;
}
