"""CodeDeploy pre-traffic check. AWS-managed Python includes boto3.

No event/token/payload/error text is logged. Fake authorizer claims are confined
inside an IAM-authorized direct Lambda invocation; they are not accepted over HTTP.
"""
import json
import os
import uuid
import boto3

def handler(event, context):
    functions=boto3.client('lambda')
    deploy=boto3.client('codedeploy')
    status='Failed'
    try:
        for path in ['/api/health','/api/definitions']:
            payload={'version':'2.0','routeKey':'ANY /api/{proxy+}','rawPath':path,'rawQueryString':'',
                'headers':{'host':'smoke.invalid'},'requestContext':{'apiId':os.environ['API_ID'],
                'requestId':uuid.uuid4().hex,'http':{'method':'GET','path':path,'sourceIp':'127.0.0.1','protocol':'HTTP/1.1'},
                'authorizer':{'jwt':{'claims':{'sub':'pipeline-pretraffic','token_use':'access','scope':'outcomelens/api','cognito:groups':'[operators]'}}}},'isBase64Encoded':False}
            response=functions.invoke(FunctionName=os.environ['TARGET_FUNCTION'],Qualifier=os.environ['TARGET_VERSION'],Payload=json.dumps(payload).encode())
            result=json.loads(response['Payload'].read())
            if response.get('FunctionError') or result.get('statusCode')!=200:raise RuntimeError('Pretraffic check failed')
        status='Succeeded'
    except Exception:
        status='Failed'
    deploy.put_lifecycle_event_hook_execution_status(deploymentId=event['DeploymentId'],lifecycleEventHookExecutionId=event['LifecycleEventHookExecutionId'],status=status)
    return {'status':status}
