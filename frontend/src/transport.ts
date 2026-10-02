// File preview is explicitly isolated from the HTTP backend and AWS.
declare global { interface Window { __OUTCOMELENS_SAMPLE__?: Record<string, any> } }
const key='outcomelens-preview-definitions-v1';
const auditKey='outcomelens-preview-audit-v1';
export async function offline(path:string, init?:RequestInit){
 const url=new URL(path,'http://preview.invalid');
 const body=JSON.parse(String(init?.body||'{}'));
 const saved=()=>JSON.parse(localStorage.getItem(key)||'[]') as any[];
 if(url.pathname==='/health')return {mode:'offline-preview',assistant:'rules',aws_connected:false};
 if(url.pathname==='/dashboard'){
  const q=url.searchParams;
  const data=structuredClone(window.__OUTCOMELENS_SAMPLE__![`${q.get('service')}|${q.get('days')}|${q.get('scenario')}`]);
  const pct=Number(q.get('allocation'));
  const update=(r:any)=>{r.allocated_shared=r.shared_pool*pct/100;r.unallocated_shared=r.shared_pool-r.allocated_shared;r.allocated_cost=r.direct_cost+r.allocated_shared;r.cost_per_order=data.service==='checkout'&&r.completed?r.allocated_cost/r.completed:null};
  update(data.summary);data.trend.forEach(update);data.provenance.allocation_pct=pct;return data;
 }
 if(url.pathname==='/definitions')return saved();
 if(url.pathname==='/audit')return JSON.parse(localStorage.getItem(auditKey)||'[]');
 if(url.pathname.startsWith('/definitions/')){
  const id=url.pathname.split('/').pop(), all=saved(),old=all.find(x=>x.id===id);
  if((old?.version||0)!==body.expected_version)throw Error('Version conflict. Reload.');
  if(!body.owner.trim()||!(body.target>0)||body.kind==='success_rate'&&body.target>100)throw Error('Invalid KPI target or owner');
  if(body.kind==='cost_per_order'&&body.service!=='checkout')throw Error('Catalog has no completed order events');
  const record={...body,id,version:(old?.version||0)+1};delete record.expected_version;
  localStorage.setItem(key,JSON.stringify([...all.filter(x=>x.id!==id),record]));
  const audit=JSON.parse(localStorage.getItem(auditKey)||'[]');
  audit.unshift({id:crypto.randomUUID(),created:new Date().toISOString(),action:'definition.saved',body:JSON.stringify(record)});
  localStorage.setItem(auditKey,JSON.stringify(audit.slice(0,50)));return record;
 }
 if(url.pathname==='/propose'){
  const text=body.text.toLowerCase();
  const base={engine:'rules',sources:[]};
  if(['매출','revenue','mau','활성','profit','이익'].some(x=>text.includes(x)))return {...base,status:'missing_source',kind:null,reason:'Revenue/refund or distinct active-user events are not connected.'};
  const kind=['지연','latency','p95','느려'].some(x=>text.includes(x))?'latency_p95':['성공','success','slo','오류'].some(x=>text.includes(x))?'success_rate':['비용','cost','주문','order'].some(x=>text.includes(x))?'cost_per_order':null;
  if(!kind)return {...base,status:'unsupported',kind:null,reason:'Choose cost per order, success rate, or p95 latency.'};
  if(kind==='cost_per_order'&&body.service!=='checkout')return {...base,status:'missing_source',kind:null,reason:'Catalog does not emit completed orders.'};
  return {...base,status:'ready',kind,formula:window.__OUTCOMELENS_SAMPLE__!['checkout|14|baseline'].formulas[kind],reason:'Review synthetic source data and formula before saving.',sources:['synthetic operation events','simulated cost pool']};
 }
 throw Error('Unavailable in offline preview');
}
// Preset KPI contracts for the santacloth demo, written once; later edits are never overwritten.
const SEEDED='cloudoutcome-demo-contracts-seeded-v1';
export function seedDemoContracts(){
 try{
  if(localStorage.getItem(SEEDED)||localStorage.getItem(key))return;
  const contracts=[
   {id:'checkout_cost_per_order',kind:'cost_per_order',name:'Cost per order',target:0.25,owner:'santacloth Platform',service:'checkout',shared_allocation_pct:40,version:2},
   {id:'checkout_success_rate',kind:'success_rate',name:'Checkout success',target:99.5,owner:'santacloth Payments',service:'checkout',shared_allocation_pct:40,version:1},
   {id:'checkout_latency_p95',kind:'latency_p95',name:'Checkout p95 latency',target:450,owner:'santacloth SRE',service:'checkout',shared_allocation_pct:40,version:1},
   {id:'catalog_latency_p95',kind:'latency_p95',name:'Checkout p95 latency',target:300,owner:'santacloth Search',service:'catalog',shared_allocation_pct:20,version:1},
  ];
  localStorage.setItem(key,JSON.stringify(contracts));
  const day=86400000,now=Date.now();
  localStorage.setItem(auditKey,JSON.stringify(contracts.map((c,i)=>({id:'seed-'+c.id,created:new Date(now-(i+1)*day).toISOString(),action:'definition.saved',body:JSON.stringify(c)}))));
  localStorage.setItem(SEEDED,'1');
 }catch{/* storage unavailable: the studio simply starts empty */}
}
