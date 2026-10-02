import {Stack,RemovalPolicy,CfnOutput,Duration,Tags} from 'aws-cdk-lib';
import * as codecommit from 'aws-cdk-lib/aws-codecommit';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as logs from 'aws-cdk-lib/aws-logs';
export class RepositoryStack extends Stack {
 constructor(scope,id,props={}) {
  super(scope,id,props);
  Tags.of(this).add('Project','OutcomeLens');
  for(const component of ['frontend','backend','infra']) {
   const repository=new codecommit.Repository(this,component+'Repository',{
    repositoryName:'outcomelens-'+component,
    description:'OutcomeLens '+component+' source; main branch verification',
   });
   repository.applyRemovalPolicy(RemovalPolicy.RETAIN);
   const group=new logs.LogGroup(this,component+'BuildLogs',{
    retention:logs.RetentionDays.ONE_WEEK,removalPolicy:RemovalPolicy.RETAIN,
   });
   const project=new codebuild.Project(this,component+'Verify',{
    projectName:'outcomelens-'+component+'-verify',
    source:codebuild.Source.codeCommit({repository,branchOrRef:'main'}),
    buildSpec:codebuild.BuildSpec.fromSourceFilename('buildspec.yml'),
    environment:{buildImage:codebuild.LinuxBuildImage.STANDARD_7_0,
     computeType:codebuild.ComputeType.SMALL,privileged:false},
    timeout:Duration.minutes(15),queuedTimeout:Duration.minutes(30),
    concurrentBuildLimit:1,grantReportGroupPermissions:false,logging:{cloudWatch:{logGroup:group}},
   });
   // No scheduled build, NAT gateway, reserved fleet, or deployment permissions.
   // Start a verification build explicitly; add reviewed release automation later.
   new CfnOutput(this,component+'CloneUrl',{value:repository.repositoryCloneUrlHttp});
   new CfnOutput(this,component+'BuildName',{value:project.projectName});
  }
 }
}
