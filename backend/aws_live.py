"""Read-only AWS usage collection with AWS Price List estimates.

Estimates multiply CloudWatch usage by public on-demand list prices. They are not a bill:
Free Tier, credits, discounts, taxes and unsupported services are excluded. Billing APIs are
never called because organization policies commonly block them in member accounts.
"""
import hashlib
import json
import re
import time
from datetime import datetime, timedelta, timezone
from fastapi import HTTPException

ROLE_NAME = "cloud_outcome_readonlyaccess"  # every connected account must create exactly this role
ROLE_ARN = re.compile(r"^arn:aws:iam::(\d{12}):role/" + ROLE_NAME + "$")
REGIONS = ("us-east-1", "us-east-2", "us-west-2", "ap-northeast-1", "ap-northeast-2", "eu-west-1", "eu-central-1")
MAX_RESOURCES = 40  # per service; keeps GetMetricData well under its 500-query limit
MAX_DAYS = 30
SUPPORTED = ("AWS Lambda", "Amazon API Gateway", "Amazon DynamoDB")


def role_arn(account):
    return f"arn:aws:iam::{account}:role/{ROLE_NAME}"


def validate_role_arn(value):
    if not isinstance(value, str) or not ROLE_ARN.match(value):
        raise HTTPException(422, f"Role ARN must be arn:aws:iam::<account>:role/{ROLE_NAME}")
    return value


def mask_account(account):
    return account[:4] + "••••" + account[-4:]


PUBLIC_PREFIXES = ("outcomelens-", "santa-")  # CloudOutcome itself and the fictional santacloth demo workload
PUBLIC_TAG_KEYS = ("outcome",)  # business grouping tags kept in public snapshots; all other tags are dropped


def mask_name(name):
    """Public views keep this project's own resource names and pseudonymize the rest."""
    if name.startswith(PUBLIC_PREFIXES):
        return name
    return name[:3] + "…" + hashlib.sha256(name.encode()).hexdigest()[:6]


def assume(role_arn, external_id, sts=None, boto3_module=None):
    import boto3
    from botocore.exceptions import ClientError
    boto3_module = boto3_module or boto3
    sts = sts or boto3_module.client("sts")
    try:
        credentials = sts.assume_role(RoleArn=role_arn, ExternalId=external_id, DurationSeconds=900,
                                      RoleSessionName="outcomelens-collector")["Credentials"]
    except ClientError:
        # Never echo SDK messages: they can contain principal ARNs from another account.
        raise HTTPException(403, "Role could not be assumed. Check the trust policy, External ID and role name.") from None
    return boto3_module.Session(aws_access_key_id=credentials["AccessKeyId"],
                                aws_secret_access_key=credentials["SecretAccessKey"],
                                aws_session_token=credentials["SessionToken"])


def _first_tier(product, paid=False):
    dimensions = [d for term in product["terms"].get("OnDemand", {}).values() for d in term["priceDimensions"].values()]
    if paid:
        dimensions = [d for d in dimensions if float(d["pricePerUnit"]["USD"]) > 0] or dimensions
    dimensions.sort(key=lambda d: float(d.get("beginRange", "0")))
    return float(dimensions[0]["pricePerUnit"]["USD"]) if dimensions else None


def unit_prices(region, pricing):
    """Public on-demand list prices (USD) from the AWS Price List API for one Region."""
    def products(service, *filters):
        query = [{"Type": "TERM_MATCH", "Field": "regionCode", "Value": region}] + [
            {"Type": "TERM_MATCH", "Field": f, "Value": v} for f, v in filters]
        found = []
        for page in pricing.get_paginator("get_products").paginate(ServiceCode=service, Filters=query):
            found += [json.loads(item) for item in page["PriceList"]]
        return found

    def pick(items, suffix, exclude=(), paid=False):
        for product in items:
            usage = product["product"]["attributes"].get("usagetype", "")
            if usage.endswith(suffix) and not any(x in usage for x in exclude):
                return _first_tier(product, paid)
        return None

    lambda_requests = products("AWSLambda", ("group", "AWS-Lambda-Requests"))
    lambda_x86 = products("AWSLambda", ("group", "AWS-Lambda-Duration"))
    lambda_arm = products("AWSLambda", ("group", "AWS-Lambda-Duration-ARM"))
    api_calls = products("AmazonApiGateway", ("productFamily", "API Calls"))
    ddb_read = products("AmazonDynamoDB", ("group", "DDB-ReadUnits"))
    ddb_write = products("AmazonDynamoDB", ("group", "DDB-WriteUnits"))
    ddb_storage = products("AmazonDynamoDB", ("productFamily", "Database Storage"))
    return {
        "lambda_request": pick(lambda_requests, "Request", ("Edge",)),
        "lambda_gb_second": pick(lambda_x86, "Lambda-GB-Second", ("ARM", "Edge", "Provisioned")),
        "lambda_gb_second_arm": pick(lambda_arm, "Lambda-GB-Second-ARM", ("Provisioned",)),
        "http_api_request": pick(api_calls, "ApiGatewayHttpRequest"),
        "rest_api_request": pick(api_calls, "ApiGatewayRequest", ("Cache", "Private")),
        "ddb_read_request_unit": pick(ddb_read, "ReadRequestUnits", ("Repl", "IA-")),
        "ddb_write_request_unit": pick(ddb_write, "WriteRequestUnits", ("Repl", "IA-")),
        # Price List encodes the Free Tier as a $0 first tier; estimates deliberately exclude Free Tier.
        "ddb_storage_gb_month": pick(ddb_storage, "TimedStorage-ByteHrs", ("IA-",), paid=True),
    }


def _window(days, now=None):
    if days not in (7, 14, 30):
        raise HTTPException(422, "Window must be 7, 14 or 30 days")
    # The trailing window includes today as a partial day so recent activity is visible.
    end = (now or datetime.now(timezone.utc)).replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=1)
    return end - timedelta(days=days), end


def inventory(session, region):
    lam = session.client("lambda", region_name=region)
    functions = []
    for page in lam.get_paginator("list_functions").paginate():
        functions += [{"name": f["FunctionName"], "arn": f.get("FunctionArn", ""), "memory_mb": f.get("MemorySize", 128),
                       "arm": "arm64" in f.get("Architectures", [])} for f in page["Functions"]]
    http = session.client("apigatewayv2", region_name=region).get_apis(MaxResults="100").get("Items", [])
    rest = session.client("apigateway", region_name=region).get_rest_apis(limit=100).get("items", [])
    ddb = session.client("dynamodb", region_name=region)
    names = []
    for page in ddb.get_paginator("list_tables").paginate():
        names += page["TableNames"]
    tables = []
    for name in names[:MAX_RESOURCES]:
        table = ddb.describe_table(TableName=name)["Table"]
        tables.append({"name": name, "arn": table.get("TableArn", ""), "bytes": table.get("TableSizeBytes", 0),
                       "on_demand": table.get("BillingModeSummary", {}).get("BillingMode") == "PAY_PER_REQUEST"})
    return {"functions": functions[:MAX_RESOURCES],
            "http_apis": [{"id": a["ApiId"], "name": a["Name"], "arn": f"arn:aws:apigateway:{region}::/apis/{a['ApiId']}"} for a in http if a.get("ProtocolType") == "HTTP"][:MAX_RESOURCES],
            "rest_apis": [{"id": a["id"], "name": a["name"], "arn": f"arn:aws:apigateway:{region}::/restapis/{a['id']}"} for a in rest][:MAX_RESOURCES],
            "tables": tables, "truncated": len(functions) > MAX_RESOURCES or len(names) > MAX_RESOURCES}


def _queries(inv):
    """One daily Sum query per metric; ids map results back to resources."""
    out = []
    def add(qid, namespace, metric, dimension, value):
        out.append({"Id": qid, "ReturnData": True, "MetricStat": {"Stat": "Sum", "Period": 86400, "Metric": {
            "Namespace": namespace, "MetricName": metric, "Dimensions": [{"Name": dimension, "Value": value}]}}})
    for i, f in enumerate(inv["functions"]):
        add(f"fi{i}", "AWS/Lambda", "Invocations", "FunctionName", f["name"])
        add(f"fd{i}", "AWS/Lambda", "Duration", "FunctionName", f["name"])
    for i, a in enumerate(inv["http_apis"]):
        add(f"ha{i}", "AWS/ApiGateway", "Count", "ApiId", a["id"])
        add(f"he{i}", "AWS/ApiGateway", "5xx", "ApiId", a["id"])
    for i, a in enumerate(inv["rest_apis"]):
        add(f"ra{i}", "AWS/ApiGateway", "Count", "ApiName", a["name"])
        add(f"re{i}", "AWS/ApiGateway", "5XXError", "ApiName", a["name"])
    for i, t in enumerate(inv["tables"]):
        add(f"tr{i}", "AWS/DynamoDB", "ConsumedReadCapacityUnits", "TableName", t["name"])
        add(f"tw{i}", "AWS/DynamoDB", "ConsumedWriteCapacityUnits", "TableName", t["name"])
    return out


def metrics(session, region, inv, start, end):
    queries = _queries(inv)
    days = [(start + timedelta(days=d)).date().isoformat() for d in range((end - start).days)]
    series = {}
    if queries:
        cw = session.client("cloudwatch", region_name=region)
        for page in cw.get_paginator("get_metric_data").paginate(MetricDataQueries=queries, StartTime=start, EndTime=end):
            for result in page["MetricDataResults"]:
                daily = series.setdefault(result["Id"], {})
                for stamp, value in zip(result["Timestamps"], result["Values"]):
                    key = stamp.astimezone(timezone.utc).date().isoformat()
                    daily[key] = daily.get(key, 0) + value
    return days, {qid: [series.get(qid, {}).get(day, 0.0) for day in days] for qid in (q["Id"] for q in queries)}


NAMESPACE_NAMES = {"AWS/Lambda": "AWS Lambda", "AWS/ApiGateway": "Amazon API Gateway", "AWS/DynamoDB": "Amazon DynamoDB",
    "AWS/EC2": "Amazon EC2", "AWS/EBS": "Amazon EBS", "AWS/ECS": "Amazon ECS", "AWS/EKS": "Amazon EKS", "ContainerInsights": "Container Insights",
    "AWS/RDS": "Amazon RDS", "AWS/S3": "Amazon S3", "AWS/SQS": "Amazon SQS", "AWS/SNS": "Amazon SNS", "AWS/Events": "Amazon EventBridge",
    "AWS/Logs": "CloudWatch Logs", "AWS/Kinesis": "Kinesis Data Streams", "AWS/Firehose": "Data Firehose", "AWS/CloudFront": "Amazon CloudFront",
    "AWS/ELB": "Classic Load Balancer", "AWS/ApplicationELB": "Application Load Balancer", "AWS/NetworkELB": "Network Load Balancer",
    "AWS/NATGateway": "NAT Gateway", "AWS/States": "Step Functions", "AWS/Bedrock": "Amazon Bedrock", "AWS/ElastiCache": "ElastiCache",
    "AWS/CodeBuild": "CodeBuild", "AWS/Amplify": "AWS Amplify", "AWS/Cognito": "Amazon Cognito", "AWS/AthenaQueries": "Amazon Athena",
    "AWS/Glue": "AWS Glue", "AWS/SageMaker": "Amazon SageMaker", "AWS/OpenSearchService": "OpenSearch Service", "AWS/Route53": "Route 53",
    "AWS/WAFV2": "AWS WAF", "AWS/X-Ray": "AWS X-Ray", "AWS/CodeDeploy": "CodeDeploy", "AWS/Scheduler": "EventBridge Scheduler",
    "AWS/KMS": "AWS KMS", "AWS/SecretsManager": "Secrets Manager", "AWS/EFS": "Amazon EFS", "AWS/AmplifyHosting": "Amplify Hosting",
    "AWS/STS": "AWS STS", "AWS/IPAM": "VPC IPAM", "AWS/HealthLake": "AWS HealthLake", "AWS/Bedrock/DataAutomation": "Bedrock Data Automation",
    "AWS/Bedrock/Agents": "Bedrock Agents", "AWS/ECR": "Amazon ECR", "AWS/Redshift": "Amazon Redshift", "AWS/MSK": "Amazon MSK", "AWS/Kafka": "Amazon MSK"}
IGNORED_NAMESPACES = ("AWS/Usage", "AWS/Billing", "AWS/Logs/Metric", "AWS/TrustedAdvisor")
MAX_METRIC_PAGES = 3  # per Region (1,500 metrics); ListMetrics paging dominated latency in busy Regions
PRICE_TTL_SECONDS = 86400
_price_cache = {}


def enabled_regions(session, home):
    """Regions enabled for the account; falls back to the home Region when the role predates ec2:DescribeRegions."""
    from botocore.exceptions import ClientError
    try:
        names = [r["RegionName"] for r in session.client("ec2", region_name=home).describe_regions()["Regions"]]
    except ClientError:
        return [home], False
    return sorted(set(names) | {home}), True


def discover(cloudwatch):
    """Count CloudWatch metrics per AWS namespace: a cheap signal of which services are in use."""
    counts, pages = {}, 0
    for page in cloudwatch.get_paginator("list_metrics").paginate():
        for metric in page["Metrics"]:
            namespace = metric["Namespace"]
            if namespace.startswith(IGNORED_NAMESPACES):
                continue
            counts[namespace] = counts.get(namespace, 0) + 1
        pages += 1
        if pages >= MAX_METRIC_PAGES:
            return counts, True
    return counts, False


class _RegionClients:
    """boto3 sessions are not thread-safe; build every client on the calling thread, then fan out."""
    NAMES = ("lambda", "apigatewayv2", "apigateway", "dynamodb", "cloudwatch", "resourcegroupstaggingapi")
    def __init__(self, session, region):
        self.clients = {name: session.client(name, region_name=region) for name in self.NAMES}
    def client(self, name, region_name=None):
        return self.clients[name]


def resource_tags(tagging):
    """ARN -> tags for supported services; empty when the role predates tag:GetResources."""
    from botocore.exceptions import ClientError
    tags = {}
    try:
        for page in tagging.get_paginator("get_resources").paginate(ResourceTypeFilters=["lambda", "dynamodb", "apigateway"]):
            for item in page["ResourceTagMappingList"]:
                tags[item["ResourceARN"]] = {t["Key"]: t["Value"] for t in item.get("Tags", [])}
    except ClientError:
        return {}
    return tags


def _discover_or_none(cloudwatch):
    from botocore.exceptions import ClientError
    try:
        return discover(cloudwatch)
    except ClientError:
        return None


def _collect_region(clients, region, start, end, mask, discovery):
    from concurrent.futures import ThreadPoolExecutor
    # Service discovery runs beside inventory/metrics; it was the slowest step in busy Regions.
    with ThreadPoolExecutor(max_workers=1) as side:
        found = side.submit(_discover_or_none, clients.client("cloudwatch")) if discovery else None
        inv = inventory(clients, region)
        dates, data = metrics(clients, region, inv, start, end)
        tags = resource_tags(clients.client("resourcegroupstaggingapi"))
        if mask:
            tags = {arn: {k: v for k, v in t.items() if k in PUBLIC_TAG_KEYS} for arn, t in tags.items()}
        result = found.result() if found else None
    services, discovery_truncated = result or ({}, False)
    discovery = result is not None
    name = mask_name if mask else (lambda n: n)
    tag = lambda item: tags.get(item.get("arn", ""), {})  # masked public snapshots never carry tags
    resources = []
    for i, f in enumerate(inv["functions"]):
        gb = f["memory_mb"] / 1024
        resources.append({"service": "AWS Lambda", "region": region, "name": name(f["name"]), "tags": tag(f), "price_keys": ["lambda_request", "lambda_gb_second_arm" if f["arm"] else "lambda_gb_second"],
                          "usage": {"requests": data[f"fi{i}"], "gb_seconds": [ms / 1000 * gb for ms in data[f"fd{i}"]], "duration_ms": data[f"fd{i}"]}})
    for i, a in enumerate(inv["http_apis"]):
        resources.append({"service": "Amazon API Gateway", "region": region, "name": name(a["name"]) + " (HTTP)", "tags": tag(a), "price_keys": ["http_api_request"], "usage": {"requests": data[f"ha{i}"], "errors_5xx": data[f"he{i}"]}})
    for i, a in enumerate(inv["rest_apis"]):
        resources.append({"service": "Amazon API Gateway", "region": region, "name": name(a["name"]) + " (REST)", "tags": tag(a), "price_keys": ["rest_api_request"], "usage": {"requests": data[f"ra{i}"], "errors_5xx": data[f"re{i}"]}})
    for i, t in enumerate(inv["tables"]):
        usage = {"read_units": data[f"tr{i}"], "write_units": data[f"tw{i}"], "storage_gb": t["bytes"] / 1024 ** 3}
        resources.append({"service": "Amazon DynamoDB", "region": region, "name": name(t["name"]), "tags": tag(t), "on_demand": t["on_demand"],
                          "price_keys": ["ddb_read_request_unit", "ddb_write_request_unit", "ddb_storage_gb_month"], "usage": usage})
    return {"dates": dates, "resources": resources, "services": services, "discovery": discovery,
            "truncated": inv["truncated"] or discovery_truncated}


def cached_unit_prices(region, pricing):
    hit = _price_cache.get(region)
    if hit and time.monotonic() - hit[0] < PRICE_TTL_SECONDS:
        return hit[1]
    prices = unit_prices(region, pricing)
    _price_cache[region] = (time.monotonic(), prices)
    return prices


def collect(session, region, days=MAX_DAYS, pricing=None, now=None, mask=False, regions=None, workers=None):
    """Raw per-resource daily usage across Regions plus per-Region unit prices. summarize() derives every view."""
    from concurrent.futures import ThreadPoolExecutor
    from botocore.exceptions import ClientError, ConnectionError as SdkConnectionError, HTTPClientError
    if region not in REGIONS:
        raise HTTPException(422, "Unsupported Region")
    start, end = _window(days, now)
    import boto3
    pricing = pricing or boto3.client("pricing", region_name="us-east-1")
    scanned, discovery = (regions, True) if regions else enabled_regions(session, region)
    clients = {r: _RegionClients(session, r) for r in scanned}
    workers = workers or min(20, len(scanned))  # I/O bound: one worker per Region
    def run(r):
        try:
            return r, _collect_region(clients[r], r, start, end, mask, discovery)
        except (ClientError, SdkConnectionError, HTTPClientError):
            return r, None  # opt-in Regions or service gaps must not fail the whole view; credential errors still propagate
    with ThreadPoolExecutor(max_workers=workers) as pool:
        results = dict(pool.map(run, scanned))
    ok = {r: v for r, v in results.items() if v}
    if not ok:
        raise HTTPException(502, "AWS read request failed in every Region")
    account = session.client("sts").get_caller_identity()["Account"]
    resources = [res for r in scanned if r in ok for res in ok[r]["resources"]]
    def used(res):
        return any(v if not isinstance(v, list) else sum(v) for v in res["usage"].values())
    priced_regions = sorted({res["region"] for res in resources if used(res)})  # idle Regions cost nothing to price
    with ThreadPoolExecutor(max_workers=workers) as pool:
        prices = dict(zip(priced_regions, pool.map(lambda r: cached_unit_prices(r, pricing), priced_regions)))
    in_use = {}
    for r, value in ok.items():
        for namespace, count in value["services"].items():
            label = NAMESPACE_NAMES.get(namespace) or namespace.removeprefix("AWS/").replace("/", " ")
            entry = in_use.setdefault(namespace, {"namespace": namespace, "service": label, "regions": {}})
            entry["regions"][r] = count
    return {"schema": 2, "account": mask_account(account), "home_region": region, "regions_scanned": scanned,
            "regions_failed": sorted(set(scanned) - set(ok)), "discovery": discovery,
            "dates": next(iter(ok.values()))["dates"], "collected_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "prices": prices, "resources": resources, "services_in_use": sorted(in_use.values(), key=lambda e: (-len(e["regions"]), e["service"])),
            "truncated": any(v["truncated"] for v in ok.values())}


def _resource_daily_cost(resource, prices, days_in_month=30):
    u, p = resource["usage"], prices
    zero = [0.0] * len(next(iter(v for v in u.values() if isinstance(v, list))))
    def per(values, key):
        price = p.get(key)
        return [v * price for v in values] if price is not None else None
    if resource["service"] == "AWS Lambda":
        parts = [per(u["requests"], "lambda_request"), per(u["gb_seconds"], resource["price_keys"][1])]
    elif resource["service"] == "Amazon API Gateway":
        parts = [per(u["requests"], resource["price_keys"][0])]
    else:
        if not resource.get("on_demand", True):
            return None  # provisioned capacity is billed per hour, not per consumed unit
        storage = p.get("ddb_storage_gb_month")
        parts = [per(u["read_units"], "ddb_read_request_unit"), per(u["write_units"], "ddb_write_request_unit"),
                 [u["storage_gb"] * storage / days_in_month] * len(zero) if storage is not None else None]
    if any(part is None for part in parts):
        return None
    return [sum(values) for values in zip(*parts)]


def summarize(raw, days, weight=None):
    """Slice the trailing window and price it. Costs are None when a list price is unavailable."""
    if days not in (7, 14, 30) or days > len(raw["dates"]):
        raise HTTPException(422, "Window must be 7, 14 or 30 days")
    if raw.get("schema", 1) == 1:  # snapshots written before multi-Region collection
        raw = {**raw, "schema": 2, "home_region": raw["region"], "regions_scanned": [raw["region"]], "regions_failed": [],
               "discovery": False, "services_in_use": [], "prices": {raw["region"]: raw["prices"]},
               "resources": [{**r, "region": raw["region"]} for r in raw["resources"]]}
    dates = raw["dates"][-days:]
    daily = [0.0] * days
    services, resources, unpriced, daily_usage_rows = {}, [], 0, []
    for resource in raw["resources"]:
        window = {k: v[-days:] if isinstance(v, list) else v for k, v in resource["usage"].items()}
        share = weight(resource) if weight else 1.0
        if not share:
            continue  # resource outside the selected business service
        cost = _resource_daily_cost({**resource, "usage": window}, raw["prices"].get(resource["region"], {}))
        cost = [c * share for c in cost] if cost is not None else None
        total = round(sum(cost), 8) if cost is not None else None
        if cost is None:
            unpriced += 1
        else:
            daily = [a + b for a, b in zip(daily, cost)]
        usage = {k: round(sum(v), 3) if isinstance(v, list) else round(v, 6) for k, v in window.items()}
        daily_usage_rows.append({k: v for k, v in window.items() if isinstance(v, list)})
        resources.append({"service": resource["service"], "region": resource["region"], "name": resource["name"], "usage": usage,
                          "estimated_usd": total, "tags": resource.get("tags", {}), "share": share})
        entry = services.setdefault(resource["service"], {"service": resource["service"], "resources": 0, "estimated_usd": 0.0})
        entry["resources"] += 1
        entry["estimated_usd"] += total or 0.0
    daily_usage = {id(r): u for r, u in zip(resources, daily_usage_rows)}  # before sorting changes the order
    resources.sort(key=lambda r: -(r["estimated_usd"] or 0))
    regions_with_cost = sorted({r["region"] for r in resources if r["estimated_usd"]})
    requests_5xx = [(r["usage"].get("requests", 0), r["usage"].get("errors_5xx", 0)) for r in resources if r["service"] == "Amazon API Gateway"]
    outcomes = {}
    for r in resources:  # business grouping by the outcome tag (e.g. one storefront per value)
        key = r.get("tags", {}).get("outcome")
        if not key:
            continue
        o = outcomes.setdefault(key, {"estimated_usd": 0.0, "api_requests": 0.0, "api_errors_5xx": 0.0, "orders": 0.0,
                                      "lambda_invocations": 0.0, "lambda_duration_ms": 0.0, "resources": 0,
                                      "daily_requests": [0.0] * days, "daily_errors_5xx": [0.0] * days, "daily_orders": [0.0] * days})
        series = daily_usage.get(id(r), {})
        for name, metric in (("daily_requests", "requests"), ("daily_errors_5xx", "errors_5xx"), ("daily_orders", "write_units")):
            if r["service"] == ("Amazon DynamoDB" if name == "daily_orders" else "Amazon API Gateway") and metric in series:
                o[name] = [a + b for a, b in zip(o[name], series[metric])]
        u = r["usage"]
        o["resources"] += 1
        o["estimated_usd"] += r["estimated_usd"] or 0.0
        if r["service"] == "Amazon API Gateway":
            o["api_requests"] += u.get("requests", 0); o["api_errors_5xx"] += u.get("errors_5xx", 0)
        elif r["service"] == "AWS Lambda":
            o["lambda_invocations"] += u.get("requests", 0); o["lambda_duration_ms"] += u.get("duration_ms", 0)
        else:
            o["orders"] += u.get("write_units", 0)  # one checkout writes one order item
    for o in outcomes.values():
        o["estimated_usd"] = round(o["estimated_usd"], 8)
        o["avg_checkout_ms"] = round(o["lambda_duration_ms"] / o["lambda_invocations"], 1) if o["lambda_invocations"] else None
    return {"source": "aws-live", "account": raw["account"], "region": raw["home_region"], "collected_at": raw["collected_at"],
            "regions_scanned": raw["regions_scanned"], "regions_failed": raw["regions_failed"], "regions_with_cost": regions_with_cost,
            "services_in_use": raw["services_in_use"], "discovery": raw["discovery"],
            "window": {"start": dates[0], "end_exclusive": (datetime.fromisoformat(dates[-1]) + timedelta(days=1)).date().isoformat(), "days": days},
            "total_estimated_usd": round(sum(daily), 8),
            "daily": [{"date": d, "estimated_usd": round(c, 8)} for d, c in zip(dates, daily)],
            "services": sorted(({**s, "estimated_usd": round(s["estimated_usd"], 8)} for s in services.values()), key=lambda s: -s["estimated_usd"]),
            "resources": resources, "unpriced_resources": unpriced, "truncated": raw["truncated"], "partial_last_day": True,
            "api_requests": sum(r for r, _ in requests_5xx), "api_errors_5xx": sum(e for _, e in requests_5xx), "outcomes": outcomes,
            "pricing": {"source": "AWS Price List API (public on-demand list prices)", "unit_prices_usd": raw["prices"].get(raw["home_region"]) or next(iter(raw["prices"].values()), {}),
                        "regions_priced": sorted(raw["prices"]),
                        "free_tier_applied": False, "supported_services": list(SUPPORTED)}}


def refresh_public_demo(store, environ, session_factory=assume):
    """Scheduled task: collect the demo account through its read-only role and store a masked snapshot."""
    role_arn, external_id = environ.get("LIVE_DEMO_ROLE_ARN"), environ.get("LIVE_DEMO_EXTERNAL_ID")
    if not role_arn or not external_id:
        return {"status": "skipped", "reason": "live demo role not configured"}
    session = session_factory(validate_role_arn(role_arn), external_id)
    raw = collect(session, environ.get("LIVE_DEMO_REGION", "us-east-1"), MAX_DAYS, mask=True)
    store.save_snapshot(raw, {str(d): summarize(raw, d) for d in (7, 14, 30)})
    return {"status": "refreshed", "resources": len(raw["resources"]), "collected_at": raw["collected_at"]}
