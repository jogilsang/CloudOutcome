from decimal import Decimal as D
import pytest
from fastapi.testclient import TestClient
import main
from domain import Observation, calculate, percentile, dashboard


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "DB", str(tmp_path / "test.sqlite"))
    monkeypatch.setattr(main, "PUBLIC", False)
    monkeypatch.delenv("BEDROCK_MODEL_ID", raising=False)
    return TestClient(main.app)


def event(key="one", **kwargs):
    return Observation(event_id=key, attempt_id=f"attempt-{key}", order_id=f"order-{key}",
                       timestamp="2026-09-30T12:00:00Z",
                       service="checkout", success=kwargs.get("success", True),
                       latency_ms=kwargs.get("latency_ms", 100))


def test_allocated_cost_and_completed_orders():
    result = calculate([event(), event("two"), event("three", success=False)], D(10), D(20), D(25))
    assert result["allocated_cost"] == 15
    assert result["cost_per_order"] == 7.5
    assert result["unallocated_shared"] == 15
    assert result["success_rate"] == pytest.approx(200/3)


def test_duplicate_retry_does_not_inflate_business_outcomes():
    result = calculate([event(), event()], D(10), D(0), D(0))
    assert result["completed"] == 1
    assert result["duplicate_count"] == 1
    assert result["cost_per_order"] == 10


def test_multiple_attempts_for_one_order_do_not_inflate_orders():
    first = event()
    second = event("two").model_copy(update={"order_id": first.order_id})
    r = calculate([first, second], D(10), D(0), D(0))
    assert r["attempts"] == 2
    assert r["successful_attempts"] == 2
    assert r["completed"] == 1
    assert r["cost_per_order"] == 10


def test_duplicate_delivery_with_new_event_id_does_not_inflate_attempts():
    first = event()
    redelivery = first.model_copy(update={"event_id": "another-delivery"})
    r = calculate([first, redelivery], D(10), D(0), D(0))
    assert r["attempts"] == 1
    assert r["duplicate_count"] == 1


def test_conflicting_terminal_attempt_rejected():
    first = event()
    other = first.model_copy(update={"event_id": "another", "success": False})
    with pytest.raises(ValueError, match="terminal attempt"):
        calculate([first, other], D(10), D(0), D(0))


def test_empty_denominator_is_unavailable():
    result = calculate([], D(10), D(0), D(0))
    assert result["cost_per_order"] is None
    assert result["success_rate"] is None
    assert result["latency_p95"] is None
    assert result["allocated_cost"] == 10


def test_conflicting_duplicate_rejected():
    with pytest.raises(ValueError, match="conflicting"):
        calculate([event(), event(success=False)], D(1), D(0), D(0))


def test_percentile_uses_raw_nearest_rank():
    assert percentile(list(range(1, 101))) == 95


def test_catalog_cannot_invent_order_cost():
    assert dashboard(service="catalog")["summary"]["cost_per_order"] is None


def test_incident_changes_quality_and_unit_cost():
    base, incident = dashboard()["summary"], dashboard(scenario="incident")["summary"]
    assert incident["success_rate"] < base["success_rate"]
    assert incident["cost_per_order"] > base["cost_per_order"]
    assert incident["latency_p95"] > base["latency_p95"]


@pytest.mark.parametrize("days", [7, 14, 30])
def test_api_accepts_explicit_query_used_by_frontend(client, days):
    response = client.get(f"/api/dashboard?service=checkout&days={days}&scenario=baseline&allocation=40")
    assert response.status_code == 200
    assert response.json()["window"]["days"] == days


def test_api_rejects_unbounded_scope(client):
    assert client.get("/api/dashboard?days=365").status_code == 422
    assert client.get("/api/dashboard?days=8").status_code == 422
    assert client.get("/api/dashboard?allocation=101").status_code == 422
    assert client.get("/api/dashboard?service=anything").status_code == 422


def definition(**kwargs):
    return {"name": "Order cost", "kind": "cost_per_order", "service": "checkout",
            "target": .25, "shared_allocation_pct": 40, "owner": "Commerce",
            "expected_version": 0, **kwargs}


def test_save_reload_and_audit(client):
    assert client.put("/api/definitions/order_cost", json=definition()).json()["version"] == 1
    assert client.get("/api/definitions").json()[0]["owner"] == "Commerce"
    assert client.get("/api/audit").json()[0]["action"] == "definition.saved"


def test_concurrent_definition_update_returns_conflict(client):
    client.put("/api/definitions/order_cost", json=definition())
    assert client.put("/api/definitions/order_cost", json=definition()).status_code == 409
    assert client.put("/api/definitions/order_cost", json=definition(expected_version=1)).json()["version"] == 2


def test_public_demo_refuses_persistent_writes(client, monkeypatch):
    monkeypatch.setattr(main, "PUBLIC", True)
    assert client.put("/api/definitions/order_cost", json=definition()).status_code == 403
    assert client.get("/api/definitions").json() == []


def test_cross_origin_writes_rejected(client):
    assert client.put("/api/definitions/order_cost", json=definition(),
                      headers={"Origin": "https://untrusted.example"}).status_code == 403


def test_missing_revenue_is_not_hallucinated(client):
    result = client.post("/api/propose", json={"text": "매출 대비 비용", "service": "checkout"}).json()
    assert result["status"] == "missing_source" and result["kind"] is None
    assert result["engine"] == "rules"


def test_supported_bilingual_proposal(client):
    for text in ["주문당 비용", "cost per order"]:
        r = client.post("/api/propose", json={"text": text}).json()
        assert r["kind"] == "cost_per_order" and r["status"] == "ready"


def test_no_arbitrary_expression_execution(client):
    r = client.post("/api/propose", json={"text": "__import__('os').system('id')"}).json()
    assert r["status"] == "unsupported"


def test_invalid_event_and_oversize_payload(client):
    doc = {"events": [event().model_dump(mode="json")], "direct_cost": 1, "shared_cost": 0, "allocation_pct": 0}
    doc["events"][0]["timestamp"] = "2026-09-30T12:00:00"
    assert client.post("/api/preview", json=doc).status_code == 422
    assert client.post("/api/preview", json={}, headers={"Content-Length": "1000001"}).status_code == 413


def test_request_id_on_read(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.headers["x-request-id"]
    assert r.json()["aws_connected"] is False


def test_import_preview_requires_matching_window(client):
    doc = {"events": [event().model_dump(mode="json")], "direct_cost": 5,
           "shared_cost": 10, "allocation_pct": 20, "currency": "USD",
           "cost_basis": "unblended", "window_start": "2026-09-30T00:00:00Z",
           "window_end": "2026-10-01T00:00:00Z"}
    response = client.post("/api/preview", json=doc)
    assert response.status_code == 200
    assert response.json()["summary"]["cost_per_order"] == 7
    doc["window_end"] = "2026-09-30T12:00:00Z"
    assert client.post("/api/preview", json=doc).status_code == 422


def test_import_rejects_mixed_service_and_currency(client):
    doc = {"events": [event().model_dump(mode="json")], "direct_cost": 5,
           "shared_cost": 0, "allocation_pct": 0, "currency": "USD",
           "cost_basis": "unblended", "window_start": "2026-09-30T00:00:00Z",
           "window_end": "2026-10-01T00:00:00Z"}
    second = {**doc["events"][0], "service": "catalog", "event_id": "catalog"}
    doc["events"].append(second)
    assert client.post("/api/preview", json=doc).status_code == 422
    doc["events"].pop()
    doc["currency"] = "KRW"
    assert client.post("/api/preview", json=doc).status_code == 422


def test_local_workspace_rejects_untrusted_host(client):
    assert client.get("/api/health", headers={"Host": "untrusted.example"}).status_code == 400


def test_configured_model_response_is_validated_before_saving(client, monkeypatch):
    from unittest.mock import Mock
    fake = Mock()
    fake.converse.return_value = {"stopReason": "end_turn",
        "output": {"message": {"content": [{"text": '{"kind":"latency_p95"}'}]}}}
    monkeypatch.setenv("BEDROCK_MODEL_ID", "test-model")
    monkeypatch.setattr(main, "bedrock_client", lambda: fake)
    response = client.post("/api/propose", json={"text": "How slow is checkout?"})
    assert response.json()["engine"] == "bedrock"
    assert response.json()["kind"] == "latency_p95"
    assert client.get("/api/definitions").json() == []


def test_model_outage_returns_sanitized_error(client, monkeypatch):
    from unittest.mock import Mock
    fake = Mock()
    fake.converse.side_effect = TimeoutError("internal provider detail")
    monkeypatch.setenv("BEDROCK_MODEL_ID", "test-model")
    monkeypatch.setattr(main, "bedrock_client", lambda: fake)
    response = client.post("/api/propose", json={"text": "Evaluate latency"})
    assert response.status_code == 502
    assert "internal provider detail" not in response.text
