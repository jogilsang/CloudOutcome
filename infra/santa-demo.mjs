// santacloth demo workload: three storefront checkouts tagged outcome=<shop>, driven by synthetic traffic,
// so CloudOutcome reads real CloudWatch metrics for a fictional apparel company. Separate from the platform.
import {Stack,Duration,RemovalPolicy,Tags,CfnOutput} from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';

// Per-shop traffic profile per 5-minute run: requests, error rate and typical checkout latency.
export const SHOPS=[
 {id:'child-santa-cloth',requests:30,errorRate:0.01,baseMs:120},
 {id:'adult-santa-cloth',requests:60,errorRate:0.005,baseMs:80},
 {id:'senior-santa-cloth',requests:15,errorRate:0.03,baseMs:450},
];

const CHECKOUT=`import json, os, random, time, uuid, boto3
table = boto3.resource("dynamodb").Table(os.environ["TABLE"])
def handler(event, context):
    time.sleep(max(0.01, random.gauss(float(os.environ["BASE_MS"]), float(os.environ["BASE_MS"]) * 0.3)) / 1000)
    if random.random() < float(os.environ["ERROR_RATE"]):
        return {"statusCode": 500, "body": json.dumps({"error": "payment provider timeout (synthetic)"})}
    order = {"order_id": uuid.uuid4().hex, "amount_krw": random.choice([19000, 29000, 39000, 59000]), "expires_at": int(time.time()) + 86400}
    table.put_item(Item=order)
    return {"statusCode": 201, "body": json.dumps({"order_id": order["order_id"]})}
`;

const TRAFFIC=`import json, os, urllib.request
from concurrent.futures import ThreadPoolExecutor
def call(url):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data=b"{}", method="POST", headers={"Content-Type": "application/json"}), timeout=10) as r:
            return r.status
    except urllib.error.HTTPError as error:
        return error.code
    except Exception:
        return 0
def handler(event, context):
    jobs = [t["url"] for t in json.loads(os.environ["TARGETS"]) for _ in range(t["requests"])]
    with ThreadPoolExecutor(max_workers=5) as pool:
        codes = list(pool.map(call, jobs))
    return {"sent": len(codes), "ok": sum(1 for c in codes if 200 <= c < 300)}
`;

export class SantaDemoStack extends Stack {
 constructor(scope,id,props={}){
  super(scope,id,props);
  Tags.of(this).add('Project','CloudOutcomeDemo');Tags.of(this).add('company','santacloth');
  const traffic=[];
  for(const shop of SHOPS){
   const table=new dynamodb.Table(this,shop.id+'-orders',{tableName:`santa-${shop.id}-orders`,partitionKey:{name:'order_id',type:dynamodb.AttributeType.STRING},
    billingMode:dynamodb.BillingMode.PAY_PER_REQUEST,maxWriteRequestUnits:20,maxReadRequestUnits:20,timeToLiveAttribute:'expires_at',removalPolicy:RemovalPolicy.DESTROY});
   const fn=new lambda.Function(this,shop.id+'-checkout',{functionName:`santa-${shop.id}-checkout`,runtime:lambda.Runtime.PYTHON_3_13,handler:'index.handler',
    code:lambda.Code.fromInline(CHECKOUT),memorySize:128,timeout:Duration.seconds(5),reservedConcurrentExecutions:5,
    environment:{TABLE:table.tableName,ERROR_RATE:String(shop.errorRate),BASE_MS:String(shop.baseMs)},
    logGroup:new logs.LogGroup(this,shop.id+'-logs',{logGroupName:`/santa/${shop.id}/checkout`,retention:logs.RetentionDays.ONE_WEEK,removalPolicy:RemovalPolicy.DESTROY})});
   table.grantWriteData(fn);
   const api=new apigw.HttpApi(this,shop.id+'-api',{apiName:`santa-${shop.id}-api`,createDefaultStage:false});
   api.addRoutes({path:'/checkout',methods:[apigw.HttpMethod.POST],integration:new integrations.HttpLambdaIntegration(shop.id+'-integration',fn)});
   // Public demo endpoint: throttled so outside callers cannot run up cost.
   const stage=new apigw.HttpStage(this,shop.id+'-stage',{httpApi:api,stageName:'$default',autoDeploy:true,throttle:{rateLimit:20,burstLimit:40}});
   for(const resource of [table,fn,api])Tags.of(resource).add('outcome',shop.id);
   traffic.push({url:`${stage.url}checkout`,requests:shop.requests});
   new CfnOutput(this,shop.id.replace(/-/g,'')+'Url',{value:`${stage.url}checkout`});
  }
  const generator=new lambda.Function(this,'TrafficGenerator',{functionName:'santa-traffic-generator',runtime:lambda.Runtime.PYTHON_3_13,handler:'index.handler',
   code:lambda.Code.fromInline(TRAFFIC),memorySize:128,timeout:Duration.seconds(60),reservedConcurrentExecutions:1,
   environment:{TARGETS:this.toJsonString(traffic)},
   logGroup:new logs.LogGroup(this,'TrafficLogs',{logGroupName:'/santa/traffic-generator',retention:logs.RetentionDays.ONE_WEEK,removalPolicy:RemovalPolicy.DESTROY})});
  new events.Rule(this,'Traffic',{ruleName:'santa-traffic-every-5-minutes',schedule:events.Schedule.rate(Duration.minutes(5)),targets:[new targets.LambdaFunction(generator,{retryAttempts:0})]});
 }
}
