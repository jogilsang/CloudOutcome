// santacloth: a fictional apparel ecommerce company preset by its IT owner for the demo.
// Manual business inputs (entered by people) are combined with CloudWatch measurements of
// resources tagged outcome=<shop>. Edits stay in this browser; "reset" restores the preset.

export type Lang=[string,string];
export type CwId='cost_krw_month'|'api_requests'|'api_errors_5xx'|'error_rate_pct'|'orders_month'|'avg_checkout_ms'|'cost_per_order_krw';
export type Ref={kind:'cw';id:CwId}|{kind:'manual';id:string}|{kind:'company';id:string}|{kind:'none'};
export type KpiDef={id:string;name:Lang;numerator:Ref;denominator:Ref;multiplier:number;unit:string;target:number;direction:'lower'|'higher'};
export type Manual={id:string;name:Lang;unit:string;value:number;asOf:string};
export type Shop={id:string;name:Lang;audience:Lang;manual:Manual[];kpis:KpiDef[]};
export type Company={name:string;monthlyRevenueKrw:number;itBudgetPct:number;fxKrwPerUsd:number;manual:Manual[];kpis:KpiDef[];shops:Shop[];updatedAt:string};
export type Outcome={estimated_usd:number;api_requests:number;api_errors_5xx:number;orders:number;lambda_invocations:number;avg_checkout_ms:number|null;resources:number;
 daily_requests?:number[];daily_errors_5xx?:number[];daily_orders?:number[]};

export const CW_METRICS:{id:CwId;name:Lang;unit:string}[]=[
 {id:'cost_krw_month',name:['추정 AWS 비용 (월 환산)','Estimated AWS cost (monthly)'],unit:'₩'},
 {id:'api_requests',name:['API 요청 수 (기간)','API requests (window)'],unit:''},
 {id:'api_errors_5xx',name:['API 5xx 오류 수 (기간)','API 5xx errors (window)'],unit:''},
 {id:'error_rate_pct',name:['결제 오류율','Checkout error rate'],unit:'%'},
 {id:'orders_month',name:['가상 주문 수 (월 환산, DynamoDB 쓰기)','Synthetic orders (monthly, DynamoDB writes)'],unit:''},
 {id:'avg_checkout_ms',name:['체크아웃 평균 처리시간','Average checkout time'],unit:'ms'},
 {id:'cost_per_order_krw',name:['주문당 인프라 비용','Infrastructure cost per order'],unit:'₩'},
];

const today=()=>new Date().toISOString().slice(0,10);
const cw=(id:CwId):Ref=>({kind:'cw',id});
const none:Ref={kind:'none'};
const shopKpis=(latency:number):KpiDef[]=>[
 {id:'error_rate',name:['결제 오류율','Checkout error rate'],numerator:cw('error_rate_pct'),denominator:none,multiplier:1,unit:'%',target:1,direction:'lower'},
 {id:'checkout_ms',name:['체크아웃 평균 처리시간','Average checkout time'],numerator:cw('avg_checkout_ms'),denominator:none,multiplier:1,unit:'ms',target:latency,direction:'lower'},
 {id:'cost_per_order',name:['주문당 인프라 비용','Infrastructure cost per order'],numerator:cw('cost_per_order_krw'),denominator:none,multiplier:1,unit:'₩',target:0.005,direction:'lower'},  // demo scale: synthetic orders cost a fraction of a won
 {id:'cloud_ratio',name:['매출 대비 클라우드 비용','Cloud cost as % of revenue'],numerator:cw('cost_krw_month'),denominator:{kind:'manual',id:'revenue'},multiplier:100,unit:'%',target:5,direction:'lower'},
 {id:'csat',name:['고객만족도','Customer satisfaction'],numerator:{kind:'manual',id:'csat'},denominator:none,multiplier:1,unit:'/5',target:4.5,direction:'higher'},
];
const shopManual=(revenue:number,csat:number,returns:number):Manual[]=>[
 {id:'revenue',name:['월 매출','Monthly revenue'],unit:'₩',value:revenue,asOf:today()},
 {id:'csat',name:['고객만족도 (설문)','Customer satisfaction (survey)'],unit:'/5',value:csat,asOf:today()},
 {id:'returns',name:['반품률','Return rate'],unit:'%',value:returns,asOf:today()},
];

export function preset():Company{
 return {name:'santacloth',monthlyRevenueKrw:2_000_000,itBudgetPct:5,fxKrwPerUsd:1400,updatedAt:new Date().toISOString(),
  manual:[{id:'debt_ratio',name:['부채비율','Debt ratio'],unit:'%',value:38,asOf:today()}],
  kpis:[
   {id:'it_budget_use',name:['IT 예산 소진율 (AWS)','IT budget used by AWS'],numerator:{kind:'company',id:'total_cost_krw_month'},denominator:{kind:'company',id:'it_budget_krw'},multiplier:100,unit:'%',target:100,direction:'lower'},
   {id:'debt_ratio',name:['부채비율','Debt ratio'],numerator:{kind:'manual',id:'debt_ratio'},denominator:none,multiplier:1,unit:'%',target:50,direction:'lower'},
  ],
  shops:[
   {id:'child-santa-cloth',name:['아동 쇼핑몰','Kids store'],audience:['아동용 의류','Children\'s apparel'],manual:shopManual(600_000,4.5,3.2),kpis:shopKpis(300)},
   {id:'adult-santa-cloth',name:['어른 쇼핑몰','Adult store'],audience:['어른용 의류','Adult apparel'],manual:shopManual(1_100_000,4.7,2.1),kpis:shopKpis(300)},
   {id:'senior-santa-cloth',name:['시니어 쇼핑몰','Senior store'],audience:['노약자용 의류','Apparel for seniors'],manual:shopManual(300_000,4.1,4.8),kpis:shopKpis(500)},
  ]};
}

const KEY='cloudoutcome-santa-v1';
// Browser storage is untrusted input: layer only well-formed saved values onto the current preset.
// Names always follow the preset; malformed or missing fields keep the preset value.
const isNum=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
const isRef=(r:any)=>r&&(r.kind==='none'||(['cw','manual','company'].includes(r.kind)&&typeof r.id==='string'));
const isKpi=(k:any)=>k&&typeof k.id==='string'&&Array.isArray(k.name)&&isRef(k.numerator)&&isRef(k.denominator)&&isNum(k.multiplier)&&isNum(k.target)&&['lower','higher'].includes(k.direction);
const mergeManual=(base:Manual[],saved:unknown)=>base.map(m=>{const v=Array.isArray(saved)?saved.find((x:any)=>x&&x.id===m.id):null;return v&&isNum(v.value)?{...m,value:v.value,asOf:typeof v.asOf==='string'?v.asOf:m.asOf}:m});
const mergeKpis=(base:KpiDef[],saved:unknown)=>Array.isArray(saved)&&saved.length&&saved.every(isKpi)?saved as KpiDef[]:base;
export function load():Company{
 const base=preset();
 let v:any=null;try{v=JSON.parse(localStorage.getItem(KEY)||'null')}catch{v=null}
 if(!v||typeof v!=='object')return base;
 return {...base,
  monthlyRevenueKrw:isNum(v.monthlyRevenueKrw)?v.monthlyRevenueKrw:base.monthlyRevenueKrw,
  itBudgetPct:isNum(v.itBudgetPct)?v.itBudgetPct:base.itBudgetPct,
  fxKrwPerUsd:isNum(v.fxKrwPerUsd)?v.fxKrwPerUsd:base.fxKrwPerUsd,
  manual:mergeManual(base.manual,v.manual),kpis:mergeKpis(base.kpis,v.kpis),
  shops:base.shops.map(shop=>{const saved=Array.isArray(v.shops)?v.shops.find((x:any)=>x&&x.id===shop.id):null;
   return saved?{...shop,manual:mergeManual(shop.manual,saved.manual),kpis:mergeKpis(shop.kpis,saved.kpis)}:shop})};
}
export function save(c:Company){try{localStorage.setItem(KEY,JSON.stringify({...c,updatedAt:new Date().toISOString()}))}catch{/* private mode */}}
export function reset(){try{localStorage.removeItem(KEY)}catch{/* nothing stored */}return preset()}

export const itBudgetKrw=(c:Company)=>c.monthlyRevenueKrw*c.itBudgetPct/100;

// CloudWatch-derived values for one storefront over a window, normalized to a month where noted.
export function cwValues(o:Outcome|undefined,days:number,fx:number):Record<CwId,number|null>{
 if(!o)return {cost_krw_month:null,api_requests:null,api_errors_5xx:null,error_rate_pct:null,orders_month:null,avg_checkout_ms:null,cost_per_order_krw:null};
 const month=30/days,cost=o.estimated_usd*month*fx,orders=o.orders*month;
 return {cost_krw_month:cost,api_requests:o.api_requests,api_errors_5xx:o.api_errors_5xx,error_rate_pct:o.api_requests?o.api_errors_5xx/o.api_requests*100:null,
  orders_month:orders,avg_checkout_ms:o.avg_checkout_ms,cost_per_order_krw:orders?cost/orders:null};
}

export function companyValues(c:Company,outcomes:Record<string,Outcome>,days:number){
 const total=c.shops.reduce((sum,s)=>sum+(cwValues(outcomes[s.id],days,c.fxKrwPerUsd).cost_krw_month||0),0);
 return {total_cost_krw_month:total,it_budget_krw:itBudgetKrw(c),monthly_revenue_krw:c.monthlyRevenueKrw} as Record<string,number>;
}

export function resolve(ref:Ref,ctx:{cw:Record<string,number|null>;manual:Manual[];company:Record<string,number>}):number|null{
 if(ref.kind==='none')return null;
 if(ref.kind==='cw')return ctx.cw[ref.id]??null;
 if(ref.kind==='manual')return ctx.manual.find(m=>m.id===ref.id)?.value??null;
 return ctx.company[ref.id]??null;
}

export type Evaluated={def:KpiDef;value:number|null;status:'ok'|'breach'|'unknown'};
export function evaluate(def:KpiDef,ctx:Parameters<typeof resolve>[1]):Evaluated{
 const n=resolve(def.numerator,ctx),d=def.denominator.kind==='none'?1:resolve(def.denominator,ctx);
 const value=n==null||d==null||d===0?null:n/d*def.multiplier;
 const status=value==null?'unknown':(def.direction==='lower'?value<=def.target:value>=def.target)?'ok':'breach';
 return {def,value,status};
}

// Small values keep significant digits (₩0.0031, 0.0042 %) so tiny demo costs never read as zero.
const digits=(v:number)=>v===0||Math.abs(v)>=1?2:Math.min(6,Math.ceil(-Math.log10(Math.abs(v)))+1);
const num=(v:number)=>Math.abs(v)>=100?Math.round(v).toLocaleString('en-US'):v.toLocaleString('en-US',{maximumFractionDigits:digits(v)});
export const fmtValue=(v:number|null,unit:string)=>v==null?'—':unit==='₩'?'₩'+(Math.abs(v)>=10?Math.round(v).toLocaleString('ko-KR'):num(v)):
 num(v)+(unit&&unit!=='₩'?' '+unit:'');

// Rule-based actions for KPIs that miss their target. Every item cites the measured value; nothing is inferred beyond it.
export type Insight={shop:string;shopName:Lang;kpi:Lang;value:string;target:string;severity:number;action:Lang};
const ACTIONS:Record<string,Lang>={
 error_rate:['체크아웃 API의 5xx와 체크아웃 Lambda 오류 로그를 먼저 확인하세요.','Check checkout API 5xx responses and checkout Lambda error logs first.'],
 checkout_ms:['체크아웃 Lambda 처리시간과 DynamoDB 쓰기 지연을 비교해 병목을 찾으세요.','Compare checkout Lambda duration with DynamoDB write latency to find the bottleneck.'],
 cost_per_order:['주문 수 대비 리소스 크기와 호출량이 적절한지 검토하세요.','Review resource sizing and call volume against orders.'],
 cloud_ratio:['매출 대비 클라우드 비용이 예산 비율을 넘었습니다. 비용 상위 리소스를 확인하세요.','Cloud cost exceeds the revenue share; review the top-cost resources.'],
 csat:['고객만족도가 목표 미만입니다. 반품률과 결제 오류·지연을 함께 확인하세요.','Satisfaction is below target; review return rate together with checkout errors and latency.'],
};
export function insights(c:Company,views:{shop:Shop;kpis:Evaluated[]}[]):Insight[]{
 const out:Insight[]=[];
 for(const {shop,kpis} of views)for(const k of kpis){
  if(k.status!=='breach'||k.value==null)continue;
  const gap=k.def.target?Math.abs(k.value-k.def.target)/Math.abs(k.def.target):1;
  out.push({shop:shop.id,shopName:shop.name,kpi:k.def.name,value:fmtValue(k.value,k.def.unit),target:(k.def.direction==='lower'?'≤ ':'≥ ')+fmtValue(k.def.target,k.def.unit),severity:gap,
   action:ACTIONS[k.def.id]||['목표 미달 원인이 된 입력값과 지표를 확인하세요.','Review the inputs and metrics behind this KPI.']});
 }
 return out.sort((a,b)=>b.severity-a.severity);
}
