import {App} from 'aws-cdk-lib';
import {DemoHostingStack} from './stack.mjs';
import {fileURLToPath} from 'node:url';
const app=new App({outdir:fileURLToPath(new URL('./cdk.out',import.meta.url))});
new DemoHostingStack(app,'OutcomeLensDemo',{
  env:{region:'us-east-1'},
  previewPath:process.env.OUTCOMELENS_PREVIEW,
  terminationProtection:true,
  description:'OutcomeLens isolated synthetic demo hosting. No live customer connectors.',
});
app.synth();
