import React, {useEffect, useRef, useState} from 'react';

// Requests finish in one response, so progress is an estimate from the expected duration.
// It eases toward 95% and only reaches 100% when the work actually completes; the label says "estimated".
export function estimatedPercent(elapsedMs:number,expectedMs:number){
 if(expectedMs<=0)return 95;
 return Math.min(95,Math.round(95*(1-Math.exp(-2.2*elapsedMs/expectedMs))));
}

export function Progress({active,expectedMs,steps,t}:{active:boolean;expectedMs:number;steps:string[];t:(ko:string,en:string)=>string}){
 const [elapsed,setElapsed]=useState(0),[done,setDone]=useState(false);
 const started=useRef(0),wasActive=useRef(false);
 useEffect(()=>{
  if(active){started.current=Date.now();wasActive.current=true;setDone(false);setElapsed(0);
   const timer=setInterval(()=>setElapsed(Date.now()-started.current),200);return()=>clearInterval(timer);}
  if(wasActive.current){wasActive.current=false;setDone(true);const hide=setTimeout(()=>setDone(false),600);return()=>clearTimeout(hide);}
 },[active]);
 if(!active&&!done)return null;
 const percent=done?100:estimatedPercent(elapsed,expectedMs);
 const step=steps[Math.min(steps.length-1,Math.floor(percent/100*steps.length))];
 const remaining=Math.max(0,Math.ceil((expectedMs-elapsed)/1000));
 return <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label={step}>
  <div className="progress-track"><div className="progress-fill" style={{width:percent+'%'}}/></div>
  <div className="progress-label"><span>{done?t('완료','Done'):step}</span><span>{done?'100%':`${percent}% · ${remaining>0?t(`예상 약 ${remaining}초 남음`,`about ${remaining}s left (estimated)`):t('거의 완료','almost done')}`}</span></div>
 </div>;
}
