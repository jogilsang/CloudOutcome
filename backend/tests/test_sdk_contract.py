import boto3
from botocore.stub import Stubber
from cloud_store import Store,encode
from domain import Definition

def sdk():
    # Synthetic credentials with a stubbed transport; no AWS call is sent.
    return boto3.client('dynamodb',region_name='us-east-1',aws_access_key_id='synthetic',aws_secret_access_key='synthetic')

def test_tenant_query_is_sent_as_key_query_not_scan():
    client=sdk()
    expected={'TableName':'test-table','KeyConditionExpression':'pk = :pk AND begins_with(sk, :prefix)',
        'ExpressionAttributeValues':encode({':pk':'WORKSPACE#tenant-a',':prefix':'DEF#'}),
        'ConsistentRead':True,'ScanIndexForward':True,'Limit':50}
    with Stubber(client) as stub:
        stub.add_response('query',{'Items':[encode({'pk':'WORKSPACE#tenant-a','sk':'DEF#checkout_cost_per_order','body':'{"version":1}'})]},expected)
        assert Store('tenant-a',client,'test-table').definitions()==[{'version':1}]
        stub.assert_no_pending_responses()

def test_quota_uses_atomic_conditional_increment():
    client=sdk()
    with Stubber(client) as stub:
        stub.add_response('update_item',{}, {'TableName':'test-table','Key':encode({'pk':'WORKSPACE#tenant-a','sk':'QUOTA#10'}),
            'UpdateExpression':'SET expires_at = :ttl ADD #count :one',
            'ConditionExpression':'attribute_not_exists(#count) OR #count < :limit',
            'ExpressionAttributeNames':{'#count':'count'},'ExpressionAttributeValues':encode({':ttl':720,':one':1,':limit':60})})
        Store('tenant-a',client,'test-table').consume(60,minute=10)
        stub.assert_no_pending_responses()
