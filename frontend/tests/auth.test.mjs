import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
const source=transformSync(readFileSync(new URL('../src/auth.ts',import.meta.url),'utf8'),{loader:'ts',format:'esm',define:{'import.meta.env.DEV':'false'}}).code;
const config={apiUrl:'https://sample.execute-api.us-east-1.amazonaws.com',domain:'https://sample.auth.us-east-1.amazoncognito.com',clientId:'public-client',environment:'dev',release:'sample'};
async function setup(search=''){
 const storage=new Map();globalThis.window={};globalThis.location={search,origin:'https://sample.amplifyapp.com',pathname:'/',assign:()=>{}};
 globalThis.sessionStorage={getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)};
 globalThis.history={replaceState:()=>{}};
 const api=await import('data:text/javascript;base64,'+Buffer.from(source+'\n//'+Math.random()).toString('base64'));
 return {api,storage};
}
test('cloud mode without config cannot send anonymous API requests',async()=>{
 const {api}=await setup();globalThis.fetch=async()=>({ok:false});
 await assert.rejects(api.initializeAuth(),/configuration/);
 await assert.rejects(api.authenticatedFetch('/definitions'),/configuration/);
});
test('unsigned users receive a login state',async()=>{
 const {api}=await setup();globalThis.fetch=async()=>({ok:true,json:async()=>config});
 assert.equal(await api.initializeAuth(),'login');
 await assert.rejects(api.authenticatedFetch('/definitions'),/Session expired/);
});
test('callback state mismatch is rejected and transaction cleared',async()=>{
 const {api,storage}=await setup('?code=sample&state=wrong');storage.set('outcomelens-oauth-transaction',JSON.stringify({state:'expected',verifier:'sample',created:Date.now()}));
 globalThis.fetch=async()=>({ok:true,json:async()=>config});
 await assert.rejects(api.initializeAuth(),/could not be verified/);assert.equal(storage.size,0);
});
test('expired login transaction is rejected',async()=>{
 const {api,storage}=await setup('?code=sample&state=expected');storage.set('outcomelens-oauth-transaction',JSON.stringify({state:'expected',verifier:'sample',created:Date.now()-400000}));
 globalThis.fetch=async()=>({ok:true,json:async()=>config});
 await assert.rejects(api.initializeAuth(),/could not be verified/);
});
test('successful code exchange uses bearer token without persisting it',async()=>{
 const {api,storage}=await setup('?code=sample&state=expected');storage.set('outcomelens-oauth-transaction',JSON.stringify({state:'expected',verifier:'sample',created:Date.now()}));
 let count=0;globalThis.fetch=async(url,options)=>{
  if(++count===1)return {ok:true,json:async()=>config};
  if(count===2){assert.equal(options.body.get('code_verifier'),'sample');return {ok:true,json:async()=>({access_token:'synthetic-token',refresh_token:'discard',token_type:'Bearer',expires_in:900})};}
  assert.equal(options.headers.get('authorization'),'Bearer synthetic-token');return {ok:true};
 };
 assert.equal(await api.initializeAuth(),'ready');assert.equal(storage.size,0);await api.authenticatedFetch('/definitions');
});
