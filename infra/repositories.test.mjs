import test from 'node:test';
import assert from 'node:assert/strict';
import {App} from 'aws-cdk-lib';
import {Template} from 'aws-cdk-lib/assertions';
import {RepositoryStack} from './repositories.mjs';
const template=()=>Template.fromStack(new RepositoryStack(new App(),'Repos'));
test('creates exactly three named retained source repositories',()=>{
 const repos=Object.values(template().findResources('AWS::CodeCommit::Repository'));
 assert.deepEqual(repos.map(r=>r.Properties.RepositoryName).sort(),['outcomelens-backend','outcomelens-frontend','outcomelens-infra']);
 for(const r of repos){assert.equal(r.DeletionPolicy,'Retain');assert.equal(r.UpdateReplacePolicy,'Retain');}
});
test('verification builds have bounded runtime and no VPC or privileged Docker',()=>{
 const builds=Object.values(template().findResources('AWS::CodeBuild::Project'));
 assert.equal(builds.length,3);
 for(const {Properties:p} of builds){assert.equal(p.TimeoutInMinutes,15);assert.equal(p.ConcurrentBuildLimit,1);assert.equal(p.Environment.PrivilegedMode,false);assert.equal(p.VpcConfig,undefined);assert.equal(p.Artifacts.Type,'NO_ARTIFACTS');}
});
test('verification roles cannot deploy, modify source, or read customer telemetry',()=>{
 const policies=template().findResources('AWS::IAM::Policy');
 for(const p of Object.values(policies))for(const s of p.Properties.PolicyDocument.Statement){
  for(const a of [].concat(s.Action))assert.ok(['codecommit:GitPull','logs:CreateLogStream','logs:PutLogEvents','logs:CreateLogGroup'].includes(a),'unexpected permission '+a);
 }
});
test('source repositories expose clone URLs and builds do not run on a schedule',()=>{
 const t=template();assert.equal(Object.keys(t.toJSON().Outputs).length,6);
 t.resourceCountIs('AWS::Events::Rule',0);t.resourceCountIs('AWS::CodePipeline::Pipeline',0);
});
