import json
from datetime import datetime, timedelta, timezone
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from botocore.exceptions import ClientError
import aws_live
import main

NOW = datetime(2026, 10, 1, 12, tzinfo=timezone.utc)
PRICES = {"lambda_request": 2e-07, "lambda_gb_second": 1.66667e-05, "lambda_gb_second_arm": 1.33334e-05,
          "http_api_request": 1e-06, "rest_api_request": 3.5e-06, "ddb_read_request_unit": 1.25e-07,
          "ddb_write_request_unit": 6.25e-07, "ddb_storage_gb_month": 0.25}


def product(usage, *dims):
    return json.dumps({"product": {"attributes": {"usagetype": usage}}, "terms": {"OnDemand": {"t": {"priceDimensions": {
        str(i): {"pricePerUnit": {"USD": str(price)}, "beginRange": str(begin)} for i, (begin, price) in enumerate(dims)}}}}})


class Paginator:
    def __init__(self, pages): self.pages = pages
    def paginate(self, **kwargs): return self.pages(kwargs) if callable(self.pages) else self.pages


class FakePricing:
    CATALOG = {("AWSLambda", "AWS-Lambda-Requests"): [product("Lambda-Edge-Request", (0, 6e-07)), product("Request", (0, 2e-07))],
               ("AWSLambda", "AWS-Lambda-Duration"): [product("Lambda-GB-Second", (6e9, 1.5e-05), (0, 1.66667e-05))],
               ("AWSLambda", "AWS-Lambda-Duration-ARM"): [product("Lambda-GB-Second-ARM", (0, 1.33334e-05))],
               ("AmazonApiGateway", "API Calls"): [product("USE1-ApiGatewayHttpRequest", (0, 1e-06)), product("USE1-ApiGatewayRequest", (0, 3.5e-06))],
               ("AmazonDynamoDB", "DDB-ReadUnits"): [product("ReplReadRequestUnits", (0, 9)), product("ReadRequestUnits", (0, 1.25e-07))],
               ("AmazonDynamoDB", "DDB-WriteUnits"): [product("WriteRequestUnits", (0, 6.25e-07))],
               ("AmazonDynamoDB", "Database Storage"): [product("TimedStorage-ByteHrs", (0, 0), (25, 0.25))]}
    def get_paginator(self, name):
        def pages(kwargs):
            value = [f["Value"] for f in kwargs["Filters"] if f["Field"] != "regionCode"][0]
            return [{"PriceList": self.CATALOG.get((kwargs["ServiceCode"], value), [])}]
        return Paginator(pages)


@pytest.fixture(autouse=True)
def fresh_price_cache():
    aws_live._price_cache.clear()


class EmptyRegion:
    """Second enabled Region: no supported resources, a few other service metrics."""
    def __init__(self, fail=False): self.fail = fail
    def client(self, name):
        if self.fail:
            def boom(*a, **k): raise ClientError({"Error": {"Code": "UnrecognizedClientException", "Message": "opt-in"}}, name)
            return type("X", (), {"get_paginator": lambda s, n: type("P", (), {"paginate": lambda s, **k: boom()})(), "get_apis": boom, "get_rest_apis": boom})()
        empty = Paginator([{"Functions": [], "TableNames": [], "MetricDataResults": [], "ResourceTagMappingList": [],
                            "Metrics": [{"Namespace": "AWS/EC2"}, {"Namespace": "AWS/EC2"}, {"Namespace": "AWS/Usage"}]}])
        return type("E", (), {"get_paginator": lambda s, n: empty, "get_apis": lambda s, **k: {"Items": []},
                              "get_rest_apis": lambda s, **k: {"items": []}})()


class FakeSession:
    def __init__(self, days, regions=("us-east-1", "ap-northeast-2"), failing=(), describe_denied=False):
        self.days, self.regions, self.failing, self.describe_denied = days, regions, failing, describe_denied
    def client(self, name, region_name=None):
        if name == "ec2":
            return self._ec2()
        if region_name not in (None, "us-east-1") and name not in ("sts", "pricing"):
            return EmptyRegion(region_name in self.failing).client(name)
        return getattr(self, "_" + name.replace("-", ""))()
    def _ec2(self):
        def describe_regions():
            if self.describe_denied:
                raise ClientError({"Error": {"Code": "UnauthorizedOperation", "Message": "no"}}, "DescribeRegions")
            return {"Regions": [{"RegionName": r} for r in self.regions]}
        return type("EC2", (), {"describe_regions": lambda s: describe_regions()})()
    def _lambda(self):
        page = {"Functions": [{"FunctionName": "outcomelens-dev-api", "FunctionArn": "arn:aws:lambda:us-east-1:123456789012:function:outcomelens-dev-api", "MemorySize": 1024, "Architectures": ["x86_64"]},
                              {"FunctionName": "billing-worker", "MemorySize": 512, "Architectures": ["arm64"]}]}
        return type("L", (), {"get_paginator": lambda s, n: Paginator([page])})()
    def _apigatewayv2(self):
        return type("A", (), {"get_apis": lambda s, **k: {"Items": [{"ApiId": "h1", "Name": "outcomelens-dev", "ProtocolType": "HTTP"},
                                                                     {"ApiId": "w1", "Name": "chat", "ProtocolType": "WEBSOCKET"}]}})()
    def _apigateway(self):
        return type("R", (), {"get_rest_apis": lambda s, **k: {"items": [{"id": "r1", "name": "legacy"}]}})()
    def _dynamodb(self):
        tables = {"orders": {"TableSizeBytes": 2 * 1024 ** 3, "BillingModeSummary": {"BillingMode": "PAY_PER_REQUEST"}},
                  "fixed": {"TableSizeBytes": 0}}
        return type("D", (), {"get_paginator": lambda s, n: Paginator([{"TableNames": list(tables)}]),
                              "describe_table": lambda s, TableName: {"Table": tables[TableName]}})()
    def _cloudwatch(self):
        days = self.days
        def pages(kwargs):
            start = kwargs["StartTime"]
            stamps = [start + timedelta(days=d) for d in range(days)]
            values = {"fi0": 1000, "fd0": 2000, "fi1": 10, "fd1": 100, "ha0": 1000, "he0": 10, "ra0": 100, "re0": 0, "tr0": 4000, "tw0": 800, "tr1": 5, "tw1": 5}
            return [{"MetricDataResults": [{"Id": q["Id"], "Timestamps": stamps, "Values": [values[q["Id"]]] * days}
                                           for q in kwargs["MetricDataQueries"]]}]
        listed = Paginator([{"Metrics": [{"Namespace": "AWS/Lambda"}, {"Namespace": "AWS/DynamoDB"}, {"Namespace": "AWS/Billing"}]}])
        return type("C", (), {"get_paginator": lambda s, n: listed if n == "list_metrics" else Paginator(pages)})()
    def _resourcegroupstaggingapi(self):
        page = {"ResourceTagMappingList": [{"ResourceARN": "arn:aws:lambda:us-east-1:123456789012:function:outcomelens-dev-api",
                                            "Tags": [{"Key": "service", "Value": "x-mart"}, {"Key": "outcome", "Value": "child-santa-cloth"}, {"Key": "owner", "Value": "team-a"}]}]}
        return type("T", (), {"get_paginator": lambda s, n: Paginator([page])})()
    def _sts(self):
        return type("S", (), {"get_caller_identity": lambda s: {"Account": "123456789012"}})()


def test_price_list_selection_skips_edge_replica_and_free_tier():
    assert aws_live.unit_prices("us-east-1", FakePricing()) == PRICES


def test_collect_prices_usage_and_masks_public_names():
    raw = aws_live.collect(FakeSession(7), "us-east-1", 7, pricing=FakePricing(), now=NOW, mask=True)
    view = aws_live.summarize(raw, 7)
    assert view["account"] == "1234••••9012"
    assert view["window"] == {"start": "2026-09-25", "end_exclusive": "2026-10-02", "days": 7}
    names = {r["name"] for r in view["resources"]}
    assert "outcomelens-dev-api" in names and "billing-worker" not in names
    api = next(r for r in view["resources"] if r["name"] == "outcomelens-dev-api")
    # 7 days x (1000 requests x $0.20/M + 2 s x 1 GB x $0.0000166667)
    assert api["estimated_usd"] == pytest.approx(7 * (1000 * 2e-07 + 2 * 1.66667e-05), abs=1e-8)
    orders = next(r for r in view["resources"] if r["service"] == "Amazon DynamoDB" and r["estimated_usd"])
    assert orders["estimated_usd"] == pytest.approx(7 * (4000 * 1.25e-07 + 800 * 6.25e-07 + 2 * 0.25 / 30), abs=1e-8)
    assert view["unpriced_resources"] == 1  # provisioned table is not priced per consumed unit
    assert not any("(WEBSOCKET)" in n or n.startswith("chat") for n in names)
    assert view["pricing"]["free_tier_applied"] is False


def test_summarize_slices_trailing_window():
    raw = aws_live.collect(FakeSession(30), "us-east-1", 30, pricing=FakePricing(), now=NOW)
    seven, thirty = aws_live.summarize(raw, 7), aws_live.summarize(raw, 30)
    assert len(seven["daily"]) == 7 and seven["daily"][-1]["date"] == "2026-10-01"
    assert thirty["total_estimated_usd"] == pytest.approx(seven["total_estimated_usd"] * 30 / 7, abs=1e-7)


def test_missing_list_price_is_reported_not_guessed():
    raw = aws_live.collect(FakeSession(7), "us-east-1", 7, pricing=FakePricing(), now=NOW)
    raw["prices"]["us-east-1"] = {**raw["prices"]["us-east-1"], "rest_api_request": None}
    rest = next(r for r in aws_live.summarize(raw, 7)["resources"] if r["name"].endswith("(REST)"))
    assert rest["estimated_usd"] is None


@pytest.mark.parametrize("arn", ["arn:aws:iam::123456789012:role/Admin", "arn:aws:iam::12345:role/cloud_outcome_readonlyaccess",
                                 "arn:aws-cn:iam::123456789012:role/cloud_outcome_readonlyaccess", "arn:aws:iam::123456789012:role/cloud_outcome_readonlyaccess-x",
                                 "arn:aws:iam::123456789012:role/OutcomeLensReadOnly-legacy"])
def test_only_dedicated_readonly_role_names_are_accepted(arn):
    with pytest.raises(HTTPException) as error:
        aws_live.validate_role_arn(arn)
    assert error.value.status_code == 422


@pytest.mark.parametrize("bad", [0, 365, 8])
def test_unsupported_window_is_rejected(bad):
    with pytest.raises(HTTPException):
        aws_live.collect(FakeSession(7), "us-east-1", bad, pricing=FakePricing(), now=NOW)


def test_assume_role_failure_does_not_echo_sdk_message():
    class STS:
        def assume_role(self, **kwargs):
            raise ClientError({"Error": {"Code": "AccessDenied", "Message": "arn:aws:iam::999999999999:user/secret"}}, "AssumeRole")
    with pytest.raises(HTTPException) as error:
        aws_live.assume("arn:aws:iam::123456789012:role/cloud_outcome_readonlyaccess", "ext", sts=STS())
    assert error.value.status_code == 403 and "999999999999" not in error.value.detail


def test_refresh_skips_without_configuration_and_stores_masked_snapshot(monkeypatch):
    saved = []
    store = type("S", (), {"save_snapshot": lambda s, raw, summaries=None: saved.append(raw)})()
    assert aws_live.refresh_public_demo(store, {})["status"] == "skipped"
    monkeypatch.setattr(aws_live, "collect", lambda session, region, days, mask: {"resources": [], "collected_at": "t", "mask": mask})
    monkeypatch.setattr(aws_live, "summarize", lambda raw, days: {"days": days})
    env = {"LIVE_DEMO_ROLE_ARN": "arn:aws:iam::123456789012:role/cloud_outcome_readonlyaccess", "LIVE_DEMO_EXTERNAL_ID": "fixed"}
    calls = []
    assert aws_live.refresh_public_demo(store, env, session_factory=lambda arn, ext: calls.append((arn, ext)))["status"] == "refreshed"
    assert calls == [(env["LIVE_DEMO_ROLE_ARN"], "fixed")] and saved[0]["mask"] is True


# --- HTTP boundary -----------------------------------------------------------------------------------------

CLAIMS = {"sub": "synthetic-user-a", "token_use": "access", "scope": "outcomelens/api", "cognito:groups": ["operators"]}


@pytest.fixture
def cloud(monkeypatch):
    monkeypatch.setattr(main, "CLOUD", True)
    monkeypatch.setenv("API_ID", "test-api")
    monkeypatch.setenv("ALLOWED_ORIGINS", "https://demo.example")
    monkeypatch.setenv("RUNTIME_ROLE_ARN", "arn:aws:iam::111111111111:role/outcomelens-dev-runtime-api")
    state = {"snapshot": None, "connections": {}}
    class MemoryStore:
        def __init__(self, tenant): self.tenant = tenant
        @classmethod
        def public_demo(cls): return cls("PUBLIC")
        def consume(self, limit): pass
        def snapshot(self): return state["snapshot"]
        def summary(self, days): return state.get("summaries", {}).get(str(days))
        def connection(self):
            return state["connections"].setdefault(self.tenant, {"external_id": "server-generated", "role_arn": None, "region": None})
        def save_connection(self, role_arn, region):
            doc = {**self.connection(), "role_arn": role_arn, "region": region, "verified_at": "now"}
            state["connections"][self.tenant] = doc
            return doc
    monkeypatch.setattr(main, "Store", MemoryStore)
    def client(claims=None, api_id="test-api"):
        async def wrapped(scope, receive, send):
            scope["aws.event"] = {"requestContext": {"apiId": api_id, "authorizer": {"jwt": {"claims": claims or {}}}}}
            await main.app(scope, receive, send)
        return TestClient(wrapped)
    client.state = state
    return client


def test_public_live_demo_needs_no_identity_and_is_read_only(cloud):
    cloud.state["snapshot"] = aws_live.collect(FakeSession(30), "us-east-1", 30, pricing=FakePricing(), now=NOW, mask=True)
    response = cloud().get("/api/public/live-demo?days=14")
    assert response.status_code == 200 and response.json()["mode"] == "public-live-demo"
    assert response.json()["window"]["days"] == 14
    assert cloud().post("/api/public/live-demo", json={}).status_code == 405


def test_public_live_demo_requires_trusted_gateway_and_snapshot(cloud):
    assert cloud(api_id="other").get("/api/public/live-demo").status_code == 403
    pending = cloud().get("/api/public/live-demo")
    assert pending.status_code == 200 and pending.json()["status"] == "collecting"  # never a 5xx before the first snapshot












# --- Local development profile mode -------------------------------------------------------------------------

@pytest.fixture
def local(monkeypatch, tmp_path):
    monkeypatch.setattr(main, "CLOUD", False)
    monkeypatch.setattr(main, "PUBLIC", False)
    monkeypatch.setattr(main, "DB", str(tmp_path / "local.sqlite"))
    main._local_cache.clear()
    return TestClient(main.app)


@pytest.fixture
def profile(monkeypatch):
    sessions = []
    class Session(FakeSession):
        def __init__(self, profile_name=None, region_name=None):
            super().__init__(30); sessions.append((profile_name, region_name))
        def _pricing(self): return FakePricing()
    import boto3
    monkeypatch.setattr(boto3, "Session", Session)
    monkeypatch.setattr(main, "LOCAL_AWS_PROFILE", "developer-profile")
    monkeypatch.setattr(main, "LOCAL_AWS_REGION", "us-east-1")
    return sessions




def test_collect_scans_enabled_regions_and_discovers_services():
    raw = aws_live.collect(FakeSession(7), "us-east-1", 7, pricing=FakePricing(), now=NOW)
    view = aws_live.summarize(raw, 7)
    assert view["regions_scanned"] == ["ap-northeast-2", "us-east-1"] and view["regions_failed"] == []
    in_use = {e["service"]: e["regions"] for e in view["services_in_use"]}
    assert in_use["Amazon EC2"] == {"ap-northeast-2": 2} and in_use["AWS Lambda"] == {"us-east-1": 1}
    assert "AWS/Usage" not in str(in_use) and "AWS/Billing" not in str(in_use)
    assert view["pricing"]["regions_priced"] == ["us-east-1"]  # prices only where priced resources exist
    assert all(r["region"] == "us-east-1" for r in view["resources"])


def test_failed_region_is_reported_without_failing_the_view():
    raw = aws_live.collect(FakeSession(7, failing=("ap-northeast-2",)), "us-east-1", 7, pricing=FakePricing(), now=NOW)
    view = aws_live.summarize(raw, 7)
    assert view["regions_failed"] == ["ap-northeast-2"] and view["total_estimated_usd"] > 0


def test_roles_without_describe_regions_fall_back_to_home_region():
    raw = aws_live.collect(FakeSession(7, describe_denied=True), "us-east-1", 7, pricing=FakePricing(), now=NOW)
    assert raw["regions_scanned"] == ["us-east-1"] and raw["discovery"] is False


def test_schema_one_snapshot_still_summarizes():
    raw = aws_live.collect(FakeSession(7, regions=("us-east-1",)), "us-east-1", 7, pricing=FakePricing(), now=NOW)
    legacy = {"schema": 1, "account": raw["account"], "region": "us-east-1", "dates": raw["dates"], "collected_at": raw["collected_at"],
              "prices": raw["prices"]["us-east-1"], "resources": [{k: v for k, v in r.items() if k != "region"} for r in raw["resources"]], "truncated": False}
    assert aws_live.summarize(legacy, 7)["total_estimated_usd"] == aws_live.summarize(raw, 7)["total_estimated_usd"]





def test_outcome_tag_groups_cost_requests_and_checkout_time():
    view = aws_live.summarize(aws_live.collect(FakeSession(7), "us-east-1", 7, pricing=FakePricing(), now=NOW), 7)
    shop = view["outcomes"]["child-santa-cloth"]
    assert shop["resources"] == 1 and shop["lambda_invocations"] == 7 * 1000
    assert shop["avg_checkout_ms"] == 2.0 and shop["estimated_usd"] > 0  # 2000 ms total over 1000 invocations per day


def test_public_snapshots_keep_only_outcome_tags_and_demo_names():
    raw = aws_live.collect(FakeSession(7), "us-east-1", 7, pricing=FakePricing(), now=NOW, mask=True)
    api = next(r for r in raw["resources"] if r["name"] == "outcomelens-dev-api")
    assert api["tags"] == {"outcome": "child-santa-cloth"}  # owner/service tags are dropped
    assert aws_live.mask_name("santa-adult-santa-cloth-checkout") == "santa-adult-santa-cloth-checkout"
    assert aws_live.mask_name("payroll-batch").startswith("pay…")


def test_outcome_daily_series_follow_the_window():
    view = aws_live.summarize(aws_live.collect(FakeSession(7), "us-east-1", 7, pricing=FakePricing(), now=NOW), 7)
    for shop in view["outcomes"].values():
        assert len(shop["daily_requests"]) == 7 and len(shop["daily_orders"]) == 7


def test_public_live_demo_serves_precomputed_summary_without_summarizing(cloud, monkeypatch):
    cloud.state["summaries"] = {"7": {"total_estimated_usd": 1.23, "window": {"days": 7}}}
    monkeypatch.setattr(aws_live, "summarize", lambda *a, **k: (_ for _ in ()).throw(AssertionError("must not summarize")))
    body = cloud().get("/api/public/live-demo?days=7").json()
    assert body["total_estimated_usd"] == 1.23 and body["mode"] == "public-live-demo"
