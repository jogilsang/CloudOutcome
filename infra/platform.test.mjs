import test from 'node:test';
import assert from 'node:assert/strict';
import {App} from 'aws-cdk-lib';
import {Template} from 'aws-cdk-lib/assertions';
import {PlatformStack} from './platform.mjs';
import {DeploymentPipelineStack} from './pipeline.mjs';
const platform=()=>Template.fromStack(new PlatformStack(new App(),'Platform',{env:{region:'us-east-1'}}));
test('data is on-demand, retained, encrypted and protected from deletion',()=>{
 const t=platform();const table=Object.values(t.findResources('AWS::DynamoDB::Table'))[0];
 assert.equal(table.Properties.BillingMode,'PAY_PER_REQUEST');assert.equal(table.DeletionPolicy,'Retain');
 assert.equal(table.Properties.DeletionProtectionEnabled,true);assert.equal(table.Properties.PointInTimeRecoverySpecification.PointInTimeRecoveryEnabled,true);
 assert.ok(table.Properties.OnDemandThroughput);assert.ok(table.Properties.SSESpecification);
});
test('every API route except the GET-only public snapshot requires JWT scope and no public Lambda URL exists',()=>{
 const t=platform();for(const route of Object.values(t.findResources('AWS::ApiGatewayV2::Route'))){if(route.Properties.RouteKey==='GET /api/public/{proxy+}'||route.Properties.RouteKey.endsWith(' /api/anon/{proxy+}')){assert.ok(!route.Properties.AuthorizationType||route.Properties.AuthorizationType==='NONE');continue;}assert.equal(route.Properties.AuthorizationType,'JWT');assert.deepEqual(route.Properties.AuthorizationScopes,['outcomelens/api']);}
 t.resourceCountIs('AWS::Lambda::Url',0);
 const keys=Object.values(t.findResources('AWS::ApiGatewayV2::Route')).map(r=>r.Properties.RouteKey);
 assert.deepEqual(keys.sort(),['GET /api/anon/{proxy+}','GET /api/public/{proxy+}','GET /api/{proxy+}','POST /api/anon/{proxy+}','POST /api/{proxy+}','PUT /api/anon/{proxy+}','PUT /api/{proxy+}']);
 const stage=Object.values(t.findResources('AWS::ApiGatewayV2::Stage'))[0].Properties;
 assert.ok(stage.AccessLogSettings);assert.ok(stage.DefaultRouteSettings.ThrottlingRateLimit);
});
test('authentication requires MFA, disables signup and uses public PKCE-compatible code flow',()=>{
 const t=platform();const pool=Object.values(t.findResources('AWS::Cognito::UserPool'))[0].Properties;
 assert.equal(pool.MfaConfiguration,'ON');assert.equal(pool.AdminCreateUserConfig.AllowAdminCreateUserOnly,true);
 const client=Object.values(t.findResources('AWS::Cognito::UserPoolClient'))[0].Properties;
 assert.equal(client.GenerateSecret,false);assert.deepEqual(client.AllowedOAuthFlows,['code']);
});
test('runtime roles have boundaries; account access is limited to OutcomeLens read-only roles and no model access is granted',()=>{
 const t=platform();for(const role of Object.values(t.findResources('AWS::IAM::Role')))assert.ok(role.Properties.PermissionsBoundary);
 for(const policy of Object.values(t.findResources('AWS::IAM::Policy')))for(const statement of policy.Properties.PolicyDocument.Statement)for(const action of [].concat(statement.Action)){
  assert.ok(!action.startsWith('bedrock:'));
  if(action==='sts:AssumeRole')assert.match(JSON.stringify(statement.Resource),/:iam::\*:role\/cloud_outcome_readonlyaccess"/);
 }
 const fn=Object.values(t.findResources('AWS::Lambda::Function'))[0].Properties;
 assert.equal(fn.TracingConfig.Mode,'Active');assert.ok(fn.ReservedConcurrentExecutions);assert.equal(fn.Environment.Variables.OUTCOMELENS_MODE,'cloud');
});
test('access logs exclude personal data, tokens, full URLs and request bodies',()=>{
 const t=platform();const log=Object.values(t.findResources('AWS::ApiGatewayV2::Stage'))[0].Properties.AccessLogSettings.Format;
 assert.doesNotMatch(log,/sourceIp|userAgent|authorization|queryString|body|claims/i);
 assert.match(log,/requestId/);
});
test('pipeline automatically deploys the same release in dev validation prod order',()=>{
 const t=Template.fromStack(new DeploymentPipelineStack(new App(),'Pipeline',{env:{region:'us-east-1'}}));
 const p=Object.values(t.findResources('AWS::CodePipeline::Pipeline'))[0].Properties;
 assert.equal(p.PipelineType,'V2');assert.equal(p.ExecutionMode,'QUEUED');
 assert.deepEqual(p.Stages.map(s=>s.Name),['Source','Build','Deploydev','Deployvalidation','Deployprod']);
 assert.ok(p.Stages.slice(2).every(s=>s.Actions[0].InputArtifacts[0].Name==='Release'));
 assert.ok(p.Stages.every(s=>s.Actions.every(a=>a.ActionTypeId.Category!=='Approval')));
 for(const b of Object.values(t.findResources('AWS::CodeBuild::Project')))assert.equal(b.Properties.Environment.PrivilegedMode,false);
});
test('cloudformation roles grant resource handler create/read actions used by the platform template',()=>{
 // From CloudFormation registry handler permissions (describe-type) for the platform resource types.
 const required=['cognito-idp:SetUserPoolMfaConfig','cognito-idp:GetUserPoolMfaConfig','cognito-idp:ListUserPoolClientSecrets','cloudwatch:ListTagsForResource','codedeploy:ListDeployments','apigateway:TagResource',
  'dynamodb:DescribeContributorInsights','dynamodb:DescribeKinesisStreamingDestination','dynamodb:GetResourcePolicy','logs:DescribeIndexPolicies','logs:GetDataProtectionPolicy',
  'lambda:GetFunctionCodeSigningConfig','lambda:GetFunctionRecursionConfig','lambda:GetFunctionScalingConfig','lambda:GetProvisionedConcurrencyConfig','lambda:GetRuntimeManagementConfig'];
 const t=Template.fromStack(new DeploymentPipelineStack(new App(),'Pipeline',{env:{region:'us-east-1'}}));
 const policies=Object.entries(t.findResources('AWS::IAM::Policy')).filter(([k])=>/^(dev|validation|prod)CloudFormationDefaultPolicy/.test(k));
 assert.equal(policies.length,3);
 for(const [,p] of policies){
  const granted=new Set(p.Properties.PolicyDocument.Statement.flatMap(s=>[s.Action].flat()));
  for(const a of required)assert.ok(granted.has(a),`missing ${a}`);
  assert.ok(!granted.has('iam:DeleteRolePermissionsBoundary'));
 }
});
test('cloudformation roles may attach every managed policy the platform template uses',()=>{
 const platform=Template.fromStack(new PlatformStack(new App(),'Platform',{env:{region:'us-east-1'}}));
 const used=Object.values(platform.findResources('AWS::IAM::Role')).flatMap(r=>r.Properties.ManagedPolicyArns||[])
  .map(a=>a['Fn::Join'][1].slice(-1)[0]);
 assert.ok(used.length>0);
 const t=Template.fromStack(new DeploymentPipelineStack(new App(),'Pipeline',{env:{region:'us-east-1'}}));
 for(const [k,p] of Object.entries(t.findResources('AWS::IAM::Policy')).filter(([k])=>/CloudFormationDefaultPolicy/.test(k))){
  const attach=p.Properties.PolicyDocument.Statement.find(s=>[s.Action].flat().includes('iam:AttachRolePolicy'));
  const allowed=attach.Condition.ArnEquals['iam:PolicyARN'];
  for(const suffix of used)assert.ok(allowed.some(a=>a.endsWith(suffix)),`${k} cannot attach ${suffix}`);
 }
});
test('pipeline variable namespaces never collide with artifact names and revisions resolve from them',()=>{
 const t=Template.fromStack(new DeploymentPipelineStack(new App(),'Pipeline',{env:{region:'us-east-1'}}));
 const p=Object.values(t.findResources('AWS::CodePipeline::Pipeline'))[0].Properties;
 const all=p.Stages.flatMap(s=>s.Actions);
 const artifacts=new Set(all.flatMap(a=>(a.OutputArtifacts||[]).map(o=>o.Name)));
 const namespaces=all.map(a=>a.Namespace).filter(Boolean);
 assert.equal(namespaces.length,3);
 for(const n of namespaces)assert.ok(!artifacts.has(n),`namespace ${n} matches an output artifact`);
 const env=JSON.parse(p.Stages.find(s=>s.Name==='Build').Actions[0].Configuration.EnvironmentVariables);
 for(const v of env.filter(e=>e.name.endsWith('_REVISION')))assert.ok(namespaces.includes(v.value.match(/^#\{(\w+)\.CommitId\}$/)[1]));
});
test('collector runs the 10-minute demo refresh and the daily connection check with fixed task inputs',()=>{
 const rules=Object.values(platform().findResources('AWS::Events::Rule')).map(r=>[r.Properties.ScheduleExpression,JSON.parse(r.Properties.Targets[0].Input).outcomelens_task]).sort();
 assert.deepEqual(rules,[['rate(1 day)','check-connections'],['rate(10 minutes)','refresh-live-demo']]);
});
test('runtime boundary permits only the read-only collector additions',()=>{
 const t=Template.fromStack(new DeploymentPipelineStack(new App(),'Pipeline',{env:{region:'us-east-1'}}));
 for(const boundary of Object.values(t.findResources('AWS::IAM::ManagedPolicy'))){
  const statements=boundary.Properties.PolicyDocument.Statement;
  const assume=statements.find(s=>[s.Action].flat().includes('sts:AssumeRole'));
  assert.deepEqual([assume.Resource].flat(),['arn:aws:iam::*:role/cloud_outcome_readonlyaccess']);
  assert.ok(!statements.some(s=>[s.Action].flat().some(a=>a.endsWith(':*')||a==='*')));
 }
});
test('production canary shifts 10% and observes for one minute',()=>{
 const configs=Object.values(platform().findResources('AWS::CodeDeploy::DeploymentConfig'));
 assert.equal(configs.length,1);
 assert.deepEqual(configs[0].Properties.TrafficRoutingConfig,{Type:'TimeBasedCanary',TimeBasedCanary:{CanaryPercentage:10,CanaryInterval:1}});
});
