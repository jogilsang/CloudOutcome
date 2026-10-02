import test from 'node:test';
import assert from 'node:assert/strict';
import {App} from 'aws-cdk-lib';
import {Template} from 'aws-cdk-lib/assertions';
import {SantaDemoStack,SHOPS} from './santa-demo.mjs';
const t=Template.fromStack(new SantaDemoStack(new App(),'Santa',{env:{region:'us-east-1'}}));
const tagged=(type)=>Object.values(t.findResources(type)).map(r=>{const tags=r.Properties.Tags;return Array.isArray(tags)?Object.fromEntries(tags.map(x=>[x.Key,x.Value])).outcome:tags?.outcome});
test('every shop resource carries its outcome tag',()=>{
 const shops=SHOPS.map(s=>s.id).sort();
 assert.deepEqual(tagged('AWS::DynamoDB::Table').sort(),shops);
 assert.deepEqual(tagged('AWS::ApiGatewayV2::Api').sort(),shops);
 assert.deepEqual(tagged('AWS::Lambda::Function').filter(Boolean).sort(),shops);
});
test('synthetic traffic runs every five minutes from EventBridge',()=>{
 const [rule]=Object.values(t.findResources('AWS::Events::Rule'));
 assert.equal(rule.Properties.ScheduleExpression,'rate(5 minutes)');
});
test('demo cost is bounded by throttles, concurrency and table throughput',()=>{
 for(const s of Object.values(t.findResources('AWS::ApiGatewayV2::Stage')))assert.ok(s.Properties.DefaultRouteSettings.ThrottlingRateLimit<=20);
 for(const f of Object.values(t.findResources('AWS::Lambda::Function')))assert.ok(f.Properties.ReservedConcurrentExecutions<=5);
 for(const d of Object.values(t.findResources('AWS::DynamoDB::Table')))assert.ok(d.Properties.OnDemandThroughput.MaxWriteRequestUnits<=20);
});
