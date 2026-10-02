# CloudOutcome product contract v0.2

Status: deployed to dev, validation and prod in us-east-1 through the automatic pipeline (2026-10-01). Acceptance evidence is recorded in the hackathon folder `evidence/` and `NOTES.md`.

Product name: **CloudOutcome** (Cloud + Outcome: the business outcomes earned from cloud investment), renamed from OutcomeLens on 2026-10-01. AWS identifiers keep the `outcomelens-` / `OutcomeLensReadOnly-` prefixes and the `outcomelens/api` scope so deployed resources, repositories and connected roles stay valid.

## User decisions

Ecommerce first; banana-chip visual direction; Korean/English UI; visitors (hackathon judges) use the demo without signing in; read-only cross-account role connection; a live demo of the team's own account; cost shown as AWS Price List estimates because organization policies can block Cost Explorer; independent frontend/backend/infra CodeCommit repositories; Amplify hosting, API Gateway + Lambda, DynamoDB; automated deployment rather than delivery; same pipeline/template with dev, validation and prod parameters; traceable operations and privacy safeguards.

## Scope

KPI contracts: cost per unique completed order, success per terminal attempt, p95 of raw latency samples. Explicit service/window/currency/cost allocation; missing values stay missing. Sample KPI data is synthetic in all environments until a separately tested live connector exists. Cloud deployment enables authenticated persistence. Live AWS views are a separate estimate: CloudWatch usage of Lambda, API Gateway and DynamoDB multiplied by AWS Price List API on-demand list prices; Free Tier, credits, discounts, taxes and other services are excluded and the UI states it is not a bill. Billing APIs are not called. The initial cloud workspace is isolated per Cognito subject; team membership/shared organizations remain a future feature.

## Acceptance IDs

| ID | Required behavior | Evidence |
| --- | --- | --- |
| KPI-01 | Existing formulas, deduplication and null semantics remain correct | backend tests/test_kpis.py |
| AUTH-01 | API Gateway JWT issuer/audience + required scope; app rejects ID tokens, absent role or untrusted gateway context | platform.test.mjs; tests/test_cloud.py |
| DATA-01 | Subject-derived workspace partition; atomic definition/version/audit commit; bounded keys; no scans | cloud_store.py; tests/test_cloud.py |
| PRIV-01 | Unknown model fields rejected; common PII/secret patterns rejected; validation never echoes input | privacy.py; tests/test_cloud.py |
| OPS-01 | Minimal structured request logs, API access logs, latency/error/throttle alarms and Lambda X-Ray | platform.mjs; platform.test.mjs |
| DEPLOY-01 | One release from three exact source revisions advances automatically dev -> validation -> prod | pipeline.mjs; ci/package_release.py |
| DEPLOY-02 | Artifact hashes, stateful change gate, pretraffic test, postdeploy smoke, previous-release restoration | ci/deploy.py; ci/pretraffic.py; ci/tests |
| DEMO-01 | Unauthenticated visitors get the synthetic demo; edits stay in browser storage; sign-in is optional | frontend main.tsx; tests |
| LIVE-01 | Every enabled Region is scanned (failed Regions reported, not fatal); services in use come from CloudWatch metric namespaces; estimates use per-Region Price List first-tier on-demand prices, exclude Free Tier, report unpriced resources, keep sub-cent precision | backend aws_live.py; tests/test_aws_live.py |
| LIVE-02 | Connections assume only `OutcomeLensReadOnly-*` roles with a server-generated per-workspace External ID; operators only; SDK messages never echoed | main.py; tests/test_aws_live.py; platform.test.mjs; frontend tests/live.test.mjs |
| LIVE-03 | Public demo is a GET-only route serving a 10-minute masked snapshot; the UI refreshes every 10 minutes only while visible and offers a manual refresh; no AWS call per anonymous request | platform.mjs; ci/deploy.py smoke; tests |
| LIMIT-01 | Gateway throttles, function concurrency, bounded on-demand throughput and per-workspace minute counter | environments.json; platform.mjs; cloud tests |

## Non-goals and change process

No write access to connected accounts, credential or access-key collection, billing API calls, AI-generated automatic production changes, raw order/PII ingestion, public sign-up, persistent browser tokens, production SQLite, or live financial inference. Bedrock remains off in cloud deployment. Changes to data boundaries, scopes, KPI formulas, artifact compatibility or quotas must update this spec and linked tests before promotion. Pipeline source is ordinary main branches, protected operationally with CodeCommit review/IAM policy; remote enforcement has not been provisioned.

## Ownership

The infra repository owns this canonical product/deployment contract. Each repository owns its module SPEC.md/SECURITY.md and tests. Hackathon records link here, avoiding another design copy. Generic root CLAUDE/Kiro rules inform the workflow but are not required to build isolated clones.
