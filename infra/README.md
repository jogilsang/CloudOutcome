# CloudOutcome infrastructure v0.2

Read spec/PRODUCT.md, spec/DEPLOYMENT.md and spec/SECURITY.md before changes. Independent CDK repository, with authored automatic deployment rather than an approval-based delivery pipeline.

```sh
npm ci
npm test
npm run synth:repositories
npm run synth:platform
npm run synth:pipeline
python3 tools/check_policy.py
# In a Python environment with pytest and requirements-ci.txt:
python -m pytest -q ci/tests
```

- repositories.mjs: retained CodeCommit repositories and optional standalone verification builds.
- platform.mjs: one CloudFormation parameterized Amplify/Cognito/HTTP API/Lambda/DynamoDB template, scoped runtime roles, limits/logs/alarms and CodeDeploy pretraffic/canary.
- pipeline.mjs: CodeCommit events -> build/check/package -> dev -> validation -> prod, sequential automatic deployment of the same release.
- ci/: immutable artifact hashes, stateful replacement rejection, deployment/smoke and previous-release restoration.
- spec/environments.json: reviewed per-environment parameters.

Parameter-only platform/pipeline templates have no CDK asset publication dependency. Lambda release zip is uploaded to the pipeline artifact bucket at runtime. The platform requires the runtime permissions boundary created by the pipeline bootstrap. Deploy the repository template, push the three sources, deploy the pipeline template with CAPABILITY_NAMED_IAM, then start execution. Exact limitations and bootstrap steps are in spec/DEPLOYMENT.md.

Legacy `stack.mjs` remains a static synthetic S3/CloudFront demo. To synthesize it, provide OUTCOMELENS_PREVIEW=/absolute/path/to/OutcomeLens.html. It is not the current full-platform deployment target.

Deployed 2026-10-01 in us-east-1: repository stack, pipeline bootstrap and all three environments through the automatic pipeline. Origin is outcomelens-infra; the local developer profile is chosen with `AWS_PROFILE`. Local synth/tests alone still do not establish CloudFormation, IAM or runtime success.

## Official references reviewed

- CodeCommit availability: https://aws.amazon.com/blogs/devops/aws-codecommit-returns-to-general-availability/
- CodeBuild runtimes: https://docs.aws.amazon.com/codebuild/latest/userguide/available-runtimes.html
- JWT authorizer/scopes: https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-jwt-authorizer.html
- Amplify manual deploy: https://docs.aws.amazon.com/boto3/latest/reference/services/amplify/client/create_deployment.html
- S3 conditional writes: https://aws.amazon.com/blogs/storage/building-multi-writer-applications-on-amazon-s3-using-native-controls/

Some control-plane actions require dynamic-ID wildcard scopes; runtime roles are bounded, but this is not strict production-account isolation. No prices/Free Tier entitlement assumed. See the spec for costs, telemetry gaps, notification setup, first-release failure and rollback limits.

## Local source policy and CodeCommit push

`core.hooksPath=.githooks` is configured in this workspace; isolated clones can enable it with `git config core.hooksPath .githooks`. The pre-commit hook scans working and staged content for selected sensitive patterns. Review history and data semantics too; pattern scanning is not exhaustive. Unpublished agent commits were given pseudonymous author metadata before any remote push.

The CodeCommit origin selects your AWS CLI profile through `git-remote-codecommit` (`codecommit://<profile>@<repo>`). `tools/push.sh` pushes main with `AWS_PROFILE`; profiles created by `aws login` so install the helper with the CRT extra (`uv tool install git-remote-codecommit --with 'botocore[crt]'`). No static Git credentials were created.
