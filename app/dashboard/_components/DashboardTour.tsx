'use client';
import { useEffect, useState } from 'react';
import { X, ChevronLeft, ChevronRight, MapPin, Target, Star, Search, BarChart3 } from 'lucide-react';

export const DASHBOARD_TOUR_VERSION = 1;
export type TourStep={id:string;title:string;body:string;selector?:string;icon:any};
export const TOUR_STEPS:TourStep[]=[
 {id:'welcome',title:'Turn permits into opportunities',body:'PermitMap helps you spot construction activity earlier, focus on the right projects, and build a working prospect list.',icon:Target},
 {id:'market',title:'Start with your market',body:'Your county sets the operating area. Locked markets stay visible so you know what additional coverage is available.',selector:'[data-tour="dashboard-tabs"]',icon:MapPin},
 {id:'opportunities',title:'Work the best opportunities first',body:'Opportunities ranks the projects most worth researching so you can spend less time digging through raw permit records.',selector:'[data-tour="tab-opportunities"]',icon:Target},
 {id:'search',title:'Research the exact project you want',body:'Use search, trade and date controls to narrow permit activity to the jobs that fit your business.',selector:'[data-tour="tab-permits"]',icon:Search},
 {id:'save',title:'Build your prospect list',body:'Star a useful permit to save it as a lead. Your saved list becomes the projects you can research and follow up on.',selector:'[data-tour="tab-saved"]',icon:Star},
 {id:'briefing',title:'Read the market, not just the rows',body:'Market intelligence and trends help you see where activity is moving so your prospecting has context.',selector:'[data-tour="tab-trends"]',icon:BarChart3},
];

export default function DashboardTour({open,onFinish,onTrack}:{open:boolean;onFinish:(state:'completed'|'dismissed')=>void;onTrack:(event:string,data?:Record<string,any>)=>void}){
 const [step,setStep]=useState(0); const current=TOUR_STEPS[step];
 useEffect(()=>{if(!open)return; setStep(0); onTrack('dashboard_tour_started',{version:DASHBOARD_TOUR_VERSION});},[open]);
 useEffect(()=>{if(!open||!current)return; onTrack('dashboard_tour_step_viewed',{version:DASHBOARD_TOUR_VERSION,step:current.id,index:step+1});
  if(current.selector){const el=document.querySelector(current.selector) as HTMLElement|null; el?.scrollIntoView({behavior:'smooth',block:'center'}); el?.classList.add('pm-tour-highlight'); return()=>el?.classList.remove('pm-tour-highlight');}
 },[open,step]);
 useEffect(()=>{if(!open)return; const key=(e:KeyboardEvent)=>{if(e.key==='Escape')finish('dismissed');}; document.addEventListener('keydown',key); return()=>document.removeEventListener('keydown',key);},[open]);
 if(!open)return null;
 const Icon=current.icon;
 const finish=(state:'completed'|'dismissed')=>{onTrack(state==='completed'?'dashboard_tour_completed':'dashboard_tour_skipped',{version:DASHBOARD_TOUR_VERSION,step:current.id});onFinish(state);};
 return <div role="dialog" aria-modal="true" aria-label="PermitMap dashboard tour" style={{position:'fixed',inset:0,zIndex:10000,background:'rgba(2,6,23,.62)',display:'flex',alignItems:'center',justifyContent:'center',padding:18}}>
  <div style={{width:'min(440px,100%)',background:'#0f172a',border:'1px solid #334155',borderRadius:18,boxShadow:'0 24px 80px rgba(0,0,0,.55)',overflow:'hidden'}}>
   <div style={{height:150,background:'linear-gradient(135deg,#0b3b32,#0f766e)',display:'flex',alignItems:'center',justifyContent:'center',position:'relative'}}>
    <div style={{width:76,height:76,borderRadius:20,background:'rgba(255,255,255,.12)',border:'1px solid rgba(255,255,255,.25)',display:'grid',placeItems:'center'}}><Icon size={38} color="#d1fae5"/></div>
    <button aria-label="Close tour" onClick={()=>finish('dismissed')} style={{position:'absolute',right:14,top:14,width:34,height:34,borderRadius:9,border:'1px solid rgba(255,255,255,.35)',background:'rgba(15,23,42,.65)',color:'#fff',cursor:'pointer'}}><X size={18}/></button>
   </div>
   <div style={{padding:'22px 24px 20px'}}>
    <div style={{fontSize:11,fontWeight:800,letterSpacing:'.08em',textTransform:'uppercase',color:'#34d399',marginBottom:8}}>{step+1} of {TOUR_STEPS.length}</div>
    <h2 style={{margin:'0 0 9px',fontSize:22,color:'#f8fafc',letterSpacing:'-.02em'}}>{current.title}</h2>
    <p style={{margin:0,color:'#cbd5e1',fontSize:14,lineHeight:1.65}}>{current.body}</p>
    <div style={{display:'flex',gap:6,marginTop:18}}>{TOUR_STEPS.map((_,i)=><span key={i} style={{height:4,flex:1,borderRadius:4,background:i<=step?'#34d399':'#334155'}}/>)}</div>
    <div style={{display:'flex',justifyContent:'space-between',gap:10,marginTop:22}}>
     <button onClick={()=>step?setStep(step-1):finish('dismissed')} style={{padding:'10px 14px',borderRadius:9,border:'1px solid #334155',background:'transparent',color:'#cbd5e1',fontWeight:700,cursor:'pointer',display:'flex',gap:6,alignItems:'center'}}>{step?<><ChevronLeft size={16}/>Back</>:'Skip for now'}</button>
     <button onClick={()=>step===TOUR_STEPS.length-1?finish('completed'):setStep(step+1)} style={{padding:'10px 18px',borderRadius:9,border:0,background:'#34d399',color:'#052e25',fontWeight:800,cursor:'pointer',display:'flex',gap:6,alignItems:'center'}}>{step===TOUR_STEPS.length-1?'Find opportunities':<>Next<ChevronRight size={16}/></>}</button>
    </div>
   </div>
  </div>
 </div>;
}
