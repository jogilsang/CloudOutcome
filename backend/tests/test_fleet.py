import time
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
import aws_live
import fleet
import main
from tests.test_aws_live import FakePricing, FakeSession, NOW

A, B, C = "111111111111", "222222222222", "333333333333"


class MemoryDocs:
    def __init__(self, pk="WORKSPACE#t", store=None, expires_at=None):
        self.pk, self.expires_at = pk, expires_at
        self.store = store if store is not None else {}
    def get(self, sk): return self.store.get((self.pk, sk))
    def put(self, sk, doc): self.store[(self.pk, sk)] = doc; return doc
    def put_new(self, sk, doc):
        if (self.pk, sk) in self.store: return None
        return self.put(sk, doc)
    def query(self, prefix): return [v for (pk, sk), v in sorted(self.store.items()) if pk == self.pk and sk.startswith(prefix)]


class AccountSession(FakeSession):
    def __init__(self, account): super().__init__(30, regions=("us-east-1",)); self.account = account
    def _sts(self): return type("S", (), {"get_caller_identity": lambda s: {"Account": self.account}})()


def sessions(good=(A, B), mismatch=()):
    calls = []
    def session_for(account, external_id):
        calls.append((account, external_id))
        if account in mismatch: return AccountSession("999999999999")
        if account not in good: raise HTTPException(403, "denied")
        return AccountSession(account)
    session_for.calls = calls
    return session_for


def collected(docs, accounts_, session_for):
    collect = lambda s, region, days: aws_live.collect(s, region, days, pricing=FakePricing(), now=NOW)
    return fleet.collect_chunk(docs, accounts_, session_for, collect=collect)


def test_account_lists_accept_any_common_delimiter_and_dedupe():
    assert fleet.parse_accounts(f"{B}, {A}\n{A};{C}\t") == [A, B, C]
    assert fleet.parse_accounts([A, B]) == [A, B]


@pytest.mark.parametrize("bad", ["12345", "abc", "1234567890123"])
def test_non_account_entries_are_rejected(bad):
    with pytest.raises(HTTPException):
        fleet.parse_accounts(f"{A},{bad}")


def test_more_than_one_hundred_accounts_is_rejected():
    with pytest.raises(HTTPException):
        fleet.parse_accounts([str(100000000000 + i) for i in range(101)])


def test_sync_marks_statuses_and_uses_the_workspace_external_id():
    docs = MemoryDocs(); fleet.save_accounts(docs, [A, B, C])
    session_for = sessions(good=(A,), mismatch=(B,))
    rows = {r["id"]: r for r in fleet.sync(docs, session_for)}
    assert rows[A]["status"] == "connected" and rows[B]["reason"] == "account-mismatch" and rows[C]["reason"] == "assume-role-denied"
    assert {ext for _, ext in session_for.calls} == {fleet.connection(docs)["external_id"]}


def test_failed_accounts_are_never_collected():
    docs = MemoryDocs(); fleet.save_accounts(docs, [A, C]); fleet.sync(docs, sessions(good=(A,)))
    dispatched = []
    state = fleet.start_collection(docs, lambda pk, chunk: dispatched.append(chunk))
    assert dispatched == [[A]] and state["accounts"] == [A]
    session_for = sessions(good=(A,))
    assert collected(docs, [A, C], session_for) == [A]
    assert all(account == A for account, _ in session_for.calls)  # C was not even attempted


def test_collection_is_chunked_and_progress_counts_fresh_snapshots():
    ids = [str(100000000000 + i) for i in range(23)]
    docs = MemoryDocs(); fleet.save_accounts(docs, ids); fleet.sync(docs, sessions(good=ids))
    chunks = []
    fleet.start_collection(docs, lambda pk, chunk: chunks.append(chunk))
    assert [len(c) for c in chunks] == [10, 10, 3]
    assert fleet.progress(docs) == {**fleet.progress(docs), "total": 23, "done": 0, "running": True, "failed": []}
    collected(docs, chunks[2], sessions(good=ids))
    assert fleet.progress(docs)["done"] == 3


def test_workspace_view_merges_accounts_and_filters_by_service():
    docs = MemoryDocs(); fleet.save_accounts(docs, [A, B]); fleet.sync(docs, sessions())
    collected(docs, [A, B], sessions())
    both = fleet.workspace_view(docs, 7)
    one = fleet.workspace_view(docs, 7, account=A)
    assert both["total_estimated_usd"] == pytest.approx(2 * one["total_estimated_usd"])
    assert {a["id"] for a in both["accounts"]} == {A, B} and len(both["daily"]) == 7
    service = {"id": "x-mart", "accounts": [A], "rules": [{"type": "tag", "key": "service", "value": "x-mart", "share_pct": 100},
                                                          {"type": "name", "contains": "orders", "share_pct": 50}]}
    view = fleet.workspace_view(docs, 7, service=service)
    names = {r["name"]: r for r in view["resources"]}
    assert set(names) == {"outcomelens-dev-api", "orders"} and names["orders"]["share"] == 0.5
    assert all(r["account"] == A for r in view["resources"])


def test_service_kpis_use_business_inputs_and_api_errors():
    docs = MemoryDocs(); fleet.save_accounts(docs, [A]); fleet.sync(docs, sessions())
    collected(docs, [A], sessions())
    view = fleet.workspace_view(docs, 7)
    service = {"kpis": [{"id": "cost_per_order", "target": 0.25}, {"id": "api_error_rate"}, {"id": "conversion_rate"}],
               "business": {"monthly_orders": 1000}}
    values, monthly = fleet.kpis(view, service)
    by_id = {v["id"]: v for v in values}
    assert by_id["cost_per_order"]["value"] == pytest.approx(monthly / 1000, rel=1e-4)
    assert by_id["api_error_rate"]["value"] == pytest.approx(10 / 1100 * 100, rel=1e-3)  # 7 days x 10 5xx / (1000+100) requests
    assert by_id["conversion_rate"]["value"] is None


def test_service_validation_rejects_bad_rules_and_unknown_kpis():
    ok = fleet.validate_services([{"name": "X Mart", "accounts": [A, C], "rules": [{"type": "tag", "key": "service", "value": "x-mart"}],
                                   "kpis": [{"id": "api_error_rate", "target": "0.1"}], "business": {"monthly_orders": "10"}}], {A})
    assert ok[0]["id"] == "x-mart" and ok[0]["accounts"] == [A] and ok[0]["kpis"][0]["target"] == 0.1
    for bad in [{"name": "", "rules": [{"type": "name", "contains": "a"}]}, {"name": "x", "rules": []},
                {"name": "x", "rules": [{"type": "name", "contains": "a", "share_pct": 0}]},
                {"name": "x", "rules": [{"type": "name", "contains": "a"}], "kpis": [{"id": "made_up"}]}]:
        with pytest.raises(HTTPException):
            fleet.validate_services([bad], {A})


def test_daily_check_visits_every_registered_workspace():
    store = {}
    for pk in ("WORKSPACE#1", "WORKSPACE#2"):
        fleet.save_accounts(MemoryDocs(pk, store), [A])
    result = fleet.daily_check(["WORKSPACE#1", "WORKSPACE#2"], lambda pk: MemoryDocs(pk, store), sessions())
    assert result["workspaces"] == 2 and fleet.accounts(MemoryDocs("WORKSPACE#2", store))[0]["status"] == "connected"


# --- HTTP routes -----------------------------------------------------------------------------------------------

@pytest.fixture
def local_api(monkeypatch, tmp_path):
    monkeypatch.setattr(main, "CLOUD", False)
    monkeypatch.setattr(main, "PUBLIC", False)
    monkeypatch.setattr(main, "DB", str(tmp_path / "w.sqlite"))
    monkeypatch.setattr(main, "session_for", sessions())
    monkeypatch.setattr(main, "LOCAL_AWS_PROFILE", None)
    main._local_account.cache_clear()
    dispatched = []
    monkeypatch.setattr(main, "_dispatch", lambda pk, chunk, expires=None: dispatched.append(chunk))
    client = TestClient(main.app); client.dispatched = dispatched
    return client


ORIGIN = {"origin": "http://127.0.0.1:5173"}


def test_local_workspace_connects_lists_and_collects_only_connected(local_api):
    connection = local_api.get("/api/workspace/connection").json()
    assert connection["role_name"] == "cloud_outcome_readonlyaccess" and len(connection["external_id"]) > 20
    body = local_api.put("/api/workspace/accounts", json={"accounts": f"{A},{C}"}, headers=ORIGIN).json()
    assert {a["id"]: a["status"] for a in body["accounts"]} == {A: "connected", C: "failed"}
    assert local_api.dispatched == [[A]]
    assert local_api.post("/api/workspace/sync", json={}, headers=ORIGIN).status_code == 200
    assert local_api.get("/api/workspace/live?days=7").json()["view"] is None  # nothing collected yet


def test_services_round_trip_and_unknown_service_404(local_api):
    local_api.put("/api/workspace/accounts", json={"accounts": [A]}, headers=ORIGIN)
    saved = local_api.put("/api/workspace/services", headers=ORIGIN, json={"services": [{"name": "X Mart", "rules": [{"type": "name", "contains": "api"}]}]})
    assert saved.status_code == 200 and local_api.get("/api/workspace/services").json()["services"][0]["id"] == "x-mart"
    assert local_api.get("/api/workspace/live?service=nope").status_code == 404


@pytest.fixture
def cloud_anon(monkeypatch):
    store = {}
    monkeypatch.setattr(main, "CLOUD", True)
    monkeypatch.setenv("API_ID", "test-api")
    monkeypatch.setenv("ALLOWED_ORIGINS", "https://demo.example")
    monkeypatch.setenv("RUNTIME_ROLE_ARN", "arn:aws:iam::444444444444:role/outcomelens-dev-runtime-api")
    monkeypatch.setattr(main, "DynamoDocs", lambda pk, expires_at=None: MemoryDocs(pk, store, expires_at))
    monkeypatch.setattr(main, "Store", type("Q", (), {"__init__": lambda s, t, pk=None: None, "consume": lambda s, limit: None}))
    monkeypatch.setattr(main, "session_for", sessions())
    monkeypatch.setattr(main, "_dispatch", lambda pk, chunk, expires=None: None)
    monkeypatch.setattr(main, "_registry", lambda pk, active: None)
    async def wrapped(scope, receive, send):
        scope["aws.event"] = {"requestContext": {"apiId": "test-api", "authorizer": {}}}
        await main.app(scope, receive, send)
    client = TestClient(wrapped); client.store = store
    return client


def test_anonymous_workspace_key_is_required_and_never_stored(cloud_anon):
    assert cloud_anon.get("/api/anon/workspace/connection").status_code == 401
    created = cloud_anon.post("/api/anon/workspace", json={}, headers={"origin": "https://demo.example"}).json()
    assert created["expires_at"] - time.time() == pytest.approx(7 * 86400, abs=60)
    assert all(created["token"] not in pk for pk, _ in cloud_anon.store)
    headers = {main.ANON_HEADER: created["token"], "origin": "https://demo.example"}
    view = cloud_anon.get("/api/anon/workspace/connection", headers=headers).json()
    assert view["mode"] == "temporary" and view["trusted_account_id"] == "444444444444"
    body = cloud_anon.put("/api/anon/workspace/accounts", json={"accounts": A}, headers=headers).json()
    assert body["accounts"][0]["status"] == "connected"


def test_expired_anonymous_workspace_is_rejected(cloud_anon):
    created = cloud_anon.post("/api/anon/workspace", json={}, headers={"origin": "https://demo.example"}).json()
    for key, doc in cloud_anon.store.items():
        doc["expires_at"] = int(time.time()) - 1
    assert cloud_anon.get("/api/anon/workspace/accounts", headers={main.ANON_HEADER: created["token"]}).status_code == 401


def test_workspace_collection_prices_with_our_credentials_not_the_customer_role(monkeypatch):
    marker, seen = object(), {}
    monkeypatch.setattr(main, "pricing_client", lambda: marker)
    monkeypatch.setattr(aws_live, "collect", lambda session, region, days, pricing=None: seen.update(pricing=pricing) or {})
    main.collect_for_workspace(object(), "us-east-1", 30)
    assert seen["pricing"] is marker


def test_merged_outcomes_sum_numbers_and_daily_series_elementwise():
    docs = MemoryDocs(); fleet.save_accounts(docs, [A, B]); fleet.sync(docs, sessions())
    collected(docs, [A, B], sessions())
    one = fleet.workspace_view(docs, 7, account=A)["outcomes"]["child-santa-cloth"]
    both = fleet.workspace_view(docs, 7)["outcomes"]["child-santa-cloth"]
    assert both["lambda_invocations"] == 2 * one["lambda_invocations"]
    assert len(both["daily_requests"]) == 7 and both["daily_requests"] == [2 * x for x in one["daily_requests"]]
