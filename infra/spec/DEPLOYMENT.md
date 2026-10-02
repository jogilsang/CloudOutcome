# Automatic deployment contract

The new platform supersedes the earlier standalone S3/CloudFront demo as the target architecture. The legacy static preview stack remains available solely for isolated samples.

## Infrastructure and environment identity

One parameterized platform template, separate stacks `outcomelens-dev`, `outcomelens-validation`, `outcomelens-prod`. Each has its own Amplify app, Cognito pool/client, API, Lambda version/alias, DynamoDB table, log groups and alarms. Same-account isolation is the implemented baseline. Dedicated production AWS accounts are recommended before real customer data; dynamic-ID control-plane IAM resources currently require some service-level wildcards. Runtime permissions are environment-resource scoped and bounded. The CloudFormation role cannot modify its own role or pipeline roles; it can create/manage runtime-prefixed roles only under the required permissions boundary.

`environments.json` is the reviewed quota input; no command-line arbitrary environment name. Higher limits require a spec change. Three environments have independent billed resources; these are not assumed free. Cognito, logging, alarms, dashboards, CodePipeline, CodeBuild, requests and storage incur usage/standing charges according to their pricing. Free Tier not assumed.

## Release path

Hackathon operation (2026-10-01): the inbound transition to Deployvalidation is disabled, so pushes deploy dev only; re-enable it (`aws codepipeline enable-stage-transition --stage-name Deployvalidation --transition-type Inbound`) for the final validation/prod promotion. Pipeline bootstrap must be redeployed first because the CloudFormation role gained DeploymentConfig actions.

CodeCommit main change in any module -> three source snapshots -> CodeBuild package/check -> dev deploy/smoke -> validation deploy/smoke -> prod deploy/smoke. No manual approval action. Pipeline is QUEUED to prevent overlapping promotions. Initial pipeline/IAM creation is a bootstrap operation, not self-mutation from an application commit.

Builds enforce the frontend/backend synthetic contract and cross-platform wheel packaging (x86_64 manylinux_2_28 for Python 3.14), then produce Lambda zip, frontend dist zip, platform template, immutable hash manifest, parameter files and deployment runner. Compiled artifacts are reused; only public `config.json` differs by environment. Runtime dependencies require an actual Linux build; local validation does not imply deployment success.

Before traffic shift: CodeDeploy hook invokes the new version and checks service/storage behavior. Prod shifts 10% and observes for one minute (custom CodeDeploy config) with error alarms; dev/validation use all-at-once after the hook. First creation has no prior version to canary. After deployment: real API rejects missing/invalid JWTs; public frontend serves expected config, security header and app shell; direct IAM Lambda invocation checks the storage path. This is not a real-user OAuth/MFA browser test. Live Cognito login, expired/wrong-audience JWT tests and real write/read workflows remain required external acceptance.

Postdeployment failure: restore previous manifest/template/parameters and frontend artifact, re-run smoke, stop pipeline. Stateful removal/replacement is rejected, including conditional replacement. Rollback does not reverse already committed user data; schema changes must remain backward compatible. On a first release there is no previous application: failure stops promotion and may leave partial resources for investigation; stateful resources are retained. Existing rollback-failed stacks require operator remediation.

## Bootstrap/run order (executed 2026-10-01 with a developer profile)

1. Use an existing developer session (AWS CLI profile or AWS MCP); verify account and Region without recording identifiers.
2. Read existing repo names and deploy `OutcomeLensRepositories.template.json` (retained repos). Existing manual verification projects are optional and coexist with the deployment pipeline.
3. Push reviewed source histories to each configured CodeCommit origin using profile-based authentication. Current session cannot resolve the Git endpoint or execute AWS API scripts.
4. Deploy `OutcomeLensDeployment.template.json` with CAPABILITY_NAMED_IAM; its role/bucket/event triggers are infrastructure, not automatically self-mutated by source pushes.
5. Start the pipeline once, or push the next reviewed change. Capture stage IDs/results, URLs, rollback evidence and real-user acceptance before marking LIVE.
5a. Live demo: deploy the frontend's `public/outcomelens-readonly-role.json` as stack `OutcomeLensReadOnly-demo` with `RoleSuffix=demo`, `ExternalId=outcomelens-live-demo` and the three `outcomelens-<env>-runtime-api` role ARNs as trusted principals. The 10-minute EventBridge task scans every enabled Region and stores the masked snapshot; the public route returns 503 until the first collection.
5b. A failed first creation leaves `ROLLBACK_COMPLETE` plus retained, named stateful resources that block re-creation. Operator remediation: confirm the table has no items, the pool has no users and log groups are empty, then disable deletion protection, delete them and delete the stack before the next run.
6. Provision pseudonymous invited users in each environment and assign operators or viewers. No email/SMS delivery or personal contact data is required by the app. MFA enrollment occurs in Cognito login. Anonymous access is rejected.

## Observability and retention

App logs: request ID, gateway request ID, route template, status, method, elapsed milliseconds and release hash. No body, query string, token, raw subject, IP, email or owner. API access logs omit IP/user-agent and full URL. CloudWatch stores 30 days; audit items expire after 30 days (TTL is asynchronous). Operational logs are distinct from customer telemetry. Lambda active X-Ray covers service execution; HTTP API does not provide the same native X-Ray capability as REST API. Full ADOT/Application Signals instrumentation and downstream spans are not claimed. Amplify access-log exports can contain IP/URL data and are deliberately not collected without a redaction/retention decision. Pipeline logs track deployment issues. Application logs also include a safe exception class (not its message) for diagnosis. CloudTrail account management-event history remains an account capability; no new account-wide trail was created.

Alarms/dashboard exist; external notification subscription and AWS Budget recipient remain unset to avoid inventing a contact address. Before a real release, attach the team's approved destination. Budget alerts/throttles are not a guaranteed spend cap; reserved concurrency, per-workspace counters and DynamoDB maximum throughput constrain traffic but do not cap all billable requests, storage or services. Emergency actions: disable pipeline transitions, set API rate conservatively, or set API Lambda reserved concurrency to zero; preserve data.
