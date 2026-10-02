// OAuth authorization code + PKCE. Access token stays in memory, never localStorage.
export type RuntimeConfig = {apiUrl:string;clientId:string;domain:string;environment:string;release:string};
let config:RuntimeConfig|null=null;
let accessToken='';
let expiresAt=0;
const storageKey='outcomelens-oauth-transaction';
const base64=(bytes:Uint8Array)=>btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
export async function initializeAuth():Promise<'ready'|'login'> {
 if(window.__OUTCOMELENS_SAMPLE__ || import.meta.env.DEV)return 'ready';
 const response=await fetch('/config.json',{cache:'no-store',credentials:'omit'});
 if(!response.ok)throw Error('Deployment configuration is unavailable.');
 const value=await response.json();
 const api=new URL(value.apiUrl), domain=new URL(value.domain);
 if(api.protocol!=='https:'||domain.protocol!=='https:'||api.username||domain.username||
    !api.hostname.endsWith('.amazonaws.com')||!domain.hostname.endsWith('.amazoncognito.com'))throw Error('Invalid deployment configuration.');
 config=value;
 const query=new URLSearchParams(location.search);
 if(query.has('code')||query.has('error')) {
  const saved=sessionStorage.getItem(storageKey);sessionStorage.removeItem(storageKey);
  history.replaceState({},'',location.pathname); // Clear code before any app request/telemetry.
  if(!saved)throw Error('Login expired. Please sign in again.');
  const transaction=JSON.parse(saved);
  if(query.get('state')!==transaction.state||Date.now()-transaction.created>300000||query.has('error'))throw Error('Login could not be verified. Please retry.');
  const token=await fetch(domain.origin+'/oauth2/token',{method:'POST',credentials:'omit',
   headers:{'Content-Type':'application/x-www-form-urlencoded'},
   body:new URLSearchParams({grant_type:'authorization_code',client_id:value.clientId,
    code:query.get('code')!,code_verifier:transaction.verifier,redirect_uri:location.origin+'/'})});
  if(!token.ok)throw Error('Login exchange failed. Please retry.');
  const result=await token.json();
  if(result.token_type!=='Bearer'||typeof result.access_token!=='string'||!(result.expires_in>0))throw Error('Invalid login response.');
  accessToken=result.access_token;expiresAt=Date.now()+result.expires_in*1000;
  // Refresh/ID tokens are deliberately not stored. API Gateway verifies the access token.
  return 'ready';
 }
 return 'login';
}
export async function signIn(){
 if(!config)throw Error('Deployment configuration is unavailable.');
 const verifier=base64(crypto.getRandomValues(new Uint8Array(32)));
 const state=base64(crypto.getRandomValues(new Uint8Array(32)));
 sessionStorage.setItem(storageKey,JSON.stringify({verifier,state,created:Date.now()}));
 const challenge=base64(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))));
 const url=new URL(config.domain+'/oauth2/authorize');
 url.search=new URLSearchParams({response_type:'code',client_id:config.clientId,
  redirect_uri:location.origin+'/',scope:'openid outcomelens/api',state,
  code_challenge:challenge,code_challenge_method:'S256'}).toString();
 location.assign(url.toString());
}
export function signOut(){
 accessToken='';expiresAt=0;
 if(config){const url=new URL(config.domain+'/logout');url.search=new URLSearchParams({client_id:config.clientId,logout_uri:location.origin+'/'}).toString();location.assign(url.toString());}
}
export async function authenticatedFetch(path:string,init?:RequestInit){
 if(!config&&!window.__OUTCOMELENS_SAMPLE__&&!import.meta.env.DEV)throw Error('Deployment configuration is unavailable.');
 const headers=new Headers(init?.headers);headers.set('Content-Type','application/json');
 if(config){if(!accessToken||Date.now()>expiresAt-30000)throw Error('Session expired. Sign out and sign in again.');headers.set('Authorization','Bearer '+accessToken);}
 return fetch((config?.apiUrl||'')+'/api'+path,{...init,headers,credentials:'omit'});
}
export function environment(){return config?.environment;}
export function signedIn(){return Boolean(accessToken)&&Date.now()<expiresAt-30000;}
export function cloudConfigured(){return Boolean(config);}
// Anonymous read of the precomputed public snapshot. Never attaches a token.
export async function publicFetch(path:string){
 if(!config&&!import.meta.env.DEV)throw Error('Live demo is available in the cloud deployment only.');
 return fetch((config?.apiUrl||'')+'/api/public'+path,{credentials:'omit',headers:{Accept:'application/json'}});
}
// Temporary anonymous workspace: the key is a bearer secret kept only in this browser (7-day expiry).
const anonKey='cloudoutcome-anon-workspace';
export type AnonWorkspace={token:string;expires_at:number|null};
export function anonWorkspace():AnonWorkspace|null{
 try{const v=JSON.parse(localStorage.getItem(anonKey)||'null');return v&&(!v.expires_at||v.expires_at*1000>Date.now())?v:null}catch{return null}
}
export function forgetAnonWorkspace(){try{localStorage.removeItem(anonKey)}catch{/* nothing stored */}}
export async function createAnonWorkspace():Promise<AnonWorkspace>{
 const r=await fetch((config?.apiUrl||'')+'/api/anon/workspace',{method:'POST',credentials:'omit',headers:{'Content-Type':'application/json'},body:'{}'});
 if(!r.ok)throw Error('Could not start a temporary workspace.');
 const v=await r.json();try{localStorage.setItem(anonKey,JSON.stringify(v))}catch{/* private mode: key lives in memory only */}
 return v;
}
export async function anonFetch(path:string,init:RequestInit|undefined,ws:AnonWorkspace){
 const headers=new Headers(init?.headers);headers.set('Content-Type','application/json');headers.set('x-cloudoutcome-workspace',ws.token);
 return fetch((config?.apiUrl||'')+'/api/anon/workspace'+path,{...init,headers,credentials:'omit'});
}
