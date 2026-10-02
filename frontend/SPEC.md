# frontend module contract v0.2

Owns bilingual banana UI, OAuth code/PKCE sign-in, memory-only tokens, runtime config and explicit offline samples. Normal cloud builds fail closed without config/authentication. No AWS credentials or direct database access. Standalone commands: npm ci; npm run build; npm run build:preview; npm test.

Design owner: outcomelens-infra, spec/PRODUCT.md and spec/DEPLOYMENT.md. This module can build/test independently; source integration occurs through versioned artifacts/API contracts, not sibling-path imports.
