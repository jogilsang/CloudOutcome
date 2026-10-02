import {App,DefaultStackSynthesizer} from 'aws-cdk-lib';
import {SantaDemoStack} from './santa-demo.mjs';
const app=new App({outdir:'cdk.out/santa'});
new SantaDemoStack(app,'CloudOutcomeSantaDemo',{env:{region:'us-east-1'},synthesizer:new DefaultStackSynthesizer({generateBootstrapVersionRule:false}),
 description:'santacloth demo storefronts (synthetic traffic) for CloudOutcome; delete this stack to remove every demo resource'});
app.synth();
