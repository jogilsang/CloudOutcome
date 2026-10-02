import {Stack, Duration, RemovalPolicy, CfnOutput, Tags} from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as deployment from 'aws-cdk-lib/aws-s3-deployment';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as logsService from 'aws-cdk-lib/aws-logs';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';


export class DemoHostingStack extends Stack {
  constructor(scope, id, props={}) {
    const {previewPath, ...stackProps}=props;
    super(scope,id,stackProps);
    Tags.of(this).add('Project','OutcomeLens');
    Tags.of(this).add('Environment','demo');
    Tags.of(this).add('DataClassification','synthetic');
    if(!previewPath) throw new Error('previewPath is required: supply a reviewed frontend artifact');
    const html=readFileSync(previewPath,'utf8');
    if(!html.includes('window.__OUTCOMELENS_SAMPLE__=')) throw new Error('Expected an isolated synthetic preview artifact');
    const hashes=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
      .map(m=>`'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`);
    const logs=new s3.Bucket(this,'AccessLogs',{
      blockPublicAccess:s3.BlockPublicAccess.BLOCK_ALL,
      encryption:s3.BucketEncryption.S3_MANAGED,enforceSSL:true,
      objectOwnership:s3.ObjectOwnership.OBJECT_WRITER,
      removalPolicy:RemovalPolicy.RETAIN,
      lifecycleRules:[{expiration:Duration.days(30),abortIncompleteMultipartUploadAfter:Duration.days(1)}],
    });
    const assets=new s3.Bucket(this,'WebAssets',{
      blockPublicAccess:s3.BlockPublicAccess.BLOCK_ALL,
      encryption:s3.BucketEncryption.S3_MANAGED,enforceSSL:true,
      versioned:true,removalPolicy:RemovalPolicy.RETAIN,
      serverAccessLogsBucket:logs,serverAccessLogsPrefix:'s3/',
      lifecycleRules:[{noncurrentVersionExpiration:Duration.days(30),abortIncompleteMultipartUploadAfter:Duration.days(1)}],
    });
    const headers=new cloudfront.ResponseHeadersPolicy(this,'SecurityHeaders',{
      securityHeadersBehavior:{
        contentTypeOptions:{override:true},
        frameOptions:{frameOption:cloudfront.HeadersFrameOption.DENY,override:true},
        referrerPolicy:{referrerPolicy:cloudfront.HeadersReferrerPolicy.NO_REFERRER,override:true},
        strictTransportSecurity:{accessControlMaxAge:Duration.days(365),includeSubdomains:true,override:true},
        contentSecurityPolicy:{
          contentSecurityPolicy:`default-src 'none'; script-src ${hashes.join(' ')}; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
          override:true,
        },
      },
    });
    const cdn=new cloudfront.Distribution(this,'Distribution',{
      comment:'OutcomeLens isolated synthetic preview. No customer data or API.',
      defaultRootObject:'index.html',
      enableLogging:true,logBucket:logs,logFilePrefix:'cloudfront/',
      minimumProtocolVersion:cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      httpVersion:cloudfront.HttpVersion.HTTP2_AND_3,
      priceClass:cloudfront.PriceClass.PRICE_CLASS_200,
      defaultBehavior:{
        origin:origins.S3BucketOrigin.withOriginAccessControl(assets),
        viewerProtocolPolicy:cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods:cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        compress:true,responseHeadersPolicy:headers,
        cachePolicy:cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
    });
    new deployment.BucketDeployment(this,'PublishPreview',{
      sources:[deployment.Source.data('index.html',html)],
      destinationBucket:assets,distribution:cdn,distributionPaths:['/*'],
      retainOnDelete:true,prune:false,
      logGroup:new logsService.LogGroup(this,'DeploymentLogs',{
        retention:logsService.RetentionDays.ONE_WEEK,
        removalPolicy:RemovalPolicy.RETAIN,
      }),
      cacheControl:[deployment.CacheControl.maxAge(Duration.minutes(5))],
    });
    new cloudwatch.Alarm(this,'OriginErrorAlarm',{
      metric:new cloudwatch.Metric({namespace:'AWS/CloudFront',metricName:'5xxErrorRate',
        dimensionsMap:{DistributionId:cdn.distributionId,Region:'Global'},
        region:'us-east-1',statistic:'Average',period:Duration.minutes(5)}),
      threshold:1,evaluationPeriods:2,treatMissingData:cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription:'Demo origin 5xx > 1%. Notification routing must be configured before production.',
    });
    new CfnOutput(this,'PreviewUrl',{value:`https://${cdn.distributionDomainName}`});
    new CfnOutput(this,'DataBoundary',{value:'Synthetic static preview only. Definitions remain in each browser.'});
  }
}
