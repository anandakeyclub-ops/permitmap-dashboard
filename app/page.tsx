'use client';

import { useEffect, useState } from 'react';
import { useUser } from '@clerk/nextjs';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  Cell, LineChart, Line, Legend
} from 'recharts';
import {
  MapPin, TrendingUp, Zap, Building2, Target, Star,
  Lock, Bookmark, BookmarkCheck, Eye, ArrowUp, ArrowDown,
  Mail, ChevronDown, ChevronUp, Info
} from 'lucide-react';

const API = process.env.NEXT_PUBLIC_API_URL || 'https://permitmap-api.onrender.com';

const TIER_LIMITS: Record<string, { counties: number; permits: number; label: string }> = {
  starter: { counties: 1, permits: 50,  label: 'Starter' },
  pro:     { counties: 5, permits: 500, label: 'Pro' },
  team:    { counties: 99, permits: 9999, label: 'Team' },
};

const TRADE_COLORS: Record<string, string> = {
  roofing: '#ef4444', hvac: '#f97316', electrical: '#eab308',
  plumbing: '#3b82f6', pool: '#06b6d4', solar: '#22c55e',
  general_contractor: '#8b5cf6',
};

const SCORE_COLOR = (s: number) =>
  s >= 80 ? '#22c55e' : s >= 60 ? '#f97316' : s >= 40 ? '#eab308' : '#6b7280';

const TAG_COLORS: Record<string, string> = {
  saved: '#3b82f6', hot: '#ef4444', 'follow-up': '#f97316', contacted: '#22c55e',
};

export default function Dashboard() {
  const { user } = useUser();
  const tier   = (user?.publicMetadata?.tier as string) || 'starter';
  const limits = TIER_LIMITS[tier] || TIER_LIMITS.starter;
  const userId = user?.id || 'anonymous';

  const [counties, setCounties]     = useState<any[]>([]);
  const [county, setCounty]         = useState('palm_beach');
  const [summary, setSummary]       = useState<any>(null);
  const [permits, setPermits]       = useState<any[]>([]);
  const [trends, setTrends]         = useState<any>(null);
  const [digest, setDigest]         = useState<any>(null);
  const [heatmap, setHeatmap]       = useState<any[]>([]);
  const [saved, setSaved]           = useState<any[]>([]);
  const [loading, setLoading]       = useState(true);
  const [activeTab, setActiveTab]   = useState<'permits'|'trends'|'insights'|'saved'|'digest'>('permits');
  const [tradeFilter, setTradeFilter] = useState('');
  const [explainPermit, setExplainPermit] = useState<string | null>(null);

  // Load counties
  useEffect(() => {
    fetch(`${API}/counties`).then(r=>r.json()).then(d=>setCounties(d.counties||[])).catch(()=>{});
    fetch(`${API}/saved/${userId}`).then(r=>r.json()).then(d=>setSaved(d.saved||[])).catch(()=>{});
  }, [userId]);

  // Load data when county changes
  useEffect(() => {
    setLoading(true);
    Promise.all([
      fetch(`${API}/summary?county=${county}`).then(r=>r.json()),
      fetch(`${API}/permits?county=${county}&limit=${limits.permits}&explain=true`).then(r=>r.json()),
      fetch(`${API}/trends?county=${county}&weeks=6`).then(r=>r.json()),
      fetch(`${API}/digest?county=${county}&trade=${tradeFilter||''}`).then(r=>r.json()),
      fetch(`${API}/heatmap?county=${county}`).then(r=>r.json()),
    ]).then(([s, p, t, d, h]) => {
      setSummary(s); setPermits(p.permits||[]); setTrends(t);
      setDigest(d); setHeatmap(h.zips||[]);
      setLoading(false);
    }).catch(()=>setLoading(false));
  }, [county, limits.permits]);

  const filteredPermits = tradeFilter ? permits.filter(p=>p.trade===tradeFilter) : permits;

  const tradeChartData = summary?.trade_breakdown
    ? Object.entries(summary.trade_breakdown).map(([t,c])=>({
        trade: t.replace('_',' '), count: c as number, fill: TRADE_COLORS[t]||'#6b7280'
      })) : [];

  const trendChartData = trends?.weeks_data?.slice(0,6).reverse().map((w:any)=>({
    week: w.week==='current' ? 'Now' : w.week.replace('2026-',''),
    roofing: w.by_trade?.roofing?.count||0,
    hvac: w.by_trade?.hvac?.count||0,
    pool: w.by_trade?.pool?.count||0,
    solar: w.by_trade?.solar?.count||0,
    electrical: w.by_trade?.electrical?.count||0,
    plumbing: w.by_trade?.plumbing?.count||0,
  })) || [];

  const wow = summary?.wow;

  const handleSave = async (permit: any, tag: string = 'saved') => {
    const pno = permit.PERMITNO;
    const already = saved.find(s=>s.PERMITNO===pno);
    if (already && already._tag === tag) {
      await fetch(`${API}/saved/${userId}/${pno}`, {method:'DELETE'});
      setSaved(saved.filter(s=>s.PERMITNO!==pno));
    } else {
      await fetch(`${API}/saved/${userId}`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({permit,tag})});
      setSaved([...saved.filter(s=>s.PERMITNO!==pno), {...permit,_tag:tag}]);
    }
  };

  const isSaved = (pno: string) => saved.some(s=>s.PERMITNO===pno);
  const getSavedTag = (pno: string) => saved.find(s=>s.PERMITNO===pno)?._tag;

  return (
    <div style={{minHeight:'100vh',background:'#0a0f1e',color:'#e2e8f0',fontFamily:"'DM Sans','Helvetica Neue',sans-serif"}}>

      {/* Header */}
      <header style={{borderBottom:'1px solid #1e293b',padding:'0 32px',height:60,display:'flex',alignItems:'center',justifyContent:'space-between',background:'#0d1529',position:'sticky',top:0,zIndex:50}}>
        <div style={{display:'flex',alignItems:'center',gap:12}}>
          <MapPin size={22} color="#3b82f6"/>
          <span style={{fontWeight:700,fontSize:18,letterSpacing:'-0.02em'}}>
            permit<span style={{color:'#3b82f6'}}>map</span>
          </span>
          <span style={{background:'#1e3a5f',color:'#60a5fa',fontSize:11,fontWeight:600,padding:'2px 8px',borderRadius:4,textTransform:'uppercase',letterSpacing:'0.05em'}}>{limits.label}</span>
          {summary?.weeks_available > 0 && (
            <span style={{background:'#14532d',color:'#4ade80',fontSize:11,fontWeight:600,padding:'2px 8px',borderRadius:4}}>
              {summary.weeks_available}w history
            </span>
          )}
        </div>
        <div style={{display:'flex',alignItems:'center',gap:16}}>
          <span style={{fontSize:13,color:'#64748b'}}>{user?.emailAddresses?.[0]?.emailAddress}</span>
          {tier==='starter' && <a href="/pricing" style={{background:'#2563eb',color:'#fff',fontSize:12,fontWeight:600,padding:'6px 14px',borderRadius:6,textDecoration:'none'}}>Upgrade →</a>}
        </div>
      </header>

      <div style={{display:'flex',height:'calc(100vh - 60px)'}}>

        {/* Sidebar */}
        <aside style={{width:220,borderRight:'1px solid #1e293b',padding:'20px 0',overflowY:'auto',flexShrink:0,background:'#0d1529'}}>
          <div style={{padding:'0 16px 12px',fontSize:10,fontWeight:700,color:'#475569',textTransform:'uppercase',letterSpacing:'0.1em'}}>Counties</div>
          {counties.map((c,i)=>{
            const locked=i>=limits.counties; const active=c.key===county;
            return (
              <button key={c.key} onClick={()=>!locked&&setCounty(c.key)} style={{width:'100%',textAlign:'left',padding:'10px 16px',background:active?'#1e3a5f':'transparent',border:'none',cursor:locked?'not-allowed':'pointer',display:'flex',alignItems:'center',justifyContent:'space-between',opacity:locked?0.4:1,borderLeft:active?'3px solid #3b82f6':'3px solid transparent'}}>
                <div>
                  <span style={{fontSize:13,color:active?'#93c5fd':'#94a3b8',fontWeight:active?600:400,display:'block'}}>{c.label}</span>
                  {c.weeks_history > 0 && <span style={{fontSize:10,color:'#475569'}}>{c.weeks_history}w history</span>}
                </div>
                {locked ? <Lock size={12} color="#475569"/> : <span style={{fontSize:11,color:'#475569'}}>{c.count}</span>}
              </button>
            );
          })}
          {tier!=='team' && (
            <div style={{margin:'16px',padding:'12px',background:'#1e293b',borderRadius:8,textAlign:'center'}}>
              <p style={{fontSize:11,color:'#64748b',margin:'0 0 8px'}}>{limits.counties===1?'Upgrade for 5 counties':'Upgrade for all counties'}</p>
              <a href="/pricing" style={{fontSize:11,color:'#3b82f6',fontWeight:600}}>Upgrade →</a>
            </div>
          )}
        </aside>

        {/* Main */}
        <main style={{flex:1,overflowY:'auto',padding:'28px 32px'}}>
          {loading ? (
            <div style={{display:'flex',alignItems:'center',justifyContent:'center',height:'60vh',flexDirection:'column',gap:12}}>
              <div style={{width:40,height:40,border:'3px solid #1e293b',borderTop:'3px solid #3b82f6',borderRadius:'50%',animation:'spin 1s linear infinite'}}/>
              <span style={{color:'#475569',fontSize:13}}>Loading permit intelligence...</span>
            </div>
          ) : !summary ? <div style={{color:'#ef4444'}}>Failed to load data.</div> : (
            <>
              {/* Header */}
              <div style={{marginBottom:24,display:'flex',alignItems:'flex-start',justifyContent:'space-between'}}>
                <div>
                  <h1 style={{fontSize:24,fontWeight:700,margin:0,letterSpacing:'-0.03em',color:'#f1f5f9'}}>{summary.label}</h1>
                  <p style={{color:'#475569',fontSize:13,margin:'4px 0 0'}}>Week of {summary.week_of} · {summary.kpis?.total_permits} permits issued</p>
                </div>
                {/* WoW badge */}
                {wow?.total_pct !== undefined && (
                  <div style={{display:'flex',alignItems:'center',gap:6,background:wow.total_pct>=0?'#14532d20':'#7f1d1d20',border:`1px solid ${wow.total_pct>=0?'#22c55e40':'#ef444440'}`,borderRadius:8,padding:'8px 14px'}}>
                    {wow.total_pct>=0 ? <ArrowUp size={14} color="#22c55e"/> : <ArrowDown size={14} color="#ef4444"/>}
                    <span style={{fontSize:13,fontWeight:600,color:wow.total_pct>=0?'#22c55e':'#ef4444'}}>{Math.abs(wow.total_pct)}% vs last week</span>
                  </div>
                )}
              </div>

              {/* KPI Cards */}
              <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:16,marginBottom:28}}>
                {[
                  {label:'Total Permits',value:summary.kpis?.total_permits,icon:Building2,color:'#3b82f6'},
                  {label:'High Value (50k+)',value:summary.kpis?.high_value_count,icon:TrendingUp,color:'#22c55e'},
                  {label:'Avg Project Value',value:`$${(summary.kpis?.avg_value||0).toLocaleString(undefined,{maximumFractionDigits:0})}`,icon:Zap,color:'#f97316'},
                  {label:'Top Trade',value:(summary.kpis?.top_trade||'').replace('_',' '),icon:Target,color:'#8b5cf6'},
                ].map(({label,value,icon:Icon,color})=>(
                  <div key={label} style={{background:'#111827',border:'1px solid #1e293b',borderRadius:12,padding:'20px 24px',borderTop:`3px solid ${color}`}}>
                    <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:8}}>
                      <Icon size={16} color={color}/>
                      <span style={{fontSize:11,color:'#475569',textTransform:'uppercase',letterSpacing:'0.08em',fontWeight:600}}>{label}</span>
                    </div>
                    <div style={{fontSize:26,fontWeight:700,color:'#f1f5f9',letterSpacing:'-0.02em',textTransform:'capitalize'}}>{value??'—'}</div>
                  </div>
                ))}
              </div>

              {/* Smart targeting */}
              {summary.targeting?.recommendation && (
                <div style={{background:'linear-gradient(135deg,#1e3a5f 0%,#1e293b 100%)',border:'1px solid #2563eb40',borderRadius:12,padding:'16px 20px',display:'flex',alignItems:'center',gap:12,marginBottom:28}}>
                  <Target size={20} color="#3b82f6" style={{flexShrink:0}}/>
                  <div>
                    <div style={{fontSize:11,color:'#60a5fa',fontWeight:600,textTransform:'uppercase',letterSpacing:'0.08em',marginBottom:2}}>Smart Targeting</div>
                    <div style={{fontSize:14,color:'#e2e8f0'}}>{summary.targeting.recommendation}</div>
                    {summary.targeting.top_opportunity?.owner && (
                      <div style={{fontSize:12,color:'#64748b',marginTop:4}}>Owner: {summary.targeting.top_opportunity.owner}</div>
                    )}
                  </div>
                </div>
              )}

              {/* Tabs */}
              <div style={{display:'flex',gap:4,marginBottom:20,borderBottom:'1px solid #1e293b'}}>
                {(['permits','trends','insights','saved','digest'] as const).map(tab=>(
                  <button key={tab} onClick={()=>setActiveTab(tab)} style={{padding:'8px 18px',background:'none',border:'none',cursor:'pointer',fontSize:13,fontWeight:600,color:activeTab===tab?'#3b82f6':'#475569',borderBottom:activeTab===tab?'2px solid #3b82f6':'2px solid transparent',textTransform:'capitalize',marginBottom:-1,display:'flex',alignItems:'center',gap:6}}>
                    {tab==='saved' && <Bookmark size={13}/>}
                    {tab==='digest' && <Mail size={13}/>}
                    {tab}
                    {tab==='saved' && saved.length>0 && <span style={{background:'#2563eb',color:'#fff',fontSize:10,fontWeight:700,padding:'1px 5px',borderRadius:10}}>{saved.length}</span>}
                  </button>
                ))}
              </div>

              {/* PERMITS TAB */}
              {activeTab==='permits' && (
                <>
                  <div style={{display:'flex',gap:8,marginBottom:16,flexWrap:'wrap'}}>
                    {['','roofing','hvac','electrical','plumbing','pool','solar','general_contractor'].map(t=>(
                      <button key={t} onClick={()=>setTradeFilter(t)} style={{padding:'5px 12px',borderRadius:20,border:`1px solid ${tradeFilter===t?(TRADE_COLORS[t]||'#3b82f6'):'#1e293b'}`,background:tradeFilter===t?`${TRADE_COLORS[t]||'#2563eb'}20`:'transparent',color:tradeFilter===t?(TRADE_COLORS[t]||'#3b82f6'):'#64748b',fontSize:12,fontWeight:600,cursor:'pointer',textTransform:'capitalize'}}>
                        {t||'All Trades'}
                      </button>
                    ))}
                  </div>

                  <div style={{background:'#111827',border:'1px solid #1e293b',borderRadius:12,overflow:'hidden'}}>
                    <table style={{width:'100%',borderCollapse:'collapse'}}>
                      <thead>
                        <tr style={{borderBottom:'1px solid #1e293b'}}>
                          {['Score','Address','Owner','Type','Trade','Value','Date','Save'].map(h=>(
                            <th key={h} style={{padding:'12px 16px',textAlign:'left',fontSize:11,color:'#475569',fontWeight:700,textTransform:'uppercase',letterSpacing:'0.06em'}}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {filteredPermits.slice(0,50).map((p,i)=>(
                          <tr key={i} style={{borderBottom:'1px solid #0f172a',background:i%2===0?'#111827':'#0d1529'}}>
                            <td style={{padding:'10px 16px'}}>
                              <div style={{display:'inline-flex',alignItems:'center',justifyContent:'center',width:36,height:36,borderRadius:'50%',background:`${SCORE_COLOR(p.score)}20`,border:`2px solid ${SCORE_COLOR(p.score)}`,fontSize:12,fontWeight:700,color:SCORE_COLOR(p.score),cursor:'pointer',position:'relative'}}
                                onClick={()=>setExplainPermit(explainPermit===p.PERMITNO?null:p.PERMITNO)}>
                                {p.score}
                              </div>
                              {/* Score explanation dropdown */}
                              {explainPermit===p.PERMITNO && p.score_breakdown && (
                                <div style={{position:'absolute',zIndex:100,background:'#1e293b',border:'1px solid #334155',borderRadius:8,padding:'12px',marginTop:4,minWidth:220,fontSize:12}}>
                                  <div style={{fontWeight:700,color:'#f1f5f9',marginBottom:8}}>Score breakdown</div>
                                  {Object.entries(p.score_breakdown).map(([k,v]:any)=>(
                                    <div key={k} style={{display:'flex',justifyContent:'space-between',marginBottom:4,color:'#94a3b8'}}>
                                      <span style={{textTransform:'capitalize'}}>{k}</span>
                                      <span style={{color:'#3b82f6',fontWeight:600}}>{v.pts}/{v.max} — {v.reason}</span>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </td>
                            <td style={{padding:'10px 16px',fontSize:13,color:'#e2e8f0',maxWidth:180,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{p.FULL_ADDRESS||'—'}</td>
                            <td style={{padding:'10px 16px',fontSize:12,color:'#94a3b8',maxWidth:140,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{p.OWNER_NAME||'—'}</td>
                            <td style={{padding:'10px 16px',fontSize:12,color:'#94a3b8',maxWidth:140,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{p.RECORD_TYPE||p.PERMIT_DESCRIPTION||'—'}</td>
                            <td style={{padding:'10px 16px'}}>
                              <span style={{fontSize:11,fontWeight:600,padding:'3px 8px',borderRadius:4,textTransform:'capitalize',background:`${TRADE_COLORS[p.trade]||'#475569'}20`,color:TRADE_COLORS[p.trade]||'#94a3b8'}}>{(p.trade||'').replace('_',' ')}</span>
                            </td>
                            <td style={{padding:'10px 16px',fontSize:13,color:'#22c55e',fontWeight:600}}>
                              {p.FINAL_VALUATION ? `$${parseFloat((p.FINAL_VALUATION).replace(/[^0-9.]/g,'')||'0').toLocaleString()}` : '—'}
                            </td>
                            <td style={{padding:'10px 16px',fontSize:12,color:'#64748b'}}>{p.LAST_ISSUED_DATE||'—'}</td>
                            <td style={{padding:'10px 16px'}}>
                              <div style={{display:'flex',gap:4}}>
                                {['saved','hot','follow-up'].map(tag=>(
                                  <button key={tag} onClick={()=>handleSave(p,tag)} title={tag} style={{background:getSavedTag(p.PERMITNO)===tag?`${TAG_COLORS[tag]}20`:'transparent',border:`1px solid ${getSavedTag(p.PERMITNO)===tag?TAG_COLORS[tag]:'#1e293b'}`,borderRadius:4,padding:'3px 6px',cursor:'pointer',fontSize:10,color:getSavedTag(p.PERMITNO)===tag?TAG_COLORS[tag]:'#475569',fontWeight:600}}>
                                    {tag==='saved'?'★':tag==='hot'?'🔥':'↩'}
                                  </button>
                                ))}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {filteredPermits.length===0 && <div style={{padding:40,textAlign:'center',color:'#475569'}}>No permits found.</div>}
                    {tier==='starter' && permits.length>=50 && (
                      <div style={{padding:'16px 20px',background:'#1e293b',borderTop:'1px solid #1e293b',display:'flex',alignItems:'center',justifyContent:'space-between'}}>
                        <div style={{display:'flex',alignItems:'center',gap:8}}><Lock size={14} color="#475569"/><span style={{fontSize:12,color:'#64748b'}}>{permits.length-50} more permits on Pro</span></div>
                        <a href="/pricing" style={{fontSize:12,color:'#3b82f6',fontWeight:600}}>Upgrade →</a>
                      </div>
                    )}
                  </div>
                </>
              )}

              {/* TRENDS TAB */}
              {activeTab==='trends' && (
                <div style={{display:'flex',flexDirection:'column',gap:20}}>
                  {/* WoW breakdown */}
                  {wow?.by_trade && (
                    <div style={{background:'#111827',border:'1px solid #1e293b',borderRadius:12,padding:'20px 24px'}}>
                      <h3 style={{margin:'0 0 16px',fontSize:13,fontWeight:700,color:'#94a3b8',textTransform:'uppercase',letterSpacing:'0.06em'}}>Week Over Week</h3>
                      <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:12}}>
                        {Object.entries(wow.by_trade).map(([trade,data]:any)=>(
                          <div key={trade} style={{background:'#0d1529',borderRadius:8,padding:'12px',border:`1px solid ${data.pct>=0?'#22c55e20':'#ef444420'}`}}>
                            <div style={{fontSize:11,color:'#64748b',textTransform:'capitalize',marginBottom:4}}>{trade.replace('_',' ')}</div>
                            <div style={{fontSize:20,fontWeight:700,color:'#f1f5f9'}}>{data.current}</div>
                            <div style={{display:'flex',alignItems:'center',gap:4,fontSize:11}}>
                              {data.pct>=0 ? <ArrowUp size={11} color="#22c55e"/> : <ArrowDown size={11} color="#ef4444"/>}
                              <span style={{color:data.pct>=0?'#22c55e':'#ef4444'}}>{Math.abs(data.pct)}%</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Historical trend chart */}
                  {trendChartData.length > 1 ? (
                    <div style={{background:'#111827',border:'1px solid #1e293b',borderRadius:12,padding:'20px 24px'}}>
                      <h3 style={{margin:'0 0 16px',fontSize:13,fontWeight:700,color:'#94a3b8',textTransform:'uppercase',letterSpacing:'0.06em'}}>Permit Volume — Last {trendChartData.length} Weeks</h3>
                      <ResponsiveContainer width="100%" height={260}>
                        <LineChart data={trendChartData}>
                          <XAxis dataKey="week" tick={{fontSize:11,fill:'#475569'}} axisLine={false} tickLine={false}/>
                          <YAxis tick={{fontSize:11,fill:'#475569'}} axisLine={false} tickLine={false}/>
                          <Tooltip contentStyle={{background:'#1e293b',border:'1px solid #334155',borderRadius:8,fontSize:12}} cursor={{stroke:'#334155'}}/>
                          <Legend wrapperStyle={{fontSize:11,color:'#94a3b8'}}/>
                          {Object.entries(TRADE_COLORS).map(([trade,color])=>(
                            <Line key={trade} type="monotone" dataKey={trade} stroke={color} strokeWidth={2} dot={false}/>
                          ))}
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  ) : (
                    <div style={{background:'#111827',border:'1px solid #1e293b',borderRadius:12,padding:'40px',textAlign:'center',color:'#475569'}}>
                      Historical trend data builds after the second week. Check back next Monday.
                    </div>
                  )}

                  {/* Trade bar chart + ZIP heatmap */}
                  <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:20}}>
                    <div style={{background:'#111827',border:'1px solid #1e293b',borderRadius:12,padding:'20px 24px'}}>
                      <h3 style={{margin:'0 0 16px',fontSize:13,fontWeight:700,color:'#94a3b8',textTransform:'uppercase',letterSpacing:'0.06em'}}>This Week by Trade</h3>
                      <ResponsiveContainer width="100%" height={240}>
                        <BarChart data={tradeChartData} layout="vertical">
                          <XAxis type="number" tick={{fontSize:11,fill:'#475569'}} axisLine={false} tickLine={false}/>
                          <YAxis dataKey="trade" type="category" tick={{fontSize:11,fill:'#94a3b8'}} axisLine={false} tickLine={false} width={100}/>
                          <Tooltip contentStyle={{background:'#1e293b',border:'1px solid #334155',borderRadius:8,fontSize:12}} cursor={{fill:'#ffffff08'}}/>
                          <Bar dataKey="count" radius={[0,4,4,0]}>
                            {tradeChartData.map((e,i)=><Cell key={i} fill={e.fill}/>)}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </div>

                    {/* ZIP heatmap */}
                    <div style={{background:'#111827',border:'1px solid #1e293b',borderRadius:12,padding:'20px 24px'}}>
                      <h3 style={{margin:'0 0 16px',fontSize:13,fontWeight:700,color:'#94a3b8',textTransform:'uppercase',letterSpacing:'0.06em'}}>ZIP Code Activity</h3>
                      {heatmap.slice(0,8).map((z:any,i:number)=>(
                        <div key={z.zip} style={{display:'flex',alignItems:'center',gap:10,marginBottom:10}}>
                          <span style={{fontSize:12,color:'#64748b',width:16,textAlign:'right'}}>#{i+1}</span>
                          <div style={{flex:1}}>
                            <div style={{display:'flex',justifyContent:'space-between',marginBottom:3}}>
                              <span style={{fontSize:13,fontWeight:600,color:'#e2e8f0'}}>{z.zip}</span>
                              <span style={{fontSize:12,color:'#64748b'}}>{z.count} permits · ${(z.avg_value||0).toLocaleString(undefined,{maximumFractionDigits:0})} avg</span>
                            </div>
                            <div style={{height:4,background:'#1e293b',borderRadius:2}}>
                              <div style={{height:4,background:'#3b82f6',borderRadius:2,width:`${z.intensity}%`}}/>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* INSIGHTS TAB */}
              {activeTab==='insights' && (
                <div style={{display:'flex',flexDirection:'column',gap:12}}>
                  {summary.insights?.map((insight:string,i:number)=>(
                    <div key={i} style={{background:'#111827',border:'1px solid #1e293b',borderRadius:10,padding:'16px 20px',display:'flex',alignItems:'flex-start',gap:12}}>
                      <Star size={16} color="#f59e0b" style={{flexShrink:0,marginTop:2}}/>
                      <p style={{margin:0,fontSize:14,color:'#e2e8f0',lineHeight:1.6}}>{insight}</p>
                    </div>
                  ))}
                  {summary.targeting?.top_opportunity?.address && (
                    <div style={{background:'linear-gradient(135deg,#14532d20,#0f172a)',border:'1px solid #22c55e40',borderRadius:12,padding:'20px 24px',marginTop:8}}>
                      <div style={{fontSize:11,color:'#22c55e',fontWeight:700,textTransform:'uppercase',letterSpacing:'0.1em',marginBottom:8}}>🎯 Top Opportunity This Week</div>
                      <div style={{fontSize:18,fontWeight:700,color:'#f1f5f9',marginBottom:4}}>{summary.targeting.top_opportunity.address}</div>
                      {summary.targeting.top_opportunity.owner && (
                        <div style={{fontSize:13,color:'#94a3b8',marginBottom:4}}>Owner: {summary.targeting.top_opportunity.owner}</div>
                      )}
                      <div style={{display:'flex',gap:16,fontSize:13,color:'#64748b'}}>
                        <span>{summary.targeting.top_opportunity.type}</span>
                        <span style={{color:'#22c55e'}}>Score: {summary.targeting.top_opportunity.score}/100</span>
                        {summary.targeting.top_opportunity.value && <span style={{color:'#22c55e'}}>${parseFloat((summary.targeting.top_opportunity.value).replace(/[^0-9.]/g,'')||'0').toLocaleString()}</span>}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* SAVED TAB */}
              {activeTab==='saved' && (
                <div>
                  {saved.length===0 ? (
                    <div style={{textAlign:'center',padding:'60px 20px',color:'#475569'}}>
                      <Bookmark size={32} style={{marginBottom:12,opacity:0.4}}/>
                      <p>No saved permits yet. Click ★ on any permit to save it.</p>
                    </div>
                  ) : (
                    <div style={{background:'#111827',border:'1px solid #1e293b',borderRadius:12,overflow:'hidden'}}>
                      <table style={{width:'100%',borderCollapse:'collapse'}}>
                        <thead>
                          <tr style={{borderBottom:'1px solid #1e293b'}}>
                            {['Tag','Address','Owner','Trade','Value','Saved','Actions'].map(h=>(
                              <th key={h} style={{padding:'12px 16px',textAlign:'left',fontSize:11,color:'#475569',fontWeight:700,textTransform:'uppercase',letterSpacing:'0.06em'}}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {saved.map((p,i)=>(
                            <tr key={i} style={{borderBottom:'1px solid #0f172a',background:i%2===0?'#111827':'#0d1529'}}>
                              <td style={{padding:'10px 16px'}}>
                                <span style={{fontSize:11,fontWeight:600,padding:'3px 8px',borderRadius:4,background:`${TAG_COLORS[p._tag]||'#475569'}20`,color:TAG_COLORS[p._tag]||'#94a3b8',textTransform:'capitalize'}}>{p._tag||'saved'}</span>
                              </td>
                              <td style={{padding:'10px 16px',fontSize:13,color:'#e2e8f0',maxWidth:200,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{p.FULL_ADDRESS||'—'}</td>
                              <td style={{padding:'10px 16px',fontSize:12,color:'#94a3b8'}}>{p.OWNER_NAME||'—'}</td>
                              <td style={{padding:'10px 16px'}}>
                                <span style={{fontSize:11,fontWeight:600,padding:'3px 8px',borderRadius:4,textTransform:'capitalize',background:`${TRADE_COLORS[p.trade]||'#475569'}20`,color:TRADE_COLORS[p.trade]||'#94a3b8'}}>{(p.trade||'').replace('_',' ')}</span>
                              </td>
                              <td style={{padding:'10px 16px',fontSize:13,color:'#22c55e',fontWeight:600}}>
                                {p.FINAL_VALUATION?`$${parseFloat((p.FINAL_VALUATION).replace(/[^0-9.]/g,'')||'0').toLocaleString()}`:'—'}
                              </td>
                              <td style={{padding:'10px 16px',fontSize:12,color:'#64748b'}}>{p._saved_at?.split('T')[0]||'—'}</td>
                              <td style={{padding:'10px 16px'}}>
                                <button onClick={()=>handleSave(p,p._tag)} style={{background:'#7f1d1d20',border:'1px solid #ef444440',borderRadius:4,padding:'3px 8px',cursor:'pointer',fontSize:11,color:'#ef4444',fontWeight:600}}>Remove</button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}

              {/* DIGEST TAB */}
              {activeTab==='digest' && digest && (
                <div style={{display:'flex',flexDirection:'column',gap:16}}>
                  <div style={{background:'#111827',border:'1px solid #1e293b',borderRadius:12,padding:'20px 24px'}}>
                    <div style={{fontSize:11,color:'#60a5fa',fontWeight:700,textTransform:'uppercase',letterSpacing:'0.1em',marginBottom:12}}>📧 Your Monday Email Preview</div>
                    <div style={{background:'#0d1529',borderRadius:8,padding:'16px',fontFamily:'monospace',fontSize:13,color:'#94a3b8',lineHeight:1.8,whiteSpace:'pre-wrap'}}>
                      <div style={{color:'#64748b',marginBottom:8}}>Subject: {digest.subject}</div>
                      <div style={{borderTop:'1px solid #1e293b',paddingTop:8}}>{digest.body_preview}</div>
                    </div>
                  </div>
                  <div style={{background:'#111827',border:'1px solid #1e293b',borderRadius:12,padding:'20px 24px'}}>
                    <div style={{fontSize:11,color:'#94a3b8',fontWeight:700,textTransform:'uppercase',letterSpacing:'0.06em',marginBottom:12}}>Top 5 Permits in This Digest</div>
                    {digest.top_permits?.map((p:any,i:number)=>(
                      <div key={i} style={{display:'flex',alignItems:'center',gap:12,padding:'10px 0',borderBottom:'1px solid #1e293b'}}>
                        <div style={{width:32,height:32,borderRadius:'50%',background:`${SCORE_COLOR(p.score)}20`,border:`2px solid ${SCORE_COLOR(p.score)}`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:11,fontWeight:700,color:SCORE_COLOR(p.score),flexShrink:0}}>{p.score}</div>
                        <div style={{flex:1}}>
                          <div style={{fontSize:13,color:'#e2e8f0'}}>{p.FULL_ADDRESS||'—'}</div>
                          <div style={{fontSize:11,color:'#64748b'}}>{p.PERMIT_DESCRIPTION||p.RECORD_TYPE||'—'}</div>
                        </div>
                        <div style={{fontSize:13,color:'#22c55e',fontWeight:600}}>
                          {p.FINAL_VALUATION?`$${parseFloat((p.FINAL_VALUATION).replace(/[^0-9.]/g,'')||'0').toLocaleString()}`:'—'}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </main>
      </div>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;600;700&display=swap');
        * { box-sizing: border-box; }
        @keyframes spin { to { transform: rotate(360deg); } }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: #0a0f1e; }
        ::-webkit-scrollbar-thumb { background: #1e293b; border-radius: 3px; }
      `}</style>
    </div>
  );
}
