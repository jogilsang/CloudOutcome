"""Tenant-scoped DynamoDB storage with atomic definition/audit writes."""
import hashlib
import json
import os
import secrets
import time
import uuid
from datetime import datetime, timezone
from functools import lru_cache
from decimal import Decimal
from fastapi import HTTPException

@lru_cache(maxsize=1)
def client():
    import boto3
    from botocore.config import Config
    return boto3.client("dynamodb", config=Config(connect_timeout=2, read_timeout=3,
        retries={"mode": "standard", "total_max_attempts": 2}))

def tenant_for(claims):
    sub = claims.get("sub", "")
    if not isinstance(sub, str) or not sub or len(sub) > 128:
        raise HTTPException(403, "Workspace identity unavailable")
    return hashlib.sha256(sub.encode()).hexdigest()

def encode(item):
    from boto3.dynamodb.types import TypeSerializer
    serializer = TypeSerializer()
    return {k: serializer.serialize(v) for k, v in item.items()}

def decode(item):
    from boto3.dynamodb.types import TypeDeserializer
    deserializer = TypeDeserializer()
    return {k: deserializer.deserialize(v) for k, v in item.items()}

PUBLIC_DEMO_PK = "PUBLIC#live-demo"


class Store:
    def __init__(self, tenant, sdk=None, table=None, pk=None):
        self.pk = pk or "WORKSPACE#" + tenant
        self.sdk = sdk or client()
        self.table = table or os.environ["TABLE_NAME"]

    def list(self, prefix, limit=50):
        result = self.sdk.query(TableName=self.table,
            KeyConditionExpression="pk = :pk AND begins_with(sk, :prefix)",
            ExpressionAttributeValues=encode({":pk": self.pk, ":prefix": prefix}),
            ConsistentRead=True, ScanIndexForward=prefix != "AUDIT#", Limit=limit)
        # Definition universe is capped by schema to 2 services x 3 supported kinds.
        return [decode(item) for item in result.get("Items", [])]

    def definitions(self):
        return [json.loads(row["body"]) for row in self.list("DEF#")]

    def audit(self):
        return [{k: v for k, v in row.items() if k in {"id", "created", "action", "body"}}
                for row in self.list("AUDIT#") if row.get("expires_at", 0) > time.time()]

    def save(self, key, body):
        if key != body.service + "_" + body.kind:
            raise HTTPException(422, "Definition id must match service and KPI kind")
        doc = {"id": key, "version": body.expected_version + 1,
               **body.model_dump(exclude={"expected_version"})}
        item = {"pk": self.pk, "sk": "DEF#" + key,
                "version": doc["version"], "body": json.dumps(doc)}
        now = datetime.now(timezone.utc).isoformat()
        event = {"pk": self.pk, "sk": "AUDIT#" + now + "#" + uuid.uuid4().hex,
                 "id": uuid.uuid4().hex, "created": now, "action": "definition.saved",
                 # Audit holds immutable non-content metadata, never owner/name/prompt.
                 "body": json.dumps({"id": key, "version": doc["version"]}),
                 "expires_at": int(time.time()) + int(os.environ.get("AUDIT_DAYS", "30")) * 86400}
        condition = {"ConditionExpression": "attribute_not_exists(pk)"} if body.expected_version == 0 else {
            "ConditionExpression": "#version = :expected", "ExpressionAttributeNames": {"#version": "version"},
            "ExpressionAttributeValues": encode({":expected": body.expected_version})}
        try:
            self.sdk.transact_write_items(TransactItems=[
                {"Put": {"TableName": self.table, "Item": encode(item), **condition}},
                {"Put": {"TableName": self.table, "Item": encode(event)}}])
        except self.sdk.exceptions.TransactionCanceledException as error:
            if any(r.get("Code") == "ConditionalCheckFailed" for r in error.response.get("CancellationReasons", [])):
                raise HTTPException(409, "Definition changed. Reload before saving.") from None
            raise HTTPException(503, "Storage temporarily unavailable") from None
        return doc

    def consume(self, limit, minute=None):
        minute = int(time.time() // 60) if minute is None else minute
        try:
            self.sdk.update_item(TableName=self.table, Key=encode({"pk": self.pk, "sk": "QUOTA#" + str(minute)}),
                UpdateExpression="SET expires_at = :ttl ADD #count :one",
                ConditionExpression="attribute_not_exists(#count) OR #count < :limit",
                ExpressionAttributeNames={"#count": "count"},
                ExpressionAttributeValues=encode({":ttl": minute * 60 + 120, ":one": 1, ":limit": limit}))
        except self.sdk.exceptions.ConditionalCheckFailedException:
            raise HTTPException(429, "Workspace request limit reached") from None

    def item(self, sk):
        # Query (already granted) instead of GetItem keeps the runtime policy unchanged.
        rows = self.sdk.query(TableName=self.table, KeyConditionExpression="pk = :pk AND sk = :sk",
            ExpressionAttributeValues=encode({":pk": self.pk, ":sk": sk}), ConsistentRead=True, Limit=1).get("Items", [])
        return decode(rows[0]) if rows else None

    def connection(self):
        """Per-workspace AWS connection. The External ID is generated server-side, never accepted from clients."""
        found = self.item("CONNECTION")
        if found:
            return json.loads(found["body"])
        doc = {"external_id": secrets.token_urlsafe(24), "role_arn": None, "region": None, "verified_at": None}
        try:
            self.sdk.put_item(TableName=self.table, Item=encode({"pk": self.pk, "sk": "CONNECTION", "body": json.dumps(doc)}),
                              ConditionExpression="attribute_not_exists(pk)")
        except self.sdk.exceptions.ConditionalCheckFailedException:
            return json.loads(self.item("CONNECTION")["body"])
        return doc

    def save_connection(self, role_arn, region):
        doc = {**self.connection(), "role_arn": role_arn, "region": region,
               "verified_at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
        self.sdk.put_item(TableName=self.table, Item=encode({"pk": self.pk, "sk": "CONNECTION", "body": json.dumps(doc)}))
        return doc

    @classmethod
    def public_demo(cls, sdk=None, table=None):
        return cls("", sdk, table, pk=PUBLIC_DEMO_PK)

    def snapshot(self):
        found = self.item("SNAPSHOT")
        return json.loads(found["body"]) if found else None

    def save_snapshot(self, raw, summaries=None):
        self.sdk.put_item(TableName=self.table, Item=encode({"pk": self.pk, "sk": "SNAPSHOT", "body": json.dumps(raw)}))
        if summaries is not None:  # precomputed windows so anonymous reads skip summarizing
            self.sdk.put_item(TableName=self.table, Item=encode({"pk": self.pk, "sk": "SUMMARIES", "body": _pack(summaries)}))

    def summary(self, days):
        found = self.item("SUMMARIES")
        return _unpack(found["body"]).get(str(days)) if found else None


# --- JSON document stores used by fleet.py (multi-account workspaces) -------------------------------------
# Only Query/PutItem/UpdateItem are used, matching the runtime policy. Large documents are compressed.
import base64
import sqlite3
import zlib

REGISTRY_PK = "REGISTRY#connections"
ANON_DAYS = 7


def _pack(doc):
    data = json.dumps(doc, separators=(",", ":")).encode()
    return "z:" + base64.b64encode(zlib.compress(data, 6)).decode() if len(data) > 20000 else data.decode()


def _unpack(body):
    return json.loads(zlib.decompress(base64.b64decode(body[2:])) if body.startswith("z:") else body)


class DynamoDocs:
    def __init__(self, pk, sdk=None, table=None, expires_at=None):
        self.pk, self.expires_at = pk, expires_at
        self.sdk = sdk or client()
        self.table = table or os.environ["TABLE_NAME"]

    def _item(self, sk, doc):
        item = {"pk": self.pk, "sk": sk, "body": _pack(doc)}
        if self.expires_at:
            item["expires_at"] = self.expires_at  # anonymous workspaces expire with every item
        return encode(item)

    def get(self, sk):
        rows = self.sdk.query(TableName=self.table, KeyConditionExpression="pk = :pk AND sk = :sk",
            ExpressionAttributeValues=encode({":pk": self.pk, ":sk": sk}), ConsistentRead=True, Limit=1).get("Items", [])
        return _unpack(decode(rows[0])["body"]) if rows else None

    def put(self, sk, doc):
        self.sdk.put_item(TableName=self.table, Item=self._item(sk, doc))
        return doc

    def put_new(self, sk, doc):
        try:
            self.sdk.put_item(TableName=self.table, Item=self._item(sk, doc), ConditionExpression="attribute_not_exists(pk)")
            return doc
        except self.sdk.exceptions.ConditionalCheckFailedException:
            return None

    def query(self, prefix):
        out, kwargs = [], {"TableName": self.table, "KeyConditionExpression": "pk = :pk AND begins_with(sk, :p)",
                           "ExpressionAttributeValues": encode({":pk": self.pk, ":p": prefix}), "ConsistentRead": True}
        while True:
            page = self.sdk.query(**kwargs)
            out += [_unpack(decode(i)["body"]) for i in page.get("Items", [])]
            if "LastEvaluatedKey" not in page:
                return out
            kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]


def register(pk, active, sdk=None, table=None):
    """Registry of workspaces with accounts, so the daily check never needs a table scan."""
    DynamoDocs(REGISTRY_PK, sdk, table).put("WS#" + pk, {"pk": pk, "active": active})


def registered(sdk=None, table=None):
    return [d["pk"] for d in DynamoDocs(REGISTRY_PK, sdk, table).query("WS#") if d.get("active")]


def anon_pk(token):
    if not isinstance(token, str) or not 20 <= len(token) <= 100:
        raise HTTPException(401, "Temporary workspace key missing or invalid")
    return "ANON#" + hashlib.sha256(token.encode()).hexdigest()  # the raw key is never stored


class LocalDocs:
    """SQLite twin of DynamoDocs for local development."""
    def __init__(self, pk, path):
        self.pk, self.path = pk, path
        with sqlite3.connect(path) as db:
            db.execute("CREATE TABLE IF NOT EXISTS docs (pk TEXT, sk TEXT, body TEXT, PRIMARY KEY (pk, sk))")

    def get(self, sk):
        with sqlite3.connect(self.path) as db:
            row = db.execute("SELECT body FROM docs WHERE pk=? AND sk=?", (self.pk, sk)).fetchone()
        return _unpack(row[0]) if row else None

    def put(self, sk, doc):
        with sqlite3.connect(self.path) as db:
            db.execute("INSERT OR REPLACE INTO docs VALUES (?,?,?)", (self.pk, sk, _pack(doc)))
        return doc

    def put_new(self, sk, doc):
        with sqlite3.connect(self.path) as db:
            cursor = db.execute("INSERT OR IGNORE INTO docs VALUES (?,?,?)", (self.pk, sk, _pack(doc)))
        return doc if cursor.rowcount else None

    def query(self, prefix):
        with sqlite3.connect(self.path) as db:
            rows = db.execute("SELECT body FROM docs WHERE pk=? AND sk LIKE ? ORDER BY sk", (self.pk, prefix.replace("%", "") + "%")).fetchall()
        return [_unpack(r[0]) for r in rows]
