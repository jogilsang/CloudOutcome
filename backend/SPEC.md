# backend module contract v0.2

Owns deterministic KPI logic and privacy/auth/storage boundaries. Local single-user SQLite is development-only; cloud mode requires expected API Gateway event and DynamoDB. Subject-derived workspaces, operator/viewer roles, per-minute request cap, atomic version/audit writes. Run uv venv, install requirements-tested.txt plus SDK test pins, then pytest. Lambda packaging uses requirements-runtime.txt; Mangum/Linux execution is not yet verified live.

Design owner: outcomelens-infra, spec/PRODUCT.md and spec/DEPLOYMENT.md. This module can build/test independently; source integration occurs through versioned artifacts/API contracts, not sibling-path imports.
