import {Stack,Duration,RemovalPolicy,CfnOutput,Tags} from 'aws-cdk-lib';
import * as cp from 'aws-cdk-lib/aws-codepipeline';
import * as actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as cb from 'aws-cdk-lib/aws-codebuild';
import * as cc from 'aws-cdk-lib/aws-codecommit';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as logs from 'aws-cdk-lib/aws-logs';
export class DeploymentPipelineStack extends Stack {
 constructor(scope,id,props={}) {
  super(scope,id,props);Tags.of(this).add('Project','OutcomeLens');
  const artifactBucket=new s3.Bucket(this,'Artifacts',{encryption:s3.BucketEncryption.S3_MANAGED,blockPublicAccess:s3.BlockPublicAccess.BLOCK_ALL,enforceSSL:true,versioned:true,removalPolicy:RemovalPolicy.RETAIN,lifecycleRules:[{noncurrentVersionExpiration:Duration.days(30),abortIncompleteMultipartUploadAfter:Duration.days(1)}]});
  artifactBucket.addToResourcePolicy(new iam.PolicyStatement({effect:iam.Effect.DENY,principals:[new iam.AnyPrincipal()],actions:['s3:DeleteObject','s3:DeleteObjectVersion'],resources:[artifactBucket.arnForObjects('releases/*')]}));
  artifactBucket.addToResourcePolicy(new iam.PolicyStatement({effect:iam.Effect.DENY,principals:[new iam.AnyPrincipal()],actions:['s3:PutObject'],resources:[artifactBucket.arnForObjects('releases/*')],conditions:{Null:{'s3:if-none-match':'true'}}}));
  const pipeline=new cp.Pipeline(this,'Pipeline',{pipelineName:'outcomelens-deployment',pipelineType:cp.PipelineType.V2,executionMode:cp.ExecutionMode.QUEUED,artifactBucket,restartExecutionOnUpdate:false});
  const source={};const sourceActions=[];
  for(const component of ['frontend','backend','infra']){
   source[component]=new cp.Artifact(component);
   sourceActions.push(new actions.CodeCommitSourceAction({actionName:component,repository:cc.Repository.fromRepositoryName(this,component,'outcomelens-'+component),branch:'main',output:source[component],trigger:actions.CodeCommitTrigger.EVENTS,variablesNamespace:component+'Src'}));
  }
  pipeline.addStage({stageName:'Source',actions:sourceActions});
  const logGroup=id=>new logs.LogGroup(this,id,{retention:logs.RetentionDays.ONE_MONTH,removalPolicy:RemovalPolicy.RETAIN});
  const bundle=new cp.Artifact('Release');
  const build=new cb.PipelineProject(this,'Build',{buildSpec:cb.BuildSpec.fromSourceFilename('ci/buildspec-build.yml'),timeout:Duration.minutes(20),grantReportGroupPermissions:false,
   environment:{buildImage:cb.LinuxBuildImage.STANDARD_7_0,computeType:cb.ComputeType.SMALL,privileged:false},logging:{cloudWatch:{logGroup:logGroup('BuildLogs')}}});
  pipeline.addStage({stageName:'Build',actions:[new actions.CodeBuildAction({actionName:'PackageAndVerify',project:build,input:source.infra,extraInputs:[source.frontend,source.backend],outputs:[bundle],environmentVariables:{FRONTEND_REVISION:{value:'#{frontendSrc.CommitId}'},BACKEND_REVISION:{value:'#{backendSrc.CommitId}'},INFRA_REVISION:{value:'#{infraSrc.CommitId}'}}})]});
  for(const environment of ['dev','validation','prod']){
   const prefix='outcomelens-'+environment;
   const arn=(service,resource)=>this.formatArn({service,resource});
   const functionArn=arn('lambda','function:'+prefix+'-*');
   const tableArn=arn('dynamodb','table/'+prefix+'-*');
   const runtimeBoundary=new iam.ManagedPolicy(this,environment+'RuntimeBoundary',{
    managedPolicyName:prefix+'-runtime-boundary',statements:[
     new iam.PolicyStatement({actions:['dynamodb:Query','dynamodb:UpdateItem','dynamodb:PutItem'],resources:[tableArn]}),
     new iam.PolicyStatement({actions:['logs:CreateLogStream','logs:PutLogEvents','logs:CreateLogGroup'],resources:[arn('logs','log-group:/outcomelens/'+environment+'/*')]}),
     new iam.PolicyStatement({actions:['xray:PutTraceSegments','xray:PutTelemetryRecords','cloudwatch:DescribeAlarms','codedeploy:PutLifecycleEventHookExecutionStatus'],resources:['*']}),
     new iam.PolicyStatement({actions:['lambda:GetAlias','lambda:UpdateAlias','lambda:GetFunctionConfiguration','lambda:InvokeFunction','lambda:ListVersionsByFunction'],resources:[functionArn]}),
     new iam.PolicyStatement({actions:['sts:AssumeRole'],resources:['arn:aws:iam::*:role/cloud_outcome_readonlyaccess']}),
     new iam.PolicyStatement({actions:['pricing:GetProducts'],resources:['*']}),
    ]});
   const execution=new iam.Role(this,environment+'CloudFormation',{assumedBy:new iam.ServicePrincipal('cloudformation.amazonaws.com'),roleName:prefix+'-cloudformation'});
   const runtimeRoles=this.formatArn({service:'iam',region:'',resource:'role/'+prefix+'-runtime-*'});
   execution.addToPolicy(new iam.PolicyStatement({actions:['iam:CreateRole','iam:PutRolePermissionsBoundary'],resources:[runtimeRoles],conditions:{StringEquals:{'iam:PermissionsBoundary':runtimeBoundary.managedPolicyArn}}}));
   execution.addToPolicy(new iam.PolicyStatement({actions:['iam:GetRole','iam:DeleteRole','iam:PutRolePolicy','iam:DeleteRolePolicy','iam:GetRolePolicy','iam:ListRolePolicies','iam:ListAttachedRolePolicies','iam:TagRole','iam:UntagRole'],resources:[runtimeRoles]}));
   execution.addToPolicy(new iam.PolicyStatement({actions:['iam:AttachRolePolicy','iam:DetachRolePolicy'],resources:[runtimeRoles],conditions:{ArnEquals:{'iam:PolicyARN':['arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole','arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess','arn:aws:iam::aws:policy/service-role/AWSCodeDeployRoleForLambdaLimited']}}}));
   execution.addToPolicy(new iam.PolicyStatement({actions:['iam:PassRole'],resources:[runtimeRoles],conditions:{StringEquals:{'iam:PassedToService':['lambda.amazonaws.com','codedeploy.amazonaws.com']}}}));
   execution.addToPolicy(new iam.PolicyStatement({actions:['lambda:CreateFunction','lambda:GetFunction','lambda:GetFunctionConfiguration','lambda:UpdateFunctionCode','lambda:UpdateFunctionConfiguration','lambda:DeleteFunction','lambda:PublishVersion','lambda:ListVersionsByFunction','lambda:CreateAlias','lambda:GetAlias','lambda:UpdateAlias','lambda:DeleteAlias','lambda:AddPermission','lambda:RemovePermission','lambda:GetPolicy','lambda:PutFunctionConcurrency','lambda:DeleteFunctionConcurrency','lambda:TagResource','lambda:UntagResource','lambda:GetFunctionCodeSigningConfig','lambda:GetFunctionRecursionConfig','lambda:GetFunctionScalingConfig','lambda:GetProvisionedConcurrencyConfig','lambda:GetRuntimeManagementConfig'],resources:[functionArn]}));
   execution.addToPolicy(new iam.PolicyStatement({actions:['dynamodb:CreateTable','dynamodb:DescribeTable','dynamodb:UpdateTable','dynamodb:DescribeContinuousBackups','dynamodb:UpdateContinuousBackups','dynamodb:DescribeTimeToLive','dynamodb:UpdateTimeToLive','dynamodb:TagResource','dynamodb:UntagResource','dynamodb:ListTagsOfResource','dynamodb:DescribeContributorInsights','dynamodb:DescribeKinesisStreamingDestination','dynamodb:GetResourcePolicy'],resources:[tableArn]}));
   execution.addToPolicy(new iam.PolicyStatement({actions:['logs:CreateLogGroup','logs:DescribeLogGroups','logs:PutRetentionPolicy','logs:DeleteRetentionPolicy','logs:TagResource','logs:UntagResource','logs:ListTagsForResource','logs:DescribeIndexPolicies','logs:GetDataProtectionPolicy'],resources:[arn('logs','log-group:/outcomelens/'+environment+'/*')]}));
   execution.addToPolicy(new iam.PolicyStatement({actions:['logs:CreateLogDelivery','logs:GetLogDelivery','logs:UpdateLogDelivery','logs:DeleteLogDelivery','logs:ListLogDeliveries','logs:PutResourcePolicy','logs:DescribeResourcePolicies','logs:DescribeLogGroups'],resources:['*']}));
   // Resource IDs for these services are assigned on creation. Explicit service/action lists
   // bound the control-plane role; separate production accounts are recommended for stronger isolation.
   execution.addToPolicy(new iam.PolicyStatement({actions:['apigateway:GET','apigateway:POST','apigateway:PUT','apigateway:PATCH','apigateway:DELETE','apigateway:TagResource','apigateway:UntagResource'],resources:[`arn:aws:apigateway:${this.region}::/apis*`,`arn:aws:apigateway:${this.region}::/tags/*`]}));
   execution.addToPolicy(new iam.PolicyStatement({actions:['cognito-idp:CreateUserPool','cognito-idp:DescribeUserPool','cognito-idp:UpdateUserPool','cognito-idp:CreateUserPoolClient','cognito-idp:DescribeUserPoolClient','cognito-idp:UpdateUserPoolClient','cognito-idp:DeleteUserPoolClient','cognito-idp:CreateUserPoolDomain','cognito-idp:DescribeUserPoolDomain','cognito-idp:UpdateUserPoolDomain','cognito-idp:DeleteUserPoolDomain','cognito-idp:CreateResourceServer','cognito-idp:DescribeResourceServer','cognito-idp:UpdateResourceServer','cognito-idp:DeleteResourceServer','cognito-idp:CreateGroup','cognito-idp:GetGroup','cognito-idp:UpdateGroup','cognito-idp:DeleteGroup','cognito-idp:TagResource','cognito-idp:UntagResource','cognito-idp:ListTagsForResource','cognito-idp:SetUserPoolMfaConfig','cognito-idp:GetUserPoolMfaConfig','cognito-idp:ListUserPoolClientSecrets'],resources:['*']}));
   execution.addToPolicy(new iam.PolicyStatement({actions:['amplify:CreateApp'],resources:['*'],conditions:{StringEquals:{'aws:RequestTag/Project':'OutcomeLens','aws:RequestTag/Environment':environment}}}));
   execution.addToPolicy(new iam.PolicyStatement({actions:['amplify:GetApp','amplify:UpdateApp','amplify:DeleteApp','amplify:CreateBranch','amplify:GetBranch','amplify:UpdateBranch','amplify:DeleteBranch','amplify:TagResource','amplify:UntagResource','amplify:ListTagsForResource'],resources:[arn('amplify','apps/*')]}));
   execution.addToPolicy(new iam.PolicyStatement({actions:['cloudwatch:PutMetricAlarm','cloudwatch:DeleteAlarms','cloudwatch:DescribeAlarms','cloudwatch:PutDashboard','cloudwatch:GetDashboard','cloudwatch:DeleteDashboards','cloudwatch:TagResource','cloudwatch:UntagResource','cloudwatch:ListTagsForResource'],resources:['*']}));
   execution.addToPolicy(new iam.PolicyStatement({actions:['codedeploy:CreateApplication','codedeploy:GetApplication','codedeploy:DeleteApplication','codedeploy:CreateDeploymentGroup','codedeploy:GetDeploymentGroup','codedeploy:UpdateDeploymentGroup','codedeploy:DeleteDeploymentGroup','codedeploy:CreateDeployment','codedeploy:GetDeployment','codedeploy:ListDeployments','codedeploy:CreateDeploymentConfig','codedeploy:DeleteDeploymentConfig','codedeploy:StopDeployment','codedeploy:GetDeploymentConfig','codedeploy:RegisterApplicationRevision','codedeploy:GetApplicationRevision','codedeploy:TagResource','codedeploy:UntagResource','codedeploy:ListTagsForResource'],resources:['*']}));
   execution.addToPolicy(new iam.PolicyStatement({actions:['events:PutRule','events:DescribeRule','events:DeleteRule','events:PutTargets','events:RemoveTargets','events:ListTargetsByRule','events:TagResource','events:UntagResource','events:ListTagsForResource'],resources:[arn('events','rule/'+prefix+'-*')]}));
   artifactBucket.grantRead(execution,'releases/*');
   const deploy=new cb.PipelineProject(this,environment+'Deploy',{timeout:Duration.minutes(45),grantReportGroupPermissions:false,
    buildSpec:cb.BuildSpec.fromSourceFilename('ci/buildspec-deploy.yml'),environment:{buildImage:cb.LinuxBuildImage.STANDARD_7_0,computeType:cb.ComputeType.SMALL,privileged:false},
    logging:{cloudWatch:{logGroup:logGroup(environment+'DeployLogs')}},environmentVariables:{DEPLOY_ENV:{value:environment},ARTIFACT_BUCKET:{value:artifactBucket.bucketName},CFN_ROLE:{value:execution.roleArn},RUNTIME_BOUNDARY:{value:runtimeBoundary.managedPolicyArn}}});
   const stackArn=arn('cloudformation','stack/'+prefix+'/*');
   deploy.addToRolePolicy(new iam.PolicyStatement({actions:['cloudformation:DescribeStacks','cloudformation:CreateChangeSet','cloudformation:DescribeChangeSet','cloudformation:ExecuteChangeSet','cloudformation:DeleteChangeSet','cloudformation:GetTemplate','cloudformation:UpdateTerminationProtection'],resources:[stackArn,arn('cloudformation','changeSet/outcomelens-*/*')]}));
   deploy.addToRolePolicy(new iam.PolicyStatement({actions:['iam:PassRole'],resources:[execution.roleArn],conditions:{StringEquals:{'iam:PassedToService':'cloudformation.amazonaws.com'}}}));
   deploy.addToRolePolicy(new iam.PolicyStatement({actions:['amplify:CreateDeployment','amplify:StartDeployment','amplify:GetJob'],resources:[arn('amplify','apps/*/branches/live*')]}));
   deploy.addToRolePolicy(new iam.PolicyStatement({actions:['lambda:InvokeFunction'],resources:[functionArn]}));
   artifactBucket.grantReadWrite(deploy,'releases/*');artifactBucket.grantReadWrite(deploy,'environments/'+environment+'/*');
   pipeline.addStage({stageName:'Deploy'+environment,actions:[new actions.CodeBuildAction({actionName:'DeployAndVerify',project:deploy,input:bundle})]});
  }
  new CfnOutput(this,'PipelineName',{value:pipeline.pipelineName});
 }
}
