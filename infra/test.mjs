import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {App} from 'aws-cdk-lib';
import {Template,Match} from 'aws-cdk-lib/assertions';
import {DemoHostingStack} from './stack.mjs';
const template=()=>Template.fromStack(new DemoHostingStack(new App(),'Test',{env:{region:'us-east-1'},previewPath:fileURLToPath(new URL('./fixtures/synthetic-test.html',import.meta.url))}));
test('all buckets block public access and enforce secure transport',()=>{
 const t=template();
 for(const r of Object.values(t.findResources('AWS::S3::Bucket'))){
  if(!r.Properties.PublicAccessBlockConfiguration)throw Error('Public block absent');
  for(const v of Object.values(r.Properties.PublicAccessBlockConfiguration))if(v!==true)throw Error('Public access allowed');
  if(!r.Properties.BucketEncryption)throw Error('Encryption absent');
 }
 t.hasResourceProperties('AWS::S3::BucketPolicy',{PolicyDocument:{Statement:Match.arrayWith([
  Match.objectLike({Effect:'Deny',Condition:{Bool:{'aws:SecureTransport':'false'}}}),
 ])}});
});
test('CloudFront uses origin access control and HTTPS',()=>{
 const t=template();
 t.resourceCountIs('AWS::CloudFront::OriginAccessControl',1);
 t.hasResourceProperties('AWS::CloudFront::Distribution',{DistributionConfig:Match.objectLike({
  DefaultCacheBehavior:Match.objectLike({ViewerProtocolPolicy:'redirect-to-https'}),
  Logging:Match.objectLike({Prefix:'cloudfront/'}),
 })});
});
test('content security policy does not allow arbitrary inline scripts',()=>{
 const t=template();
 const r=Object.values(t.findResources('AWS::CloudFront::ResponseHeadersPolicy'))[0];
 const csp=r.Properties.ResponseHeadersPolicyConfig.SecurityHeadersConfig.ContentSecurityPolicy.ContentSecurityPolicy;
 if(!csp.includes("script-src 'sha256-")||csp.includes("script-src 'unsafe-inline'"))throw Error('Weak script policy');
});
test('no account connector or model permissions in public demo',()=>{
 const t=template();
 for(const policy of Object.values(t.findResources('AWS::IAM::Policy'))){
  const text=JSON.stringify(policy);
  if(/sts:AssumeRole|bedrock:|ce:GetCostAndUsage/.test(text))throw Error('Public demo can access customer data');
 }
 t.resourceCountIs('AWS::CloudWatch::Alarm',1);
 t.hasResourceProperties('AWS::Logs::LogGroup',{RetentionInDays:7});
});

test('hosting refuses an absent frontend artifact',()=>{
 assert.throws(()=>new DemoHostingStack(new App(),'Missing'),/previewPath is required/);
});
test('hosting reports an unreadable frontend artifact',()=>{
 assert.throws(()=>new DemoHostingStack(new App(),'MissingFile',{previewPath:'/nonexistent/outcomelens.html'}),/ENOENT/);
});
test('hosting rejects a non-preview document',()=>{
 assert.throws(()=>new DemoHostingStack(new App(),'Wrong',{previewPath:fileURLToPath(new URL('./package.json',import.meta.url))}),/Expected an isolated/);
});
