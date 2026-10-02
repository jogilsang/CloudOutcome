import React, {useEffect, useRef, useState} from 'react';
import {Progress} from './progress';
import {Workspace} from './workspace';

// Live AWS usage priced with AWS Price List API list prices. Never presented as a bill.
type InUse = {namespace:string;service:string;regions:Record<string,number>};
export type Estimate = {source:string;mode:string;account:string;region:string;collected_at:string;
 regions_scanned:string[];regions_failed:string[];regions_with_cost:string[];services_in_use:InUse[];discovery:boolean;
 window:{start:string;end_exclusive:string;days:number};total_estimated_usd:number;
 daily:{date:string;estimated_usd:number}[];services:{service:string;resources:number;estimated_usd:number}[];
 resources:{service:string;region:string;name:string;usage:Record<string,number>;estimated_usd:number|null;account?:string;share?:number}[];
 unpriced_resources:number;truncated:boolean;partial_last_day:boolean;
 pricing:{source:string;unit_prices_usd:Record<string,number|null>;free_tier_applied:boolean;supported_services:string[]}};
type Connection = {mode:'role'|'local-profile';profile?:string;external_id:string;role_arn:string|null;region:string|null;verified_at:string|null;trusted_principal_arn:string;template_path:string;regions:string[]};
type Request = <T>(path:string,init?:RequestInit)=>Promise<T>;

export const usd=(x:number|null|undefined)=>{
 if(x==null)return '—';
 if(x===0)return '$0.00';
 if(Math.abs(x)<0.01)return '$'+x.toFixed(Math.min(8,Math.ceil(-Math.log10(Math.abs(x)))+2));
 return '$'+x.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
};
// Unit prices are often below 1e-6; never show scientific notation.
export const unitPrice=(v:number|null)=>v==null?'—':'$'+v.toFixed(10).replace(/0+$/,'').replace(/\.$/,'.0');
export const AUTO_REFRESH_MS=10*60*1000;
const LOCAL=import.meta.env.DEV;

const priceLabels:Record<string,[string,string]>={lambda_request:['Lambda 요청','Lambda request'],lambda_gb_second:['Lambda GB-초 (x86)','Lambda GB-second (x86)'],
 lambda_gb_second_arm:['Lambda GB-초 (Arm)','Lambda GB-second (Arm)'],http_api_request:['HTTP API 요청','HTTP API request'],rest_api_request:['REST API 요청','REST API request'],
 ddb_read_request_unit:['DynamoDB 읽기 요청 단위','DynamoDB read request unit'],ddb_write_request_unit:['DynamoDB 쓰기 요청 단위','DynamoDB write request unit'],ddb_storage_gb_month:['DynamoDB 스토리지 GB-월','DynamoDB storage GB-month']};

function Bars({daily,en}:{daily:Estimate['daily'];en:boolean}){
 const width=660,height=170,left=56,bottom=26,top=10,max=Math.max(...daily.map(d=>d.estimated_usd),1e-9);
 const step=(width-left-10)/daily.length;
 return <svg className="chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={en?'Estimated daily cost':'일별 추정 비용'}>
  {[0,.5,1].map(r=><g key={r}><line x1={left} x2={width-10} y1={height-bottom-r*(height-top-bottom)} y2={height-bottom-r*(height-top-bottom)} stroke="#eee3c9" strokeDasharray="3 4"/><text x={left-8} y={height-bottom-r*(height-top-bottom)+4} textAnchor="end">{usd(max*r)}</text></g>)}
  {daily.map((d,i)=><g key={d.date}><rect x={left+i*step+step*.18} width={step*.64} y={height-bottom-d.estimated_usd/max*(height-top-bottom)} height={Math.max(d.estimated_usd/max*(height-top-bottom),d.estimated_usd>0?1:0)} rx={3} fill={i===daily.length-1?'#f3df91':'#977000'}><title>{d.date}: {usd(d.estimated_usd)}</title></rect>
   {(i===0||i===daily.length-1)&&<text x={left+i*step+step/2} y={height-6} textAnchor="middle">{d.date.slice(5)}</text>}</g>)}
 </svg>;
}

export function EstimateView({data,t,en}:{data:Estimate;t:(ko:string,en:string)=>string;en:boolean}){
 const [allServices,setAllServices]=useState(false);
 const multi=data.resources.some(r=>r.account);
 const services=allServices?data.services_in_use:data.services_in_use.slice(0,12);
 const usage=(u:Record<string,number>)=>Object.entries(u).map(([k,v])=>`${k} ${v.toLocaleString('en-US',{maximumFractionDigits:3})}`).join(' · ');
 return <>
  <div className="kpi-grid">
   <div className="kpi-card static"><div className="card-top"><span>{t('추정 비용 (기간 합계)','Estimated cost (window)')}</span></div><div className="metric-value">{usd(data.total_estimated_usd)}</div><div className="metric-bottom"><span className="pill amber">{t('청구서 아님','Not a bill')}</span><span>{data.window.days}{t('일',' days')} · USD</span></div></div>
   <div className="kpi-card static"><div className="card-top"><span>{t('대상 계정 · 스캔 리전','Account · Regions scanned')}</span></div><div className="metric-value small">{data.account}</div><div className="metric-bottom"><span className="pill neutral">{data.regions_scanned.length}{t('개 리전',' Regions')}{data.regions_failed.length>0&&` · ${t('실패','failed')} ${data.regions_failed.length}`}</span><span>{data.services_in_use.length}{t('개 서비스 사용 중',' services in use')}</span></div></div>
   <div className="kpi-card static"><div className="card-top"><span>{t('수집 시각 (UTC)','Collected (UTC)')}</span></div><div className="metric-value small">{data.collected_at.replace('T',' ').slice(0,16)}</div><div className="metric-bottom"><span className="pill green">CloudWatch</span><span>{t('오늘은 부분 집계','Today is partial')}</span></div></div>
  </div>
  <div className="two-col">
   <section className="panel"><div className="panel-heading"><div><h2>{t('일별 추정 비용','Estimated daily cost')}</h2><p>{data.window.start} → {data.window.end_exclusive} (exclusive)</p></div><span className="badge neutral">{data.window.days}D · USD</span></div><Bars daily={data.daily} en={en}/></section>
   <section className="panel"><div className="panel-heading"><div><h2>{t('서비스별 추정','By service')}</h2><p>{t('지원 서비스만 계산합니다.','Supported services only.')}</p></div></div>
    <table><thead><tr><th>{t('서비스','Service')}</th><th>{t('리소스','Resources')}</th><th>USD</th></tr></thead><tbody>{data.services.map(s=><tr key={s.service}><td>{s.service}</td><td>{s.resources}</td><td>{usd(s.estimated_usd)}</td></tr>)}</tbody></table>
    {data.unpriced_resources>0&&<p className="subtle">{t(`${data.unpriced_resources}개 리소스는 가격 기준이 없어(예: 프로비저닝 용량) 합계에서 제외했습니다.`,`${data.unpriced_resources} resources have no per-use list price (e.g. provisioned capacity) and are excluded.`)}</p>}
   </section>
  </div>
  <section className="panel"><div className="panel-heading"><div><h2>{t('사용 중인 서비스','Services in use')}</h2><p>{t('최근 약 2주간 CloudWatch 지표가 있는 서비스를 모든 활성 리전에서 찾았습니다. 비용 추정은 지원 서비스만 계산합니다.','Services with CloudWatch metrics in roughly the past two weeks, across all enabled Regions. Cost estimates cover supported services only.')}</p></div><span className="badge neutral">{data.regions_scanned.length} REGIONS</span></div>
   {data.discovery?<table><thead><tr><th>{t('서비스','Service')}</th><th>{t('리전 (지표 수)','Regions (metrics)')}</th><th>{t('비용 추정','Estimate')}</th></tr></thead><tbody>{services.map(e=><tr key={e.namespace}><td>{e.service}</td><td>{Object.entries(e.regions).sort().map(([r,c])=><span className="badge neutral region-chip" key={r}>{r} · {c}</span>)}</td><td className="nowrap">{data.pricing.supported_services.includes(e.service)?<span className="pill green">{t('지원','Supported')}</span>:<span className="subtle">{t('지표만','Metrics only')}</span>}</td></tr>)}</tbody></table>
    :<div className="callout">{t('연결된 역할에 cloudwatch:ListMetrics·ec2:DescribeRegions 권한이 없어 홈 리전만 조회했습니다. 최신 템플릿으로 스택을 업데이트하면 전 리전 서비스가 표시됩니다.','The connected role lacks cloudwatch:ListMetrics and ec2:DescribeRegions, so only the home Region was read. Update the stack with the latest template to see every Region.')}</div>}
   {data.discovery&&data.services_in_use.length>12&&<button className="button secondary" onClick={()=>setAllServices(!allServices)}>{allServices?t('접기','Show fewer'):t(`모두 보기 (${data.services_in_use.length}개)`,`Show all (${data.services_in_use.length})`)}</button>}
   {data.regions_failed.length>0&&<p className="subtle">{t('조회 실패 리전','Regions not readable')}: {data.regions_failed.join(', ')}</p>}
  </section>
  <section className="panel"><div className="panel-heading"><div><h2>{t('리소스별 사용량과 추정 비용','Usage and estimate by resource')}</h2><p>{data.mode==='public-live-demo'?t('공개 데모는 CloudOutcome 자체 리소스(outcomelens-*) 외 이름을 가립니다.','The public demo pseudonymizes names outside CloudOutcome resources (outcomelens-*).'):t('연결한 계정의 실제 리소스 이름입니다.','Actual resource names from your connected account.')}</p></div><span className="badge teal">{data.mode==='public-live-demo'?'PUBLIC SNAPSHOT':multi?'ACCOUNTS':'CONNECTED'}</span></div>
   <table><thead><tr><th>{t('서비스','Service')}</th>{multi&&<th>{t('계정','Account')}</th>}<th>{t('리전','Region')}</th><th>{t('리소스','Resource')}</th><th>{t('사용량','Usage')}</th><th>USD</th></tr></thead><tbody>{data.resources.slice(0,15).map(r=><tr key={(r.account||'')+r.region+r.service+r.name}><td>{r.service}</td>{multi&&<td><code>{r.account}</code></td>}<td>{r.region}</td><td><code>{r.name}</code>{r.share!=null&&r.share<1&&<span className="subtle"> · {Math.round(r.share*100)}%</span>}</td><td className="subtle">{usage(r.usage)}</td><td>{usd(r.estimated_usd)}</td></tr>)}</tbody></table>
   {data.truncated&&<p className="subtle">{t('서비스당 40개까지만 수집했습니다.','Collection is capped at 40 resources per service.')}</p>}
  </section>
  <section className="panel"><div className="panel-heading"><div><h2>{t('가격 근거','Pricing evidence')}</h2><p>{data.pricing.source} · {t('표시 단가','shown for')} {data.region} · {t('리전별 단가 적용','per-Region prices applied')}</p></div><span className="badge amber">{t('프리 티어 미적용','FREE TIER NOT APPLIED')}</span></div>
   <table><tbody>{Object.entries(data.pricing.unit_prices_usd).map(([k,v])=><tr key={k}><td>{priceLabels[k]?.[en?1:0]||k}</td><td><code>{unitPrice(v)}</code></td></tr>)}</tbody></table>
   <div className="callout">{t('CloudWatch 사용량 × AWS Price List API 공개 온디맨드 단가로 계산한 추정치입니다. 조직 정책으로 Cost Explorer를 쓸 수 없는 계정도 사용할 수 있지만, 프리 티어·크레딧·할인·세금과 미지원 서비스는 반영하지 않으므로 실제 청구액과 다릅니다.','Estimated from CloudWatch usage × AWS Price List API public on-demand prices. Works where organization policy blocks Cost Explorer, but excludes Free Tier, credits, discounts, taxes and unsupported services, so it differs from your bill.')}<br/>{t('지원','Supported')}: {data.pricing.supported_services.join(', ')}</div>
  </section>
 </>;
}

export function LivePanel({t,en,signedIn,onSignIn,request,publicRequest}:{t:(ko:string,en:string)=>string;en:boolean;signedIn:boolean;onSignIn:()=>void;request:Request;publicRequest:Request}){
 const [source,setSource]=useState<'demo'|'mine'>('demo'),[days,setDays]=useState(7);
 const [data,setData]=useState<Estimate|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false);
 const [tick,setTick]=useState(0),[updatedAt,setUpdatedAt]=useState<Date|null>(null);
 const forced=useRef(false);
 // While this page is visible, refresh every 10 minutes; hidden tabs make no AWS calls.
 useEffect(()=>{const timer=setInterval(()=>{if(document.visibilityState==='visible')setTick(x=>x+1)},AUTO_REFRESH_MS);
  const back=()=>{if(document.visibilityState==='visible'&&updatedAt&&Date.now()-updatedAt.getTime()>AUTO_REFRESH_MS)setTick(x=>x+1)};
  document.addEventListener('visibilitychange',back);return()=>{clearInterval(timer);document.removeEventListener('visibilitychange',back)}},[updatedAt]);
 function refreshNow(){forced.current=true;setTick(x=>x+1)}
 const scope=`${source}|${days}`,shown=useRef('');
 useEffect(()=>{let alive=true;setError('');
  if(source==='mine'){setData(null);setLoading(false);return}
  if(shown.current!==scope)setData(null); // keep current numbers visible during a refresh of the same view
  const refresh=forced.current?'&refresh=true':'';forced.current=false;
  setLoading(true);
  publicRequest<Estimate>(`/live-demo?days=${days}${refresh}`)
   .then(x=>{if(alive){setData(x);shown.current=scope;setUpdatedAt(new Date())}}).catch(e=>{if(alive)setError(e.message)}).finally(()=>{if(alive)setLoading(false)});
  return()=>{alive=false}},[source,days,tick]);
 return <>
  <div className="filters"><label>{t('데이터 출처','Data source')}<select value={source} onChange={e=>setSource(e.target.value as 'demo'|'mine')}><option value="demo">{t('라이브 데모 계정 (읽기 전용 스냅샷)','Live demo account (read-only snapshot)')}</option><option value="mine">{t('내 AWS 계정 연결','Connect my AWS account')}</option></select></label>
   <label>{t('분석 기간','Window')}<select value={days} onChange={e=>setDays(Number(e.target.value))}>{[7,14,30].map(d=><option key={d} value={d}>{d}{t('일',' days')}</option>)}</select></label>
   {source==='demo'&&<><div className="filter-status"><span className="status-dot"/>{loading?t('수집 중','Collecting'):t('AWS Price List 기반 추정','AWS Price List estimate')}</div>
   <button className="button secondary" disabled={loading} onClick={refreshNow}>{loading?t('새로고침 중…','Refreshing…'):t('새로고침','Refresh')}</button></>}</div>
  {source==='demo'&&<p className="subtle refresh-note">{t('이 페이지를 보고 있는 동안 10분마다 자동으로 새로고침합니다.','While this page is visible it refreshes automatically every 10 minutes.')} {updatedAt&&<>{t('마지막 갱신','Last updated')} {updatedAt.toLocaleTimeString(en?'en-US':'ko-KR')}.</>} {source==='demo'?t('라이브 데모 데이터는 서버가 10분마다 수집하므로 그 사이에는 같은 값이 보일 수 있습니다.','The live demo is collected by the server every 10 minutes, so values may repeat between collections.'):t('새로고침 버튼은 연결된 계정을 즉시 다시 조회합니다(전 리전, 수 초 소요).','Refresh re-reads the connected account immediately (all Regions, takes a few seconds).')}</p>}
  {error&&<div className="error" role="alert">{error}</div>}
  {source==='mine'&&<Workspace t={t} en={en} signedIn={signedIn} onSignIn={onSignIn} request={request} days={days}/>}
  <Progress active={loading} expectedMs={source==='demo'&&!LOCAL?1500:12000} t={t} steps={[t('활성 리전 확인','Finding enabled Regions'),t('리전별 리소스 조회','Listing resources per Region'),t('CloudWatch 지표 수집','Reading CloudWatch metrics'),t('사용 중인 서비스 탐색','Discovering services in use'),t('공개 단가로 비용 계산','Pricing with public list prices')]}/>
  {source==='demo'&&data&&((data as {status?:string}).status==='collecting'?<div className="callout">{t('새로 배포된 환경이라 라이브 데모 데이터를 수집하고 있습니다(최대 10분). 잠시 후 새로고침하세요.','This environment was just deployed and is collecting live demo data (up to 10 minutes). Refresh shortly.')}</div>:<EstimateView data={data} t={t} en={en}/>)}
 </>;
}
