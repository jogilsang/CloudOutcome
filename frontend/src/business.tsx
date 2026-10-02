import React, {useEffect, useState} from 'react';
import {Progress} from './progress';
import {Company, CW_METRICS, KpiDef, Manual, Outcome, Ref, Shop, companyValues, cwValues, evaluate, fmtValue, insights, itBudgetKrw, load, reset, save} from './santa';

type T=(ko:string,en:string)=>string;
type Live={window:{days:number;start:string;end_exclusive:string};daily?:{date:string;estimated_usd:number}[];outcomes?:Record<string,Outcome>;resources:{service:string;name:string;region:string;tags?:Record<string,string>}[];collected_at:string};
type Req=<X>(path:string)=>Promise<X>;

// Days of data behind the window: full past days with activity plus the elapsed fraction of today.
export function activeDays(daily:{date:string;estimated_usd:number}[],collectedAt:string|undefined,fallback:number){
 const withData=daily.filter(d=>d.estimated_usd>0);
 if(!withData.length||!collectedAt)return fallback;
 const today=collectedAt.slice(0,10),past=withData.filter(d=>d.date!==today).length;
 const t=new Date(collectedAt),fraction=(t.getUTCHours()*60+t.getUTCMinutes())/1440;
 return past+(withData.some(d=>d.date===today)?Math.max(1/24,fraction):0)||fallback;
}

export function useSanta(publicRequest:Req){
 const [company,setCompany]=useState<Company>(load),[live,setLive]=useState<Live|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState('');
 const [collecting,setCollecting]=useState(false);
 const days=7;
 useEffect(()=>{let alive=true;setLoading(true);
  publicRequest<Live&{status?:string}>(`/live-demo?days=${days}`).then(x=>{if(alive){if(x.status==='collecting'){setCollecting(true);setLive(null)}else setLive(x)}}).catch(e=>{if(alive)setError((e as Error).message)}).finally(()=>{if(alive)setLoading(false)});
  return()=>{alive=false}},[]);
 const update=(c:Company)=>{setCompany(c);save(c)};
 const outcomes=live?.outcomes||{};
 // Scale to a month by the days that actually have data, so newly created resources are not diluted by empty days.
 // Activity of the storefronts themselves (other resources in the account must not stretch the window).
 const storeDaily=(live?.daily||[]).map((d,i)=>({date:d.date,estimated_usd:Object.values(outcomes).reduce((sum,o)=>sum+(o.daily_requests?.[i]||0),0)}));
 const active=activeDays(storeDaily,live?.collected_at,days);
 const company_=companyValues(company,outcomes,active);
 const shopView=(s:Shop)=>{const cw=cwValues(outcomes[s.id],active,company.fxKrwPerUsd);return {cw,kpis:s.kpis.map(k=>evaluate(k,{cw,manual:s.manual,company:company_}))}};
 const companyKpis=company.kpis.map(k=>evaluate(k,{cw:{},manual:company.manual,company:company_}));
 const actions=insights(company,company.shops.map(s=>({shop:s,kpis:shopView(s).kpis})));
 return {company,update,live,loading,error,collecting,days,active,outcomes,companyTotals:company_,shopView,companyKpis,actions,resetAll:()=>update(reset())};
}
export type Santa=ReturnType<typeof useSanta>;

const statusBadge=(s:string,t:T)=>s==='ok'?<span className="pill green">{t('목표 달성','On target')}</span>:s==='breach'?<span className="pill amber">{t('목표 미달','Off target')}</span>:<span className="pill neutral">{t('데이터 대기','Awaiting data')}</span>;
const refLabel=(r:Ref,shop:Shop|undefined,c:Company,en:boolean)=>r.kind==='none'?'—':r.kind==='cw'?(CW_METRICS.find(m=>m.id===r.id)?.name[en?1:0]||r.id)+' (CloudWatch)':
 r.kind==='manual'?([...(shop?.manual||[]),...c.manual].find(m=>m.id===r.id)?.name[en?1:0]||r.id)+(en?' (manual)':' (수동)'):(r.id==='it_budget_krw'?(en?'IT budget':'IT 예산'):r.id==='total_cost_krw_month'?(en?'Total AWS cost':'전체 AWS 비용'):r.id);

function ManualEditor({items,onChange,t,en}:{items:Manual[];onChange:(m:Manual[])=>void;t:T;en:boolean}){
 return <table className="manual-table"><thead><tr><th>{t('수동 입력 지표','Manual input')}</th><th>{t('값','Value')}</th><th>{t('기준일','As of')}</th></tr></thead><tbody>{items.map(m=><tr key={m.id}><td>{en?m.name[1]:m.name[0]}</td>
  <td><input aria-label={en?m.name[1]:m.name[0]} type="number" step="any" value={m.value} onChange={e=>onChange(items.map(x=>x.id===m.id?{...x,value:Number(e.target.value),asOf:new Date().toISOString().slice(0,10)}:x))}/> <span className="subtle">{m.unit}</span></td>
  <td className="subtle">{m.asOf}</td></tr>)}</tbody></table>;
}

function KpiBuilder({shop,company,onAdd,onCancel,t,en}:{shop:Shop;company:Company;onAdd:(k:KpiDef)=>void;onCancel:()=>void;t:T;en:boolean}){
 const options:Ref[]=[...CW_METRICS.map(m=>({kind:'cw',id:m.id}) as Ref),...shop.manual.map(m=>({kind:'manual',id:m.id}) as Ref),{kind:'company',id:'it_budget_krw'},{kind:'company',id:'total_cost_krw_month'}];
 const key=(r:Ref)=>r.kind==='none'?'none':`${r.kind}:${r.id}`;
 const from=(k:string):Ref=>k==='none'?{kind:'none'}:options.find(o=>key(o)===k)!;
 const [k,setK]=useState<KpiDef>({id:'custom-'+Date.now(),name:['',''],numerator:{kind:'cw',id:'error_rate_pct'},denominator:{kind:'none'},multiplier:1,unit:'',target:1,direction:'lower'});
 return <div className="kpi-builder"><h4>{t('KPI 만들기','Build a KPI')}</h4>
  <div className="form-row"><label>{t('이름','Name')}<input value={en?k.name[1]:k.name[0]} maxLength={60} onChange={e=>setK({...k,name:[e.target.value,e.target.value]})}/></label>
   <label>{t('단위','Unit')}<input value={k.unit} maxLength={8} placeholder="%, ms, ₩" onChange={e=>setK({...k,unit:e.target.value})}/></label></div>
  <div className="form-row"><label>{t('분자','Numerator')}<select value={key(k.numerator)} onChange={e=>setK({...k,numerator:from(e.target.value)})}>{options.map(o=><option key={key(o)} value={key(o)}>{refLabel(o,shop,company,en)}</option>)}</select></label>
   <label>{t('분모 (선택)','Denominator (optional)')}<select value={key(k.denominator)} onChange={e=>setK({...k,denominator:from(e.target.value)})}><option value="none">—</option>{options.map(o=><option key={key(o)} value={key(o)}>{refLabel(o,shop,company,en)}</option>)}</select></label></div>
  <div className="form-row"><label>{t('곱하기','Multiplier')}<input type="number" step="any" value={k.multiplier} onChange={e=>setK({...k,multiplier:Number(e.target.value)})}/></label>
   <label>{t('목표','Target')}<input type="number" step="any" value={k.target} onChange={e=>setK({...k,target:Number(e.target.value)})}/></label>
   <label>{t('좋은 방향','Better when')}<select value={k.direction} onChange={e=>setK({...k,direction:e.target.value as KpiDef['direction']})}><option value="lower">{t('낮을수록','lower')}</option><option value="higher">{t('높을수록','higher')}</option></select></label></div>
  <p className="subtle">KPI = {refLabel(k.numerator,shop,company,en)}{k.denominator.kind!=='none'&&<> ÷ {refLabel(k.denominator,shop,company,en)}</>}{k.multiplier!==1&&<> × {k.multiplier}</>}</p>
  <div className="modal-actions start"><button className="button secondary" onClick={onCancel}>{t('취소','Cancel')}</button><button className="button primary" disabled={!k.name[0].trim()} onClick={()=>onAdd(k)}>{t('KPI 추가','Add KPI')}</button></div></div>;
}

export function Business({santa,t,en}:{santa:Santa;t:T;en:boolean}){
 const {company,update,loading,error,shopView,companyKpis,companyTotals,live}=santa;
 const [building,setBuilding]=useState<string|null>(null);
 const setShop=(s:Shop)=>update({...company,shops:company.shops.map(x=>x.id===s.id?s:x)});
 const budget=itBudgetKrw(company),used=companyTotals.total_cost_krw_month,pct=budget?Math.min(100,used/budget*100):0;
 return <>
  <div className="sample-banner"><span className="badge amber">{t('데모 회사','DEMO COMPANY')}</span><span>{t('santacloth는 가상의 의류 이커머스 회사입니다. 쇼핑몰 3개의 AWS 리소스(태그 outcome)는 데모 계정에서 실제로 동작하며 5분마다 가상 주문 트래픽이 들어옵니다. 수동 입력값은 이 브라우저에만 저장됩니다.','santacloth is a fictional apparel ecommerce company. Its three storefronts run on real AWS resources (tag outcome) in the demo account with synthetic orders every 5 minutes. Manual inputs stay in this browser.')}</span>
   <button className="link-button" onClick={santa.resetAll}>{t('샘플로 초기화','Reset sample')}</button></div>
  {error&&<div className="error" role="alert">{error}</div>}
  {santa.collecting&&<div className="callout">{t('CloudWatch 데모 데이터를 수집하는 중입니다. 몇 분 뒤 새로고침하세요.','Collecting CloudWatch demo data. Refresh in a few minutes.')}</div>}
  <Progress active={loading} expectedMs={1500} t={t} steps={[t('CloudWatch 스냅샷 불러오는 중','Loading CloudWatch snapshot'),t('쇼핑몰별 KPI 계산 중','Calculating storefront KPIs')]}/>
  <div className="two-col">
   <section className="panel"><div className="panel-heading"><div><h2>{t('회사 프로필','Company profile')} · {company.name}</h2><p>{t('경영 입력값을 바꾸면 모든 KPI가 즉시 다시 계산됩니다.','Changing business inputs recalculates every KPI immediately.')}</p></div></div>
    <div className="form-row"><label>{t('월 매출 (₩)','Monthly revenue (₩)')}<input type="number" value={company.monthlyRevenueKrw} onChange={e=>update({...company,monthlyRevenueKrw:Number(e.target.value)})}/></label>
     <label>{t('IT 예산 (매출 대비 %)','IT budget (% of revenue)')}<input type="number" step="any" value={company.itBudgetPct} onChange={e=>update({...company,itBudgetPct:Number(e.target.value)})}/></label>
     <label>{t('환율 (₩/USD)','FX rate (₩/USD)')}<input type="number" value={company.fxKrwPerUsd} onChange={e=>update({...company,fxKrwPerUsd:Number(e.target.value)})}/></label></div>
    <ManualEditor items={company.manual} t={t} en={en} onChange={m=>update({...company,manual:m})}/>
   </section>
   <section className="panel"><div className="panel-heading"><div><h2>{t('IT 예산 대비 AWS 비용','AWS cost vs IT budget')}</h2><p>{t(`쇼핑몰 3개 합계 · 최근 7일 중 실제 데이터 ${santa.active.toFixed(1)}일분을 월로 환산`,`Three storefronts · ${santa.active.toFixed(1)} day(s) of data in the last 7, scaled to a month`)}</p></div></div>
    <div className="cost-total">{fmtValue(used,'₩')}<small>{t(`월 예산 ${fmtValue(budget,'₩')} 중 ${pct.toFixed(1)}%`,`${pct.toFixed(1)}% of the ${fmtValue(budget,'₩')} monthly budget`)}</small></div>
    <div className="stacked-bar"><span style={{width:pct+'%'}}/></div>
    <table><tbody>{companyKpis.map(k=><tr key={k.def.id}><td>{en?k.def.name[1]:k.def.name[0]}</td><td><b>{fmtValue(k.value,k.def.unit)}</b></td><td className="subtle">{k.def.direction==='lower'?'≤':'≥'} {fmtValue(k.def.target,k.def.unit)}</td><td>{statusBadge(k.status,t)}</td></tr>)}</tbody></table>
   </section>
  </div>
  <Actions santa={santa} t={t} en={en}/>
  <div className="shop-grid">{company.shops.map(s=>{const v=shopView(s);return <section className="panel shop" key={s.id}>
   <div className="panel-heading"><div><h2>{en?s.name[1]:s.name[0]}</h2><p>{en?s.audience[1]:s.audience[0]} · <code>outcome={s.id}</code></p></div><span className="badge teal">{v.kpis.filter(k=>k.status==='ok').length}/{v.kpis.length}</span></div>
   <div className="cw-strip"><span>{t('요청','Requests')} <b>{fmtValue(v.cw.api_requests,'')}</b></span><span>{t('오류율','Errors')} <b>{fmtValue(v.cw.error_rate_pct,'%')}</b></span><span>{t('처리시간','Checkout')} <b>{fmtValue(v.cw.avg_checkout_ms,'ms')}</b></span><span>{t('월 비용','Cost/mo')} <b>{fmtValue(v.cw.cost_krw_month,'₩')}</b></span></div>
   <Sparkline requests={santa.outcomes[s.id]?.daily_requests||[]} errors={santa.outcomes[s.id]?.daily_errors_5xx||[]} t={t}/>
   <table><thead><tr><th>KPI</th><th>{t('현재','Current')}</th><th>{t('목표','Target')}</th><th/></tr></thead><tbody>{v.kpis.map(k=><tr key={k.def.id}><td title={`${refLabel(k.def.numerator,s,company,en)}${k.def.denominator.kind!=='none'?' ÷ '+refLabel(k.def.denominator,s,company,en):''}`}>{en?k.def.name[1]:k.def.name[0]}</td>
    <td><b>{fmtValue(k.value,k.def.unit)}</b></td><td className="subtle">{k.def.direction==='lower'?'≤':'≥'} {fmtValue(k.def.target,k.def.unit)}</td><td className="nowrap">{statusBadge(k.status,t)} {k.def.id.startsWith('custom-')&&<button className="link-button" onClick={()=>setShop({...s,kpis:s.kpis.filter(x=>x.id!==k.def.id)})}>{t('삭제','Remove')}</button>}</td></tr>)}</tbody></table>
   <ManualEditor items={s.manual} t={t} en={en} onChange={m=>setShop({...s,manual:m})}/>
   {building===s.id?<KpiBuilder shop={s} company={company} t={t} en={en} onCancel={()=>setBuilding(null)} onAdd={k=>{setShop({...s,kpis:[...s.kpis,k]});setBuilding(null)}}/>
    :<button className="button secondary" onClick={()=>setBuilding(s.id)}>{t('KPI 추가 (수동 + CloudWatch 조합)','Add KPI (manual + CloudWatch)')}</button>}
  </section>})}</div>
  {live&&<p className="subtle">{t('CloudWatch 수집 시각','CloudWatch collected')} {live.collected_at.replace('T',' ').slice(0,16)} UTC · {t('주문 수 = DynamoDB 쓰기 단위(주문 1건 = 쓰기 1회), 처리시간 = 체크아웃 Lambda 평균 실행시간, 비용 = AWS 공개 단가 추정(청구서 아님)','Orders = DynamoDB writes (one per order), checkout time = average checkout Lambda duration, cost = AWS public price estimate (not a bill)')}</p>}
 </>;
}

export function Lineage({santa,t,en}:{santa:Santa;t:T;en:boolean}){
 const {company,shopView,companyKpis,live,loading}=santa;
 const [focus,setFocus]=useState<string|null>(null);
 const resources=(shop:string)=>(live?.resources||[]).filter(r=>r.tags?.outcome===shop);
 return <section className="panel lineage live-lineage"><div className="panel-heading"><div><h2>{t('회사 목표에서 AWS 리소스까지','From company goal to AWS resources')}</h2>
   <p>{t('santacloth의 목표가 쇼핑몰 KPI와 실제 CloudWatch 리소스로 어떻게 이어지는지 실시간 값으로 보여줍니다. KPI를 누르면 계산식이 보입니다.','How santacloth\'s goal flows into storefront KPIs and the CloudWatch resources behind them, with live values. Tap a KPI to see its formula.')}</p></div><span className="badge teal">LIVE · outcome TAG</span></div>
  <Progress active={loading} expectedMs={1500} t={t} steps={[t('관계 데이터 불러오는 중','Loading lineage data')]}/>
  <div className="lineage-flow">
   <div className="node goal"><small>COMPANY GOAL</small><strong>{t('안정적인 쇼핑 경험으로 온라인 매출 성장','Grow online revenue with a reliable shopping experience')}</strong>
    <div className="lineage-kpis">{companyKpis.map(k=><span key={k.def.id} className={'kpi-chip '+k.status}>{en?k.def.name[1]:k.def.name[0]} · {fmtValue(k.value,k.def.unit)}</span>)}</div></div>
   <span className="flow-arrow">↓</span>
   <div className="lineage-shops">{company.shops.map(s=>{const v=shopView(s);return <div className="lineage-shop" key={s.id}>
    <div className="node"><small>STOREFRONT</small><strong>{en?s.name[1]:s.name[0]}</strong><p>outcome={s.id}</p></div>
    <span className="flow-arrow">↓</span>
    <div className="lineage-kpis">{v.kpis.map(k=><button key={k.def.id} className={'kpi-chip '+k.status+(focus===s.id+k.def.id?' focused':'')} onClick={()=>setFocus(focus===s.id+k.def.id?null:s.id+k.def.id)}>{en?k.def.name[1]:k.def.name[0]} · <b>{fmtValue(k.value,k.def.unit)}</b></button>)}</div>
    {v.kpis.filter(k=>focus===s.id+k.def.id).map(k=><div className="callout" key="f">{t('계산식','Formula')}: {refLabel(k.def.numerator,s,company,en)}{k.def.denominator.kind!=='none'&&<> ÷ {refLabel(k.def.denominator,s,company,en)}</>}{k.def.multiplier!==1&&<> × {k.def.multiplier}</>} · {t('목표','target')} {k.def.direction==='lower'?'≤':'≥'} {fmtValue(k.def.target,k.def.unit)}</div>)}
    <span className="flow-arrow">↓</span>
    <div className="lineage-resources">{resources(s.id).length?resources(s.id).map(r=><div className="resource-node" key={r.service+r.name}><span>{r.service.replace('Amazon ','').replace('AWS ','')}</span><small>{r.name} · {r.region}</small></div>)
     :<p className="subtle">{t('태그된 리소스 대기 중 (스냅샷은 10분마다 갱신)','Waiting for tagged resources (snapshot refreshes every 10 minutes)')}</p>}</div>
   </div>})}</div>
  </div>
  <div className="callout">{t('초록=목표 달성, 노랑=목표 미달, 회색=데이터 대기. 수동 입력값(고객만족도·매출 등)은 "경영 KPI" 메뉴에서 바꿀 수 있습니다.','Green = on target, amber = off target, grey = awaiting data. Change manual inputs (satisfaction, revenue, …) in Business KPIs.')}</div>
 </section>;
}

export function Sparkline({requests,errors,t}:{requests:number[];errors:number[];t:T}){
 const w=220,h=46,max=Math.max(1,...requests),step=w/Math.max(1,requests.length);
 if(!requests.some(Boolean))return <p className="subtle">{t('일별 추세는 데이터가 쌓이면 표시됩니다.','Daily trend appears as data accumulates.')}</p>;
 return <svg className="sparkline" viewBox={`0 0 ${w} ${h+12}`} role="img" aria-label={t('최근 일별 요청과 오류','Recent daily requests and errors')}>
  {requests.map((v,i)=><rect key={i} x={i*step+step*.15} width={step*.7} y={h-v/max*h} height={Math.max(v?1:0,v/max*h)} rx={2} fill="#f0d98c"><title>{v} requests, {errors[i]||0} 5xx</title></rect>)}
  {errors.map((v,i)=>v>0&&<circle key={'e'+i} cx={i*step+step/2} cy={Math.max(4,h-v/max*h-4)} r={3} fill="#c0602a"><title>{v} 5xx</title></circle>)}
  <text x="0" y={h+11}>{t('7일 전','7d ago')}</text><text x={w} y={h+11} textAnchor="end">{t('오늘','today')}</text></svg>;
}

export function Actions({santa,t,en,limit=5}:{santa:Santa;t:T;en:boolean;limit?:number}){
 const l=(p:[string,string])=>en?p[1]:p[0];
 return <section className="panel actions"><div className="panel-heading"><div><h2>{t('오늘 할 일','Today\'s actions')}</h2><p>{t('목표를 못 맞춘 KPI를 차이가 큰 순서로 보여줍니다. 실측값만 근거로 쓰고 원인을 단정하지 않습니다.','KPIs off target, largest gap first. Only measured values are cited; causes are not asserted.')}</p></div><span className="badge amber">{santa.actions.length}</span></div>
  {santa.actions.length?<ol className="action-list">{santa.actions.slice(0,limit).map((a,i)=><li key={a.shop+a.kpi[1]+i}><b>{l(a.shopName)} · {l(a.kpi)}</b> <span className="pill amber">{a.value} ({t('목표','target')} {a.target})</span><p>{l(a.action)}</p></li>)}</ol>
   :<p className="subtle">{t('모든 KPI가 목표 안에 있습니다.','Every KPI is on target.')}</p>}
 </section>;
}

export function Executive({santa,t,en,go}:{santa:Santa;t:T;en:boolean;go:(tab:string)=>void}){
 const {company,shopView,companyTotals,loading,outcomes,live}=santa;
 const views=company.shops.map(s=>({shop:s,...shopView(s)}));
 const all=views.flatMap(v=>v.kpis),ok=all.filter(k=>k.status==='ok').length;
 const req=views.reduce((a,v)=>a+(v.cw.api_requests||0),0),err=views.reduce((a,v)=>a+(v.cw.api_errors_5xx||0),0),orders=views.reduce((a,v)=>a+(v.cw.orders_month||0),0);
 const budget=itBudgetKrw(company),used=companyTotals.total_cost_krw_month;
 return <>
  <Progress active={loading} expectedMs={1500} t={t} steps={[t('경영 요약 불러오는 중','Loading the executive summary')]}/>
  {santa.collecting&&<div className="callout">{t('새로 배포된 환경이라 CloudWatch 데모 데이터를 수집하고 있습니다. 몇 분 뒤 새로고침하면 실측값이 표시됩니다.','This environment was just deployed and is collecting CloudWatch demo data. Refresh in a few minutes to see measured values.')}</div>}
  <div className="kpi-grid four">
   <div className="kpi-card static"><div className="card-top"><span>{t('이번 달 예상 AWS 비용','AWS cost this month (est.)')}</span></div><div className="metric-value small">{fmtValue(used,'₩')}</div><div className="metric-bottom"><span className="pill neutral">{t('예산','Budget')} {fmtValue(budget,'₩')}</span><span>{budget?fmtValue(used/budget*100,'%'):'—'}</span></div></div>
   <div className="kpi-card static"><div className="card-top"><span>{t('목표 달성 KPI','KPIs on target')}</span></div><div className="metric-value small">{ok} / {all.length}</div><div className="metric-bottom"><span className={'pill '+(ok===all.length?'green':'amber')}>{all.length-ok} {t('개 미달','off target')}</span></div></div>
   <div className="kpi-card static"><div className="card-top"><span>{t('전체 결제 오류율','Checkout error rate')}</span></div><div className="metric-value small">{req?fmtValue(err/req*100,'%'):'—'}</div><div className="metric-bottom"><span>{fmtValue(req,'')} {t('요청 · 최근 7일','requests · last 7 days')}</span></div></div>
   <div className="kpi-card static"><div className="card-top"><span>{t('가상 주문 (월 환산)','Synthetic orders (monthly)')}</span></div><div className="metric-value small">{fmtValue(orders,'')}</div><div className="metric-bottom"><span>{t('트래픽 생성기 · DynamoDB 쓰기 기준','Traffic generator · DynamoDB writes')}</span></div></div>
  </div>
  <div className="two-col">
   <section className="panel"><div className="panel-heading"><div><h2>{t('쇼핑몰 건강 상태','Storefront health')}</h2><p>{t('태그 outcome으로 묶인 AWS 리소스의 실측값과 수동 입력을 함께 봅니다.','Live values of AWS resources grouped by the outcome tag, alongside manual inputs.')}</p></div><button className="button secondary" onClick={()=>go('business')}>{t('경영 KPI 열기','Open Business KPIs')}</button></div>
    {views.map(v=>{const off=v.kpis.filter(k=>k.status==='breach').length,o=outcomes[v.shop.id];return <div className="health-row" key={v.shop.id}>
     <div><span className={'status-dot '+(off?'warn':'')}/><b>{en?v.shop.name[1]:v.shop.name[0]}</b><small> outcome={v.shop.id}</small>
      <p className="subtle">{t('오류율','Errors')} {fmtValue(v.cw.error_rate_pct,'%')} · {t('처리시간','Checkout')} {fmtValue(v.cw.avg_checkout_ms,'ms')} · {t('월 비용','Cost/mo')} {fmtValue(v.cw.cost_krw_month,'₩')} · {off?t(`${off}개 KPI 미달`,`${off} KPI off target`):t('모든 KPI 달성','All KPIs on target')}</p></div>
     <Sparkline requests={o?.daily_requests||[]} errors={o?.daily_errors_5xx||[]} t={t}/></div>})}
   </section>
   <Actions santa={santa} t={t} en={en} limit={4}/>
  </div>
  <section className="insight"><div><div className="eyebrow">{t('어떻게 연결되나요?','HOW IT CONNECTS')}</div><h3>{t('회사 목표 → 쇼핑몰 KPI → 실제 AWS 리소스','Company goal → storefront KPIs → real AWS resources')}</h3><p>{t('KPI 관계 맵에서 각 숫자가 어떤 리소스와 계산식에서 나왔는지 확인하세요.','See which resources and formulas each number comes from in the KPI lineage.')}</p></div><button className="button" onClick={()=>go('map')}>{t('KPI 관계 맵 보기','View KPI lineage')}</button></section>
  {live&&<p className="subtle">{t('CloudWatch 수집','CloudWatch collected')} {live.collected_at.replace('T',' ').slice(0,16)} UTC · {t('비용은 AWS 공개 단가 추정이며 청구서가 아닙니다.','Costs are AWS public price estimates, not a bill.')}</p>}
 </>;
}
