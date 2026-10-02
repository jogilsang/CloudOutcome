import {App,DefaultStackSynthesizer} from 'aws-cdk-lib';
import {DeploymentPipelineStack} from './pipeline.mjs';
const app=new App({outdir:'cdk.out/pipeline'});
new DeploymentPipelineStack(app,'OutcomeLensDeployment',{env:{region:'us-east-1'},synthesizer:new DefaultStackSynthesizer({generateBootstrapVersionRule:false}),terminationProtection:true});
app.synth();
