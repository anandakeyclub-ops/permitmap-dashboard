'use client';
import { useEffect, useMemo, useState } from 'react';
import { CalendarClock, Target, DollarSign, ArrowRight } from 'lucide-react';
import { getSavedLeads, type GetToken } from '../../../lib/api';
import type { SavedLead } from '../../../lib/types';

export default function TodayCommandCenter({getToken, scoredCount, onOpportunities, onSaved}:{getToken:GetToken;scoredCount:number;onOpportunities:()=>void;onSaved:()=>void}) {
 const [leads,setLeads]=useState<SavedLead[]>([]);
 useEffect(()=>{let dead=false;getSavedLeads(getToken).then(d=>{if(!dead)setLeads(d.leads||[])}).catch(()=>{});return()=>{dead=true}},[getToken]);
 const x=useMemo(()=>{const now=new Date();const start=new Date(now);start.setHours(0,0,0,0);const end=new Date(start);end.setDate(end.getDate()+1);
  const open=leads.filter(l=>l.status!=='won'&&l.status!=='lost');
  const overdue=open.filter(l=>l.follow_up_at&&new Date(l.follow_up_at)<start).length;
  const due=open.filter(l=>l.follow_up_at&&new Date(l.follow_up_at)>=start&&new Date(l.follow_up_at)<end).length;
  const quotes=open.filter(l=>l.status==='quoted'); const quoteValue=quotes.reduce((s,l)=>s+(l.quoted_amount||0),0);
  const won=leads.filter(l=>l.status==='won').reduce((s,l)=>s+(l.won_amount||0),0);
  return {overdue,due,quotes:quotes.length,quoteValue,won};},[leads]);
 const money=(n:number)=>'$'+n.toLocaleString(undefined,{maximumFractionDigits:0});
 return <section aria-label="Today command center" style={{background:'#0d1529',border:'1px solid #22c55e44',borderRadius:14,padding:'16px 18px',marginBottom:24}}>
  <div style={{display:'flex',justifyContent:'space-between',gap:12,alignItems:'center',flexWrap:'wrap',marginBottom:12}}><div><div style={{fontSize:11,fontWeight:800,color:'#22c55e',textTransform:'uppercase',letterSpacing:'.08em'}}>Today</div><strong style={{fontSize:17,color:'#f1f5f9'}}>What moves the next job forward?</strong></div><button className="pm-btn-secondary" onClick={onSaved}>Open work queue <ArrowRight size={14}/></button></div>
  <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(145px,1fr))',gap:10}}>
   <button onClick={onSaved} style={card}><CalendarClock size={16}/><strong>{x.overdue}</strong><span>Overdue follow-ups</span></button>
   <button onClick={onSaved} style={card}><CalendarClock size={16}/><strong>{x.due}</strong><span>Due today</span></button>
   <button onClick={onOpportunities} style={card}><Target size={16}/><strong>{scoredCount}</strong><span>Fresh opportunities</span></button>
   <button onClick={onSaved} style={card}><DollarSign size={16}/><strong>{x.quotes}</strong><span>Open quotes · {money(x.quoteValue)}</span></button>
   <button onClick={onSaved} style={card}><DollarSign size={16}/><strong>{money(x.won)}</strong><span>Won revenue tracked</span></button>
  </div>
 </section>;
}
const card:React.CSSProperties={display:'grid',gridTemplateColumns:'20px 1fr',columnGap:6,rowGap:2,textAlign:'left',background:'#111827',border:'1px solid #1e293b',borderRadius:9,padding:'10px 12px',color:'#94a3b8',cursor:'pointer'};
