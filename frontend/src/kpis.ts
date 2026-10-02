// Predefined ecommerce KPIs for business decision makers, and a rule-based recommender.
// Runs entirely in the browser: the user's text is never sent to a server or a model.
// Guardrails: only catalog KPIs are returned, no numbers are generated, sensitive text and
// off-topic requests are refused without echoing the input.

export type Source='cloudwatch'|'cost-estimate'|'business-events';
export type Kpi={id:string;name:[string,string];question:[string,string];formula:string;why:[string,string];
 sources:Source[];live?:'cost_per_order'|'success_rate'|'latency_p95';target:[string,string];keywords:string[]};

export const CATALOG:Kpi[]=[
 {id:'cost_per_order',name:['주문당 인프라 비용','Infrastructure cost per order'],question:['주문 하나를 처리하는 데 클라우드 비용이 얼마나 드나요?','How much cloud spend does one order cost?'],
  formula:'allocated cloud cost (USD) / completed orders',why:['트래픽이 늘 때 비용이 주문보다 빨리 늘면 수익성이 나빠지는 신호입니다.','If spend grows faster than orders, unit economics are deteriorating.'],
  sources:['cost-estimate','business-events'],live:'cost_per_order',target:['예: ≤ $0.25 / 주문','e.g. ≤ $0.25 per order'],
  keywords:['비용','원가','단가','주문당','절감','예산','돈','cost','spend','budget','unit','order','saving','economics','finops']},
 {id:'checkout_success',name:['결제 성공률','Checkout success rate'],question:['결제를 시도한 고객 중 몇 %가 끝까지 성공하나요?','What share of checkout attempts succeed?'],
  formula:'successful terminal attempts / all terminal attempts × 100',why:['실패한 결제는 곧 놓친 매출입니다. 장애 영향의 가장 직접적인 지표입니다.','Failed checkouts are lost revenue; the most direct measure of incident impact.'],
  sources:['cloudwatch','business-events'],live:'success_rate',target:['예: ≥ 99%','e.g. ≥ 99%'],
  keywords:['결제','실패','성공','오류','결제창','pg','checkout','payment','fail','success','decline']},
 {id:'checkout_latency_p95',name:['결제 p95 응답 시간','Checkout p95 latency'],question:['느린 고객 5%는 결제에 얼마나 기다리나요?','How long do the slowest 5% of customers wait at checkout?'],
  formula:'95th percentile of raw checkout latency samples (ms)',why:['평균은 느린 고객을 숨깁니다. p95가 체감 품질과 이탈에 더 가깝습니다.','Averages hide slow customers; p95 tracks experience and abandonment better.'],
  sources:['cloudwatch'],live:'latency_p95',target:['예: ≤ 500 ms','e.g. ≤ 500 ms'],
  keywords:['느림','느려','지연','속도','응답','렉','latency','slow','speed','response','performance','p95']},
 {id:'api_error_rate',name:['API 오류율 (5xx)','API error rate (5xx)'],question:['서버 오류로 실패하는 요청이 얼마나 되나요?','How many requests fail with server errors?'],
  formula:'API Gateway 5XXError / Count × 100',why:['고객이 보기 전에 장애를 감지하는 가장 빠른 경보 지표입니다.','The fastest early-warning signal, before customers report problems.'],
  sources:['cloudwatch'],target:['예: ≤ 0.1%','e.g. ≤ 0.1%'],
  keywords:['장애','에러','오류','다운','먹통','안정','5xx','error','outage','incident','down','failure','stability']},
 {id:'availability_slo',name:['가용성 SLO와 에러 버짓','Availability SLO and error budget'],question:['약속한 가용성 목표 대비 얼마나 여유가 남았나요?','How much of the availability budget is left?'],
  formula:'1 − (failed requests / total requests) over 30 days, vs 99.9% target',why:['배포 속도와 안정성 사이의 의사결정을 숫자로 합니다(버짓 소진 시 배포 동결 등).','Turns the speed-vs-stability trade-off into a number (e.g. freeze releases when the budget is spent).'],
  sources:['cloudwatch'],target:['예: 30일 99.9%','e.g. 99.9% over 30 days'],
  keywords:['slo','sla','가용성','업타임','신뢰성','에러버짓','배포','availability','uptime','reliability','budget','release']},
 {id:'cloud_cost_ratio',name:['매출 대비 클라우드 비용 비율','Cloud cost as % of revenue'],question:['매출 100원당 클라우드에 몇 원을 쓰나요?','How much of each revenue dollar goes to cloud?'],
  formula:'estimated cloud cost / gross merchandise value × 100',why:['경영진이 가장 먼저 묻는 질문입니다. 성장 단계별 적정 비율을 관리합니다.','The first question leadership asks; track the healthy ratio for your growth stage.'],
  sources:['cost-estimate','business-events'],target:['예: GMV의 ≤ 3%','e.g. ≤ 3% of GMV'],
  keywords:['매출','수익','마진','이익','gmv','경영','경영진','대표','이사회','타당','투자','roi','revenue','margin','profit','investment','board','executive','leadership','cfo','ceo','justif','worth']},
 {id:'conversion_rate',name:['구매 전환율','Purchase conversion rate'],question:['방문한 세션 중 몇 %가 구매로 이어지나요?','What share of sessions convert to a purchase?'],
  formula:'completed orders / sessions × 100',why:['성능·장애 개선이 실제 매출 향상으로 이어지는지 확인하는 기준입니다.','Shows whether performance and reliability work actually moves revenue.'],
  sources:['business-events'],target:['예: ≥ 2.5%','e.g. ≥ 2.5%'],
  keywords:['전환','구매율','방문','유입','퍼널','마케팅','광고','conversion','funnel','visit','session','marketing','campaign']},
 {id:'cart_abandonment',name:['장바구니 이탈률','Cart abandonment rate'],question:['장바구니에 담고도 결제하지 않는 비율은?','What share of carts never reach payment?'],
  formula:'(carts created − checkouts started) / carts created × 100',why:['결제 지연·오류와 함께 보면 기술 문제로 인한 이탈을 분리할 수 있습니다.','Paired with latency and errors it separates technical churn from pricing churn.'],
  sources:['business-events','cloudwatch'],target:['예: ≤ 70%','e.g. ≤ 70%'],
  keywords:['장바구니','이탈','포기','카트','cart','abandon','basket','drop']},
 {id:'peak_headroom',name:['피크 트래픽 여유율','Peak traffic headroom'],question:['세일·이벤트 트래픽을 감당할 여유가 얼마나 있나요?','How much capacity is left for sales and campaign peaks?'],
  formula:'1 − peak concurrency / configured limit; plus throttle count',why:['블랙프라이데이 같은 이벤트 전에 증설·사전 확장 여부를 결정합니다.','Decide on pre-scaling before events like Black Friday.'],
  sources:['cloudwatch'],target:['예: 피크 대비 ≥ 30% 여유, 스로틀 0','e.g. ≥ 30% headroom, zero throttles'],
  keywords:['세일','이벤트','프로모션','피크','트래픽','블랙프라이데이','대목','폭주','확장','스로틀','sale','event','promotion','peak','traffic','black friday','scale','throttle','capacity']},
 {id:'cost_per_active_user',name:['활성 사용자당 비용','Cost per active user'],question:['월간 활성 사용자 한 명에게 클라우드 비용이 얼마나 드나요?','What is the cloud cost per monthly active user?'],
  formula:'estimated monthly cloud cost / monthly active users',why:['사용자 성장 대비 비용 효율을 비교하는 기준입니다(가격 정책·인프라 최적화 판단).','Compares cost efficiency against user growth (pricing and optimization decisions).'],
  sources:['cost-estimate','business-events'],target:['예: 사용자당 ≤ $0.05 / 월','e.g. ≤ $0.05 per user per month'],
  keywords:['사용자','회원','mau','dau','고객수','성장','user','member','growth','active','customer']},
];

const DOMAIN=['이커머스','쇼핑','쇼핑몰','커머스','온라인','상품','고객','kpi','지표','클라우드','aws','서비스','앱','매장','ecommerce','commerce','shop','store','customer','metric','cloud','app','site','business'];
const SENSITIVE=[/[\w.+-]+@[\w-]+\.[\w.]+/,/01[016789][-\s]?\d{3,4}[-\s]?\d{4}/,/\b(?:\d[ -]?){13,19}\b/,/\bAKIA[0-9A-Z]{16}\b/,/\b\d{6}-?[1-4]\d{6}\b/,/(?:password|passwd|secret|비밀번호)\s*[:=]/i];
const STARTER=['checkout_success','cost_per_order','api_error_rate'];

export type Recommendation={kpi:Kpi;score:number;matched:string[]};
export type Reply={status:'ok'|'refused-sensitive'|'off-topic'|'too-long'|'empty';items:Recommendation[];generic:boolean};

export function recommend(text:string,limit=5):Reply{
 const input=text.trim();
 if(!input)return {status:'empty',items:[],generic:false};
 if(input.length>500)return {status:'too-long',items:[],generic:false};
 if(SENSITIVE.some(p=>p.test(input)))return {status:'refused-sensitive',items:[],generic:false};
 const lower=input.toLowerCase();
 const scored=CATALOG.map(kpi=>{const matched=kpi.keywords.filter(k=>lower.includes(k));return {kpi,score:matched.length,matched}})
  .filter(r=>r.score>0).sort((a,b)=>b.score-a.score||CATALOG.indexOf(a.kpi)-CATALOG.indexOf(b.kpi));
 if(scored.length)return {status:'ok',items:scored.slice(0,limit),generic:false};
 if(DOMAIN.some(k=>lower.includes(k)))return {status:'ok',items:STARTER.map(id=>({kpi:CATALOG.find(k=>k.id===id)!,score:0,matched:[]})),generic:true};
 return {status:'off-topic',items:[],generic:false};
}
