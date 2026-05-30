from fastapi import Depends, FastAPI, HTTPException, Query
from .config import UserScope
from .security import require_internal_user
from .service import forecast

app = FastAPI(title="SR Groups Self-Hosted Forecasting Service", version="1.0.0")


@app.get("/health")
def health():
    return {"ok": True, "service": "forecasting"}


@app.get("/api/predictions/tomorrow-sales")
def tomorrow_sales(shopId: int | None = Query(default=None), user: UserScope = Depends(require_internal_user)):
    revenue = forecast(user, "revenue", 1, "tomorrow-sales", shopId)
    invoice_count = forecast(user, "invoice_count", 1, "tomorrow-invoice-count", shopId)
    return {
        "ok": True,
        "generatedAt": revenue["generatedAt"],
        "scope": revenue["scope"],
        "tomorrow": revenue["predictions"][0]["date"],
        "revenue": revenue,
        "invoiceCount": invoice_count,
    }


@app.get("/api/predictions/weekly-revenue")
def weekly_revenue(shopId: int | None = Query(default=None), user: UserScope = Depends(require_internal_user)):
    return forecast(user, "revenue", 7, "weekly-revenue", shopId)


@app.get("/api/predictions/monthly-revenue")
def monthly_revenue(shopId: int | None = Query(default=None), user: UserScope = Depends(require_internal_user)):
    return forecast(user, "revenue", 30, "monthly-revenue", shopId)


@app.get("/api/predictions/tax-forecast")
def tax_forecast(shopId: int | None = Query(default=None), user: UserScope = Depends(require_internal_user)):
    return forecast(user, "tax", 30, "tax-forecast", shopId)
