import {App,DefaultStackSynthesizer} from 'aws-cdk-lib';
import {PlatformStack} from './platform.mjs';
const app=new App({outdir:'cdk.out/platform'});
new PlatformStack(app,'OutcomeLensPlatform',{env:{region:'us-east-1'},synthesizer:new DefaultStackSynthesizer({generateBootstrapVersionRule:false}),description:'Parameterized authenticated serverless OutcomeLens platform'});
app.synth();
