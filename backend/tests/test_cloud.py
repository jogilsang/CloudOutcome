import json
from types import SimpleNamespace
from unittest.mock import Mock
import pytest
from fastapi.testclient import TestClient
from fastapi import HTTPException
import main
import cloud_store
from domain import Definition

CLAIMS = {'sub':'synthetic-user-a','token_use':'access','scope':'outcomelens/api','cognito:groups':['operators']}
BODY = dict(name='Checkout cost',kind='cost_per_order',service='checkout',target=.25,shared_allocation_pct=40,owner='Platform Team',expected_version=0)

@pytest.fixture
def cloud(monkeypatch):
    monkeypatch.setattr(main,'CLOUD',True)
    monkeypatch.setenv('API_ID','test-api')
    monkeypatch.setenv('ALLOWED_ORIGINS','https://demo.example')
    stores={}
    class MemoryStore:
        def __init__(self,tenant): self.tenant=tenant;stores.setdefault(tenant,[])
        def consume(self,limit): pass
        def definitions(self): return stores[self.tenant]
        def audit(self): return []
        def save(self,key,body):
            doc={'id':key,'version':1,**body.model_dump()};stores[self.tenant].append(doc);return doc
    monkeypatch.setattr(main,'Store',MemoryStore)
    def client(claims=None,api_id='test-api'):
        async def wrapped(scope,receive,send):
            scope['aws.event']={'requestContext':{'apiId':api_id,'authorizer':{'jwt':{'claims':claims or {}}}}}
            await main.app(scope,receive,send)
        return TestClient(wrapped)
    return client

def test_cloud_definition_isolated_between_subjects(cloud):
    first=cloud(CLAIMS);other=cloud({**CLAIMS,'sub':'synthetic-user-b'})
    assert first.put('/api/definitions/checkout_cost_per_order',json=BODY).status_code==200
    assert len(first.get('/api/definitions').json())==1
    assert other.get('/api/definitions').json()==[]

def test_viewer_can_read_but_cannot_write(cloud):
    client=cloud({**CLAIMS,'cognito:groups':'[viewers]'})
    assert client.get('/api/dashboard').status_code==200
    assert client.put('/api/definitions/checkout_cost_per_order',json=BODY).status_code==403

@pytest.mark.parametrize('claims',[{}, {**CLAIMS,'token_use':'id'}, {**CLAIMS,'scope':'openid'}, {**CLAIMS,'cognito:groups':[]}, {**CLAIMS,'sub':''}])
def test_invalid_identity_is_denied(cloud,claims):
    assert cloud(claims).get('/api/definitions').status_code in {401,403}

def test_spoofed_headers_do_not_create_identity(cloud):
    assert cloud().get('/api/definitions',headers={'x-tenant-id':'synthetic-user-a','authorization':'Bearer fake'}).status_code==401

def test_wrong_gateway_cannot_invoke_application(cloud):
    assert cloud(CLAIMS,api_id='different-api').get('/api/health').status_code==403

@pytest.mark.parametrize('text',['mail to person@example.test','010-0000-0000', 'AKIA'+'A'*16])
def test_sensitive_input_rejected_without_echo(cloud,text):
    response=cloud(CLAIMS).post('/api/propose',json={'text':text})
    assert response.status_code==422
    assert text not in response.text

def test_validation_errors_do_not_echo_input(cloud):
    response=cloud(CLAIMS).put('/api/definitions/checkout_cost_per_order',json={**BODY,'target':'PRIVATE-CONTENT'})
    assert response.status_code==422 and 'PRIVATE-CONTENT' not in response.text

def test_quota_returns_429_without_storage_details(cloud,monkeypatch):
    def consume(self,limit): raise HTTPException(429,'Workspace request limit reached')
    monkeypatch.setattr(main.Store,'consume',consume)
    assert cloud(CLAIMS).get('/api/dashboard').status_code==429

def test_sdk_error_is_sanitized(cloud,monkeypatch):
    def consume(self,limit): raise RuntimeError('private-table-identifiers')
    monkeypatch.setattr(main.Store,'consume',consume)
    response=cloud(CLAIMS).get('/api/dashboard')
    assert response.status_code==503 and 'private-table' not in response.text

def test_transaction_atomically_records_definition_and_content_free_audit(monkeypatch):
    monkeypatch.setattr(cloud_store,'encode',lambda x:x)
    sdk=Mock();store=cloud_store.Store('tenant',sdk,'table')
    result=store.save('checkout_cost_per_order',Definition(**BODY))
    writes=sdk.transact_write_items.call_args.kwargs['TransactItems']
    assert result['version']==1 and len(writes)==2
    assert writes[0]['Put']['ConditionExpression']=='attribute_not_exists(pk)'
    assert 'Platform Team' not in writes[1]['Put']['Item']['body']

def test_stale_version_returns_conflict(monkeypatch):
    monkeypatch.setattr(cloud_store,'encode',lambda x:x)
    class Cancelled(Exception):
        response={'CancellationReasons':[{'Code':'ConditionalCheckFailed'}]}
    sdk=Mock();sdk.exceptions=SimpleNamespace(TransactionCanceledException=Cancelled)
    sdk.transact_write_items.side_effect=Cancelled()
    with pytest.raises(HTTPException) as error:
        cloud_store.Store('tenant',sdk,'table').save('checkout_cost_per_order',Definition(**BODY))
    assert error.value.status_code==409

def test_definition_identifier_must_match_bounded_schema():
    with pytest.raises(HTTPException) as error:
        cloud_store.Store('tenant',Mock(),'table').save('arbitrary_id',Definition(**BODY))
    assert error.value.status_code==422
