# Module security rules

Runtime-specific obligations: Owns canonical spec/, parameterized platform, deployment pipeline, environment roles and automated recovery. npm test; npm run synth:platform; npm run synth:pipeline. Run ci/tests with Python pytest+boto3. No self-mutation or unreviewed stateful replacement. CodeCommit repositories and all cloud resources still need permitted AWS execution.

Do not commit or log credentials, contact details, raw customer events, tokens or personal identifiers. Use synthetic fixtures and pseudonymous identifiers; owner fields are team labels. Review all staged content and Git metadata before remote publication. Do not weaken authentication, quotas or automated deployment gates to pass a test. Record remaining limitations rather than claiming complete privacy/compliance. Run `python3 tools/check_policy.py` before commits and deployment packaging. This pattern scan is defense-in-depth, not an exhaustive PII detector.
