from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Callable

import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestRegressor
from sklearn.linear_model import LinearRegression
from statsmodels.tsa.holtwinters import ExponentialSmoothing
from xgboost import XGBRegressor


@dataclass
class ModelResult:
    name: str
    predictions: list[float]
    mae: float | None
    available: bool = True
    reason: str | None = None


def clamp(value: float) -> float:
    if not math.isfinite(value):
        return 0.0
    return max(0.0, float(value))


def make_features(values: list[float]) -> pd.DataFrame:
    rows = []
    for index, value in enumerate(values):
        day = index
        dow = index % 7
        rows.append(
            {
                "day": day,
                "dow": dow,
                "month_position": index % 30,
                "is_weekend": 1 if dow in (5, 6) else 0,
                "lag_1": values[index - 1] if index >= 1 else value,
                "lag_7": values[index - 7] if index >= 7 else value,
                "rolling_7": float(np.mean(values[max(0, index - 7): index + 1])),
            }
        )
    return pd.DataFrame(rows)


def make_future_features(values: list[float], horizon: int) -> pd.DataFrame:
    working = list(values)
    rows = []
    for step in range(horizon):
        index = len(working)
        dow = index % 7
        last = working[-1] if working else 0.0
        rows.append(
            {
                "day": index,
                "dow": dow,
                "month_position": index % 30,
                "is_weekend": 1 if dow in (5, 6) else 0,
                "lag_1": last,
                "lag_7": working[index - 7] if index >= 7 else last,
                "rolling_7": float(np.mean(working[-7:])) if working else 0.0,
            }
        )
        working.append(last)
    return pd.DataFrame(rows)


def linear_regression(values: list[float], horizon: int) -> list[float]:
    x = make_features(values)
    y = np.array(values, dtype=float)
    model = LinearRegression()
    model.fit(x, y)
    return [clamp(x) for x in model.predict(make_future_features(values, horizon)).tolist()]


def random_forest(values: list[float], horizon: int) -> list[float]:
    x = make_features(values)
    y = np.array(values, dtype=float)
    model = RandomForestRegressor(n_estimators=220, min_samples_leaf=2, random_state=42)
    model.fit(x, y)
    return [clamp(x) for x in model.predict(make_future_features(values, horizon)).tolist()]


def xgboost(values: list[float], horizon: int) -> list[float]:
    x = make_features(values)
    y = np.array(values, dtype=float)
    model = XGBRegressor(
        n_estimators=180,
        max_depth=3,
        learning_rate=0.05,
        subsample=0.9,
        colsample_bytree=0.9,
        objective="reg:squarederror",
        random_state=42,
    )
    model.fit(x, y, verbose=False)
    return [clamp(x) for x in model.predict(make_future_features(values, horizon)).tolist()]


def time_series(values: list[float], horizon: int) -> list[float]:
    series = pd.Series(values, dtype=float)
    seasonal_periods = 7 if len(values) >= 21 else None
    if seasonal_periods:
        model = ExponentialSmoothing(series, trend="add", seasonal="add", seasonal_periods=7)
    else:
        model = ExponentialSmoothing(series, trend="add", seasonal=None)
    fitted = model.fit(optimized=True)
    return [clamp(x) for x in fitted.forecast(horizon).tolist()]


MODEL_REGISTRY: list[tuple[str, Callable[[list[float], int], list[float]], int]] = [
    ("Linear Regression", linear_regression, 7),
    ("Random Forest Regressor", random_forest, 14),
    ("XGBoost Regressor", xgboost, 21),
    ("Time-series Forecast", time_series, 10),
]


def mae(actual: list[float], predicted: list[float]) -> float:
    if not actual:
        return 0.0
    return float(np.mean(np.abs(np.array(actual) - np.array(predicted))))


def score_model(name: str, fn: Callable[[list[float], int], list[float]], min_days: int, values: list[float], backtest_days: int) -> ModelResult:
    if len(values) < min_days:
        return ModelResult(name=name, predictions=[], mae=None, available=False, reason="Not enough training days")
    test_size = min(backtest_days, max(3, len(values) // 3))
    train = values[:-test_size]
    test = values[-test_size:]
    if len(train) < min_days:
        return ModelResult(name=name, predictions=[], mae=None, available=False, reason="Not enough backtest history")
    try:
        preds = fn(train, test_size)
        return ModelResult(name=name, predictions=preds, mae=round(mae(test, preds), 4))
    except Exception as error:
        return ModelResult(name=name, predictions=[], mae=None, available=False, reason=str(error))


def select_best_model(values: list[float], horizon: int, backtest_days: int) -> tuple[ModelResult, list[ModelResult]]:
    scores = [score_model(name, fn, min_days, values, backtest_days) for name, fn, min_days in MODEL_REGISTRY]
    candidates = [score for score in scores if score.available and score.mae is not None]
    selected_score = min(candidates, key=lambda item: item.mae) if candidates else scores[-1]
    selected_fn = next(fn for name, fn, _min_days in MODEL_REGISTRY if name == selected_score.name)
    try:
        predictions = selected_fn(values, horizon)
    except Exception:
        predictions = time_series(values, horizon) if len(values) >= 10 else [float(np.mean(values or [0.0]))] * horizon
        selected_score = ModelResult(name="Time-series Forecast", predictions=predictions, mae=selected_score.mae)
    selected = ModelResult(name=selected_score.name, predictions=[clamp(x) for x in predictions], mae=selected_score.mae)
    return selected, scores
