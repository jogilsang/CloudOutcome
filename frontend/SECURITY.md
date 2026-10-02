# Module security rules

Runtime-specific obligations: Owns bilingual banana UI, OAuth code/PKCE sign-in, memory-only tokens, runtime config and explicit offline samples. Normal cloud builds fail closed without config/authentication. No AWS credentials or direct database access. Standalone commands: npm ci; npm run build; npm run build:preview; npm test.

Do not commit or log credentials, contact details, raw customer events, tokens or personal identifiers. Use synthetic fixtures and pseudonymous identifiers; owner fields are team labels. Review all staged content and Git metadata before remote publication. Do not weaken authentication, quotas or automated deployment gates to pass a test. Record remaining limitations rather than claiming complete privacy/compliance. Run `python3 tools/check_policy.py` before commits and deployment packaging. This pattern scan is defense-in-depth, not an exhaustive PII detector.
