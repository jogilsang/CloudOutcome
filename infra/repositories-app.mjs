import {App} from 'aws-cdk-lib';
import {RepositoryStack} from './repositories.mjs';
const app=new App({outdir:'cdk.out/repositories'});
new RepositoryStack(app,'OutcomeLensRepositories',{
 env:{region:process.env.AWS_REGION||'us-east-1'},terminationProtection:true,
 description:'OutcomeLens retained source repositories and on-demand verification builds',
});
app.synth();
