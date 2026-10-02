import React, {useEffect, useState} from 'react';
import {createRoot} from 'react-dom/client';
import './style.css';
import {offline,seedDemoContracts} from './transport';
import {initializeAuth,signIn,signOut,authenticatedFetch,environment,signedIn,cloudConfigured,publicFetch} from './auth';
import {LivePanel} from './live';
import {Studio} from './studio';
import {Progress} from './progress';
import {Onboarding,onboardingSeen} from './onboarding';
import {Business,Executive,Lineage,useSanta} from './business';
import {exportHtml,exportJson,exportPrint,Report} from './exporter';
import {fmtValue} from './santa';

type Kind = 'cost_per_order'|'success_rate'|'latency_p95';
type Row = {date:string; cost_per_order:number|null; success_rate:number|null; latency_p95:number|null; completed:number; allocated_cost:number};
type Data = {service:string; scenario:string; window:{start:string;end_exclusive:string;days:number}; summary:Row & {attempts:number;direct_cost:number;shared_pool:number;allocated_shared:number;unallocated_shared:number}; trend:Row[]; formulas:Record<Kind,string>; provenance:Record<string,unknown>};
type Saved = {id:string;version:number;kind:Kind;name:string;target:number;owner:string;service:string;shared_allocation_pct:number};
type Proposal = {status:string;engine:string;kind:Kind|null;formula?:string;reason:string;sources:string[]};
const names:Record<Kind,[string,string]> = {cost_per_order:['주문당 비용','Cost per order'],success_rate:['결제 성공률','Checkout success'],latency_p95:['결제 p95 지연','Checkout p95 latency']};
const fmt=(x:number|null|undefined,d=2)=>x==null?'—':x.toLocaleString('en-US',{maximumFractionDigits:d,minimumFractionDigits:d});
async function api<T>(path:string,init?:RequestInit):Promise<T>{
 if(window.__OUTCOMELENS_SAMPLE__)return offline(path,init) as Promise<T>;
 const r=await authenticatedFetch(path,init);
 return parse<T>(r);
}
async function parse<T>(r:Response):Promise<T>{
 const result=await r.json().catch(()=>({})); if(!r.ok)throw Error(typeof result.detail==='string'?result.detail:result.message||`HTTP ${r.status}`); return result;
}
async function publicApi<T>(path:string):Promise<T>{return parse<T>(await publicFetch(path))}
function Icon({name,size=20}:{name:string;size?:number}){
 const paths:Record<string,React.ReactNode>={
 grid:<><rect x="3" y="3" width="7" height="7" rx="1.4"/><rect x="14" y="3" width="7" height="7" rx="1.4"/><rect x="3" y="14" width="7" height="7" rx="1.4"/><rect x="14" y="14" width="7" height="7" rx="1.4"/></>,
 graph:<><circle cx="5" cy="12" r="3"/><circle cx="19" cy="5" r="3"/><circle cx="19" cy="19" r="3"/><path d="m8 11 8-5M8 13l8 5"/></>,
 check:<><path d="M12 3 3 7v5c0 5 9 9 9 9s9-4 9-9V7z"/><path d="m8 12 3 3 5-6"/></>,
 spark:<><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z"/></>,
 clock:<><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
 arrow:<><path d="M5 12h14m-5-5 5 5-5 5"/></>,
 dollar:<><path d="M12 2v20m5-16H9a4 4 0 0 0 0 8h6a4 4 0 0 1 0 8H6" transform="translate(0 -2) scale(1 .9)"/></>,
 book:<><path d="M4 3h12l4 4v14H4zM8 11h8M8 15h8M8 7h4"/></>,
 };
 return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{paths[name]||paths.grid}</svg>
}
function App({demo=false}:{demo?:boolean}){
 const [lang,setLang]=useState(localStorage.getItem('ol-lang')||'en');
 const [guide,setGuide]=useState(()=>!onboardingSeen());
 const en=lang==='en'; const t=(ko:string,eng:string)=>en?eng:ko;
 const [tab,setTab]=useState('overview'),[service,setService]=useState('checkout'),[days,setDays]=useState(14);
 const [scenario,setScenario]=useState('baseline'),[allocation,setAllocation]=useState(40);
 const [data,setData]=useState<Data|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true);
 const [detail,setDetail]=useState<Kind|null>(null),[saved,setSaved]=useState<Saved[]>([]),[audit,setAudit]=useState<any[]>([]);
 const [busy,setBusy]=useState(false);
 const [target,setTarget]=useState('0.25'),[owner,setOwner]=useState('Commerce Platform'),[notice,setNotice]=useState('');
 const [health,setHealth]=useState<{mode:string;assistant:string}|null>(null);
 useEffect(()=>{document.documentElement.lang=lang;localStorage.setItem('ol-lang',lang)},[lang]);
 useEffect(()=>{if(!detail)return;
 const previous=document.activeElement as HTMLElement|null;
 const dialog=document.querySelector<HTMLElement>('[role=dialog]');
 const first=dialog?.querySelector<HTMLElement>('button,input');first?.focus();
 const close=(e:KeyboardEvent)=>{if(e.key==='Escape')setDetail(null);if(e.key==='Tab'&&dialog){const items=[...dialog.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)')];const a=items[0],z=items[items.length-1];if(e.shiftKey&&document.activeElement===a){e.preventDefault();z?.focus()}else if(!e.shiftKey&&document.activeElement===z){e.preventDefault();a?.focus()}}};
 window.addEventListener('keydown',close);return()=>{window.removeEventListener('keydown',close);previous?.focus()}
 },[detail]);
 useEffect(()=>{let alive=true;setLoading(true);setError('');
 api<Data>(`/dashboard?service=${service}&days=${days}&scenario=${scenario}&allocation=${allocation}`)
 .then(x=>{if(alive)setData(x)}).catch(e=>{if(alive)setError(e.message)}).finally(()=>{if(alive)setLoading(false)});
 return()=>{alive=false}
 },[service,days,scenario,allocation]);
 async function refresh(){setSaved(await api<Saved[]>('/definitions'));setAudit(await api<any[]>('/audit'))}
 useEffect(()=>{api<any>('/health').then(setHealth).catch(e=>setError(e.message));refresh().catch(e=>setError(e.message))},[]);
 function openDefinition(k:Kind,scope=service,restore=false){setDetail(k);const found=saved.find(d=>d.kind===k&&d.service===scope);if(restore&&found){setService(scope);setAllocation(found.shared_allocation_pct)}setTarget(String(found?.target??(k==='cost_per_order'?.25:k==='success_rate'?99:500)));setOwner(found?.owner||'Commerce Platform')}
 async function save(){
 if(!detail)return;setBusy(true);setNotice('');
 const id=`${service}_${detail}`;const previous=saved.find(x=>x.id===id);
 try{await api('/definitions/'+id,{method:'PUT',body:JSON.stringify({kind:detail,name:names[detail][1],target:Number(target),owner,service,shared_allocation_pct:allocation,expected_version:previous?.version||0})});await refresh();setNotice(t('정의와 변경 이력을 저장했습니다.','Definition and audit event saved.'))}catch(e){setNotice(String(e))}finally{setBusy(false)}
 }
 const santa=useSanta(publicApi);
 const subtitle:Record<string,string>={
  overview:t('santacloth의 IT 투자가 쇼핑몰 매출·안정성에 어떻게 이어지는지 한눈에 봅니다.',"How santacloth's IT spend turns into storefront revenue and reliability, at a glance."),
  business:t('수동 입력(매출·고객만족도)과 CloudWatch 실측을 조합해 쇼핑몰별 KPI를 관리합니다.','Manage storefront KPIs by combining manual inputs (revenue, satisfaction) with CloudWatch measurements.'),
  live:t('실제 AWS 계정의 사용 중인 서비스와 공개 단가 기준 추정 비용을 모든 리전에서 봅니다.','See services in use and public-price cost estimates across every Region of a real AWS account.'),
  map:t('회사 목표가 쇼핑몰 KPI와 실제 AWS 리소스로 어떻게 이어지는지 확인합니다.','Trace how the company goal flows into storefront KPIs and real AWS resources.'),
  studio:t('상황을 설명하면 이커머스 KPI를 추천하고, 정한 KPI를 계약으로 관리합니다.','Describe a situation to get ecommerce KPI picks, and manage agreed KPIs as contracts.'),
  simulator:t('합성 결제 데이터로 장애·이벤트 누락 시나리오가 KPI를 어떻게 바꾸는지 시험합니다.','Try how incidents or missing events change KPIs, on synthetic checkout data.')};
 const [exportOpen,setExportOpen]=useState(false);
 function report():Report{
  const l=(p:[string,string])=>en?p[1]:p[0];
  const row=(k:{def:{name:[string,string];unit:string;target:number;direction:string};value:number|null;status:string})=>({kpi:l(k.def.name),value:fmtValue(k.value,k.def.unit),target:(k.def.direction==='lower'?'≤ ':'≥ ')+fmtValue(k.def.target,k.def.unit),status:k.status});
  return {title:`${santa.company.name} · ${t('KPI 근거 보고서','KPI evidence report')}`,generatedAt:new Date().toISOString(),
   sections:[{title:t('회사 KPI','Company KPIs'),rows:santa.companyKpis.map(row)},
    ...santa.company.shops.map(sh=>({title:l(sh.name),subtitle:'outcome='+sh.id,rows:santa.shopView(sh).kpis.map(row)})),
    {title:t('저장된 KPI 계약','Saved KPI contracts'),rows:saved.map(d=>({kpi:`${d.name} (${d.service})`,value:'v'+d.version,target:String(d.target),status:d.owner}))}],
   notes:[t('비용은 CloudWatch 사용량 × AWS 공개 단가 추정치이며 청구서가 아닙니다.','Costs are CloudWatch usage × AWS public price estimates, not a bill.'),
    t('수동 입력값은 사용자가 입력한 값과 기준일을 그대로 사용합니다.','Manual inputs are used as entered, with their as-of dates.'),
    santa.live?`${t('CloudWatch 수집','CloudWatch collected')} ${santa.live.collected_at}`:t('CloudWatch 데이터 없음','No CloudWatch data')],
   data:{company:santa.company,outcomes:santa.outcomes,dashboard:data,definitions:saved}};
 }
 const s=data?.summary;
 const nav=[['overview','grid',t('경영 요약','Executive summary')],['business','check',t('경영 KPI','Business KPIs')],['live','dollar',t('실계정 비용 추정','Live AWS estimate')],['map','graph',t('KPI 관계 맵','KPI lineage')],['studio','spark',t('KPI 스튜디오','KPI studio')],['simulator','clock',t('시나리오 시뮬레이터','Scenario simulator')]];
 return <div className="shell">
 <aside><div className="brand"><span className="brand-mark">◈</span><span>Cloud<span className="brand-light">Outcome</span><small>CLOUD → BUSINESS OUTCOMES</small></span></div>
 <div className="workspace"><span className="avatar">S</span><div>santacloth<small>{t('의류 이커머스 · 데모','Apparel ecommerce · demo')}</small></div><span className="chevron">⌄</span></div>
 <div className="nav-caption">WORKSPACE</div><nav>{nav.map(([id,icon,label])=><button key={id} className={tab===id?'active':''} onClick={()=>{setTab(id);setNotice('')}}><Icon name={icon}/>{label}{id==='studio'&&<span className="new">BETA</span>}</button>)}</nav>
 <div className="aside-note"><span className="status-dot"/>{t('라이브 데모 계정 연결됨','Live demo account connected')}<p>{t('santacloth 쇼핑몰 3곳의 AWS 리소스를 읽기 전용으로 10분마다 수집합니다.',"Read-only collection of santacloth's three storefronts every 10 minutes.")}</p><button onClick={()=>setTab('live')}>{t('라이브 계정 보기','View live account')} <Icon name="arrow" size={16}/></button></div>
 <div className="profile"><span className="avatar outline">SA</span><div>{t('santacloth IT 담당자','santacloth IT owner')}<small>{t('미리 세팅된 데모','Preset demo')}</small></div></div></aside>
 <main><header><div className="breadcrumb">santacloth <span>/</span> {nav.find(n=>n[0]===tab)?.[2]}</div><div className="header-right"><button className="button secondary" onClick={()=>setGuide(true)}>{t('가이드','Guide')}</button>{environment()&&<span className="badge amber">{environment()}</span>}{signedIn()?<button className="button secondary" onClick={signOut}>{t('로그아웃','Sign out')}</button>:cloudConfigured()&&<button className="button secondary" onClick={()=>signIn()}>{t('로그인','Sign in')}</button>}<span className="badge neutral">DEMO</span><select aria-label="Language" value={lang} onChange={e=>setLang(e.target.value)}><option value="ko">한국어</option><option value="en">English</option></select><span className="avatar mini">SA</span></div></header>
 <div className="content">
 <div className="page-title"><div><div className="eyebrow">CLOUD SIGNALS. BUSINESS CONTEXT.</div><h1>{tab==='overview'?t('비용 너머의 비즈니스 가치','See the business behind your cloud.'):tab==='simulator'?t('시나리오 시뮬레이터','Scenario simulator'):nav.find(n=>n[0]===tab)?.[2]}</h1><p>{subtitle[tab]||t('인프라 비용, 서비스 품질, 비즈니스 성과를 하나의 근거로 연결합니다.','Connect cloud spend, service quality, and business outcomes with evidence.')}</p></div><div className="export-menu"><button className="button secondary" aria-haspopup="menu" aria-expanded={exportOpen} onClick={()=>setExportOpen(!exportOpen)}><Icon name="book" size={17}/>{t('근거 내보내기','Export evidence')} ▾</button>{exportOpen&&<div className="export-options" role="menu">{[['json','JSON',()=>exportJson(report())],['html',t('HTML 보고서','HTML report'),()=>exportHtml(report())],['print',t('PDF 저장 · 프린터','PDF / Printer'),()=>exportPrint(report())]].map(([id,label,fn])=><button role="menuitem" key={id as string} onClick={()=>{(fn as ()=>void)();setExportOpen(false)}}>{label as string}</button>)}</div>}</div></div>
 {(tab==='simulator'||tab==='studio')&&<><div className="sample-banner"><span className="badge amber">{t('시뮬레이션','SIMULATED')}</span><span>{t('모든 지표·비용은 생성된 샘플입니다. 실제 AWS 청구·운영 데이터가 아닙니다.','All metrics and costs are generated samples, not observed AWS billing or telemetry.')}</span>{demo&&<span>{t('로그인 없이 체험 중입니다. 변경 사항은 이 브라우저에만 저장됩니다.','You are exploring without signing in. Changes stay in this browser.')}</span>}<span className="banner-date">UTC · Sep 2026</span></div>
 <div className="filters"><label>{t('서비스 그룹','Service group')}<select value={service} onChange={e=>setService(e.target.value)}><option value="checkout">Checkout · app:commerce</option><option value="catalog">Catalog · app:commerce</option></select></label><label>{t('분석 기간','Window')}<select value={days} onChange={e=>setDays(Number(e.target.value))}>{[7,14,30].map(d=><option key={d} value={d}>{d}{t('일',' days')}</option>)}</select></label><label>{t('샘플 시나리오','Sample scenario')}<select value={scenario} onChange={e=>setScenario(e.target.value)}><option value="baseline">{t('정상 운영','Baseline')}</option><option value="incident">{t('최근 3일 결제 장애','Checkout incident · last 3 days')}</option><option value="empty">{t('비즈니스 이벤트 없음','Missing business events')}</option></select></label><div className="filter-status"><span className="status-dot"/>{loading?t('계산 중','Computing'):t('계산 근거 추적 가능','Traceable calculations')}</div></div></>}
 {tab==='business'&&<Business santa={santa} t={t} en={en}/>}
 {tab==='map'&&<Lineage santa={santa} t={t} en={en}/>}
 {tab==='live'&&<LivePanel t={t} en={en} signedIn={signedIn()||import.meta.env.DEV} onSignIn={()=>signIn()} request={api} publicRequest={publicApi}/>}
 {error&&<div className="error" role="alert">{error}<button onClick={()=>location.reload()}>{t('다시 연결','Reconnect')}</button></div>}
 <Progress active={loading&&(tab==='simulator'||tab==='studio')} expectedMs={demo?700:2500} steps={[t('선택한 범위를 불러오는 중','Loading the selected scope'),t('KPI 계산 중','Calculating KPIs'),t('근거 정리 중','Assembling evidence')]} t={t}/>
 {tab==='overview'&&<Executive santa={santa} t={t} en={en} go={setTab}/>}
 {data&&!loading&&tab==='simulator'&&<>
 <div className="kpi-grid">{(Object.keys(names) as Kind[]).map((k,i)=>{
 const value=s?.[k];const def=saved.find(d=>d.kind===k&&d.service===service);
 const limit=def?.target??(i===0?.25:i===1?99:500);const ok=value!=null&&(i===1?value>=limit:value<=limit);
 return <button className="kpi-card" key={k} onClick={()=>openDefinition(k)}><div className="card-top"><span>{names[k][en?1:0]}</span><span className={'metric-icon tone'+i}><Icon name={i===0?'dollar':i===1?'check':'clock'}/></span></div><div className="metric-value">{i===0&&value!=null?'$':''}{fmt(value,i===2?0:2)}<span>{i===1?'%':i===2?'ms':t('/ 주문','/ order')}</span></div><div className="metric-bottom"><span className={'pill '+(value==null?'neutral':ok?'green':'amber')}>{value==null?t('데이터 필요','Needs data'):ok?t('목표 이내','Within target'):t('목표 검토','Review target')}</span><span>{t('목표','Target')} {i===1?'≥':'≤'} {limit}{i===1?'%':i===2?'ms':' USD'}</span></div><div className="card-link">{t('계산식과 근거 보기','Inspect formula & evidence')} <Icon name="arrow" size={15}/></div></button>
 })}</div>
 <div className="two-col"><section className="panel trend-panel"><div className="panel-heading"><div><h2>{t('주문 단위 경제성','Order unit economics')}</h2><p>{t('비용 변화와 완료 주문을 함께 확인하세요.','Read unit cost alongside completed orders.')}</p></div><span className="badge neutral">{days}D · USD</span></div><Trend data={data.trend} en={en}/><div className="chart-footer"><span><i className="legend-line"/> {t('주문당 비용 · USD','Cost per order · USD')}</span><span><i className="legend-bar"/> {t('완료 주문 · 건','Completed orders · count')}</span></div></section>
 <section className="panel allocation"><div className="panel-heading"><div><h2>{t('비용 배분','Cost attribution')}</h2><p>{t('포함 범위를 명시해야 신뢰할 수 있습니다.','Make the cost boundary explicit.')}</p></div><Icon name="graph"/></div><div className="cost-total">${fmt(s?.allocated_cost)}<small>{t('선택한 서비스에 배분된 비용','Allocated to this service')}</small></div><div className="stacked-bar"><span style={{width:`${(s!.direct_cost/s!.allocated_cost)*100}%`}}/><span/></div><div className="cost-row"><span><i className="legend-dot"/>{t('직접 비용','Direct cost')}</span><b>${fmt(s?.direct_cost)}</b></div><div className="cost-row"><span><i className="legend-dot light"/>{t('공유 비용 배분','Allocated shared cost')}</span><b>${fmt(s?.allocated_shared)}</b></div><div className="slider-label"><label htmlFor="allocation">{t('공유 풀 배분 비율','Share of common cost pool')}</label><b>{allocation}%</b></div><input id="allocation" type="range" min="0" max="100" step="5" value={allocation} onChange={e=>setAllocation(Number(e.target.value))}/><p className="subtle">{t('미배분 공유 비용','Unallocated shared cost')}: ${fmt(s?.unallocated_shared)}<br/>{t('수동 배분 정책 · 전체 회사 비용과 다릅니다.','Manual policy · not total company spend.')}</p></section></div>
 <section className="insight"><div className="insight-icon"><Icon name="spark" size={25}/></div><div><div className="eyebrow">{t('관측 기반 검토 포인트','EVIDENCE-BASED REVIEW')}</div><h3>{scenario==='incident'?t('결제 성공률과 지연을 함께 조사하세요.','Investigate checkout success and latency together.'):scenario==='empty'?t('비즈니스 이벤트를 연결하면 단위 비용을 계산할 수 있습니다.','Connect business events to calculate unit costs.'):t('공유 비용 배분 기준이 주문당 비용에 영향을 줍니다.','Your allocation policy changes cost per order.')}</h3><p>{t('규칙 기반 설명입니다. 인과관계나 매출 손실을 단정하지 않습니다.','Rule-based explanation. No causal claim or inferred revenue loss.')}</p></div><button className="button" onClick={()=>setTab('studio')}>{t('KPI 정의하기','Define a KPI')}<Icon name="arrow" size={16}/></button></section>
 <div className="bottom-stats"><span>{t('고유 시도','Unique attempts')} <b>{fmt(s?.attempts,0)}</b></span><span>{t('완료 이벤트','Completed events')} <b>{fmt(s?.completed,0)}</b></span><span>{t('집계 범위','Window')} <b>{data.window.start} → {data.window.end_exclusive} (exclusive)</b></span><span>{t('정의 버전 관리','Versioned definitions')} <b>{saved.length}</b></span></div>
 </>}
 {tab==='studio'&&<div className="two-col studio"><Studio t={t} en={en} onOpen={k=>openDefinition(k)}/><section className="panel"><div className="panel-heading"><div><h2>{t('저장된 KPI 계약','Saved KPI contracts')}</h2><p>{t('담당자, 목표, 배분 기준, 버전을 보관합니다.','Owner, target, allocation policy, and version.')}</p></div><span className="badge neutral">{saved.length}</span></div>{saved.length?saved.map(x=><button className="saved-row" key={x.id} onClick={()=>openDefinition(x.kind,x.service,true)}><span><b>{x.name}</b><small>{x.owner} · {x.service}</small></span><span className="badge teal">v{x.version}</span></button>):<div className="empty"><Icon name="book" size={36}/><h3>{t('첫 KPI 정의를 저장하세요','Save your first KPI contract')}</h3><p>{t('샘플 값을 보는 것에서 회사의 정의를 관리하는 것으로.','Turn a sample metric into an explicit business definition.')}</p></div>}</section></div>}
 {tab==='sources'&&<><section className="panel"><div className="panel-heading"><div><h2>{t('데이터 준비 현황','Data readiness')}</h2><p>{t('계정 연결과 비즈니스 데이터 연결은 별도의 단계입니다.','AWS access and business instrumentation are separate steps.')}</p></div><span className="badge amber">{t('AWS 미연결','AWS NOT CONNECTED')}</span></div><table><thead><tr>{[t('소스','Source'),t('필요한 데이터','Required data'),t('현재 상태','Current state')].map(x=><th key={x}>{x}</th>)}</tr></thead><tbody>{[['CloudWatch','Count · errors · raw latency',t('샘플만 사용','Sample only')],['Business events','event_id · success · timestamp',t('생성된 이벤트','Generated events')],['Cost Explorer / CUR','USD · cost scope · allocation',t('가상 청구 데이터','Simulated billing')],['Revenue / MAU',t('매출 또는 사용자 이벤트','Revenue or user events'),t('소스 없음','Missing source')]].map(r=><tr key={r[0]}>{r.map((x,i)=><td key={i}>{i===2?<span className="badge neutral">{x}</span>:x}</td>)}</tr>)}</tbody></table><div className="callout">{t('실계정 연결: 읽기 전용 역할 + ExternalId → 리전·서비스 선택 → 청구 권한 확인 → 관측 데이터 검증. 이 화면은 연결 성공을 시뮬레이션하지 않습니다.','Live onboarding: read-only role + ExternalId → Region/service scope → billing permission → observation verification. This screen does not simulate a successful connection.')}</div></section><section className="panel audit"><div className="panel-heading"><h2>{t('KPI 변경 이력','Definition audit trail')}</h2><span className="badge neutral">{audit.length}</span></div>{audit.length?<table><thead><tr><th>UTC</th><th>Action</th><th>Evidence</th></tr></thead><tbody>{audit.map(x=><tr key={x.id}><td>{x.created}</td><td>{x.action}</td><td><code>{x.body}</code></td></tr>)}</tbody></table>:<p className="subtle">{t('저장된 변경이 없습니다.','No saved changes yet.')}</p>}</section></>}
 <footer><span>CloudOutcome <b>0.1</b> · {demo?t('데모','demo'):health?.mode==='cloud-workspace'?t('클라우드 워크스페이스','cloud workspace'):health?.mode==='local-workspace'?t('로컬 개발','local development'):health?.mode||'…'}</span><span>{t('숫자마다 근거를. 판단마다 맥락을.','Evidence for every number. Context for every decision.')}</span></footer>
 </div></main>
 <Onboarding open={guide} onClose={()=>setGuide(false)} t={t}/>
 {detail&&data&&<div className="modal-overlay" onClick={()=>{setDetail(null);setNotice('')}}><section className="modal" role="dialog" aria-modal="true" aria-label={names[detail][en?1:0]} onClick={e=>e.stopPropagation()}><div className="panel-heading"><div><div className="eyebrow">KPI CONTRACT</div><h2>{names[detail][en?1:0]}</h2></div><button className="close" aria-label="Close" onClick={()=>{setDetail(null);setNotice('')}}>×</button></div><div className="formula"><small>{t('결정적 계산식','DETERMINISTIC FORMULA')}</small><code>{data.formulas[detail]}</code></div><div className="definition-meta"><span>Scope <b>{service}</b></span><span>Timezone <b>UTC</b></span><span>Allocation <b>{allocation}%</b></span></div><p className="subtle">{t('동일 기간·서비스 경계 기준입니다. 입력은 생성된 샘플이며 0 분모는 계산 불가로 처리합니다.','Same period and service boundary. Synthetic inputs; zero denominators return unavailable.')}</p><div className="form-row"><label>{t('목표','Target')}<input type="number" min="0.0001" step="any" value={target} onChange={e=>setTarget(e.target.value)}/></label><label>{t('담당 팀','Owner')}<input value={owner} maxLength={80} onChange={e=>setOwner(e.target.value)}/></label></div><div className="callout">{t('개인 이름 대신 팀명을 사용하세요. 버전 충돌 시 최신 정의를 다시 불러오세요.','Changes persist in the local workspace. Reload definitions on a version conflict.')}</div>{notice&&<div role="status" className="notice">{notice}</div>}<div className="modal-actions"><button className="button secondary" onClick={()=>setDetail(null)}>{t('닫기','Close')}</button><button className="button primary" disabled={busy||!owner.trim()||!Number(target)||Number(target)<0} onClick={save}>{busy?t('저장 중…','Saving…'):t('검토한 정의 저장','Save reviewed definition')}</button></div></section></div>}
 </div>
}
function Trend({data,en}:{data:Row[];en:boolean}){
 const width=660,height=210,left=48,right=45,top=12,bottom=30;
 const maxCost=Math.max(.4,...data.map(d=>d.cost_per_order||0))*1.15;
 const maxOrders=Math.max(1,...data.map(d=>d.completed))*1.15;
 const x=(i:number)=>left+i*(width-left-right)/(Math.max(1,data.length-1));
 const y=(v:number)=>height-bottom-v/maxCost*(height-top-bottom);
 const path=data.filter(d=>d.cost_per_order!=null).map((d,i)=>(i?'L':'M')+x(i)+','+y(d.cost_per_order!)).join(' ');
 return <svg className="chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={en?'Cost per order and completed orders over time':'기간별 주문당 비용과 완료 주문'}>
 {[0,.25,.5,.75,1].map(r=><g key={r}><line x1={left} y1={y(maxCost*r)} x2={width-right} y2={y(maxCost*r)} stroke="#eee3c9" strokeDasharray="3 4"/><text x={left-9} y={y(maxCost*r)+4} textAnchor="end">${fmt(maxCost*r)}</text><text x={width-right+8} y={y(maxCost*r)+4}>{Math.round(maxOrders*r)}</text></g>)}
 {data.map((d,i)=><g key={d.date}><rect x={x(i)-6} y={height-bottom-d.completed/maxOrders*(height-top-bottom)} width={12} height={d.completed/maxOrders*(height-top-bottom)} fill="#f3df91" rx={3}><title>{d.date}: {d.completed} orders, ${fmt(d.cost_per_order)}</title></rect>{(i===0||i===data.length-1||i===Math.floor(data.length/2))&&<text x={x(i)} y={height-7} textAnchor="middle">{d.date.slice(5)}</text>}</g>)}
 <path d={path} fill="none" stroke="#977000" strokeWidth={2.8} strokeLinecap="round"/>
 {data.map((d,i)=>d.cost_per_order!=null&&<circle key={i} cx={x(i)} cy={y(d.cost_per_order)} r={3} fill="#fff" stroke="#977000" strokeWidth={2}><title>{d.date}: ${fmt(d.cost_per_order,4)}</title></circle>)}
 </svg>
}
function Bootstrap(){
 const [status,setStatus]=useState('loading'),[message,setMessage]=useState('');
 // Visitors start in the synthetic demo; sign-in unlocks the cloud workspace and account connection.
 useEffect(()=>{initializeAuth().then(async s=>{if(s==='login'){window.__OUTCOMELENS_SAMPLE__=(await import('../fixtures/dashboard-v1.json')).default;seedDemoContracts();setStatus('demo')}else setStatus(s)}).catch(()=>{setStatus('error');setMessage('설정 또는 로그인 확인에 실패했습니다. / Configuration or login could not be verified.')})},[]);
 if(status==='ready')return <App/>;
 if(status==='demo')return <App demo/>;
 return <main style={{margin:'auto',maxWidth:620,padding:48,width:'100%'}}><div className="panel"><h1>CloudOutcome</h1><p>클라우드 투자가 만든 비즈니스 성과를 연결하세요.<br/>Connect cloud investment to business outcomes.</p><p>{message}</p>{status==='loading'?<p>Loading…</p>:<button className="button primary" onClick={()=>signIn().catch(()=>setMessage('로그인 설정을 확인해주세요. / Check deployment configuration.'))}>로그인 / Sign in</button>}<p className="subtle">초대된 계정만 접근할 수 있습니다. 개인정보를 입력하지 마세요.<br/>Invited accounts only. Do not enter personal information.</p></div></main>;
}
createRoot(document.getElementById('root')!).render(<Bootstrap/>);
