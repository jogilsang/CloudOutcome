"""Multi-account workspaces: account lists, connection checks, background collection,
cross-account summaries and business services (tag/name rules with cost shares and KPIs).

Only accounts whose last check succeeded are ever collected; failed or pending accounts are
not called at all until a sync proves the role works again.
"""
import json
import re
import secrets
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from fastapi import HTTPException
import aws_live

MAX_ACCOUNTS = 100
CHUNK = 10                 # accounts per background collection invocation
CHECK_WORKERS = 16
STALE_SECONDS = 600        # snapshots older than this are refreshed by "collect if stale"
KPI_IDS = {"cost_per_order", "checkout_success", "checkout_latency_p95", "api_error_rate", "availability_slo",
           "cloud_cost_ratio", "conversion_rate", "cart_abandonment", "peak_headroom", "cost_per_active_user"}


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def parse_accounts(value):
    """Accept a pasted list or accounts.list file content: commas, whitespace, semicolons or newlines."""
    items = value if isinstance(value, list) else re.split(r"[\s,;]+", str(value or ""))
    ids, bad = [], []
    for item in (str(i).strip() for i in items):
        if not item:
            continue
        (ids if re.fullmatch(r"\d{12}", item) else bad).append(item)
    if bad:
        raise HTTPException(422, f"{len(bad)} entries are not 12-digit AWS account IDs")
    unique = sorted(set(ids))
    if len(unique) > MAX_ACCOUNTS:
        raise HTTPException(422, f"At most {MAX_ACCOUNTS} accounts per workspace")
    return unique


# --- workspace documents ---------------------------------------------------------------------------------

def connection(docs):
    found = docs.get("CONNECTION")
    if found:
        return found
    doc = {"external_id": secrets.token_urlsafe(24), "created_at": now_iso()}
    return docs.put_new("CONNECTION", doc) or docs.get("CONNECTION")


def accounts(docs):
    return (docs.get("ACCOUNTS") or {}).get("accounts", [])


def save_accounts(docs, ids, registry=None):
    previous = {a["id"]: a for a in accounts(docs)}
    rows = [previous.get(i, {"id": i, "status": "pending", "checked_at": None, "reason": None}) for i in ids]
    docs.put("ACCOUNTS", {"accounts": rows, "updated_at": now_iso()})
    if registry is not None:
        registry(docs.pk, bool(rows))
    return rows


def check_one(account, external_id, session_for):
    """AssumeRole and confirm the caller account. Returns a status row; never raises."""
    try:
        session = session_for(account, external_id)
        actual = session.client("sts").get_caller_identity()["Account"]
        if actual != account:
            return {"id": account, "status": "failed", "reason": "account-mismatch"}
        return {"id": account, "status": "connected", "reason": None}
    except HTTPException:
        return {"id": account, "status": "failed", "reason": "assume-role-denied"}
    except Exception as error:  # SDK/network errors: keep only the class name
        return {"id": account, "status": "failed", "reason": type(error).__name__}


def sync(docs, session_for, workers=CHECK_WORKERS):
    external_id = connection(docs)["external_id"]
    ids = [a["id"] for a in accounts(docs)]
    with ThreadPoolExecutor(max_workers=max(1, min(workers, len(ids) or 1))) as pool:
        rows = list(pool.map(lambda a: check_one(a, external_id, session_for), ids))
    checked = now_iso()
    rows = [{**r, "checked_at": checked} for r in rows]
    docs.put("ACCOUNTS", {"accounts": rows, "updated_at": checked})
    return rows


def connected(docs):
    return [a["id"] for a in accounts(docs) if a["status"] == "connected"]


# --- background collection -------------------------------------------------------------------------------

def start_collection(docs, dispatch, only_stale=False):
    """Queue collection of connected accounts in chunks. Failed/pending accounts are never collected."""
    targets = connected(docs)
    if only_stale:
        fresh = {s["account"] for s in snapshots(docs) if _age(s["collected_at"]) < STALE_SECONDS}
        targets = [a for a in targets if a not in fresh]
    state = {"started_at": now_iso(), "accounts": targets, "chunks": 0}
    if targets:
        chunks = [targets[i:i + CHUNK] for i in range(0, len(targets), CHUNK)]
        state["chunks"] = len(chunks)
        docs.put("COLLECTION", state)
        for chunk in chunks:
            dispatch(docs.pk, chunk)
    return state


def collect_chunk(docs, chunk, session_for, home_region="us-east-1", collect=None):
    collect = collect or aws_live.collect
    external_id = connection(docs)["external_id"]
    allowed = set(connected(docs))
    done = []
    for account in chunk:
        if account not in allowed:
            continue  # status changed since queuing: do not touch it
        try:
            raw = collect(session_for(account, external_id), home_region, aws_live.MAX_DAYS)
        except Exception as error:
            docs.put("SNAPSHOT#" + account, {"account": account, "collected_at": now_iso(), "error": type(error).__name__})
            continue
        docs.put("SNAPSHOT#" + account, {"account": account, "collected_at": raw["collected_at"], "raw": raw})
        done.append(account)
    return done


def snapshots(docs):
    return [s for s in docs.query("SNAPSHOT#") if s.get("account")]


def _age(stamp):
    try:
        return (datetime.now(timezone.utc) - datetime.fromisoformat(stamp)).total_seconds()
    except (TypeError, ValueError):
        return float("inf")


def progress(docs):
    state = docs.get("COLLECTION") or {}
    targets = state.get("accounts", [])
    started = state.get("started_at")
    fresh = [s for s in snapshots(docs) if started and s["collected_at"] >= started and s["account"] in targets]
    done = {s["account"] for s in fresh}
    errors = sorted(s["account"] for s in fresh if s.get("error"))
    return {"started_at": started, "total": len(targets), "done": len(done), "running": bool(targets) and len(done) < len(targets), "failed": errors}


# --- summaries ---------------------------------------------------------------------------------------------

def _matches(rule, resource):
    if rule["type"] == "tag":
        return resource.get("tags", {}).get(rule["key"]) == rule["value"]
    return rule["contains"].lower() in resource["name"].lower()


def service_weight(service):
    """Share (0..1) of a resource's cost that belongs to the service: first matching rule wins."""
    def weight(resource):
        for rule in service.get("rules", []):
            if _matches(rule, resource):
                return rule.get("share_pct", 100) / 100
        return 0.0
    return weight


NUMERIC_OUTCOME_FIELDS = ("estimated_usd", "api_requests", "api_errors_5xx", "orders", "lambda_invocations", "lambda_duration_ms", "resources")


def merge(views, days):
    """Combine per-account summaries on calendar dates (snapshots may be collected on different days)."""
    if not views:
        return None
    last = max(v["daily"][-1]["date"] for v in views)
    dates = [(datetime.fromisoformat(last) - timedelta(days=d)).date().isoformat() for d in range(days - 1, -1, -1)]
    by_date = {d: 0.0 for d in dates}
    services, resources, in_use, regions = {}, [], {}, set()
    for v in views:
        for day in v["daily"]:
            if day["date"] in by_date:
                by_date[day["date"]] += day["estimated_usd"]
        for s in v["services"]:
            e = services.setdefault(s["service"], {"service": s["service"], "resources": 0, "estimated_usd": 0.0})
            e["resources"] += s["resources"]; e["estimated_usd"] += s["estimated_usd"]
        resources += [{**r, "account": v["account_id"]} for r in v["resources"]]
        regions |= set(v["regions_scanned"])
        for e in v["services_in_use"]:
            m = in_use.setdefault(e["namespace"], {"namespace": e["namespace"], "service": e["service"], "regions": {}, "accounts": 0})
            m["accounts"] += 1
            for r, c in e["regions"].items():
                m["regions"][r] = m["regions"].get(r, 0) + c
    resources.sort(key=lambda r: -(r["estimated_usd"] or 0))
    outcomes = {}
    for v in views:
        for key, o in v.get("outcomes", {}).items():
            m = outcomes.setdefault(key, {k: 0.0 for k in ("estimated_usd", "api_requests", "api_errors_5xx", "orders", "lambda_invocations", "lambda_duration_ms")} | {"resources": 0})
            for k in NUMERIC_OUTCOME_FIELDS:
                m[k] += o.get(k, 0)
            for k in ("daily_requests", "daily_errors_5xx", "daily_orders"):  # same trailing window per account
                series = o.get(k, [])
                m[k] = [a + b for a, b in zip(m[k], series)] if k in m else list(series)
    for m in outcomes.values():
        m["avg_checkout_ms"] = round(m["lambda_duration_ms"] / m["lambda_invocations"], 1) if m["lambda_invocations"] else None
    first = views[0]
    return {"source": "aws-live", "mode": "accounts", "window": {"start": dates[0], "end_exclusive": (datetime.fromisoformat(dates[-1]) + timedelta(days=1)).date().isoformat(), "days": days},
            "total_estimated_usd": round(sum(by_date.values()), 8), "daily": [{"date": d, "estimated_usd": round(c, 8)} for d, c in by_date.items()],
            "services": sorted(({**s, "estimated_usd": round(s["estimated_usd"], 8)} for s in services.values()), key=lambda s: -s["estimated_usd"]),
            "resources": resources, "services_in_use": sorted(in_use.values(), key=lambda e: (-len(e["regions"]), e["service"])),
            "regions_scanned": sorted(regions), "regions_failed": sorted({r for v in views for r in v["regions_failed"]}),
            "regions_with_cost": sorted({r["region"] for r in resources if r["estimated_usd"]}), "discovery": all(v["discovery"] for v in views),
            "unpriced_resources": sum(v["unpriced_resources"] for v in views), "truncated": any(v["truncated"] for v in views), "partial_last_day": True,
            "api_requests": sum(v["api_requests"] for v in views), "api_errors_5xx": sum(v["api_errors_5xx"] for v in views), "outcomes": outcomes,
            "accounts": [{"id": v["account_id"], "estimated_usd": v["total_estimated_usd"], "collected_at": v["collected_at"], "resources": len(v["resources"])} for v in views],
            "account": f"{len(views)} account" + ("s" if len(views) > 1 else ""), "region": first["region"], "collected_at": min(v["collected_at"] for v in views),
            "pricing": first["pricing"]}


def workspace_view(docs, days, account=None, service=None):
    allowed = set(connected(docs))
    if service:
        allowed &= set(service.get("accounts") or allowed)
    if account:
        allowed &= {account}
    weight = service_weight(service) if service else None
    views = []
    for snap in snapshots(docs):
        if snap["account"] in allowed and snap.get("raw"):
            views.append({**aws_live.summarize(snap["raw"], days, weight), "account_id": snap["account"]})
    view = merge(views, days)
    return view


def kpis(view, service):
    """Values computable from the estimate plus optional business inputs; others need data."""
    days = view["window"]["days"]
    monthly = view["total_estimated_usd"] * 30 / days
    biz = service.get("business", {})
    values = {
        "api_error_rate": round(view["api_errors_5xx"] / view["api_requests"] * 100, 4) if view["api_requests"] else None,
        "cost_per_order": round(monthly / biz["monthly_orders"], 8) if biz.get("monthly_orders") else None,
        "cloud_cost_ratio": round(monthly / biz["monthly_revenue_usd"] * 100, 8) if biz.get("monthly_revenue_usd") else None,
        "cost_per_active_user": round(monthly / biz["monthly_active_users"], 8) if biz.get("monthly_active_users") else None,
    }
    return [{"id": k["id"], "target": k.get("target"), "value": values.get(k["id"])} for k in service.get("kpis", [])], round(monthly, 8)


# --- services ----------------------------------------------------------------------------------------------

def validate_services(items, known_accounts):
    if not isinstance(items, list) or len(items) > 20:
        raise HTTPException(422, "Up to 20 services")
    out, ids = [], set()
    for s in items:
        name = str(s.get("name", "")).strip()
        if not 1 <= len(name) <= 60:
            raise HTTPException(422, "Service name must be 1-60 characters")
        sid = str(s.get("id") or re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or secrets.token_hex(4))[:40]
        if sid in ids:
            raise HTTPException(422, "Service ids must be unique")
        ids.add(sid)
        accounts_ = [a for a in parse_accounts(s.get("accounts", [])) if a in known_accounts]
        rules = []
        for r in s.get("rules", [])[:20]:
            share = int(r.get("share_pct", 100))
            if not 1 <= share <= 100:
                raise HTTPException(422, "share_pct must be 1-100")
            if r.get("type") == "tag" and 1 <= len(str(r.get("key", ""))) <= 128 and len(str(r.get("value", ""))) <= 256:
                rules.append({"type": "tag", "key": str(r["key"]), "value": str(r.get("value", "")), "share_pct": share})
            elif r.get("type") == "name" and 1 <= len(str(r.get("contains", ""))) <= 64:
                rules.append({"type": "name", "contains": str(r["contains"]), "share_pct": share})
            else:
                raise HTTPException(422, "Rules are tag key=value or name contains")
        if not rules:
            raise HTTPException(422, "Each service needs at least one rule")
        kpi_rows = []
        for k in s.get("kpis", [])[:10]:
            if k.get("id") not in KPI_IDS:
                raise HTTPException(422, "Unknown KPI")
            target = k.get("target")
            kpi_rows.append({"id": k["id"], "target": float(target) if target not in (None, "") else None})
        business = {}
        for key in ("monthly_revenue_usd", "monthly_orders", "monthly_active_users"):
            value = (s.get("business") or {}).get(key)
            if value not in (None, ""):
                value = float(value)
                if value < 0:
                    raise HTTPException(422, "Business inputs must be non-negative")
                business[key] = value
        out.append({"id": sid, "name": name, "accounts": accounts_, "rules": rules, "kpis": kpi_rows, "business": business})
    return out


def services(docs):
    return (docs.get("SERVICES") or {}).get("services", [])


# --- scheduled daily check -----------------------------------------------------------------------------------

def daily_check(registry_pks, docs_for, session_for):
    checked = 0
    for pk in registry_pks:
        docs = docs_for(pk)
        if accounts(docs):
            sync(docs, session_for)
            checked += 1
    return {"status": "checked", "workspaces": checked, "at": now_iso()}
