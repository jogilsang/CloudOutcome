# frontend module contract v0.2

Owns bilingual banana UI, OAuth code/PKCE sign-in, memory-only tokens, runtime config and explicit offline samples. Normal cloud builds fail closed without config/authentication. No AWS credentials or direct database access. Visitors connect AWS accounts from the Connect AWS accounts tab without signing in (7-day temporary workspace); the header sign-in is shown only with ?signin. Any action that assumes the read-only role first shows a resource access notice ("don't show again" is remembered per browser, and blocked storage keeps showing it). Accounts can be removed one by one or all at once; removal stops collection, and revocation is deleting the role stack. Standalone commands: npm ci; npm run build; npm run build:preview; npm test.

Design owner: outcomelens-infra, spec/PRODUCT.md and spec/DEPLOYMENT.md. This module can build/test independently; source integration occurs through versioned artifacts/API contracts, not sibling-path imports.
