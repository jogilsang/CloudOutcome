import React, {useEffect, useRef, useState} from 'react';
import {Progress} from './progress';
import {CATALOG} from './kpis';
import {anonFetch, anonWorkspace, createAnonWorkspace, forgetAnonWorkspace, AnonWorkspace} from './auth';
import {EstimateView, Estimate, AUTO_REFRESH_MS, usd} from './live';

type Account={id:string;status:'pending'|'connected'|'failed';checked_at:string|null;reason:string|null};
type ProgressState={started_at:string|null;total:number;done:number;running:boolean;failed?:string[]};
type Rule={type:'tag'|'name';key?:string;value?:string;contains?:string;share_pct:number};
type Service={id?:string;name:string;accounts:string[];rules:Rule[];kpis:{id:string;target:number|null}[];business:{monthly_revenue_usd?:number;monthly_orders?:number;monthly_active_users?:number}};
type Connection={external_id:string;role_name:string;trusted_account_id:string;template_path:string;expires_at:number|null;mode:string;local_profile_account:string|null;max_accounts:number};
type Live={view:(Estimate&{accounts?:{id:string;estimated_usd:number;collected_at:string;resources:number}[]})|null;progress:ProgressState;connected:number;
 service?:Service&{kpi_values:{id:string;target:number|null;value:number|null}[];monthly_estimated_usd:number}};
type Req=<T>(path:string,init?:RequestInit)=>Promise<T>;
type T=(ko:string,en:string)=>string;

export const splitAccounts=(text:string)=>Array.from(new Set(text.split(/[\s,;]+/).map(x=>x.trim()).filter(Boolean)));
const reasonText=(r:string|null,t:T)=>r==='assume-role-denied'?t('역할 없음/신뢰·External ID 불일치','Role missing or trust/External ID mismatch'):r==='account-mismatch'?t('다른 계정 응답','Different account answered'):r||'';

function Warning({onAccept,onCancel,t}:{onAccept:()=>void;onCancel:()=>void;t:T}){
 const [ok,setOk]=useState(false);
 return <div className="modal-overlay" onClick={onCancel}><section className="modal" role="dialog" aria-modal="true" aria-label={t('로그인 없이 연결','Connect without signing in')} onClick={e=>e.stopPropagation()}>
  <div className="eyebrow">{t('주의','BEFORE YOU CONTINUE')}</div><h2>{t('로그인 없이 계정 연결','Connect without signing in')}</h2>
  <ul className="warning-list">
   <li>{t('이 브라우저에만 저장되는 임시 워크스페이스가 만들어지고 7일 후 자동 삭제됩니다.','A temporary workspace is created for this browser only and is deleted automatically after 7 days.')}</li>
   <li>{t('브라우저 저장소를 지우거나 다른 기기에서는 이 연결을 다시 볼 수 없습니다. 공용 PC에서는 사용하지 마세요.','Clearing browser storage or switching devices loses access. Do not use a shared computer.')}</li>
   <li>{t('CloudOutcome은 자격 증명을 받지 않습니다. 각 계정의 읽기 전용 역할(cloud_outcome_readonlyaccess)로만 조회합니다.','CloudOutcome never receives credentials; it reads only through each account\'s read-only role (cloud_outcome_readonlyaccess).')}</li>
   <li>{t('저장되는 것은 계정 ID, 연결 상태, 사용량 요약뿐이며 스택을 삭제하면 즉시 접근이 끊깁니다.','Only account IDs, connection status and usage summaries are stored; deleting the stack revokes access immediately.')}</li>
   <li>{t('조직의 보안 정책상 외부 서비스 연결 승인이 필요하다면 먼저 승인을 받으세요.','If your organization requires approval for third-party access, get it first.')}</li></ul>
  <label className="check"><input type="checkbox" checked={ok} onChange={e=>setOk(e.target.checked)}/>{t('위 내용을 이해했습니다.','I understand.')}</label>
  <div className="modal-actions"><button className="button secondary" onClick={onCancel}>{t('취소','Cancel')}</button><button className="button primary" disabled={!ok} onClick={onAccept}>{t('임시 워크스페이스로 계속','Continue with a temporary workspace')}</button></div>
 </section></div>;
}

function ServiceEditor({initial,accounts,onSave,onCancel,t,en}:{initial:Service;accounts:string[];onSave:(s:Service)=>void;onCancel:()=>void;t:T;en:boolean}){
 const [s,setS]=useState<Service>(initial);
 const setRule=(i:number,patch:Partial<Rule>)=>setS({...s,rules:s.rules.map((r,j)=>j===i?{...r,...patch}:r)});
 const kpi=(id:string)=>s.kpis.find(k=>k.id===id);
 const num=(v:string)=>v===''?undefined:Number(v);
 return <section className="panel service-editor"><h2>{initial.id?t('서비스 수정','Edit service'):t('비즈니스 서비스 추가','Add a business service')}</h2>
  <div className="form-row"><label>{t('서비스 이름','Service name')}<input value={s.name} maxLength={60} placeholder={t('예: X마트 쇼핑몰','e.g. X-Mart store')} onChange={e=>setS({...s,name:e.target.value})}/></label></div>
  <fieldset><legend>{t('포함 계정 (비우면 연결된 전체)','Accounts (empty = all connected)')}</legend><div className="check-grid">{accounts.map(a=><label className="check" key={a}><input type="checkbox" checked={s.accounts.includes(a)} onChange={e=>setS({...s,accounts:e.target.checked?[...s.accounts,a]:s.accounts.filter(x=>x!==a)})}/>{a}</label>)}</div></fieldset>
  <fieldset><legend>{t('리소스 규칙 (먼저 일치한 규칙의 비율로 비용 안분)','Resource rules (first match sets the cost share)')}</legend>
   {s.rules.map((r,i)=><div className="rule-row" key={i}><select value={r.type} onChange={e=>setRule(i,{type:e.target.value as Rule['type']})}><option value="tag">{t('태그','Tag')}</option><option value="name">{t('이름 포함','Name contains')}</option></select>
    {r.type==='tag'?<><input placeholder="key" value={r.key||''} maxLength={128} onChange={e=>setRule(i,{key:e.target.value})}/><input placeholder="value" value={r.value||''} maxLength={256} onChange={e=>setRule(i,{value:e.target.value})}/></>
     :<input placeholder={t('예: xmart-','e.g. xmart-')} value={r.contains||''} maxLength={64} onChange={e=>setRule(i,{contains:e.target.value})}/>}
    <label className="share">{t('비율','Share')}<input type="number" min={1} max={100} value={r.share_pct} onChange={e=>setRule(i,{share_pct:Number(e.target.value)})}/>%</label>
    <button className="link-button" onClick={()=>setS({...s,rules:s.rules.filter((_,j)=>j!==i)})}>{t('삭제','Remove')}</button></div>)}
   <button className="button secondary" onClick={()=>setS({...s,rules:[...s.rules,{type:'tag',key:'service',value:'',share_pct:100}]})}>{t('규칙 추가','Add rule')}</button></fieldset>
  <fieldset><legend>{t('관리할 KPI와 목표','KPIs and targets')}</legend><div className="check-grid">{CATALOG.map(k=><label className="check" key={k.id}><input type="checkbox" checked={!!kpi(k.id)} onChange={e=>setS({...s,kpis:e.target.checked?[...s.kpis,{id:k.id,target:null}]:s.kpis.filter(x=>x.id!==k.id)})}/>{en?k.name[1]:k.name[0]}
    {kpi(k.id)&&<input className="target" type="number" step="any" placeholder={t('목표','target')} value={kpi(k.id)!.target??''} onChange={e=>setS({...s,kpis:s.kpis.map(x=>x.id===k.id?{...x,target:e.target.value===''?null:Number(e.target.value)}:x)})}/>}</label>)}</div></fieldset>
  <fieldset><legend>{t('비즈니스 입력 (선택, 개인정보 없이 월 합계)','Business inputs (optional monthly totals, no personal data)')}</legend><div className="form-row">
   <label>{t('월 매출 (USD)','Monthly revenue (USD)')}<input type="number" min={0} value={s.business.monthly_revenue_usd??''} onChange={e=>setS({...s,business:{...s.business,monthly_revenue_usd:num(e.target.value)}})}/></label>
   <label>{t('월 주문 수','Monthly orders')}<input type="number" min={0} value={s.business.monthly_orders??''} onChange={e=>setS({...s,business:{...s.business,monthly_orders:num(e.target.value)}})}/></label>
   <label>{t('월 활성 사용자','Monthly active users')}<input type="number" min={0} value={s.business.monthly_active_users??''} onChange={e=>setS({...s,business:{...s.business,monthly_active_users:num(e.target.value)}})}/></label></div></fieldset>
  <div className="modal-actions"><button className="button secondary" onClick={onCancel}>{t('취소','Cancel')}</button><button className="button primary" disabled={!s.name.trim()||!s.rules.length} onClick={()=>onSave(s)}>{t('저장','Save')}</button></div>
 </section>;
}

export function Workspace({t,en,signedIn,onSignIn,request,days}:{t:T;en:boolean;signedIn:boolean;onSignIn:()=>void;request:Req;days:number}){
 const [anon,setAnon]=useState<AnonWorkspace|null>(()=>signedIn?null:anonWorkspace()),[warn,setWarn]=useState(false);
 const ready=signedIn||!!anon;
 const call:Req=async(path,init)=>{
  if(signedIn)return request('/workspace'+path,init);
  const r=await anonFetch(path,init,anon!);const body=await r.json().catch(()=>({}));
  if(r.status===401){forgetAnonWorkspace();setAnon(null)}
  if(!r.ok)throw Error(typeof body.detail==='string'?body.detail:`HTTP ${r.status}`);return body;};
 const [conn,setConn]=useState<Connection|null>(null),[accounts,setAccounts]=useState<Account[]>([]),[progress,setProgress]=useState<ProgressState|null>(null);
 const [text,setText]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(''),[copied,setCopied]=useState('');
 const [services,setServices]=useState<Service[]>([]),[editing,setEditing]=useState<Service|null>(null);
 const [scope,setScope]=useState('all'),[live,setLive]=useState<Live|null>(null),[updatedAt,setUpdatedAt]=useState<Date|null>(null);
 const run=async(label:string,fn:()=>Promise<void>)=>{setBusy(label);setError('');try{await fn()}catch(e){setError((e as Error).message)}finally{setBusy('')}};
 const loadAccounts=async()=>{const r=await call<{accounts:Account[];progress:ProgressState}>('/accounts');setAccounts(r.accounts);setProgress(r.progress)};
 // Timers and polling can finish after the user switches scope; only the latest requested scope may update the view.
 const wanted=useRef('');wanted.current=`${scope}|${days}`;
 const loadLive=async()=>{const key=`${scope}|${days}`,q=scope==='all'?'':scope.startsWith('acct:')?`&account=${scope.slice(5)}`:`&service=${encodeURIComponent(scope.slice(4))}`;
  const r=await call<Live>(`/live?days=${days}${q}`);if(key!==wanted.current)return;setLive(r);setProgress(r.progress);setUpdatedAt(new Date())};
 useEffect(()=>{if(!ready)return;run('load',async()=>{setConn(await call<Connection>('/connection'));await loadAccounts();setServices((await call<{services:Service[]}>('/services')).services)})},[ready]);
 useEffect(()=>{if(ready)run('',loadLive)},[ready,scope,days]);
 // While a collection runs, poll its real progress (accounts done / total).
 useEffect(()=>{if(!progress?.running)return;const timer=setInterval(()=>{loadLive().catch(()=>{})},3000);return()=>clearInterval(timer)},[progress?.running,scope,days]);
 // Every 10 minutes while visible, collect only stale snapshots of connected accounts.
 useEffect(()=>{if(!ready)return;const timer=setInterval(()=>{if(document.visibilityState==='visible')call('/collect',{method:'POST',body:JSON.stringify({only_stale:true})}).then(loadLive).catch(()=>{})},AUTO_REFRESH_MS);return()=>clearInterval(timer)},[ready,scope,days]);
 async function startAnon(){setWarn(false);await run('anon',async()=>setAnon(await createAnonWorkspace()))}
 const save=()=>run('save',async()=>{const r=await call<{accounts:Account[];progress:ProgressState}>('/accounts',{method:'PUT',body:JSON.stringify({accounts:splitAccounts(text)})});setAccounts(r.accounts);setProgress(r.progress);await loadLive()});
 const sync=()=>run('sync',async()=>{const r=await call<{accounts:Account[];progress:ProgressState}>('/sync',{method:'POST',body:'{}'});setAccounts(r.accounts);setProgress(r.progress);await loadLive()});
 const refresh=()=>run('refresh',async()=>{const r=await call<{progress:ProgressState}>('/collect',{method:'POST',body:JSON.stringify({only_stale:false})});setProgress(r.progress);await loadLive()});
 const saveServices=(list:Service[])=>run('services',async()=>{setServices((await call<{services:Service[]}>('/services',{method:'PUT',body:JSON.stringify({services:list})})).services);setEditing(null)});
 async function file(e:React.ChangeEvent<HTMLInputElement>){const f=e.target.files?.[0];if(f)setText((await f.text()).slice(0,5000))}
 const copy=async(label:string,value:string)=>{try{await navigator.clipboard.writeText(value);setCopied(label);setTimeout(()=>setCopied(''),2000)}catch{setCopied('')}};
 if(!ready)return <>{warn&&<Warning t={t} onAccept={startAnon} onCancel={()=>setWarn(false)}/>}
  <section className="panel"><h2>{t('내 AWS 계정 연결','Connect your AWS accounts')}</h2><p>{t('로그인하면 연결이 워크스페이스에 계속 저장됩니다. 로그인 없이도 임시 워크스페이스(7일)로 바로 연결할 수 있습니다.','Sign in to keep connections in your workspace, or connect right away with a 7-day temporary workspace.')}</p>
   <div className="modal-actions start"><button className="button primary" onClick={()=>setWarn(true)}>{t('로그인 없이 연결','Connect without signing in')}</button><button className="button secondary" onClick={onSignIn}>{t('로그인','Sign in')}</button></div></section></>;
 const connected=accounts.filter(a=>a.status==='connected'),failed=accounts.filter(a=>a.status==='failed');
 const origin=location.origin,ext=conn?.external_id||'',trust=conn?.trusted_account_id||'';
 const single=`curl -fsSL ${origin}${conn?.template_path} -o cloudoutcome-role.json && aws cloudformation deploy --stack-name CloudOutcomeReadOnlyAccess --template-file cloudoutcome-role.json --capabilities CAPABILITY_NAMED_IAM --parameter-overrides ExternalIds=${ext} TrustedAccountId=${trust} && aws sts get-caller-identity --query Account --output text`;
 const stackset=`curl -fsSL ${origin}${conn?.template_path} -o cloudoutcome-role.json && aws cloudformation create-stack-set --stack-set-name CloudOutcomeReadOnlyAccess --template-body file://cloudoutcome-role.json --capabilities CAPABILITY_NAMED_IAM --permission-model SERVICE_MANAGED --auto-deployment Enabled=true,RetainStacksOnAccountRemoval=false --parameters ParameterKey=ExternalIds,ParameterValue=${ext} ParameterKey=TrustedAccountId,ParameterValue=${trust} && aws cloudformation create-stack-instances --stack-set-name CloudOutcomeReadOnlyAccess --deployment-targets OrganizationalUnitIds=<root-or-ou-id> --regions us-east-1`;
 const pct=progress&&progress.total?Math.round(progress.done/progress.total*100):0;
 return <>
  {error&&<div className="error" role="alert">{error}</div>}
  <section className="panel"><div className="panel-heading"><div><h2>{t('계정 연결','Account connections')}</h2>
    <p>{conn?.mode==='temporary'?t(`임시 워크스페이스 · ${conn.expires_at?new Date(conn.expires_at*1000).toLocaleDateString(en?'en-US':'ko-KR'):''} 만료`,`Temporary workspace · expires ${conn.expires_at?new Date(conn.expires_at*1000).toLocaleDateString('en-US'):''}`):conn?.mode==='local'?t('로컬 개발 워크스페이스','Local development workspace'):t('로그인 워크스페이스','Signed-in workspace')}</p></div>
    <span className="badge teal">{connected.length}/{accounts.length} {t('연결됨','connected')}</span></div>
   <div className="callout important"><b>{t('필수: 각 계정에 IAM 역할 ','Required: create the IAM role ')}<code>{conn?.role_name}</code>{t(' 을 이 이름 그대로 만들어야 연결됩니다.',' in each account with exactly this name.')}</b><br/>
    {t('신뢰 관계는 CloudOutcome 계정','Trust: CloudOutcome account')} <code>{trust}</code> {t('의 런타임 역할로만 제한되며 External ID','runtime roles only, with External ID')} <code>{ext}</code> {t('가 일치해야 합니다. 읽기 전용(목록·지표·태그)이며 스택 삭제로 해제됩니다.','. Read-only (lists, metrics, tags); delete the stack to revoke.')}</div>
   <details open={!accounts.length}><summary>{t('역할 만들기 (계정 1개 · CloudShell)','Create the role (one account · CloudShell)')}</summary>
    <p className="subtle">{t('AWS 콘솔에 로그인된 브라우저에서 CloudShell을 열고 명령을 붙여 넣으세요. 마지막 줄에 계정 ID가 출력됩니다.','Open CloudShell in a browser signed in to the console and paste the command. It prints the account ID last.')} <a className="link-button" href="https://console.aws.amazon.com/cloudshell/home?region=us-east-1" target="_blank" rel="noopener noreferrer">{t('CloudShell 열기 ↗','Open CloudShell ↗')}</a></p>
    <code className="block">{single}</code><button className="button secondary" onClick={()=>copy('single',single)}>{copied==='single'?t('복사됨 ✓','Copied ✓'):t('명령 복사','Copy command')}</button></details>
   <details><summary>{t('역할 만들기 (계정 여러 개 · Organizations StackSets)','Create the role (many accounts · Organizations StackSets)')}</summary>
    <p className="subtle">{t('관리 계정(또는 위임 관리자)의 CloudShell에서 실행하세요. <root-or-ou-id>를 대상 OU 또는 루트 ID로 바꾸면 조직의 모든 계정에 같은 이름의 역할이 만들어집니다.','Run in the management (or delegated admin) account CloudShell. Replace <root-or-ou-id> with the target OU or root ID to create the same role in every account.')}</p>
    <code className="block">{stackset}</code><button className="button secondary" onClick={()=>copy('stackset',stackset)}>{copied==='stackset'?t('복사됨 ✓','Copied ✓'):t('명령 복사','Copy command')}</button></details>
   <label className="stack">{t(`계정 ID 목록 (최대 ${conn?.max_accounts||100}개, 쉼표·줄바꿈·공백 구분)`,`Account IDs (up to ${conn?.max_accounts||100}; commas, new lines or spaces)`)}
    <textarea value={text} placeholder={'111111111111, 222222222222\n333333333333'} onChange={e=>setText(e.target.value)}/></label>
   <div className="modal-actions start"><label className="button secondary file-button">{t('accounts.list 파일 불러오기','Load accounts.list file')}<input type="file" accept=".list,.txt,.csv" onChange={file}/></label>
    {conn?.local_profile_account&&<button className="button secondary" onClick={()=>setText(x=>splitAccounts(x+' '+conn.local_profile_account).join('\n'))}>{t('로컬 프로필 계정 추가','Add local profile account')}</button>}
    <button className="button primary" disabled={!!busy||!splitAccounts(text).length} onClick={save}>{busy==='save'?t('저장·점검 중…','Saving and checking…'):t(`${splitAccounts(text).length}개 계정 저장 후 연결 점검`,`Save ${splitAccounts(text).length} accounts and check`)}</button></div>
   {accounts.length>0&&<><div className="panel-heading compact"><h3>{t('계정별 연결 상태','Connection status by account')}</h3>
     <button className="button secondary" disabled={!!busy} onClick={sync}>{busy==='sync'?t('Sync 중…','Syncing…'):t('Sync (다시 점검)','Sync (re-check)')}</button></div>
    <p className="subtle">{t('하루 한 번 자동으로 점검합니다. 실패한 계정은 다음 점검에서 성공할 때까지 데이터를 가져오지 않습니다.','Checked automatically once a day. Failed accounts are not collected until a check succeeds.')} {failed.length>0&&t(`실패 ${failed.length}개`,`${failed.length} failed`)}</p>
    <table><thead><tr><th>{t('계정','Account')}</th><th>{t('상태','Status')}</th><th>{t('사유','Reason')}</th><th>{t('점검 시각 (UTC)','Checked (UTC)')}</th></tr></thead>
     <tbody>{accounts.map(a=><tr key={a.id}><td><code>{a.id}</code></td><td><span className={'pill '+(a.status==='connected'?'green':a.status==='failed'?'amber':'neutral')}>{a.status==='connected'?t('연결됨','Connected'):a.status==='failed'?t('실패','Failed'):t('대기','Pending')}</span></td><td className="subtle">{reasonText(a.reason,t)}</td><td className="subtle">{a.checked_at?.replace('T',' ').slice(0,16)||'—'}</td></tr>)}</tbody></table></>}
  </section>
  {connected.length>0&&<>
   <div className="filters"><label>{t('보기 범위','Scope')}<select value={scope} onChange={e=>setScope(e.target.value)}><option value="all">{t(`연결된 전체 계정 (${connected.length})`,`All connected accounts (${connected.length})`)}</option>
     <optgroup label={t('비즈니스 서비스','Business services')}>{services.map(s=><option key={s.id} value={'svc:'+s.id}>{s.name}</option>)}</optgroup>
     <optgroup label={t('계정','Accounts')}>{connected.map(a=><option key={a.id} value={'acct:'+a.id}>{a.id}</option>)}</optgroup></select></label>
    <div className="filter-status"><span className="status-dot"/>{progress?.running?t('수집 중','Collecting'):t('스냅샷 기준','From snapshots')}</div>
    <button className="button secondary" disabled={!!busy||progress?.running} onClick={refresh}>{t('새로고침','Refresh')}</button></div>
   <p className="subtle refresh-note">{t('연결된 계정만 백그라운드에서 수집하며, 보고 있는 동안 10분마다 오래된 계정을 다시 수집합니다.','Only connected accounts are collected in the background; while visible, stale accounts are re-collected every 10 minutes.')} {updatedAt&&<>{t('마지막 갱신','Last updated')} {updatedAt.toLocaleTimeString(en?'en-US':'ko-KR')}.</>}</p>
   {progress?.running&&<div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}><div className="progress-track"><div className="progress-fill" style={{width:pct+'%'}}/></div>
    <div className="progress-label"><span>{t('계정 수집 중 (실제 진행률)','Collecting accounts (actual progress)')}</span><span>{progress.done}/{progress.total} · {pct}%</span></div></div>}
   {!!progress?.failed?.length&&<div className="callout">{t(`수집에 실패한 계정: ${progress.failed.join(', ')} — 연결은 유지되며 다음 새로고침에서 다시 시도합니다.`,`Collection failed for: ${progress.failed.join(', ')}. They stay connected and are retried on the next refresh.`)}</div>}
   <Progress active={busy==='load'} expectedMs={3000} t={t} steps={[t('워크스페이스 불러오는 중','Loading workspace')]}/>
   <section className="panel"><div className="panel-heading"><div><h2>{t('비즈니스 서비스','Business services')}</h2><p>{t('여러 계정의 리소스를 태그나 이름으로 묶어 서비스 단위로 비용을 안분하고 KPI를 관리합니다.','Group resources across accounts by tag or name to allocate cost and manage KPIs per service.')}</p></div>
     <button className="button secondary" onClick={()=>setEditing({name:'',accounts:[],rules:[{type:'tag',key:'service',value:'',share_pct:100}],kpis:[{id:'api_error_rate',target:0.1}],business:{}})}>{t('서비스 추가','Add service')}</button></div>
    {services.length?<table><thead><tr><th>{t('서비스','Service')}</th><th>{t('계정','Accounts')}</th><th>{t('규칙','Rules')}</th><th/></tr></thead><tbody>{services.map(s=><tr key={s.id}><td><b>{s.name}</b></td><td>{s.accounts.length||t('전체','All')}</td>
      <td className="subtle">{s.rules.map(r=>r.type==='tag'?`${r.key}=${r.value}`:`*${r.contains}*`).map((x,i)=>`${x} (${s.rules[i].share_pct}%)`).join(', ')}</td>
      <td className="nowrap"><button className="link-button" onClick={()=>setScope('svc:'+s.id)}>{t('보기','View')}</button> · <button className="link-button" onClick={()=>setEditing(s)}>{t('수정','Edit')}</button> · <button className="link-button" onClick={()=>saveServices(services.filter(x=>x.id!==s.id))}>{t('삭제','Delete')}</button></td></tr>)}</tbody></table>
     :<p className="subtle">{t('예: "X마트 쇼핑몰" = 계정 3개 중 태그 service=x-mart 리소스 100% + 공용 API 30%','Example: "X-Mart store" = resources tagged service=x-mart at 100% plus a shared API at 30%, across three accounts')}</p>}
   </section>
   {editing&&<ServiceEditor initial={editing} accounts={connected.map(a=>a.id)} t={t} en={en} onCancel={()=>setEditing(null)}
     onSave={s=>saveServices(editing.id?services.map(x=>x.id===editing.id?{...s,id:editing.id}:x):[...services,s])}/>}
   {live?.service&&<section className="panel"><div className="panel-heading"><div><h2>{live.service.name} · KPI</h2><p>{t(`월 환산 추정 비용 ${usd(live.service.monthly_estimated_usd)} (최근 ${days}일 기준)`,`Monthly-equivalent estimate ${usd(live.service.monthly_estimated_usd)} (from the last ${days} days)`)}</p></div></div>
    <table><thead><tr><th>KPI</th><th>{t('목표','Target')}</th><th>{t('현재','Current')}</th></tr></thead><tbody>{live.service.kpi_values.map(k=>{const def=CATALOG.find(c=>c.id===k.id);return <tr key={k.id}><td>{def?(en?def.name[1]:def.name[0]):k.id}</td><td>{k.target??'—'}</td>
     <td>{k.value==null?<span className="subtle">{def?.sources.includes('business-events')?t('비즈니스 데이터 입력 필요','Needs business inputs'):t('지표 연결 예정','Metric not connected yet')}</span>:<b>{k.value.toLocaleString('en-US',{maximumFractionDigits:6})}</b>}</td></tr>})}</tbody></table></section>}
   {live?.view?<EstimateView data={live.view} t={t} en={en}/>:!progress?.running&&<div className="callout">{t('아직 수집된 스냅샷이 없습니다. 새로고침을 누르면 연결된 계정을 수집합니다.','No snapshots yet. Press Refresh to collect connected accounts.')}</div>}
  </>}
 </>;
}
