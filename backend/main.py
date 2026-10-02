import json
import logging
import os
import sqlite3
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from fastapi.exceptions import RequestValidationError
from privacy import assert_safe
from cloud_store import Store, tenant_for
import aws_live
from starlette.middleware.trustedhost import TrustedHostMiddleware
from pydantic import BaseModel, ConfigDict, Field, model_validator
from domain import Definition, FORMULAS, Observation, calculate, dashboard
from decimal import Decimal
from functools import lru_cache
from bedrock_advisor import classify

CLOUD = os.environ.get("OUTCOMELENS_MODE") == "cloud"
app = FastAPI(title="CloudOutcome", version="0.2.0", docs_url=None if CLOUD else "/docs", redoc_url=None if CLOUD else "/redoc", openapi_url=None if CLOUD else "/openapi.json")
logger = logging.getLogger("outcomelens")
logger.setLevel(logging.INFO)
DB = os.environ.get("OUTCOMELENS_DB", str(Path(__file__).with_name("outcomelens.sqlite")))
PUBLIC = os.environ.get("PUBLIC_DEMO", "false").lower() == "true"
if not PUBLIC and not CLOUD:
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=["localhost", "127.0.0.1", "testserver"])


@lru_cache(maxsize=1)
def bedrock_client():
    import boto3
    from botocore.config import Config
    return boto3.Session(region_name=os.environ.get("AWS_REGION", "us-east-1")).client(
        "bedrock-runtime", config=Config(connect_timeout=3, read_timeout=12,
        retries={"mode": "standard", "total_max_attempts": 2}))


def connection():
    db = sqlite3.connect(DB, timeout=5)
    db.row_factory = sqlite3.Row
    db.execute("CREATE TABLE IF NOT EXISTS definitions (id TEXT PRIMARY KEY, version INTEGER, body TEXT)")
    db.execute("CREATE TABLE IF NOT EXISTS audit (id TEXT PRIMARY KEY, created TEXT DEFAULT CURRENT_TIMESTAMP, action TEXT, body TEXT)")
    return db


@app.exception_handler(RequestValidationError)
async def invalid_request(request, error):
    # Pydantic errors normally include the original input. Do not echo it.
    return JSONResponse({"detail": "Invalid request shape or value"}, status_code=422)


def trusted_gateway(request):
    context = request.scope.get("aws.event", {}).get("requestContext", {})
    if context.get("apiId") != os.environ.get("API_ID") or not os.environ.get("API_ID"):
        raise HTTPException(403, "Trusted API context required")
    return context


def cloud_identity(request):
    context = trusted_gateway(request)
    claims = context.get("authorizer", {}).get("jwt", {}).get("claims", {})
    if claims.get("token_use") != "access":
        raise HTTPException(401, "Access token required")
    if "outcomelens/api" not in str(claims.get("scope", "")).split():
        raise HTTPException(403, "API scope required")
    groups = claims.get("cognito:groups", [])
    if isinstance(groups, str):
        groups = groups.strip("[]").replace('"', '').split(",")
    groups = {group.strip() for group in groups}
    required = {"operators"} if request.method in {"PUT", "POST", "DELETE"} else {"operators", "viewers"}
    if not groups & required:
        raise HTTPException(403, "Workspace role does not permit this action")
    return tenant_for(claims)


@app.middleware("http")
async def boundary(request: Request, call_next):
    request_id = uuid.uuid4().hex
    start = time.monotonic()
    error_type = None
    try:
        if CLOUD and request.url.path.startswith("/api/anon/"):
            trusted_gateway(request)  # identity is the temporary workspace key, checked per route
        elif CLOUD and request.url.path.startswith("/api/public/"):
            # Anonymous, read-only snapshot route: gateway context is still required, identity is not.
            trusted_gateway(request)
            if request.method != "GET":
                raise HTTPException(405, "Public routes are read-only")
        elif CLOUD:
            tenant = cloud_identity(request)
            request.state.store = Store(tenant)
            request.state.store.consume(int(os.environ.get("REQUESTS_PER_MINUTE", "60")))
        if request.method in {"POST", "PUT", "DELETE"}:
            if PUBLIC:
                raise HTTPException(403, "Public demo is read-only. Use local workspace for edits.")
            origin = request.headers.get("origin")
            allowed = set(os.environ.get("ALLOWED_ORIGINS", "").split(",")) if CLOUD else {
                "http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:8000", "http://127.0.0.1:8000"}
            if origin and origin not in allowed:
                raise HTTPException(403, "Origin not allowed")
        try:
            content_length = int(request.headers.get("content-length", "0"))
        except ValueError:
            raise HTTPException(400, "Invalid Content-Length") from None
        if content_length < 0 or content_length > 100000:
            raise HTTPException(413, "Payload too large")
        if request.method in {"POST", "PUT"}:
            payload = await request.body()
            if len(payload) > 100000:
                raise HTTPException(413, "Payload too large")
            try:
                assert_safe(json.loads(payload))
            except json.JSONDecodeError:
                raise HTTPException(400, "Invalid JSON") from None
            except ValueError:
                raise HTTPException(422, "Sensitive data is not permitted. Use pseudonymous IDs and team labels.") from None
        response = await call_next(request)
    except HTTPException as error:
        error_type = "http_boundary"
        response = JSONResponse({"detail": error.detail}, status_code=error.status_code)
    except Exception as error:
        error_type = type(error).__name__
        # Neither SDK error details nor payloads/headers are safe logging fields.
        response = JSONResponse({"detail": "Service temporarily unavailable"}, status_code=503)
    response.headers["X-Request-ID"] = request_id
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Cache-Control"] = "no-store"
    logger.info(json.dumps({"event": "request.completed", "request_id": request_id, "error_type": error_type,
        "route": getattr(request.scope.get("route"), "path", "unmatched"),
        "method": request.method, "status": response.status_code,
        "elapsed_ms": round((time.monotonic()-start)*1000),
        "gateway_request_id": request.scope.get("aws.event", {}).get("requestContext", {}).get("requestId", "local"),
        "release": os.environ.get("RELEASE_ID", "local")}))
    return response


@app.get("/api/health")
def health():
    return {"status": "ok", "mode": "cloud-workspace" if CLOUD else "public-demo" if PUBLIC else "local-workspace",
            "aws_connected": bool(LOCAL_AWS_PROFILE),
            "assistant": "bedrock-configured" if os.environ.get("BEDROCK_MODEL_ID") else "rules",
            "version": "0.1.0"}


@app.get("/api/dashboard")
def get_dashboard(service: Literal["checkout", "catalog"] = "checkout",
                  days: int = 14,
                  scenario: Literal["baseline", "incident", "empty"] = "baseline",
                  allocation: float = Query(40, ge=0, le=100)):
    # Literal[int] never matches the string a query parameter arrives as, so validate the parsed int.
    if days not in (7, 14, 30):
        raise HTTPException(422, "Invalid request shape or value")
    return dashboard(service, days, scenario, allocation)


@app.get("/api/resources")
def resources():
    return {"mode": "synthetic", "resources": [
        {"id": "checkout-api", "service": "API Gateway", "group": "checkout", "signal": "Count / 5XXError / Latency", "status": "sample", "tags": {"app": "commerce", "domain": "checkout"}},
        {"id": "checkout-handler", "service": "Lambda", "group": "checkout", "signal": "Invocations / Errors / Duration", "status": "sample", "tags": {"app": "commerce", "domain": "checkout"}},
        {"id": "orders", "service": "DynamoDB", "group": "checkout", "signal": "ConsumedReadCapacityUnits", "status": "sample", "tags": {"app": "commerce", "domain": "checkout"}},
        {"id": "catalog-api", "service": "API Gateway", "group": "catalog", "signal": "Count / Latency", "status": "sample", "tags": {"app": "commerce", "domain": "catalog"}},
        {"id": "shared-observability", "service": "CloudWatch", "group": "shared", "signal": "Shared cost pool", "status": "sample", "tags": {"app": "platform"}},
    ], "connection": {"status": "not_connected", "reason": "No account connector deployed. Sample resources only."}}


@app.get("/api/definitions")
def definitions(request: Request):
    if CLOUD:
        return request.state.store.definitions()
    if PUBLIC:
        return []
    with connection() as db:
        return [{"id": r["id"], "version": r["version"], **json.loads(r["body"])}
                for r in db.execute("SELECT * FROM definitions ORDER BY id")]


@app.put("/api/definitions/{key}")
def save_definition(key: str, body: Definition, request: Request):
    if CLOUD:
        return request.state.store.save(key, body)
    if not key.isidentifier() or len(key) > 64:
        raise HTTPException(422, "Invalid definition id")
    with connection() as db:
        db.execute("BEGIN IMMEDIATE")
        existing = db.execute("SELECT version FROM definitions WHERE id=?", (key,)).fetchone()
        version = existing["version"] if existing else 0
        if version != body.expected_version:
            raise HTTPException(409, "Definition changed. Reload before saving.")
        doc = body.model_dump(exclude={"expected_version"})
        db.execute("INSERT INTO definitions VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,body=excluded.body",
                   (key, version+1, json.dumps(doc)))
        db.execute("INSERT INTO audit(id,action,body) VALUES(?,?,?)",
                   (uuid.uuid4().hex, "definition.saved", json.dumps({"id": key, "version": version+1, **doc})))
    return {"id": key, "version": version+1, **doc}


@app.get("/api/audit")
def audit(request: Request):
    if CLOUD:
        return request.state.store.audit()
    if PUBLIC:
        return []
    with connection() as db:
        return [dict(r) for r in db.execute("SELECT * FROM audit ORDER BY rowid DESC LIMIT 50")]


class Prompt(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: str = Field(min_length=2, max_length=1000)
    service: Literal["checkout", "catalog"] = "checkout"


@app.post("/api/propose")
def propose(body: Prompt):
    text = body.text.lower()
    if any(w in text for w in ["매출", "revenue", "mau", "활성", "profit", "이익"]):
        return {"engine": "rules", "status": "missing_source", "kind": None,
                "reason": "Business source required: revenue/refunds or distinct active-user events.",
                "sources": [], "formula": None}
    kind = ("latency_p95" if any(w in text for w in ["지연", "latency", "p95", "느려"]) else
            "success_rate" if any(w in text for w in ["성공", "success", "slo", "오류"]) else
            "cost_per_order" if any(w in text for w in ["비용", "cost", "주문", "order"]) else None)
    engine = "rules"
    if model_id := os.environ.get("BEDROCK_MODEL_ID"):
        try:
            kind = classify(body.text, model_id, bedrock_client())
        except Exception as error:
            # Provider details may contain internal identifiers. Expose a stable boundary error.
            logger.warning("advisor_failed: %s", type(error).__name__)
            raise HTTPException(502, "Advisor unavailable or invalid response; no KPI was saved.") from error
        engine = "bedrock"
        if kind in {"missing_source", "unsupported"}:
            return {"engine": engine, "status": kind, "kind": None, "sources": [],
                    "reason": "Required source or supported KPI definition is not available."}
    if not kind:
        return {"engine": "rules", "status": "unsupported", "kind": None,
                "reason": "Choose cost per order, operation success, or p95 latency.", "sources": []}
    if kind == "cost_per_order" and body.service != "checkout":
        return {"engine": "rules", "status": "missing_source", "kind": None,
                "reason": "Catalog does not emit completed order events.", "sources": []}
    return {"engine": engine, "status": "ready", "kind": kind,
            "formula": FORMULAS[kind], "reason": "Preview against selected synthetic workspace before saving.",
            "sources": ["operation_events"] + (["daily_costs", "allocation_policy"] if kind == "cost_per_order" else [])}


class Preview(BaseModel):
    model_config = ConfigDict(extra="forbid")
    events: list[Observation] = Field(max_length=3000)
    direct_cost: Decimal = Field(ge=0, le=1000000, allow_inf_nan=False)
    shared_cost: Decimal = Field(ge=0, le=1000000, allow_inf_nan=False)
    allocation_pct: Decimal = Field(ge=0, le=100, allow_inf_nan=False)
    window_start: datetime
    window_end: datetime
    currency: Literal["USD"]
    cost_basis: Literal["unblended", "amortized", "simulated"]

    @model_validator(mode="after")
    def matching_window(self):
        if self.window_start.tzinfo is None or self.window_end.tzinfo is None:
            raise ValueError("window boundaries require timezone")
        seconds = (self.window_end - self.window_start).total_seconds()
        if not 0 < seconds <= 31 * 86400:
            raise ValueError("window must be positive and at most 31 days")
        if any(not self.window_start <= e.timestamp < self.window_end for e in self.events):
            raise ValueError("event outside declared billing window")
        return self


@app.post("/api/preview")
def preview(body: Preview):
    if len({e.service for e in body.events}) > 1:
        raise HTTPException(422, "Preview must use one service boundary")
    try:
        result = calculate(body.events, body.direct_cost, body.shared_cost, body.allocation_pct)
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    if body.events and body.events[0].service != "checkout":
        result["cost_per_order"] = None
    return {"mode": "user_supplied_preview", "summary": result,
            "window": {"start": body.window_start, "end_exclusive": body.window_end},
            "currency": body.currency, "cost_basis": body.cost_basis,
            "note": "Declared cost scope must match the event workload. Imported totals are user assertions, not verified AWS billing. No values persisted."}



def _live_errors(call):
    """Map SDK failures to fixed messages; SDK text can carry another account's principal ARNs."""
    from botocore.exceptions import BotoCoreError, ClientError, LoginError, NoCredentialsError, SSOError, TokenRetrievalError
    try:
        return call()
    except (LoginError, NoCredentialsError, SSOError, TokenRetrievalError):
        if not CLOUD:
            raise HTTPException(401, f"AWS profile '{LOCAL_AWS_PROFILE}' session expired or missing. Sign in again (for example: aws login --profile {LOCAL_AWS_PROFILE}) and refresh.") from None
        raise HTTPException(502, "AWS read request failed") from None
    except ClientError as error:
        if error.response.get("Error", {}).get("Code", "").endswith(("AccessDenied", "AccessDeniedException", "UnauthorizedOperation")):
            raise HTTPException(403, "The connected role is missing a read permission. Redeploy the provided template.") from None
        raise HTTPException(502, "AWS read request failed") from None
    except BotoCoreError:
        raise HTTPException(502, "AWS read request failed") from None


def _live_unavailable():
    if not CLOUD and not LOCAL_AWS_PROFILE:
        raise HTTPException(503, "Local live data is off. Start the backend with tools/dev.sh --profile <aws-profile>.")


# Local development only: an operator-supplied AWS profile is read directly (no role assumption).
# Nothing about the profile, account or Region is hard-coded; tools/dev.sh passes them as arguments.
LOCAL_AWS_PROFILE = None if CLOUD else os.environ.get("OUTCOMELENS_AWS_PROFILE") or None
LOCAL_AWS_REGION = os.environ.get("OUTCOMELENS_AWS_REGION", "us-east-1")
LOCAL_CACHE_SECONDS = 300
_local_cache = {}


def _local_raw(mask, refresh=False):
    """Collect 30 days once per cache window (or on an explicit refresh); every view is a slice of it."""
    cached = _local_cache.get(mask)
    if cached and not refresh and time.monotonic() - cached[0] < LOCAL_CACHE_SECONDS:
        return cached[1]
    import boto3
    session = boto3.Session(profile_name=LOCAL_AWS_PROFILE, region_name=LOCAL_AWS_REGION)
    raw = _live_errors(lambda: aws_live.collect(session, LOCAL_AWS_REGION, aws_live.MAX_DAYS,
                                                pricing=session.client("pricing", region_name="us-east-1"), mask=mask))
    _local_cache[mask] = (time.monotonic(), raw)
    return raw


@app.get("/api/public/live-demo")
def public_live_demo(days: int = 7, refresh: bool = False):
    _live_unavailable()
    if not CLOUD:  # the cloud snapshot is refreshed by the scheduled task, never by anonymous callers
        return {**aws_live.summarize(_local_raw(True, refresh), days), "mode": "public-live-demo", "local_profile": True}
    store = Store.public_demo()
    ready = store.summary(days) if days in (7, 14, 30) else None
    if ready:
        return {**ready, "mode": "public-live-demo"}
    raw = store.snapshot()
    if not raw:
        # A new environment before its first scheduled collection is a normal state, not a server error:
        # a 5xx here trips the API error alarm and makes CodeDeploy roll back every fresh deployment.
        return {"status": "collecting", "mode": "public-live-demo", "detail": "The live demo snapshot is being collected (up to 10 minutes)."}
    return {**aws_live.summarize(raw, days), "mode": "public-live-demo"}


# --- multi-account workspaces -------------------------------------------------------------------------------
# Same handlers serve signed-in workspaces (/api/workspace/...), temporary anonymous workspaces
# (/api/anon/workspace/...) and local development. Credentials never pass through the API.

import threading
import fleet
from cloud_store import DynamoDocs, LocalDocs, register, anon_pk, ANON_DAYS

ANON_HEADER = "x-cloudoutcome-workspace"


def _runtime_account():
    arn = os.environ.get("RUNTIME_ROLE_ARN", "")
    if arn.startswith("arn:aws:iam::"):
        return arn.split(":")[4]
    return _local_account() if not CLOUD else None


@lru_cache(maxsize=1)
def _local_session():
    import boto3
    return boto3.Session(profile_name=LOCAL_AWS_PROFILE, region_name=LOCAL_AWS_REGION)


@lru_cache(maxsize=1)
def _local_account():
    if not LOCAL_AWS_PROFILE:
        return None
    return _live_errors(lambda: _local_session().client("sts").get_caller_identity()["Account"])


def session_for(account, external_id):
    if not CLOUD and LOCAL_AWS_PROFILE and account == _local_account():
        return _local_session()  # local development reads the developer's own profile directly
    sts = _local_session().client("sts") if not CLOUD and LOCAL_AWS_PROFILE else None
    return aws_live.assume(aws_live.role_arn(account), external_id, sts=sts)


def pricing_client():
    """List prices are public: read them with our own credentials (Lambda role or the local profile), never the customer's."""
    import boto3
    return (_local_session() if not CLOUD and LOCAL_AWS_PROFILE else boto3).client("pricing", region_name="us-east-1")


def collect_for_workspace(session, region, days):
    return aws_live.collect(session, region, days, pricing=pricing_client())


def _docs(request):
    if request.url.path.startswith("/api/anon/"):
        if not CLOUD:
            return LocalDocs("ANON#local", DB)
        pk = anon_pk(request.headers.get(ANON_HEADER))
        found = DynamoDocs(pk).get("CONNECTION")
        if not found or found.get("expires_at", 0) < time.time():
            raise HTTPException(401, "Temporary workspace expired. Start a new connection.")
        docs = DynamoDocs(pk, expires_at=found["expires_at"])
        Store("", pk=pk).consume(int(os.environ.get("REQUESTS_PER_MINUTE", "60")))
        return docs
    if CLOUD:
        return DynamoDocs(request.state.store.pk)
    return LocalDocs("LOCAL#workspace", DB)


def _registry(pk, active):
    if CLOUD:
        register(pk, active)


def _dispatch(pk, chunk, expires_at=None):
    payload = {"outcomelens_task": "collect-accounts", "pk": pk, "accounts": chunk, "expires_at": expires_at}
    if CLOUD:
        import boto3
        boto3.client("lambda").invoke(FunctionName=os.environ["COLLECTOR_FUNCTION"], InvocationType="Event", Payload=json.dumps(payload).encode())
    else:
        docs = LocalDocs(pk, DB)
        threading.Thread(target=fleet.collect_chunk, args=(docs, chunk, session_for), kwargs={"collect": collect_for_workspace}, daemon=True).start()


def _start(docs, only_stale=False):
    expires = getattr(docs, "expires_at", None)
    return fleet.start_collection(docs, lambda pk, chunk: _dispatch(pk, chunk, expires), only_stale)


def _connection_view(docs):
    conn = fleet.connection(docs)
    account = _runtime_account()
    return {"external_id": conn["external_id"], "role_name": aws_live.ROLE_NAME, "trusted_account_id": account,
            "trusted_principal_pattern": f"arn:aws:iam::{account}:role/outcomelens-*-runtime-api" if account else None,
            "template_path": "/outcomelens-readonly-role.json", "expires_at": conn.get("expires_at"),
            "mode": "local" if not CLOUD else "temporary" if docs.pk.startswith("ANON#") else "signed-in",
            "local_profile_account": _local_account() if not CLOUD else None, "max_accounts": fleet.MAX_ACCOUNTS}


@app.post("/api/anon/workspace")
def create_anonymous_workspace():
    """Temporary workspace for visitors who connect without signing in. The key lives only in their browser."""
    if not CLOUD:
        return {"token": "local-development-anonymous-key", "expires_at": None}
    Store("", pk="ANON#create").consume(30)  # bounds workspace creation across all anonymous callers
    import secrets as _secrets
    token = _secrets.token_urlsafe(32)
    expires = int(time.time()) + ANON_DAYS * 86400
    DynamoDocs(anon_pk(token), expires_at=expires).put("CONNECTION", {"external_id": _secrets.token_urlsafe(24), "created_at": fleet.now_iso(), "expires_at": expires})
    return {"token": token, "expires_at": expires}


class AccountsRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    accounts: str | list[str] = Field(max_length=5000)


class CollectRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    only_stale: bool = False


class ServicesRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    services: list[dict] = Field(max_length=20)


def _accounts_view(docs):
    return {"accounts": fleet.accounts(docs), "progress": fleet.progress(docs)}


for prefix in ("/api/workspace", "/api/anon/workspace"):
    def routes(prefix=prefix):
        @app.get(prefix + "/connection")
        def get_connection(request: Request):
            return _connection_view(_docs(request))

        @app.get(prefix + "/accounts")
        def get_accounts(request: Request):
            return _accounts_view(_docs(request))

        @app.put(prefix + "/accounts")
        def put_accounts(body: AccountsRequest, request: Request):
            docs = _docs(request)
            fleet.connection(docs)
            fleet.save_accounts(docs, fleet.parse_accounts(body.accounts), _registry)
            fleet.sync(docs, session_for)          # checked immediately; failed accounts are never collected
            _start(docs)
            return _accounts_view(docs)

        @app.post(prefix + "/sync")
        def sync_accounts(request: Request):
            docs = _docs(request)
            fleet.sync(docs, session_for)
            _start(docs)
            return _accounts_view(docs)

        @app.post(prefix + "/collect")
        def collect_accounts(body: CollectRequest, request: Request):
            docs = _docs(request)
            _start(docs, body.only_stale)
            return _accounts_view(docs)

        @app.get(prefix + "/live")
        def workspace_live(request: Request, days: int = 7, account: str | None = None, service: str | None = None):
            docs = _docs(request)
            chosen = next((s for s in fleet.services(docs) if s["id"] == service), None) if service else None
            if service and not chosen:
                raise HTTPException(404, "Unknown service")
            view = fleet.workspace_view(docs, days, account, chosen)
            out = {"view": view, "progress": fleet.progress(docs), "connected": len(fleet.connected(docs))}
            if chosen and view:
                out["service"] = {**chosen, "kpi_values": fleet.kpis(view, chosen)[0], "monthly_estimated_usd": fleet.kpis(view, chosen)[1]}
            return out

        @app.get(prefix + "/services")
        def get_services(request: Request):
            return {"services": fleet.services(_docs(request))}

        @app.put(prefix + "/services")
        def put_services(body: ServicesRequest, request: Request):
            docs = _docs(request)
            items = fleet.validate_services(body.services, {a["id"] for a in fleet.accounts(docs)})
            docs.put("SERVICES", {"services": items, "updated_at": fleet.now_iso()})
            return {"services": items}
    routes()
