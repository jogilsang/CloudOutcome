# CloudOutcome backend

FastAPI KPI engine with local and cloud boundaries. See SPEC.md and SECURITY.md.

```sh
uv venv --python 3.14.6 .venv
uv pip install --python .venv/bin/python -r requirements-tested.txt -r requirements-aws-test.txt
.venv/bin/python -m pytest -q
.venv/bin/python -m uvicorn main:app --host 127.0.0.1 --port 8000
```

Local live views: `tools/dev.sh --profile <aws-profile> [--region us-east-1] [--port 8000]` starts the backend and reads Lambda/API Gateway/DynamoDB usage and list prices with that profile (read-only calls, cached 5 minutes). Any developer passes their own profile; nothing is hard-coded. Without `--profile` only synthetic data is served. `aws login`/SSO profiles need `requirements-local-aws.txt` (installed by the script).

Default mode is single-user/loopback SQLite. Lambda entry requires `OUTCOMELENS_MODE=cloud`, expected API_ID, TABLE_NAME and ALLOWED_ORIGINS. API Gateway performs JWT validation; application requires access-token scope, assigned operator/viewer role and trusted integration context. Data partitions derive from authenticated subject; client tenant headers have no authority. DynamoDB persists bounded definitions with atomic version/audit writes and per-minute quotas. Cloud logs exclude input bodies/headers/subjects; common sensitive-data patterns are rejected without echoing them. Detection does not prove absence of all PII.

`export_fixtures.py` exports synthetic KPI fixtures for deliberate frontend contract updates. Cloud deployment does not call billing APIs and does not enable Bedrock. `aws_live.py` reads Lambda/API Gateway/DynamoDB CloudWatch usage through `OutcomeLensReadOnly-*` roles and prices it with AWS Price List API list prices (`/api/live`, `/api/connection`, anonymous `/api/public/live-demo` snapshot); results are estimates, not bills. Tests mock/stub AWS. `requirements-runtime.txt` is packaged on Linux by CodeBuild. `tests/test_lambda_entry.py` exercises the Mangum entry point on a thread without an event loop, matching the Python 3.14 Lambda runtime; Mangum 0.19.0 is part of `requirements-aws-test.txt`.

Origin outcomelens-backend/us-east-1 is live and feeds the deployment pipeline. Use your own developer session; AWS service roles authorize deployed code, never a developer profile.

## Local source policy and CodeCommit push

`core.hooksPath=.githooks` is configured in this workspace; isolated clones can enable it with `git config core.hooksPath .githooks`. The pre-commit hook scans working and staged content for selected sensitive patterns. Review history and data semantics too; pattern scanning is not exhaustive. Unpublished agent commits were given pseudonymous author metadata before any remote push.

The CodeCommit origin selects your AWS CLI profile through `git-remote-codecommit` (`codecommit://<profile>@<repo>`). `tools/push.sh` pushes main with `AWS_PROFILE`; profiles created by `aws login` so install the helper with the CRT extra (`uv tool install git-remote-codecommit --with 'botocore[crt]'`). No static Git credentials were created.
