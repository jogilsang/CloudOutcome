import {readFileSync} from 'node:fs';
import {Stack,CfnParameter,CfnCondition,Fn,Duration,RemovalPolicy,CfnOutput,Tags} from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as amplify from 'aws-cdk-lib/aws-amplify';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as authorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as codedeploy from 'aws-cdk-lib/aws-codedeploy';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';

export class PlatformStack extends Stack {
 constructor(scope,id,props={}) {
  super(scope,id,props);
  const parameter=(name,type,options={})=>new CfnParameter(this,name,{type,...options});
  const boundary=parameter('RuntimeBoundary','String').valueAsString;
  iam.PermissionsBoundary.of(this).apply(iam.ManagedPolicy.fromManagedPolicyArn(this,'Boundary',boundary));
  const stage=parameter('Environment','String',{allowedValues:['dev','validation','prod']}).valueAsString;
  const bucket=parameter('ArtifactBucket','String').valueAsString;
  const key=parameter('BackendKey','String',{allowedPattern:'releases/[a-f0-9]{64}/backend.zip'}).valueAsString;
  const sha=parameter('BackendSha256','String').valueAsString;
  const release=parameter('ReleaseId','String',{allowedPattern:'[a-f0-9]{64}'}).valueAsString;
  const concurrency=parameter('Concurrency','Number',{default:2,minValue:1,maxValue:20}).valueAsNumber;
  const rate=parameter('ApiRate','Number',{default:5,minValue:1,maxValue:50}).valueAsNumber;
  const burst=parameter('ApiBurst','Number',{default:10,minValue:1,maxValue:100}).valueAsNumber;
  const rpm=parameter('WorkspaceRequestsPerMinute','Number',{default:60,minValue:1,maxValue:600}).valueAsString;
  const read=parameter('MaxReadUnits','Number',{default:20,minValue:1,maxValue:100}).valueAsNumber;
  const write=parameter('MaxWriteUnits','Number',{default:10,minValue:1,maxValue:100}).valueAsNumber;
  const production=new CfnCondition(this,'Production',{expression:Fn.conditionEquals(stage,'prod')});
  const name=Fn.join('-',['outcomelens',stage]);
  Tags.of(this).add('Project','OutcomeLens');Tags.of(this).add('Environment',stage);
  const table=new dynamodb.Table(this,'Workspace',{
   tableName:Fn.join('-',[name,'workspace']),partitionKey:{name:'pk',type:dynamodb.AttributeType.STRING},sortKey:{name:'sk',type:dynamodb.AttributeType.STRING},
   billingMode:dynamodb.BillingMode.PAY_PER_REQUEST,maxReadRequestUnits:read,maxWriteRequestUnits:write,
   encryption:dynamodb.TableEncryption.AWS_MANAGED,timeToLiveAttribute:'expires_at',
   pointInTimeRecoverySpecification:{pointInTimeRecoveryEnabled:true},deletionProtection:true,removalPolicy:RemovalPolicy.RETAIN,
  });
  const web=new amplify.CfnApp(this,'Web',{
   name,platform:'WEB',enableBranchAutoDeletion:false,
   customRules:[{source:'</^[^.]+$|\\.(?!(css|gif|ico|jpg|js|png|txt|svg|woff|woff2|ttf|map|json)$)([^.]+$)/>',target:'/index.html',status:'200'}],
   customHeaders:JSON.stringify({customHeaders:[{pattern:'**',headers:[
    {key:'Strict-Transport-Security',value:'max-age=31536000; includeSubDomains'},
    {key:'X-Content-Type-Options',value:'nosniff'},{key:'X-Frame-Options',value:'DENY'},
    {key:'Referrer-Policy',value:'no-referrer'},{key:'Cache-Control',value:'no-store'},
    {key:'Permissions-Policy',value:'camera=(), microphone=(), geolocation=()'},
    {key:'Content-Security-Policy',value:`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://*.execute-api.${this.region}.amazonaws.com https://*.amazoncognito.com; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self' https://*.amazoncognito.com`},
   ]}]}),
  });
  new amplify.CfnBranch(this,'WebBranch',{appId:web.attrAppId,branchName:'live',enableAutoBuild:false,stage:'PRODUCTION'});
  const webUrl=Fn.join('',['https://live.',web.attrDefaultDomain]);
  const pool=new cognito.UserPool(this,'Users',{
   userPoolName:name,selfSignUpEnabled:false,signInAliases:{username:true},
   mfa:cognito.Mfa.REQUIRED,mfaSecondFactor:{otp:true,sms:false},
   passwordPolicy:{minLength:14,requireDigits:true,requireLowercase:true,requireUppercase:true,requireSymbols:true},
   accountRecovery:cognito.AccountRecovery.NONE,removalPolicy:RemovalPolicy.RETAIN,
  });
  pool.node.defaultChild.addPropertyOverride('DeletionProtection','ACTIVE');
  const apiScope=new cognito.ResourceServerScope({scopeName:'api',scopeDescription:'Access an assigned workspace'});
  const resourceServer=pool.addResourceServer('ApiScopes',{identifier:'outcomelens',scopes:[apiScope]});
  const domain=pool.addDomain('Login',{cognitoDomain:{domainPrefix:Fn.join('-',[name,this.account])}});
  const client=pool.addClient('Browser',{
   generateSecret:false,preventUserExistenceErrors:true,enableTokenRevocation:true,
   accessTokenValidity:Duration.minutes(15),idTokenValidity:Duration.minutes(15),refreshTokenValidity:Duration.hours(1),
   oAuth:{flows:{authorizationCodeGrant:true},callbackUrls:[webUrl+'/'],logoutUrls:[webUrl+'/'],scopes:[cognito.OAuthScope.OPENID,cognito.OAuthScope.resourceServer(resourceServer,apiScope)]},
  });
  for(const group of ['operators','viewers'])new cognito.CfnUserPoolGroup(this,group,{userPoolId:pool.userPoolId,groupName:group});
  const functionLogs=new logs.LogGroup(this,'FunctionLogs',{logGroupName:Fn.join('',['/outcomelens/',stage,'/api']),retention:logs.RetentionDays.ONE_MONTH,removalPolicy:RemovalPolicy.RETAIN});
  const apiRole=new iam.Role(this,'RuntimeApiRole',{roleName:Fn.join('-',[name,'runtime-api']),assumedBy:new iam.ServicePrincipal('lambda.amazonaws.com')});
  const fn=new lambda.Function(this,'ApiFunction',{
   role:apiRole,functionName:Fn.join('-',[name,'api']),runtime:lambda.Runtime.PYTHON_3_14,architecture:lambda.Architecture.X86_64,
   code:lambda.Code.fromBucket(s3.Bucket.fromBucketName(this,'Artifacts',bucket),key),handler:'lambda_entry.handler',
   memorySize:1024,timeout:Duration.seconds(25),reservedConcurrentExecutions:concurrency,
   tracing:lambda.Tracing.ACTIVE,logGroup:functionLogs,loggingFormat:lambda.LoggingFormat.JSON,
   environment:{OUTCOMELENS_MODE:'cloud',TABLE_NAME:table.tableName,ALLOWED_ORIGINS:webUrl,REQUESTS_PER_MINUTE:rpm,AUDIT_DAYS:'30',RELEASE_ID:release,
    // Same-account demo role deployed from the public read-only template; the External ID guards the role, not a secret.
    LIVE_DEMO_ROLE_ARN:`arn:${this.partition}:iam::${this.account}:role/cloud_outcome_readonlyaccess`,LIVE_DEMO_EXTERNAL_ID:'outcomelens-live-demo',LIVE_DEMO_REGION:this.region},
  });
  fn.addEnvironment('RUNTIME_ROLE_ARN',apiRole.roleArn);
  // Read-only collection: only roles created from the OutcomeLens template, plus public list prices.
  fn.addToRolePolicy(new iam.PolicyStatement({actions:['sts:AssumeRole'],resources:[`arn:${this.partition}:iam::*:role/cloud_outcome_readonlyaccess`]}));
  fn.addToRolePolicy(new iam.PolicyStatement({actions:['pricing:GetProducts'],resources:['*']}));
  fn.addToRolePolicy(new iam.PolicyStatement({actions:['dynamodb:Query','dynamodb:UpdateItem','dynamodb:PutItem'],resources:[table.tableArn]}));
  const version=fn.currentVersion;version.node.defaultChild.codeSha256=sha;version.node.defaultChild.description=release;
  const alias=new lambda.Alias(this,'Live',{aliasName:'live',version});
  // Background collector: same code and role, long timeout for chunked multi-account collection and scheduled tasks.
  const collector=new lambda.Function(this,'Collector',{
   role:apiRole,functionName:Fn.join('-',[name,'collector']),runtime:lambda.Runtime.PYTHON_3_14,architecture:lambda.Architecture.X86_64,
   code:lambda.Code.fromBucket(s3.Bucket.fromBucketName(this,'CollectorArtifacts',bucket),key),handler:'lambda_entry.handler',
   memorySize:1024,timeout:Duration.minutes(15),reservedConcurrentExecutions:2,tracing:lambda.Tracing.ACTIVE,loggingFormat:lambda.LoggingFormat.JSON,
   logGroup:new logs.LogGroup(this,'CollectorLogs',{logGroupName:Fn.join('',['/outcomelens/',stage,'/collector']),retention:logs.RetentionDays.ONE_MONTH,removalPolicy:RemovalPolicy.RETAIN}),
   environment:{OUTCOMELENS_MODE:'cloud',TABLE_NAME:table.tableName,ALLOWED_ORIGINS:webUrl,REQUESTS_PER_MINUTE:rpm,AUDIT_DAYS:'30',RELEASE_ID:release,
    LIVE_DEMO_ROLE_ARN:`arn:${this.partition}:iam::${this.account}:role/cloud_outcome_readonlyaccess`,LIVE_DEMO_EXTERNAL_ID:'outcomelens-live-demo',LIVE_DEMO_REGION:this.region,API_ID:'collector-has-no-http'},
  });
  collector.addEnvironment('RUNTIME_ROLE_ARN',apiRole.roleArn);
  fn.addEnvironment('COLLECTOR_FUNCTION',collector.functionName);
  // ARN from the name (not collector.functionArn) to avoid a role-policy <-> function dependency cycle.
  fn.addToRolePolicy(new iam.PolicyStatement({actions:['lambda:InvokeFunction'],resources:[this.formatArn({service:'lambda',resource:'function',resourceName:Fn.join('-',[name,'collector']),arnFormat:'arn:aws:service:region:account:resource:resourceName'})]}));
  const jwt=new authorizers.HttpJwtAuthorizer('UserJwt',pool.userPoolProviderUrl,{jwtAudience:[client.userPoolClientId]});
  const api=new apigw.HttpApi(this,'Api',{apiName:name,createDefaultStage:false,
   corsPreflight:{allowOrigins:[webUrl],allowMethods:[apigw.CorsHttpMethod.GET,apigw.CorsHttpMethod.PUT,apigw.CorsHttpMethod.POST],allowHeaders:['authorization','content-type','x-cloudoutcome-workspace'],exposeHeaders:['x-request-id'],maxAge:Duration.minutes(5)}});
  fn.addEnvironment('API_ID',api.apiId);
  // Explicit methods: an ANY route would also capture unauthenticated CORS preflight and reject it at the JWT authorizer.
  api.addRoutes({path:'/api/{proxy+}',methods:[apigw.HttpMethod.GET,apigw.HttpMethod.PUT,apigw.HttpMethod.POST],authorizer:jwt,authorizationScopes:['outcomelens/api'],integration:new integrations.HttpLambdaIntegration('LambdaApi',alias)});
  // Anonymous judges/visitors read a precomputed, masked snapshot only; the app rejects non-GET and makes no AWS calls here.
  api.addRoutes({path:'/api/public/{proxy+}',methods:[apigw.HttpMethod.GET],integration:new integrations.HttpLambdaIntegration('PublicLambdaApi',alias)});
  // Temporary anonymous workspaces: identity is a browser-held key checked by the app; quotas and origin checks still apply.
  api.addRoutes({path:'/api/anon/{proxy+}',methods:[apigw.HttpMethod.GET,apigw.HttpMethod.PUT,apigw.HttpMethod.POST],integration:new integrations.HttpLambdaIntegration('AnonLambdaApi',alias)});
  const apiLogs=new logs.LogGroup(this,'AccessLogs',{logGroupName:Fn.join('',['/outcomelens/',stage,'/access']),retention:logs.RetentionDays.ONE_MONTH,removalPolicy:RemovalPolicy.RETAIN});
  new apigw.CfnStage(this,'Stage',{apiId:api.apiId,stageName:'$default',autoDeploy:true,
   defaultRouteSettings:{throttlingBurstLimit:burst,throttlingRateLimit:rate,detailedMetricsEnabled:true},
   accessLogSettings:{destinationArn:apiLogs.logGroupArn,format:JSON.stringify({request_id:'$context.requestId',route:'$context.routeKey',status:'$context.status',integration_ms:'$context.integrationLatency',response_length:'$context.responseLength'})}});
  new events.Rule(this,'LiveDemoRefresh',{ruleName:Fn.join('-',[name,'live-demo']),schedule:events.Schedule.rate(Duration.minutes(10)),
   targets:[new targets.LambdaFunction(collector,{event:events.RuleTargetInput.fromObject({outcomelens_task:'refresh-live-demo'}),retryAttempts:0})]});
  new events.Rule(this,'ConnectionCheck',{ruleName:Fn.join('-',[name,'connection-check']),schedule:events.Schedule.rate(Duration.days(1)),
   targets:[new targets.LambdaFunction(collector,{event:events.RuleTargetInput.fromObject({outcomelens_task:'check-connections'}),retryAttempts:0})]});
  const errors=new cloudwatch.Alarm(this,'LambdaErrors',{metric:fn.metricErrors({period:Duration.minutes(1)}),threshold:1,evaluationPeriods:1,treatMissingData:cloudwatch.TreatMissingData.NOT_BREACHING});
  const apiMetric=(metricName,statistic='Sum')=>new cloudwatch.Metric({namespace:'AWS/ApiGateway',metricName,dimensionsMap:{ApiId:api.apiId},statistic,period:Duration.minutes(1)});
  const apiErrors=new cloudwatch.Alarm(this,'ApiErrors',{metric:apiMetric('5xx'),threshold:1,evaluationPeriods:1,treatMissingData:cloudwatch.TreatMissingData.NOT_BREACHING});
  new cloudwatch.Alarm(this,'Latency',{metric:apiMetric('Latency','p95'),threshold:2000,evaluationPeriods:2,treatMissingData:cloudwatch.TreatMissingData.NOT_BREACHING});
  new cloudwatch.Alarm(this,'Throttles',{metric:fn.metricThrottles({period:Duration.minutes(5)}),threshold:1,evaluationPeriods:1,treatMissingData:cloudwatch.TreatMissingData.NOT_BREACHING});
  const hookRole=new iam.Role(this,'RuntimeHookRole',{roleName:Fn.join('-',[name,'runtime-pretraffic']),assumedBy:new iam.ServicePrincipal('lambda.amazonaws.com')});
  const hook=new lambda.Function(this,'PreTraffic',{role:hookRole,functionName:Fn.join('-',[name,'pretraffic']),runtime:lambda.Runtime.PYTHON_3_14,handler:'index.handler',
   code:lambda.Code.fromInline(readFileSync(new URL('./ci/pretraffic.py',import.meta.url),'utf8')),timeout:Duration.seconds(60),reservedConcurrentExecutions:1,
   logGroup:new logs.LogGroup(this,'HookLogs',{logGroupName:Fn.join('',['/outcomelens/',stage,'/pretraffic']),retention:logs.RetentionDays.ONE_MONTH,removalPolicy:RemovalPolicy.RETAIN}),
   environment:{TARGET_FUNCTION:fn.functionName,TARGET_VERSION:version.version,API_ID:api.apiId}});
  version.grantInvoke(hook);
  hook.addToRolePolicy(new iam.PolicyStatement({actions:['codedeploy:PutLifecycleEventHookExecutionStatus'],resources:['*']}));
  const rolloutRole=new iam.Role(this,'RuntimeRolloutRole',{roleName:Fn.join('-',[name,'runtime-rollout']),assumedBy:new iam.ServicePrincipal('codedeploy.amazonaws.com')});
  // Hackathon choice: 10% canary observed for 1 minute (predefined configs start at 5 minutes).
  const canary=new codedeploy.LambdaDeploymentConfig(this,'Canary1Minute',{deploymentConfigName:Fn.join('-',[name,'canary-10pct-1min']),trafficRouting:new codedeploy.TimeBasedCanaryTrafficRouting({interval:Duration.minutes(1),percentage:10})});
  const rollout=new codedeploy.LambdaDeploymentGroup(this,'Rollout',{alias,role:rolloutRole,preHook:hook,deploymentConfig:canary,
   alarms:[errors,apiErrors],autoRollback:{failedDeployment:true,stoppedDeployment:true,deploymentInAlarm:true}});
  rollout.node.defaultChild.deploymentConfigName=Fn.conditionIf(production.logicalId,canary.deploymentConfigName,'CodeDeployDefault.LambdaAllAtOnce').toString();
  new cloudwatch.Dashboard(this,'Operations',{dashboardName:Fn.join('-',[name,'operations']),widgets:[
   [new cloudwatch.GraphWidget({title:'Lambda errors and throttles',left:[fn.metricErrors(),fn.metricThrottles()]})],
   [new cloudwatch.GraphWidget({title:'API p95 latency',left:[apiMetric('Latency','p95')]})],
  ]});
  const outputs={ApiUrl:api.apiEndpoint,ApiId:api.apiId,FunctionName:fn.functionName,UserPoolId:pool.userPoolId,ClientId:client.userPoolClientId,LoginDomain:domain.baseUrl(),AmplifyAppId:web.attrAppId,WebUrl:webUrl,DeployedRelease:release};
  for(const [key,value] of Object.entries(outputs))new CfnOutput(this,key,{value});
 }
}
