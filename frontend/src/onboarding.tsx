import React, {useEffect, useState} from 'react';

const SEEN_KEY='cloudoutcome-onboarding-v1';
export function onboardingSeen(){try{return localStorage.getItem(SEEN_KEY)==='1'}catch{return true}}
function markSeen(){try{localStorage.setItem(SEEN_KEY,'1')}catch{/* private mode: show again next time */}}

type Page={icon:string;title:[string,string];body:[string,string];points:[string,string][]};
export const PAGES:Page[]=[
 {icon:'◈',title:['CloudOutcome에 오신 것을 환영합니다','Welcome to CloudOutcome'],
  body:['클라우드에 쓰는 비용이 어떤 비즈니스 성과로 이어지는지 한 화면에서 연결해 보는 도구입니다.','See how your cloud spend turns into business outcomes, in one place.'],
  points:[['지금 보는 화면은 가상의 의류 이커머스 회사 santacloth의 IT 담당자가 미리 세팅한 데모예요.','You are looking at a demo preset by the IT owner of santacloth, a fictional apparel ecommerce company.'],['로그인 없이 바로 둘러볼 수 있고, 모든 숫자에는 계산식과 근거가 붙어 있어요.','No sign-in needed, and every number comes with its formula and evidence.']]},
 {icon:'✓',title:['1. 경영 KPI','1. Business KPIs'],
  body:['쇼핑몰 3개(아동·어른·시니어)의 KPI를 고객만족도 같은 수동 입력값과 CloudWatch 실측값을 조합해 계산해요.','KPIs for three storefronts (kids, adult, senior) combine manual inputs such as satisfaction with live CloudWatch measurements.'],
  points:[['각 쇼핑몰의 AWS 리소스는 태그 outcome=쇼핑몰 이름으로 묶여 있고 5분마다 가상 주문이 들어와요.','Each storefront\'s AWS resources carry the tag outcome=<store> and receive synthetic orders every 5 minutes.'],['월 매출·IT 예산(기본 월 10만 원)·고객만족도를 바꾸면 KPI가 즉시 다시 계산돼요.','Change revenue, IT budget (₩100,000/month by default) or satisfaction and KPIs recalculate instantly.']]},
 {icon:'▦',title:['2. 비즈니스 개요','2. Overview'],
  body:['이커머스 샘플 시나리오로 주문당 비용, 결제 성공률, 결제 지연을 확인합니다.','An ecommerce sample shows cost per order, checkout success and checkout latency.'],
  points:[['시나리오를 "결제 장애"로 바꿔 지표 변화를 보세요.','Switch the scenario to an incident and watch the KPIs move.'],['카드를 누르면 계산식과 목표를 볼 수 있어요.','Open a card to see its formula and target.']]},
 {icon:'$',title:['3. 실계정 비용 추정 · KPI 관계 맵','3. Live AWS estimate · KPI lineage'],
  body:['실제 AWS 계정의 CloudWatch 지표를 모든 리전에서 읽어 사용 중인 서비스와 추정 비용을 보여줍니다.','Reads CloudWatch metrics from every Region of a real AWS account to show services in use and estimated cost.'],
  points:[['라이브 데모 계정은 바로 볼 수 있어요.','The live demo account is ready to view.'],['내 계정은 AWS CloudShell에서 읽기 전용 역할을 만들어 연결해요. 자격 증명을 입력하지 않아요.','Connect your own account by creating a read-only role in AWS CloudShell. No credentials are entered here.'],['비용은 AWS 공개 단가 기준 추정치이며 청구서가 아니에요.','Costs are estimates from AWS public prices, not a bill.']]},
 {icon:'✦',title:['4. KPI 스튜디오','4. KPI studio'],
  body:['상황을 대화하듯 설명하면 이커머스 의사결정에 맞는 KPI를 추천합니다.','Describe your situation like a chat and get ecommerce KPIs recommended for the decision.'],
  points:[['예: "블랙프라이데이 세일을 앞두고 결제 장애가 걱정돼요"','Example: "Black Friday is coming and I worry about checkout failures"'],['미리 정의된 KPI 10종 안에서만 추천하고 숫자를 지어내지 않아요.','Recommendations come only from 10 predefined KPIs; no numbers are invented.']]},
 {icon:'→',title:['시작해 볼까요?','Ready to start?'],
  body:['상단의 언어 선택으로 한국어/English를 바꿀 수 있고, "가이드" 버튼으로 이 안내를 다시 볼 수 있어요.','Switch language at the top, and reopen this guide anytime with the Guide button.'],
  points:[['저장·계정 연결이 필요하면 오른쪽 위에서 로그인하세요.','Sign in at the top right to save work or connect an account.']]},
];

export function Onboarding({open,onClose,t}:{open:boolean;onClose:()=>void;t:(ko:string,en:string)=>string}){
 const [page,setPage]=useState(0);
 useEffect(()=>{if(open)setPage(0)},[open]);
 useEffect(()=>{if(!open)return;
  const key=(e:KeyboardEvent)=>{if(e.key==='Escape')finish();if(e.key==='ArrowRight')setPage(p=>Math.min(PAGES.length-1,p+1));if(e.key==='ArrowLeft')setPage(p=>Math.max(0,p-1))};
  window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key)},[open]);
 if(!open)return null;
 function finish(){markSeen();onClose()}
 const current=PAGES[page],last=page===PAGES.length-1,lang=(pair:[string,string])=>t(pair[0],pair[1]);
 return <div className="modal-overlay" onClick={finish}><section className="modal onboarding" role="dialog" aria-modal="true" aria-label={lang(current.title)} onClick={e=>e.stopPropagation()}>
  <div className="onboarding-icon" aria-hidden>{current.icon}</div>
  <h2>{lang(current.title)}</h2><p>{lang(current.body)}</p>
  <ul>{current.points.map(p=><li key={p[1]}>{lang(p)}</li>)}</ul>
  <div className="pager-dots" role="tablist">{PAGES.map((_,i)=><button key={i} role="tab" aria-selected={i===page} aria-label={`${i+1} / ${PAGES.length}`} className={i===page?'active':''} onClick={()=>setPage(i)}/>)}</div>
  <div className="modal-actions"><button className="button secondary" onClick={finish}>{t('건너뛰기','Skip')}</button>
   <span>{page>0&&<button className="button secondary" onClick={()=>setPage(page-1)}>{t('이전','Back')}</button>}
   <button className="button primary" onClick={()=>last?finish():setPage(page+1)}>{last?t('시작하기','Get started'):t('다음','Next')}</button></span></div>
 </section></div>;
}
