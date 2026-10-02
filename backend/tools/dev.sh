#!/bin/sh
# Local backend for development. Live AWS views read the profile you pass; nothing is hard-coded.
#   tools/dev.sh                          synthetic data only
#   tools/dev.sh --profile my-profile     live views from that AWS profile (read-only calls)
#   tools/dev.sh --profile p --region us-west-2 --port 8001
set -eu
cd "$(dirname "$0")/.."
profile='' region=us-east-1 port=8000
while [ $# -gt 0 ]; do
  case "$1" in
    --profile) profile=${2:?--profile needs a value}; shift 2;;
    --region) region=${2:?--region needs a value}; shift 2;;
    --port) port=${2:?--port needs a value}; shift 2;;
    -h|--help) sed -n '2,5p' "$0"; exit 0;;
    *) echo "unknown argument: $1" >&2; exit 2;;
  esac
done
[ -x .venv/bin/python ] || { uv venv --python 3.14 .venv && uv pip install --python .venv/bin/python -r requirements-tested.txt -r requirements-aws-test.txt; }
if [ -n "$profile" ]; then
  # aws login / SSO profiles need the CRT credential provider.
  uv pip install -q --python .venv/bin/python -r requirements-local-aws.txt
  .venv/bin/python -c 'import sys,boto3;boto3.Session(profile_name=sys.argv[1]).client("sts").get_caller_identity()' "$profile" 2>/dev/null \
    || { echo "profile '$profile' has no valid session; sign in first (for example: aws login --profile $profile)" >&2; exit 1; }
  export OUTCOMELENS_AWS_PROFILE="$profile" OUTCOMELENS_AWS_REGION="$region"
  echo "Live views use AWS profile '$profile' in $region (read-only)."
fi
exec .venv/bin/python -m uvicorn main:app --host 127.0.0.1 --port "$port"
