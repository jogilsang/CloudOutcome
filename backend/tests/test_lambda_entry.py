"""Exercise the real Mangum Lambda entry point the way the Lambda runtime does: import and
invoke on a thread that has no asyncio event loop (Python 3.14 no longer creates one implicitly)."""
import importlib
import json
import sys
import threading
from types import SimpleNamespace
import pytest
import main

CLAIMS = {'sub':'synthetic-user-a','token_use':'access','scope':'outcomelens/api','cognito:groups':'[operators]'}

def event(claims, path='/api/definitions'):
    # main is imported once per test session in local mode, whose TrustedHost guard allows 'testserver'.
    return {'version':'2.0','routeKey':'ANY /api/{proxy+}','rawPath':path,'rawQueryString':'','headers':{'host':'testserver'},
        'requestContext':{'apiId':'test-api','requestId':'req-1','http':{'method':'GET','path':path,'sourceIp':'127.0.0.1','protocol':'HTTP/1.1'},
            'authorizer':{'jwt':{'claims':claims}}},'isBase64Encoded':False}

@pytest.fixture
def lambda_env(monkeypatch):
    monkeypatch.setenv('OUTCOMELENS_MODE','cloud')
    monkeypatch.setenv('API_ID','test-api')
    monkeypatch.setenv('ALLOWED_ORIGINS','https://demo.example')
    monkeypatch.setenv('TABLE_NAME','test-table')  # store construction only; no AWS call is made
    monkeypatch.setenv('AWS_DEFAULT_REGION','us-east-1')
    monkeypatch.setattr(main,'CLOUD',True)
    class MemoryStore:
        def __init__(self,tenant): pass
        def consume(self,limit): pass
        def definitions(self): return []
        def audit(self): return []
    monkeypatch.setattr(main,'Store',MemoryStore)
    sys.modules.pop('lambda_entry',None)
    yield
    sys.modules.pop('lambda_entry',None)

def cold_start_invoke(*events):
    """Import the entry module and invoke it on a fresh loop-less thread, like a Lambda cold start."""
    results=[]
    def run():
        try:
            handler=importlib.import_module('lambda_entry').handler
            results.extend(handler(e,SimpleNamespace(aws_request_id='ctx')) for e in events)
        except Exception as error:
            results.append(error)
    thread=threading.Thread(target=run);thread.start();thread.join()
    return results

def test_lambda_handler_serves_request_without_preexisting_event_loop(lambda_env):
    [response]=cold_start_invoke(event(CLAIMS))
    assert not isinstance(response,Exception),repr(response)
    assert response['statusCode']==200
    assert json.loads(response['body'])==[]

def test_lambda_handler_serves_consecutive_warm_invocations(lambda_env):
    responses=cold_start_invoke(event(CLAIMS),event(CLAIMS))
    assert [r['statusCode'] for r in responses]==[200,200]

def test_lambda_handler_denies_missing_identity(lambda_env):
    [response]=cold_start_invoke(event({}))
    assert response['statusCode'] in {401,403}

def test_lambda_entry_refuses_non_cloud_mode(lambda_env,monkeypatch):
    monkeypatch.setenv('OUTCOMELENS_MODE','local')
    [error]=cold_start_invoke()
    assert isinstance(error,RuntimeError)

def test_scheduled_refresh_task_bypasses_http_adapter(lambda_env,monkeypatch):
    import aws_live
    monkeypatch.setattr(aws_live,'refresh_public_demo',lambda store,environ:{'status':'skipped','reason':'test'})
    [result]=cold_start_invoke({'outcomelens_task':'refresh-live-demo'})
    assert result=={'status':'skipped','reason':'test'}

def test_unknown_task_is_rejected(lambda_env):
    [error]=cold_start_invoke({'outcomelens_task':'delete-everything'})
    assert isinstance(error,ValueError)

def test_failed_task_hides_error_details(lambda_env,monkeypatch):
    import aws_live
    def boom(store,environ):raise KeyError('arn:aws:iam::999999999999:role/secret')
    monkeypatch.setattr(aws_live,'refresh_public_demo',boom)
    [error]=cold_start_invoke({'outcomelens_task':'refresh-live-demo'})
    assert isinstance(error,RuntimeError) and '999999999999' not in str(error)
