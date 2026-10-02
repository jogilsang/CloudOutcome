"""Cloud entry point. Only API Gateway JWT-authorized events are accepted by middleware."""
import asyncio
import json
import logging
import os
from mangum import Mangum
if os.environ.get("OUTCOMELENS_MODE") != "cloud":
    raise RuntimeError("Lambda requires cloud mode; local unauthenticated mode is forbidden")
from main import app
import aws_live
from cloud_store import Store
# Mangum calls asyncio.get_event_loop() per request; Python 3.14 no longer creates a loop implicitly.
asyncio.set_event_loop(asyncio.new_event_loop())
http = Mangum(app, lifespan="off")
import fleet
from cloud_store import DynamoDocs, registered
from main import session_for, collect_for_workspace


def _docs_for(pk, expires_at=None):
    if pk.startswith("ANON#") and expires_at is None:
        found = DynamoDocs(pk).get("CONNECTION") or {}
        expires_at = found.get("expires_at", 0)
    return DynamoDocs(pk, expires_at=expires_at)


def _daily_check(event):
    import time
    live = [pk for pk in registered() if not pk.startswith("ANON#") or (_docs_for(pk).expires_at or 0) > time.time()]
    return fleet.daily_check(live, _docs_for, session_for)


def _collect(event):
    pk, chunk = event.get("pk", ""), event.get("accounts", [])
    if not (pk.startswith(("WORKSPACE#", "ANON#")) and isinstance(chunk, list) and len(chunk) <= fleet.CHUNK):
        raise ValueError("Invalid collection request")
    done = fleet.collect_chunk(_docs_for(pk, event.get("expires_at")), fleet.parse_accounts(chunk), session_for, collect=collect_for_workspace)
    return {"status": "collected", "accounts": len(done)}


TASKS = {"refresh-live-demo": lambda event: aws_live.refresh_public_demo(Store.public_demo(), os.environ),
         "check-connections": _daily_check, "collect-accounts": _collect}


def handler(event, context):
    # Scheduled EventBridge input is a fixed JSON object defined in the platform template.
    task = event.get("outcomelens_task") if isinstance(event, dict) else None
    if task is not None:
        if task not in TASKS:
            raise ValueError("Unknown task")
        try:
            result = TASKS[task](event)
        except Exception as error:
            logging.getLogger("outcomelens").error(json.dumps({"event": "task.failed", "task": task, "error_type": type(error).__name__}))
            raise RuntimeError("Task failed") from None
        logging.getLogger("outcomelens").info(json.dumps({"event": "task.completed", "task": task, "status": result["status"]}))
        return result
    return http(event, context)
