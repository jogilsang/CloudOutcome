"""Deterministic KPI calculations. All demo observations are synthetic."""
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from math import ceil
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class Observation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    event_id: str = Field(min_length=1, max_length=120)
    attempt_id: str = Field(min_length=1, max_length=120)
    order_id: str | None = Field(default=None, min_length=1, max_length=120)
    timestamp: datetime
    service: Literal["checkout", "catalog"]
    success: bool
    latency_ms: float = Field(ge=0, le=300000, allow_inf_nan=False)

    @model_validator(mode="after")
    def aware(self):
        if self.timestamp.tzinfo is None:
            raise ValueError("timestamp must include timezone")
        if self.service == "checkout" and self.success and not self.order_id:
            raise ValueError("successful checkout requires order_id")
        return self


class Definition(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=80)
    kind: Literal["cost_per_order", "success_rate", "latency_p95"]
    service: Literal["checkout", "catalog"] = "checkout"
    target: float = Field(gt=0, le=1000000, allow_inf_nan=False)
    shared_allocation_pct: float = Field(ge=0, le=100, allow_inf_nan=False)
    owner: str = Field(min_length=1, max_length=80)
    expected_version: int = Field(ge=0)

    @model_validator(mode="after")
    def sensible(self):
        if self.kind == "success_rate" and self.target > 100:
            raise ValueError("success target must be <= 100")
        if self.kind == "cost_per_order" and self.service != "checkout":
            raise ValueError("completed order events are available only for checkout")
        return self


def percentile(values: list[float], p: float = .95):
    """Nearest-rank percentile of raw observations, never averages of percentiles."""
    return sorted(values)[ceil(len(values) * p) - 1] if values else None


def calculate(events: list[Observation], direct: Decimal, shared: Decimal, allocation: Decimal):
    unique = {}
    for event in events:
        if event.event_id in unique and event != unique[event.event_id]:
            raise ValueError("conflicting duplicate event")
        unique[event.event_id] = event
    attempts = {}
    for event in unique.values():
        if event.attempt_id in attempts:
            old = attempts[event.attempt_id]
            if old.model_dump(exclude={"event_id"}) != event.model_dump(exclude={"event_id"}):
                raise ValueError("conflicting terminal attempt")
        attempts[event.attempt_id] = event
    rows = list(attempts.values())
    successes = sum(e.success for e in rows)
    completed_orders = len({e.order_id for e in rows if e.success and e.service == "checkout"})
    allocated = direct + shared * allocation / Decimal(100)
    return {
        "attempts": len(rows), "completed": completed_orders,
        "successful_attempts": successes,
        "duplicate_count": len(events) - len(rows),
        "direct_cost": float(direct), "shared_pool": float(shared),
        "allocated_shared": float(shared * allocation / Decimal(100)),
        "unallocated_shared": float(shared * (1 - allocation / Decimal(100))),
        "allocated_cost": float(allocated),
        "cost_per_order": float(allocated / completed_orders) if completed_orders else None,
        "success_rate": successes / len(rows) * 100 if rows else None,
        "latency_p95": percentile([e.latency_ms for e in rows]),
    }


def synthetic_data(service: str, days: int, scenario: str):
    """Fixed reference window; deterministic fixtures, not live CloudWatch data."""
    end = date(2026, 10, 1)
    rows, costs = [], []
    for i in range(days):
        day = end - timedelta(days=days-i)
        count = 90 + (i * 17 % 55)
        incident = scenario == "incident" and i >= days - 3
        if service == "catalog":
            count *= 2
        if scenario == "empty":
            count = 0
        for j in range(count):
            success = (j % (5 if incident else 53)) != 0
            rows.append(Observation(
                event_id=f"{service}-{day}-{j}",
                attempt_id=f"attempt-{service}-{day}-{j}",
                order_id=f"order-{day}-{j}" if service == "checkout" and success else None,
                timestamp=datetime(day.year, day.month, day.day, j % 24, j % 60, tzinfo=timezone.utc),
                service=service, success=success,
                latency_ms=120 + (j * 19 % 310) + (600 if incident and j % 3 == 0 else 0),
            ))
        costs.append({"date": str(day), "direct": Decimal("18.40") + Decimal(i % 5),
                      "shared": Decimal("7.20")})
    return rows, costs


FORMULAS = {
    "cost_per_order": "(direct AWS cost + shared pool × allocation %) / unique completed orders",
    "success_rate": "unique successful terminal attempts / unique eligible terminal attempts × 100",
    "latency_p95": "nearest-rank p95 of raw operation latency observations",
}


def dashboard(service="checkout", days=14, scenario="baseline", allocation=40):
    events, costs = synthetic_data(service, days, scenario)
    pct = Decimal(str(allocation))
    summary = calculate(events, sum((x["direct"] for x in costs), Decimal(0)),
                        sum((x["shared"] for x in costs), Decimal(0)), pct)
    trend = []
    for cost in costs:
        window = [e for e in events if str(e.timestamp.date()) == cost["date"]]
        trend.append({"date": cost["date"],
                      **calculate(window, cost["direct"], cost["shared"], pct)})
    if service != "checkout":
        summary["cost_per_order"] = None
        for row in trend:
            row["cost_per_order"] = None
    return {"mode": "synthetic", "service": service, "scenario": scenario,
            "window": {"start": costs[0]["date"], "end_exclusive": "2026-10-01",
                       "timezone": "UTC", "days": days},
            "summary": summary, "trend": trend, "formulas": FORMULAS,
            "provenance": {
                "events": "Deterministic synthetic operation events",
                "cost": "Simulated USD daily costs; not an AWS bill",
                "latency": "Synthetic raw observations; not aggregated CloudWatch percentiles",
                "billing_status": "simulated", "allocation_pct": allocation,
                "generated_window": "Historical sample ending 2026-10-01T00:00:00Z"},
            "limitations": ["No causal attribution", "Cloud cost excludes non-AWS business costs",
                             "SLO assessment, not contractual SLA certification"]}
