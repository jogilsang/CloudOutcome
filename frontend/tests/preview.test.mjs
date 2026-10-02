import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const data=JSON.parse(read('fixtures/dashboard-v1.json'));
test('fixture contract contains every supported selection',()=>assert.equal(Object.keys(data).length,18));
test('preview contains the app and explicitly isolated sample adapter',()=>{
 const html=read('preview/CloudOutcome.html');assert.ok(html.includes('window.__OUTCOMELENS_SAMPLE__='));assert.ok(html.includes('id="root"'));assert.ok(html.includes('#382819'));
});
test('artifact manifest identifies exact sample bytes',()=>{
 const m=JSON.parse(read('preview/manifest.json'));assert.equal(m.data,'synthetic');assert.equal(m.sha256,createHash('sha256').update(read('preview/CloudOutcome.html')).digest('hex'));
});
test('no external script is required to open the sample',()=>assert.doesNotMatch(read('preview/CloudOutcome.html'),/<script[^>]+src=/));
test('preview remains an offline document with a viewport',()=>assert.match(read('preview/CloudOutcome.html'),/name="viewport"/));
