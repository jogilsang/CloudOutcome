import React, {useEffect, useRef, useState} from 'react';
import {CATALOG, Kpi, Reply, Source, recommend} from './kpis';

type Message={id:number;role:'user'|'bot';text?:string;reply?:Reply};
type Live='cost_per_order'|'success_rate'|'latency_p95';

const sourceLabel:Record<Source,[string,string,string]>={
 cloudwatch:['CloudWatch로 측정','Measured from CloudWatch','teal'],
 'cost-estimate':['비용 추정 사용','Uses cost estimate','amber'],
 'business-events':['비즈니스 이벤트 필요','Needs business events','neutral']};

function KpiCard({kpi,rank,matched,t,en,onOpen}:{kpi:Kpi;rank?:number;matched?:string[];t:(ko:string,en:string)=>string;en:boolean;onOpen:(k:Live)=>void}){
 const l=(p:[string,string])=>en?p[1]:p[0];
 return <article className="kpi-reco">
  <div className="reco-head">{rank!=null&&<span className="reco-rank">{rank}</span>}<div><h3>{l(kpi.name)}</h3><p>{l(kpi.question)}</p></div></div>
  <code>{kpi.formula}</code>
  <p className="subtle">{l(kpi.why)}</p>
  <div className="reco-meta">{kpi.sources.map(s=><span key={s} className={'badge '+sourceLabel[s][2]}>{en?sourceLabel[s][1]:sourceLabel[s][0]}</span>)}<span className="subtle">{t('목표','Target')}: {l(kpi.target)}</span></div>
  {matched&&matched.length>0&&<p className="subtle">{t('추천 근거','Why recommended')}: “{matched.slice(0,4).join('”, “')}”</p>}
  {kpi.live?<button className="button secondary" onClick={()=>onOpen(kpi.live!)}>{t('샘플 데이터로 정의 열기','Open definition with sample data')}</button>
   :<p className="subtle">{t('대시보드 계산은 필요한 데이터 연결 후 가능합니다.','Dashboard calculation becomes available once the required data is connected.')}</p>}
 </article>;
}

export function Studio({t,en,onOpen}:{t:(ko:string,en:string)=>string;en:boolean;onOpen:(k:Live)=>void}){
 const [messages,setMessages]=useState<Message[]>([]),[input,setInput]=useState(''),[catalog,setCatalog]=useState(false);
 const next=useRef(0),end=useRef<HTMLDivElement>(null);
 useEffect(()=>{end.current?.scrollIntoView?.({block:'nearest'})},[messages]);
 const examples=en?['Black Friday is coming and I worry about checkout failures','Leadership wants to know if cloud spend is justified by revenue','Customers say the app feels slow']
  :['블랙프라이데이 세일을 앞두고 결제 장애가 걱정돼요','경영진이 매출 대비 클라우드 비용이 적절한지 묻고 있어요','고객들이 앱이 느리다고 해요'];
 function send(text=input){
  const reply=recommend(text);if(reply.status==='empty')return;
  // Refused text is not displayed back, so sensitive input never stays on screen.
  const shown=reply.status==='refused-sensitive'?t('(민감 정보가 포함되어 표시하지 않습니다)','(hidden: contained sensitive information)'):text.trim();
  setMessages(m=>[...m,{id:next.current++,role:'user',text:shown},{id:next.current++,role:'bot',reply}]);setInput('');
 }
 function botText(r:Reply){
  if(r.status==='refused-sensitive')return t('이메일·전화번호·카드번호·비밀키 같은 정보는 받지 않습니다. 개인정보 없이 상황만 설명해 주세요.','I cannot accept emails, phone numbers, card numbers or secrets. Please describe the situation without personal data.');
  if(r.status==='too-long')return t('500자 이내로 요약해 주세요.','Please keep it under 500 characters.');
  if(r.status==='off-topic')return t('이커머스 비즈니스와 클라우드 운영 KPI에 대해서만 도와드릴 수 있어요. 예: 세일 준비, 결제 장애, 비용 절감, 응답 속도.','I can only help with ecommerce and cloud operations KPIs, such as sale readiness, checkout failures, cost or speed.');
  return r.generic?t('구체적인 단서가 적어서 출발점으로 좋은 기본 KPI 3개를 추천해요. 상황을 더 알려주시면 좁혀 드릴게요.','Not many specifics yet, so here are three good starter KPIs. Tell me more to narrow it down.')
   :t(`설명하신 상황에 맞는 KPI ${r.items.length}개를 우선순위대로 추천해요.`,`Here are ${r.items.length} KPIs ranked for your situation.`);
 }
 return <section className="panel studio-chat"><div className="panel-heading"><div><h2>{t('KPI 추천 대화','KPI recommendation chat')}</h2>
   <p>{t('상황을 편하게 설명하면 미리 정의된 이커머스 KPI 10종 중에서 골라 추천합니다. 입력은 브라우저 밖으로 전송되지 않고, 숫자를 지어내지 않습니다.','Describe your situation and get picks from 10 predefined ecommerce KPIs. Your text stays in this browser and no numbers are invented.')}</p></div>
   <button className="button secondary" onClick={()=>setCatalog(!catalog)}>{catalog?t('대화로 돌아가기','Back to chat'):t('KPI 10종 전체 보기','Browse all 10 KPIs')}</button></div>
  {catalog?<div className="reco-grid">{CATALOG.map(k=><KpiCard key={k.id} kpi={k} t={t} en={en} onOpen={onOpen}/>)}</div>:<>
   <div className="chat-log" aria-live="polite">
    {messages.length===0&&<div className="chat-bubble bot">{t('안녕하세요! 어떤 상황인지 알려주세요. 예를 들어 이벤트 준비, 장애 대응, 비용 점검처럼요.','Hi! Tell me what is going on, for example event prep, an incident, or a cost review.')}</div>}
    {messages.map(m=>m.role==='user'?<div key={m.id} className="chat-bubble user">{m.text}</div>
     :<div key={m.id} className="chat-bubble bot"><p>{botText(m.reply!)}</p>{m.reply!.items.length>0&&<div className="reco-list">{m.reply!.items.map((r,i)=><KpiCard key={r.kpi.id} kpi={r.kpi} rank={i+1} matched={r.matched} t={t} en={en} onOpen={onOpen}/>)}</div>}</div>)}
    <div ref={end}/>
   </div>
   <div className="chips">{examples.map(x=><button key={x} onClick={()=>send(x)}>{x}</button>)}</div>
   <div className="chat-input"><textarea aria-label={t('상황 설명','Describe your situation')} value={input} maxLength={600} onChange={e=>setInput(e.target.value)}
     onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();send()}}} placeholder={t('예: 다음 주 프로모션 트래픽이 3배로 늘 것 같아요','Example: Next week\'s promotion may triple our traffic')}/>
    <button className="button primary" disabled={!input.trim()} onClick={()=>send()}>{t('추천 받기','Recommend')}</button></div>
  </>}
 </section>;
}
