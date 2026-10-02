"""Package one source snapshot for promotion to all environments."""
import ast
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import zipfile

def archive(source, output):
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as target:
        for file in sorted(source.rglob('*')):
            if file.is_file():
                # Stable timestamps make payload hashes independent of the packaging clock.
                info=zipfile.ZipInfo(file.relative_to(source).as_posix(), (2026,1,1,0,0,0))
                info.compress_type=zipfile.ZIP_DEFLATED
                info.external_attr=(0o100755 if file.stat().st_mode & 0o111 else 0o100644) << 16
                target.writestr(info,file.read_bytes())

LAMBDA_MODULES=['lambda_entry.py','main.py','domain.py','bedrock_advisor.py','privacy.py','cloud_store.py','aws_live.py','fleet.py']

def missing_local_imports(backend,names):
    """Backend modules imported by packaged code but left out of the allowlist (fails before deploy, not at cold start)."""
    local={p.stem for p in backend.glob('*.py')};packaged={Path(n).stem for n in names};missing=set()
    for name in names:
        for node in ast.walk(ast.parse((backend/name).read_text())):
            modules=[a.name.split('.')[0] for a in node.names] if isinstance(node,ast.Import) else [node.module.split('.')[0]] if isinstance(node,ast.ImportFrom) and node.module and not node.level else []
            missing|={m for m in modules if m in local and m not in packaged}
    return sorted(missing)

def main():
    backend=Path(os.environ['CODEBUILD_SRC_DIR_backend'])
    frontend=Path(os.environ['CODEBUILD_SRC_DIR_frontend'])
    out=Path('release');out.mkdir(exist_ok=True)
    staging=Path('lambda-package');staging.mkdir(exist_ok=True)
    subprocess.run(['uv','pip','install','--python-platform','x86_64-manylinux_2_28','--python-version','3.14','--only-binary',':all:','--target',str(staging),'-r',str(backend/'requirements-runtime.txt'),'-c',str(backend/'requirements-tested.txt'),'-c',str(backend/'requirements-aws-test.txt')],check=True)
    missing=missing_local_imports(backend,LAMBDA_MODULES)
    if missing:raise SystemExit('Lambda package allowlist misses imported modules: '+', '.join(missing))
    for name in LAMBDA_MODULES:
        shutil.copyfile(backend/name,staging/name)
    archive(staging,out/'backend.zip');archive(frontend/'dist',out/'frontend.zip')
    shutil.copyfile('cdk.out/platform/OutcomeLensPlatform.template.json',out/'platform.json')
    shutil.copytree('ci',out/'ci',dirs_exist_ok=True)
    shutil.copytree('spec',out/'spec',dirs_exist_ok=True)
    manifest={'schema':1,'revisions':{k:os.environ[k.upper()+'_REVISION'] for k in ['frontend','backend','infra']},'files':{}}
    for name in ['backend.zip','frontend.zip','platform.json','ci/deploy.py','ci/pretraffic.py','ci/buildspec-deploy.yml','ci/requirements-deploy.txt','spec/environments.json']:
        manifest['files'][name]=hashlib.sha256((out/name).read_bytes()).hexdigest()
    manifest['backendCodeSha256']=base64.b64encode(hashlib.sha256((out/'backend.zip').read_bytes()).digest()).decode()
    manifest['releaseId']=hashlib.sha256(json.dumps(manifest,sort_keys=True).encode()).hexdigest()
    (out/'manifest.json').write_text(json.dumps(manifest,indent=2))
    print('Packaged release',manifest['releaseId'])

if __name__=='__main__':
    main()
