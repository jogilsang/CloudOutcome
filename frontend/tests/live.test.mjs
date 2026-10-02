import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildSync} from 'esbuild';
const template=JSON.parse(readFileSync(new URL('../public/outcomelens-readonly-role.json',import.meta.url),'utf8'));
const role=template.Resources.ReadOnlyRole.Properties;
const statements=role.Policies.flatMap(p=>p.PolicyDocument.Statement);
const actions=statements.flatMap(s=>[s.Action].flat());

test('connection template grants only list, describe and metric reads',()=>{
 assert.ok(actions.length>0);
 for(const action of actions)assert.match(action,/^(lambda:List|dynamodb:(List|Describe)|cloudwatch:(GetMetricData|ListMetrics)$|ec2:DescribeRegions$|tag:GetResources$|apigateway:GET$)/);
 assert.ok(statements.every(s=>s.Effect==='Allow'&&!actions.includes('*')));
});
test('connection template trusts only CloudOutcome runtime roles with the workspace External ID',()=>{
 const [trust]=role.AssumeRolePolicyDocument.Statement;
 assert.deepEqual(trust.Principal,{AWS:{'Fn::Sub':'arn:${AWS::Partition}:iam::${TrustedAccountId}:root'}});
 assert.deepEqual(trust.Condition.StringEquals,{'sts:ExternalId':{Ref:'ExternalIds'}});
 assert.deepEqual(trust.Condition.ArnLike,{'aws:PrincipalArn':{'Fn::Sub':'arn:${AWS::Partition}:iam::${TrustedAccountId}:role/outcomelens-*-runtime-api'}});
});
test('connection role name is the single fixed name CloudOutcome may assume',()=>{
 assert.equal(role.RoleName,'cloud_outcome_readonlyaccess');
});
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const outfile=join(mkdtempSync(join(tmpdir(),'ol-live-')),'live.mjs');
buildSync({entryPoints:[new URL('../src/live.tsx',import.meta.url).pathname],bundle:true,outfile,format:'esm',platform:'node',jsx:'automatic',logLevel:'silent',define:{'import.meta.env.DEV':'false'}});
const {usd,unitPrice}=await import(pathToFileURL(outfile).href);
test('estimates keep sub-cent precision without scientific notation',()=>{
 assert.equal(usd(0.000325),'$0.000325');
 assert.equal(usd(12.5),'$12.50');
 assert.equal(usd(0),'$0.00');
 assert.equal(usd(null),'—');
 assert.doesNotMatch(usd(3.5e-7),/e/);
});
test('unit prices are shown in plain decimals',()=>{
 assert.equal(unitPrice(2e-7),'$0.0000002');
 assert.equal(unitPrice(0.25),'$0.25');
 assert.equal(unitPrice(null),'—');
});
