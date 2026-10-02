# infra module contract v0.2

Owns canonical spec/, parameterized platform, deployment pipeline, environment roles and automated recovery. npm test; npm run synth:platform; npm run synth:pipeline. Run ci/tests with Python pytest+boto3. No self-mutation or unreviewed stateful replacement. CodeCommit repositories and all cloud resources still need permitted AWS execution.

Design owner: outcomelens-infra, spec/PRODUCT.md and spec/DEPLOYMENT.md. This module can build/test independently; source integration occurs through versioned artifacts/API contracts, not sibling-path imports.
