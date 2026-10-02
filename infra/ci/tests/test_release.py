import base64
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import zipfile
import pytest
from unittest.mock import Mock
spec=importlib.util.spec_from_file_location('deploy',Path(__file__).parents[1]/'deploy.py')
deploy=importlib.util.module_from_spec(spec);spec.loader.exec_module(deploy)

@pytest.mark.parametrize('action,replacement',[('Remove','False'),('Modify','True'),('Modify','Conditional')])
def test_stateful_replacement_or_delete_is_blocked(action,replacement):
    with pytest.raises(ValueError):deploy.check_changes([{'ResourceChange':{'ResourceType':'AWS::DynamoDB::Table','Action':action,'Replacement':replacement}}])

def test_safe_update_and_add_are_allowed():
    deploy.check_changes([{'ResourceChange':{'ResourceType':'AWS::DynamoDB::Table','Action':'Modify','Replacement':'False'}},{'ResourceChange':{'ResourceType':'AWS::Cognito::UserPool','Action':'Add'}}])

def test_unrecognized_environment_is_blocked():
    with pytest.raises(ValueError):deploy.Release('production','bucket','role','boundary')

def test_config_changes_without_altering_frontend_code():
    source=io.BytesIO()
    with zipfile.ZipFile(source,'w') as z:z.writestr('index.html','<div id="root"></div>')
    result=deploy.zip_with_config(source.getvalue(),{'environment':'dev'})
    with zipfile.ZipFile(io.BytesIO(result)) as z:
        assert z.read('index.html')==b'<div id="root"></div>'
        assert json.loads(z.read('config.json'))['environment']=='dev'

def test_unsafe_archive_path_is_rejected():
    source=io.BytesIO()
    with zipfile.ZipFile(source,'w') as z:z.writestr('../unsafe','x')
    with pytest.raises(ValueError):deploy.zip_with_config(source.getvalue(),{})

def test_modified_artifact_stops_deployment(tmp_path):
    (tmp_path/'backend.zip').write_bytes(b'changed')
    (tmp_path/'manifest.json').write_text(json.dumps({'files':{'backend.zip':'bad'}}))
    with pytest.raises(ValueError):deploy.verify_manifest(tmp_path)

def test_successful_manifest_is_verified(tmp_path):
    files={}
    for name in deploy.RELEASE_FILES:
        file=tmp_path/name;file.parent.mkdir(parents=True,exist_ok=True);file.write_bytes(b'payload')
        files[name]=hashlib.sha256(b'payload').hexdigest()
    doc={'schema':1,'files':files,'revisions':{name:'a'*40 for name in ['frontend','backend','infra']},
        'backendCodeSha256':base64.b64encode(hashlib.sha256(b'payload').digest()).decode()}
    doc['releaseId']=hashlib.sha256(json.dumps(doc,sort_keys=True).encode()).hexdigest()
    (tmp_path/'manifest.json').write_text(json.dumps(doc))
    assert deploy.verify_manifest(tmp_path)['releaseId']==doc['releaseId']


def test_post_deploy_failure_restores_previous_release(tmp_path,monkeypatch):
    new={'releaseId':'new','files':{},'backendCodeSha256':'hash'}
    previous={'manifest':{'releaseId':'old'},'parameters':{}}
    (tmp_path/'spec').mkdir();(tmp_path/'spec/environments.json').write_text('{"dev":{}}');(tmp_path/'frontend.zip').write_bytes(b'new')
    monkeypatch.setattr(deploy,'verify_manifest',lambda root:new)
    runner=deploy.Release.__new__(deploy.Release)
    runner.environment='dev';runner.bucket='bucket';runner.boundary='boundary'
    runner.previous=Mock(return_value=previous);runner.apply=Mock(return_value={});runner.publish=Mock()
    runner.smoke=Mock(side_effect=[RuntimeError('failed'),None]);runner.s3=Mock()
    runner.s3.get_object.return_value={'Body':io.BytesIO(b'old')}
    with pytest.raises(RuntimeError):runner.run(tmp_path)
    assert runner.apply.call_args_list[1].args[0]['releaseId']=='old'
    assert runner.publish.call_args_list[1].args[0]==b'old'
    runner.s3.put_object.assert_not_called()

def test_release_zip_is_readable_by_lambda_runtime_and_deterministic(tmp_path):
    package_spec=importlib.util.spec_from_file_location('package_release',Path(__file__).parents[1]/'package_release.py')
    package=importlib.util.module_from_spec(package_spec);package_spec.loader.exec_module(package)
    source=tmp_path/'source';source.mkdir();(source/'handler.py').write_text('VALUE = 1')
    package.archive(source,tmp_path/'first.zip');package.archive(source,tmp_path/'second.zip')
    assert (tmp_path/'first.zip').read_bytes()==(tmp_path/'second.zip').read_bytes()
    with zipfile.ZipFile(tmp_path/'first.zip') as archive:
        assert archive.getinfo('handler.py').external_attr >> 16 & 0o444==0o444

OUTPUTS={'ApiUrl':'https://api.invalid','WebUrl':'https://web.invalid'}

class FakeResponse:
    def __init__(self,headers):self.headers=headers
    def __enter__(self):return self
    def __exit__(self,*args):return False

def preflight_runner():
    return deploy.Release.__new__(deploy.Release)

def test_cors_preflight_accepts_configured_origin(monkeypatch):
    seen=[]
    def urlopen(request,timeout):
        seen.append(request);return FakeResponse({'Access-Control-Allow-Origin':'https://web.invalid'})
    monkeypatch.setattr(deploy.urllib.request,'urlopen',urlopen)
    preflight_runner().preflight(OUTPUTS)
    assert seen[0].get_method()=='OPTIONS' and 'Authorization' not in seen[0].headers

def test_cors_preflight_rejected_by_authorizer_stops_deployment(monkeypatch):
    def urlopen(request,timeout):raise deploy.urllib.error.HTTPError(request.full_url,401,'Unauthorized',{},None)
    monkeypatch.setattr(deploy.urllib.request,'urlopen',urlopen)
    with pytest.raises(RuntimeError,match='preflight rejected'):preflight_runner().preflight(OUTPUTS)

def test_cors_preflight_wrong_origin_stops_deployment(monkeypatch):
    monkeypatch.setattr(deploy.urllib.request,'urlopen',lambda request,timeout:FakeResponse({'Access-Control-Allow-Origin':'*'}))
    with pytest.raises(RuntimeError,match='origin mismatch'):preflight_runner().preflight(OUTPUTS)

class Status(FakeResponse):
    def __init__(self,status):super().__init__({});self.status=status

def test_public_snapshot_ready_or_collecting_passes(monkeypatch):
    monkeypatch.setattr(deploy.urllib.request,'urlopen',lambda request,timeout:Status(200))
    preflight_runner().public_snapshot(OUTPUTS)

def test_public_snapshot_server_error_stops_deployment(monkeypatch):
    def urlopen(request,timeout):raise deploy.urllib.error.HTTPError(request,503,'unavailable',{},None)
    monkeypatch.setattr(deploy.urllib.request,'urlopen',urlopen)
    with pytest.raises(RuntimeError,match='Public snapshot'):preflight_runner().public_snapshot(OUTPUTS)

def test_live_demo_warm_up_is_async_and_never_blocks_the_release():
    runner=preflight_runner();runner.environment='prod';calls=[]
    runner.functions=type('F',(),{'invoke':lambda s,**k:calls.append(k)})()
    runner.warm_live_demo()
    assert calls[0]['FunctionName']=='outcomelens-prod-collector' and calls[0]['InvocationType']=='Event'
    runner.functions=type('F',(),{'invoke':lambda s,**k:(_ for _ in ()).throw(RuntimeError('denied'))})()
    runner.warm_live_demo()  # must not raise

def test_public_snapshot_behind_authorizer_stops_deployment(monkeypatch):
    def urlopen(request,timeout):raise deploy.urllib.error.HTTPError(request,401,'Unauthorized',{},None)
    monkeypatch.setattr(deploy.urllib.request,'urlopen',urlopen)
    with pytest.raises(RuntimeError,match='Public snapshot'):preflight_runner().public_snapshot(OUTPUTS)

def load_package():
    package_spec=importlib.util.spec_from_file_location('package_release_check',Path(__file__).parents[1]/'package_release.py')
    module=importlib.util.module_from_spec(package_spec);package_spec.loader.exec_module(module);return module

def test_package_allowlist_detects_unpackaged_local_import(tmp_path):
    (tmp_path/'entry.py').write_text('import os\nimport helper\nfrom fastapi import FastAPI\n')
    (tmp_path/'helper.py').write_text('from extra import x\n')
    (tmp_path/'extra.py').write_text('x=1\n')
    package=load_package()
    assert package.missing_local_imports(tmp_path,['entry.py'])==['helper']
    assert package.missing_local_imports(tmp_path,['entry.py','helper.py'])==['extra']
    assert package.missing_local_imports(tmp_path,['entry.py','helper.py','extra.py'])==[]

def test_current_backend_modules_are_all_packaged():
    backend=Path(__file__).parents[3]/'backend'
    if not (backend/'lambda_entry.py').exists():pytest.skip('backend checkout not adjacent')
    package=load_package()
    assert package.missing_local_imports(backend,package.LAMBDA_MODULES)==[]
