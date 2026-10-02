"""Fail promotion if checked-in sample fixtures diverge from backend semantics."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

def main():
    backend=Path(os.environ['CODEBUILD_SRC_DIR_backend'])
    frontend=Path(os.environ['CODEBUILD_SRC_DIR_frontend'])
    with tempfile.TemporaryDirectory() as temp:
        generated=Path(temp)/'dashboard.json'
        subprocess.run([sys.executable,str(backend/'export_fixtures.py'),str(generated)],check=True)
        if json.loads(generated.read_text())!=json.loads((frontend/'fixtures/dashboard-v1.json').read_text()):
            raise SystemExit('Synthetic API contract changed; update and review frontend fixtures before deployment.')
    print('Cross-repository synthetic contract passed')
if __name__=='__main__':main()
