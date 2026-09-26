'use client';
import { useEffect, useMemo, useState } from 'react';
import { CalendarClock, Target, DollarSign, ArrowRight, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { getSavedLeads, type GetToken } from '../../../lib/api';
import type { SavedLead } from '../../../lib/types';

export default function TodayCommandCenter({getToken,scoredCount,onOpportunities,onSaved}:{getToken:GetToken;scoredCount:number;onOpportunities:()=>void;onSaved:()=>void}) {
 const [leads,setLeads]=useState<SavedLead[]>([]);
 useEffect(()=>{let dead=false;getSavedLeads(getToken).then(d=>{if(!dead)setLeads(d.leads||[])}).catch(()=>{});return()=>{dead=true}},[getToken]);
 const x=useMemo(()=>{const now=new Date(),start=new Date(now);start.setHours(0,0,0,0);const end=new Date(start);end.setDate(end.getDate()+1);
  const open=leads.filter(l=>l.status!=='won'&&l.status!=='lost');
  const overdue=open.filter(l=>l.follow_up_at&&new Date(l.follow_up_at)<start).length;
  const due=open.filter(l=>l.follow_up_at&&new Date(l.follow_up_at)>=start&&new Date(l.follow_up_at)<end).length;
  const quotes=open.filter(l=>l.status==='quoted'),quoteValue=quotes.reduce((s,l)=>s+(l.quoted_amount||0),0);
  const won=leads.filter(l=>l.status==='won').reduce((s,l)=>s+(l.won_amount||0),0);
  return {overdue,due,quotes:quotes.length,quoteValue,won,open:open.length};},[leads]);
 const money=(n:number)=>'$'+n.toLocaleString(undefined,{maximumFractionDigits:0});
 const urgent=x.overdue+x.due;
 const headline=urgent>0?`${urgent} follow-up${urgent===1?'':'s'} need attention`:scoredCount>0?`${scoredCount} ranked opportunities ready to review`:'Your work queue is clear';
 const sub=urgent>0?'Protect the leads you already earned before chasing the next one.':scoredCount>0?'Start with the highest-ranked permit and work down the queue.':'PermitMap will surface the next actions as new permits and follow-ups arrive.';
 return <section aria-label="Today command center" style={{background:'linear-gradient(135deg,rgba(52,211,153,.09),#101816 62%)',border:'1px solid #34d39940',borderRadius:14,padding:'20px 22px',marginBottom:24,boxShadow:'0 14px 34px rgba(0,0,0,.18)'}}>
  <div style={{display:'flex',justifyContent:'space-between',gap:18,alignItems:'flex-start',flexWrap:'wrap',marginBottom:16}}>
   <div style={{maxWidth:650}}><div style={{fontSize:10,fontWeight:850,color:'#34d399',textTransform:'uppercase',letterSpacing:'.12em',marginBottom:5}}>Today · contractor command center</div><strong style={{display:'block',fontSize:21,color:'#f8fafc',letterSpacing:'-.02em',marginBottom:5}}>{headline}</strong><span style={{fontSize:13,color:'#94a3b8',lineHeight:1.5}}>{sub}</span></div>
   <button onClick={urgent>0?onSaved:onOpportunities} style={{display:'inline-flex',alignItems:'center',gap:7,background:'#34d399',color:'#062018',border:0,borderRadius:8,padding:'10px 15px',fontWeight:800,cursor:'pointer'}}>{urgent>0?'Work follow-ups':'Review opportunities'} <ArrowRight size={14}/></button>
  </div>
  <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(155px,1fr))',gap:10}}>
   <Metric icon={x.overdue>0?AlertTriangle:CheckCircle2} value={String(x.overdue)} label="Overdue follow-ups" hot={x.overdue>0} onClick={onSaved}/>
   <Metric icon={CalendarClock} value={String(x.due)} label="Due today" hot={x.due>0} onClick={onSaved}/>
   <Metric icon={Target} value={String(scoredCount)} label="Ranked opportunities" onClick={onOpportunities}/>
   <Metric icon={DollarSign} value={String(x.quotes)} label={`Open quotes · ${money(x.quoteValue)}`} onClick={onSaved}/>
   <Metric icon={DollarSign} value={money(x.won)} label="Won revenue tracked" positive={x.won>0} onClick={onSaved}/>
  </div>
 </section>;
}
function Metric({icon:Icon,value,label,onClick,hot=false,positive=false}:{icon:any;value:string;label:string;onClick:()=>void;hot?:boolean;positive?:boolean}){
 const accent=hot?'#f59e0b':positive?'#22c55e':'#34d399';
 return <button onClick={onClick} style={{textAlign:'left',background:'#0c1211',border:'1px solid #23312d',borderRadius:10,padding:'12px 13px',color:'#94a3b8',cursor:'pointer',minHeight:78}}>
  <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:7}}><Icon size={15} color={accent}/><span style={{fontSize:10,color:'#64748b',textTransform:'uppercase',letterSpacing:'.05em'}}>Open →</span></div>
  <strong style={{display:'block',fontSize:20,lineHeight:1.1,color:'#f8fafc',marginBottom:4}}>{value}</strong><span style={{fontSize:11.5,lineHeight:1.35}}>{label}</span>
 </button>;
}
