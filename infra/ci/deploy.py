"""Automatic deployment with hash checks, stateful-change gates and rollback.

Runs in the pipeline's environment-specific role. Never prints SDK responses,
HTTP bodies, signed upload URLs, user credentials or request payloads.
"""
import base64
import hashlib
import io
import json
import os
import re
from pathlib import Path
import time
import urllib.error
import urllib.request
import uuid
import zipfile
import boto3
from botocore.config import Config

STATEFUL={'AWS::DynamoDB::Table','AWS::Cognito::UserPool'}
RELEASE_FILES={'backend.zip','frontend.zip','platform.json','ci/deploy.py','ci/pretraffic.py','ci/buildspec-deploy.yml','ci/requirements-deploy.txt','spec/environments.json'}

def check_changes(changes):
    for change in changes:
        item=change.get('ResourceChange',{})
        if item.get('ResourceType') in STATEFUL and (item.get('Action')=='Remove' or item.get('Replacement') in {'True','Conditional'}):
            raise ValueError('Release would delete or replace protected stateful resources')

def verify_manifest(root):
    manifest=json.loads((root/'manifest.json').read_text())
    if manifest.get('schema')!=1 or set(manifest.get('files',{}))!=RELEASE_FILES:
        raise ValueError('Incomplete release manifest')
    if set(manifest.get('revisions',{}))!={'frontend','backend','infra'} or any(not re.fullmatch('[a-f0-9]{40}',v) for v in manifest['revisions'].values()):
        raise ValueError('Source revisions must be exact commit IDs')
    expected_code=base64.b64encode(hashlib.sha256((root/'backend.zip').read_bytes()).digest()).decode()
    if manifest.get('backendCodeSha256')!=expected_code:
        raise ValueError('Lambda code hash mismatch')
    for name,digest in manifest['files'].items():
        if name not in {'backend.zip','frontend.zip','platform.json','ci/deploy.py','ci/pretraffic.py','ci/buildspec-deploy.yml','ci/requirements-deploy.txt','spec/environments.json'} or hashlib.sha256((root/name).read_bytes()).hexdigest()!=digest:
            raise ValueError('Artifact integrity check failed')
    expected=manifest['releaseId'];payload={k:v for k,v in manifest.items() if k!='releaseId'}
    if hashlib.sha256(json.dumps(payload,sort_keys=True).encode()).hexdigest()!=expected:
        raise ValueError('Release identity check failed')
    return manifest

def zip_with_config(frontend,config):
    output=io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(frontend)) as source,zipfile.ZipFile(output,'w',zipfile.ZIP_DEFLATED) as result:
        for file in source.infolist():
            if file.filename.startswith('/') or '..' in file.filename.split('/'):
                raise ValueError('Unsafe frontend artifact path')
            if file.filename!='config.json':result.writestr(file,source.read(file))
        result.writestr('config.json',json.dumps(config))
    return output.getvalue()

class Release:
    def __init__(self,environment,bucket,role,boundary,session=None):
        if environment not in {'dev','validation','prod'}:raise ValueError('Unknown environment')
        self.environment=environment;self.bucket=bucket;self.role=role;self.boundary=boundary
        self.stack='outcomelens-'+environment
        session=session or boto3.Session()
        config=Config(connect_timeout=5,read_timeout=20,retries={'mode':'standard','total_max_attempts':3})
        self.cfn=session.client('cloudformation',config=config);self.s3=session.client('s3',config=config)
        self.amplify=session.client('amplify',config=config);self.functions=session.client('lambda',config=config)

    def previous(self):
        try:
            return json.loads(self.s3.get_object(Bucket=self.bucket,Key=f'environments/{self.environment}/current.json')['Body'].read())
        except self.s3.exceptions.NoSuchKey:
            return None

    def apply(self,manifest,parameters):
        name='outcomelens-'+uuid.uuid4().hex
        try:
            existing=self.cfn.describe_stacks(StackName=self.stack)['Stacks'][0]['StackStatus']
            kind='CREATE' if existing=='REVIEW_IN_PROGRESS' else 'UPDATE'
        except self.cfn.exceptions.ClientError as error:
            if error.response['Error']['Code']=='ValidationError' and 'does not exist' in error.response['Error'].get('Message',''):
                kind='CREATE'
            else:raise
        self.cfn.create_change_set(StackName=self.stack,ChangeSetName=name,ChangeSetType=kind,
            TemplateURL=f'https://{self.bucket}.s3.amazonaws.com/releases/{manifest["releaseId"]}/platform.json',
            Parameters=[{'ParameterKey':k,'ParameterValue':v} for k,v in parameters.items()],
            Capabilities=['CAPABILITY_NAMED_IAM'],RoleARN=self.role,
            Tags=[{'Key':'Project','Value':'OutcomeLens'},{'Key':'Environment','Value':self.environment}])
        deadline=time.monotonic()+180
        while time.monotonic()<deadline:
            change=self.cfn.describe_change_set(StackName=self.stack,ChangeSetName=name)
            if change['Status']=='CREATE_COMPLETE':break
            if change['Status']=='FAILED':
                reason=change.get('StatusReason','')
                if kind=='UPDATE' and ('didn\'t contain changes' in reason or 'No updates' in reason):return self.outputs()
                raise RuntimeError('Change set creation failed; inspect CloudFormation events')
            time.sleep(3)
        else:raise TimeoutError('Change set timeout')
        # DescribeChangeSet paginates large changes; do not inspect just its first page.
        paginator=self.cfn.get_paginator('describe_change_set')
        for page in paginator.paginate(StackName=self.stack,ChangeSetName=name):check_changes(page.get('Changes',[]))
        self.cfn.execute_change_set(StackName=self.stack,ChangeSetName=name)
        deadline=time.monotonic()+1800
        while time.monotonic()<deadline:
            status=self.cfn.describe_stacks(StackName=self.stack)['Stacks'][0]['StackStatus']
            if status in {'CREATE_COMPLETE','UPDATE_COMPLETE'}:
                self.cfn.update_termination_protection(StackName=self.stack,EnableTerminationProtection=True)
                return self.outputs()
            if status.endswith('_FAILED') or 'ROLLBACK_COMPLETE' in status:
                raise RuntimeError('Stack deployment failed or rolled back; inspect stack events')
            time.sleep(10)
        raise TimeoutError('Stack deployment timeout')

    def outputs(self):
        return {x['OutputKey']:x['OutputValue'] for x in self.cfn.describe_stacks(StackName=self.stack)['Stacks'][0]['Outputs']}

    def publish(self,frontend,outputs,release_id):
        config={"apiUrl":outputs['ApiUrl'],"clientId":outputs['ClientId'],"domain":outputs['LoginDomain'],"environment":self.environment,"release":release_id}
        artifact=zip_with_config(frontend,config)
        deployment=self.amplify.create_deployment(appId=outputs['AmplifyAppId'],branchName='live')
        request=urllib.request.Request(deployment['zipUploadUrl'],data=artifact,method='PUT',headers={'Content-Type':'application/zip'})
        with urllib.request.urlopen(request,timeout=60) as response:
            if response.status not in {200,201}:raise RuntimeError('Frontend upload failed')
        self.amplify.start_deployment(appId=outputs['AmplifyAppId'],branchName='live',jobId=deployment['jobId'])
        deadline=time.monotonic()+600
        while time.monotonic()<deadline:
            status=self.amplify.get_job(appId=outputs['AmplifyAppId'],branchName='live',jobId=deployment['jobId'])['job']['summary']['status']
            if status=='SUCCEED':return
            if status in {'FAILED','CANCELLED'}:raise RuntimeError('Frontend deployment failed')
            time.sleep(5)
        raise TimeoutError('Frontend deployment timeout')

    def preflight(self,outputs):
        # Browsers send CORS preflight without a token; it must be answered by API Gateway CORS, not the JWT authorizer.
        request=urllib.request.Request(outputs['ApiUrl']+'/api/definitions',method='OPTIONS',headers={'Origin':outputs['WebUrl'],
            'Access-Control-Request-Method':'PUT','Access-Control-Request-Headers':'authorization,content-type'})
        try:
            with urllib.request.urlopen(request,timeout=20) as response:allowed=response.headers.get('Access-Control-Allow-Origin')
        except urllib.error.HTTPError:
            raise RuntimeError('CORS preflight rejected') from None
        if allowed!=outputs['WebUrl']:raise RuntimeError('CORS preflight origin mismatch')

    def public_snapshot(self,outputs):
        # Anonymous route must reach the app (snapshot or 'not collected yet'), never the JWT authorizer.
        try:
            with urllib.request.urlopen(outputs['ApiUrl']+'/api/public/live-demo?days=7',timeout=20) as response:status=response.status
        except urllib.error.HTTPError as error:
            status=error.code
        if status!=200:raise RuntimeError('Public snapshot route smoke failed')

    def smoke(self,outputs,manifest):
        self.preflight(outputs)
        self.public_snapshot(outputs)
        # Real public endpoint must reject a missing/forged token.
        for headers in [{},{'Authorization':'Bearer invalid'}]:
            try:urllib.request.urlopen(urllib.request.Request(outputs['ApiUrl']+'/api/definitions',headers=headers),timeout=20)
            except urllib.error.HTTPError as error:
                if error.code not in {401,403}:raise RuntimeError('API authentication smoke failed') from None
            else:raise RuntimeError('API accepted unauthenticated traffic')
        with urllib.request.urlopen(outputs['WebUrl']+'/config.json',timeout=20) as response:
            actual=json.load(response)
        if actual.get('release')!=manifest['releaseId'] or actual.get('environment')!=self.environment:
            raise RuntimeError('Frontend release mismatch')
        with urllib.request.urlopen(outputs['WebUrl']+'/',timeout=20) as response:
            page=response.read().decode()
            if response.status!=200 or 'id="root"' not in page or not response.headers.get('Content-Security-Policy'):
                raise RuntimeError('Frontend security or page smoke failed')
        # Direct IAM-authorized Lambda invocation validates integration/storage independently
        # from Cognito login. This does not claim a real-user JWT or browser-login test.
        claims={'sub':'pipeline-smoke','token_use':'access','scope':'outcomelens/api','cognito:groups':'[operators]'}
        event={'version':'2.0','routeKey':'GET /api/{proxy+}','rawPath':'/api/definitions','rawQueryString':'',
            'headers':{'host':'smoke.invalid'},'requestContext':{'apiId':outputs['ApiId'],'requestId':uuid.uuid4().hex,
            'http':{'method':'GET','path':'/api/definitions','sourceIp':'127.0.0.1','protocol':'HTTP/1.1'},
            'authorizer':{'jwt':{'claims':claims}}},'isBase64Encoded':False}
        result=self.functions.invoke(FunctionName=outputs['FunctionName'],Qualifier='live',Payload=json.dumps(event).encode())
        payload=json.loads(result['Payload'].read())
        if result.get('FunctionError') or payload.get('statusCode')!=200:
            raise RuntimeError('Lambda/storage smoke failed')

    def warm_live_demo(self):
        # Collect the public snapshot right away instead of waiting for the 10-minute schedule.
        # Asynchronous and non-blocking: a failure only delays the demo data, never the release.
        try:self.functions.invoke(FunctionName=f'outcomelens-{self.environment}-collector',InvocationType='Event',Payload=b'{"outcomelens_task":"refresh-live-demo"}')
        except Exception as error:print('Live demo warm-up skipped:',type(error).__name__)

    def run(self,root):
        manifest=verify_manifest(root);release_id=manifest['releaseId']
        previous=self.previous()
        for name in manifest['files']:
            # Content-addressed immutable writes: existing keys must contain exactly these bytes.
            key=f'releases/{release_id}/{name}';data=(root/name).read_bytes()
            try:self.s3.put_object(Bucket=self.bucket,Key=key,Body=data,ServerSideEncryption='AES256',IfNoneMatch='*')
            except self.s3.exceptions.ClientError as error:
                if error.response['Error']['Code'] not in {'PreconditionFailed','ConditionalRequestConflict'}:raise
                existing=self.s3.get_object(Bucket=self.bucket,Key=key)['Body'].read()
                if hashlib.sha256(existing).hexdigest()!=manifest['files'][name]:raise RuntimeError('Existing release artifact differs')
        settings=json.loads((root/'spec/environments.json').read_text())[self.environment]
        parameters={**settings,'Environment':self.environment,'ArtifactBucket':self.bucket,'BackendKey':f'releases/{release_id}/backend.zip','BackendSha256':manifest['backendCodeSha256'],'ReleaseId':release_id,'RuntimeBoundary':self.boundary}
        try:
            outputs=self.apply(manifest,parameters)
            self.publish((root/'frontend.zip').read_bytes(),outputs,release_id)
            self.smoke(outputs,manifest)
        except Exception:
            if previous:
                old=previous['manifest'];outputs=self.apply(old,previous['parameters'])
                frontend=self.s3.get_object(Bucket=self.bucket,Key=f'releases/{old["releaseId"]}/frontend.zip')['Body'].read()
                self.publish(frontend,outputs,old['releaseId']);self.smoke(outputs,old)
            raise
        self.s3.put_object(Bucket=self.bucket,Key=f'environments/{self.environment}/current.json',Body=json.dumps({'manifest':manifest,'parameters':parameters}).encode(),ServerSideEncryption='AES256')
        self.warm_live_demo()
        print('Deployment verified',self.environment,release_id)

def main():
    try:
        Release(os.environ['DEPLOY_ENV'],os.environ['ARTIFACT_BUCKET'],os.environ['CFN_ROLE'],os.environ['RUNTIME_BOUNDARY']).run(Path('.'))
    except Exception as error:
        print('Deployment stopped:',type(error).__name__,'Inspect sanitized service logs and CloudFormation events.')
        raise SystemExit(1) from None

if __name__=='__main__':
    main()
