"""Check tracked/staged source for common secrets and disallowed local state.
No matching value is printed. This is not an exhaustive PII detector.
"""
from pathlib import Path
import re
import os
import subprocess
import sys
ROOT=Path(__file__).resolve().parents[1]
PATTERNS=[r"(?:AKIA|ASIA)[A-Z0-9]{16}",r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----",r"\b01[016789][- .]\d{3,4}[- .]\d{4}\b"]

def main():
    if (ROOT/'.git').exists():
        names=subprocess.check_output(['git','ls-files','--cached','--others','--exclude-standard','-z'],cwd=ROOT).decode().split('\0')
    else:
        names=[]
        for directory,dirs,files in os.walk(ROOT):
            dirs[:]=[d for d in dirs if d not in {'.git','node_modules','.venv','cdk.out','release','lambda-package','dist','preview','__pycache__','.pytest_cache'}]
            names.extend(str((Path(directory)/name).relative_to(ROOT)) for name in files)
    failures=[]
    for name in filter(None,names):
        file=ROOT/name
        if file.name.startswith('.env') and file.name!='.env.example' or file.suffix in {'.sqlite','.db','.pem','.key'}:
            failures.append(name+': forbidden local-state file');continue
        if not file.is_file() or file.stat().st_size>2_000_000:continue
        try:text=file.read_text()
        except UnicodeError:continue
        # Only the explicitly synthetic, non-assigned phone placeholder is exempted.
        text=text.replace('010-0000-0000','synthetic-phone')
        if (ROOT/'.git').exists():
            staged=subprocess.run(['git','show',':'+name],cwd=ROOT,capture_output=True)
            if staged.returncode==0:
                text+='\n'+staged.stdout.decode('utf-8',errors='ignore').replace('010-0000-0000','synthetic-phone')
        if any(re.search(p,text) for p in PATTERNS):failures.append(name+': sensitive pattern')
        for email in re.findall(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}',text):
            if not email.endswith(('.example','.test','.invalid')) and email!='developer@users.noreply.local':
                failures.append(name+': unapproved email-like value')
    for failure in failures:print(failure)
    print('Source policy check:', 'FAILED' if failures else 'passed')
    return bool(failures)
if __name__=='__main__':sys.exit(main())
