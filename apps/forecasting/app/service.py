from __future__ import annotations

import json
from datetime import date, datetime, timedelta
from statistics import pstdev
from typing import Any

import numpy as np

from .config import UserScope, settings
from .db import execute, fetch_all
from .models import select_best_model


def scope_sql(user: UserScope, requested_shop_id: int | None, alias: str = "i") -> tuple[str, list[Any], dict[str, Any]]:
    if user.role != "OWNER":
        if requested_shop_id and requested_shop_id != user.shop_id:
            raise PermissionError("Forbidden")
        shop_id = user.shop_id
    else:
        shop_id = requested_shop_id
    params: list[Any] = []
    where = ""
    if shop_id:
        params.append(shop_id)
        where = f" AND {alias}.shop_id = %s"
    return where, params, {"shopId": shop_id, "scope": "single-shop" if shop_id else "all-shops"}


def load_daily_history(user: UserScope, metric: str, requested_shop_id: int | None = None) -> dict[str, Any]:
    shop_where, shop_params, scope = scope_sql(user, requested_shop_id, "i")
    rows = fetch_all(
        f"""
        SELECT
          i.issued_at::date AS day,
          COALESCE(SUM(i.total), 0)::float AS revenue,
          COALESCE(SUM(i.tax_total), 0)::float AS tax,
          COUNT(i.id)::float AS invoice_count,
          COUNT(DISTINCT i.customer_id)::float AS customer_count
        FROM invoices i
        WHERE i.status <> 'CANCELLED' {shop_where}
        GROUP BY i.issued_at::date
        ORDER BY day ASC
        """,
        tuple(shop_params),
    )
    payment_rows = fetch_all(
        f"""
        SELECT p.method, COUNT(*)::int AS count, COALESCE(SUM(p.amount), 0)::float AS amount
        FROM payments p
        WHERE 1=1 {shop_where.replace('i.', 'p.')}
        GROUP BY p.method
        ORDER BY amount DESC
        """,
        tuple(shop_params),
    )

    if not rows:
        today = date.today()
        return {
            "history": [{"date": today.isoformat(), "revenue": 0.0, "tax": 0.0, "invoice_count": 0.0, "customer_count": 0.0}],
            "values": [0.0],
            "paymentHistory": payment_rows,
            "scope": scope,
        }

    start = rows[0]["day"]
    end = max(rows[-1]["day"], date.today())
    by_day = {
        row["day"].isoformat(): {
            "date": row["day"].isoformat(),
            "revenue": round(float(row["revenue"]), 2),
            "tax": round(float(row["tax"]), 2),
            "invoice_count": float(row["invoice_count"]),
            "customer_count": float(row["customer_count"]),
        }
        for row in rows
    }
    history = []
    current = start
    while current <= end:
        key = current.isoformat()
        history.append(by_day.get(key, {"date": key, "revenue": 0.0, "tax": 0.0, "invoice_count": 0.0, "customer_count": 0.0}))
        current += timedelta(days=1)

    return {
        "history": history,
        "values": [float(row[metric]) for row in history],
        "paymentHistory": payment_rows,
        "scope": scope,
    }


def confidence(values: list[float], predictions: list[float], metric: str) -> list[dict[str, Any]]:
    if len(values) >= 2:
        volatility = pstdev(values[-min(30, len(values)):])
    else:
        volatility = max(1.0, values[0] * 0.1 if values else 1.0)
    start = date.today() + timedelta(days=1)
    output = []
    for index, prediction in enumerate(predictions):
        margin = 1.64 * max(volatility, 1.0) * ((index + 1) ** 0.5)
        value = max(0.0, prediction)
        if metric == "invoice_count":
            value = round(value)
            lower = round(max(0.0, value - margin))
            upper = round(max(value, value + margin))
        else:
            lower = round(max(0.0, value - margin), 2)
            upper = round(max(value, value + margin), 2)
            value = round(value, 2)
        output.append({"date": (start + timedelta(days=index)).isoformat(), "value": value, "lower": lower, "upper": upper})
    return output


def trend(values: list[float]) -> dict[str, Any]:
    recent = values[-7:] if len(values) >= 7 else values
    previous = values[-14:-7] if len(values) >= 14 else values[: max(1, len(values) - len(recent))] or recent
    recent_avg = float(np.mean(recent)) if recent else 0.0
    previous_avg = float(np.mean(previous)) if previous else 0.0
    delta = recent_avg - previous_avg
    pct = (delta / previous_avg * 100) if previous_avg else 0.0
    return {
        "direction": "up" if delta > 0.01 else "down" if delta < -0.01 else "flat",
        "percent": round(pct, 2),
        "recentAverage": round(recent_avg, 2),
        "previousAverage": round(previous_avg, 2),
    }


def insights(metric: str, forecast: list[dict[str, Any]], trend_info: dict[str, Any]) -> list[str]:
    total = sum(float(row["value"]) for row in forecast)
    direction = trend_info["direction"]
    label = "revenue" if metric == "revenue" else "tax collection" if metric == "tax" else "invoice count"
    messages = [f"Forecasted {label} total is {round(total, 2)} for the selected horizon."]
    if direction == "up":
        messages.append(f"Recent {label} trend is improving by {trend_info['percent']}%.")
    elif direction == "down":
        messages.append(f"Recent {label} trend is declining by {abs(trend_info['percent'])}%.")
    else:
        messages.append(f"Recent {label} trend is stable.")
    return messages


def forecast(user: UserScope, metric: str, horizon: int, forecast_type: str, requested_shop_id: int | None = None) -> dict[str, Any]:
    loaded = load_daily_history(user, metric, requested_shop_id)
    values = loaded["values"]
    selected, scores = select_best_model(values, horizon, settings.backtest_days)
    forecast_rows = confidence(values, selected.predictions, metric)
    trend_info = trend(values)
    response = {
        "ok": True,
        "forecastType": forecast_type,
        "metric": metric,
        "generatedAt": datetime.utcnow().isoformat(timespec="seconds") + "Z",
        "selectedModel": selected.name,
        "modelScores": [score.__dict__ for score in scores],
        "scope": loaded["scope"],
        "history": loaded["history"][-90:],
        "paymentHistory": loaded["paymentHistory"],
        "predictions": forecast_rows,
        "total": {
            "value": round(sum(float(row["value"]) for row in forecast_rows), 2),
            "lower": round(sum(float(row["lower"]) for row in forecast_rows), 2),
            "upper": round(sum(float(row["upper"]) for row in forecast_rows), 2),
        },
        "trend": trend_info,
        "insights": insights(metric, forecast_rows, trend_info),
    }
    save_forecast(user, requested_shop_id, forecast_type, selected.name, scores, response)
    return response


def save_forecast(user: UserScope, requested_shop_id: int | None, forecast_type: str, model: str, scores, response: dict[str, Any]) -> None:
    shop_id = response["scope"]["shopId"]
    execute(
        """
        INSERT INTO forecast_runs (user_id, shop_id, forecast_type, selected_model, model_scores, forecast)
        VALUES (%s, %s, %s, %s, %s::jsonb, %s::jsonb)
        """,
        (
            user.user_id,
            shop_id,
            forecast_type,
            model,
            json.dumps([score.__dict__ for score in scores]),
            json.dumps(response),
        ),
    )
