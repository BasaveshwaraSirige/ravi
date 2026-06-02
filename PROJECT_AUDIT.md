# SR Groups Project Audit

Audit date: 2026-06-02

## Summary

The active app is the Python server in `python_server.py`, serving static pages from `apps/web` and JSON APIs under `/api`.

Two broken frontend navigation states were found and fixed:

- Owner login briefly redirected to `/shop.html?shopId=null`, causing a failed shop bootstrap request.
- Direct shop module links such as `/shop.html?shopId=1#stock`, `#boi`, `#sales`, and `#reports` loaded the page but left the Billing pane active.

After repair, Dashboard, Billing, Stock, Invoice, Sales, and Reports loaded without browser console errors or failed network responses.

## Backend Route Map

| Method | Route |
|---|---|
| GET | `/api/health` |
| POST | `/api/auth/login` |
| POST | `/api/auth/logout` |
| GET | `/api/auth/me` |
| POST | `/api/ai/chat` |
| GET | `/api/ai/token` |
| POST | `/api/internal/ai/billing-tools` |
| GET | `/api/shops` |
| GET | `/api/dashboard/summary` |
| GET | `/api/shops/:shopId/summary` |
| GET | `/api/shops/:shopId/products` |
| POST | `/api/shops/:shopId/products` |
| PUT | `/api/shops/:shopId/products/:productId` |
| DELETE | `/api/shops/:shopId/products/:productId` |
| POST | `/api/shops/:shopId/stock/bill-of-invoice` |
| POST | `/api/shops/:shopId/stock/adjust` |
| GET | `/api/shops/:shopId/stock/low` |
| GET | `/api/shops/:shopId/stock/incoming` |
| POST | `/api/shops/:shopId/bills` |
| GET | `/api/shops/:shopId/bills` |
| GET | `/api/shops/:shopId/bills/:billId` |
| POST | `/api/shops/:shopId/expenses` |
| GET | `/api/shops/:shopId/expenses` |
| POST | `/api/shops/:shopId/employees` |
| GET | `/api/shops/:shopId/employees` |
| POST | `/api/reports/daily` |
| DELETE | `/api/reports/:reportId` |
| GET | `/api/reports` |

## Frontend Request Comparison

| Frontend Request | Backend Route Exists? | Status |
|---|---:|---|
| `POST /api/auth/login` | Yes | Working |
| `POST /api/auth/logout` | Yes | Working |
| `GET /api/auth/me` | Yes | Working |
| `GET /api/dashboard/summary?date=...` | Yes | Working |
| `GET /api/shops` | Yes | Working |
| `GET /api/shops/${shopId}/products?...` | Yes | Working |
| `POST /api/shops/${shopId}/products` | Yes | Route exists |
| `PUT /api/shops/${shopId}/products/${targetId}` | Yes | Route exists |
| `POST /api/shops/${shopId}/stock/adjust` | Yes | Route exists |
| `POST /api/shops/${shopId}/stock/bill-of-invoice` | Yes | Route exists |
| `GET /api/shops/${shopId}/stock/incoming?date=...` | Yes | Working |
| `POST /api/shops/${shopId}/bills` | Yes | Route exists |
| `GET /api/shops/${shopId}/bills?from=...&to=...` | Yes | Working |
| `GET /api/shops/${shopId}/bills/${billId}` | Yes | Route exists |
| `GET /api/shops/${shopId}/employees` | Yes | Working |
| `POST /api/shops/${shopId}/employees` | Yes | Route exists |
| `GET /api/shops/${shopId}/expenses?from=...&to=...` | Yes | Working |
| `POST /api/shops/${shopId}/expenses` | Yes | Route exists |
| `GET /api/reports?shopId=${shopId}` | Yes | Working |
| `POST /api/reports/daily` | Yes | Route exists |
| `DELETE /api/reports/${id}` | Yes | Route exists |
| `GET /api/ai/token` | Yes | Working route |
| `POST ${LOCAL_AI_BASE_URL}/api/chat` | External service | Requires chatbot backend on port 4000 |

## Feature Status

| Feature | Frontend | Backend | Status | Issue | Fix |
|---|---|---|---|---|---|
| Dashboard | `dashboard.html` | `/api/dashboard/summary` | Working | None after audit | Verified page load and KPI fetch |
| Billing | `shop.html#billing` | `/api/shops/:shopId/bills` | Working route/UI | No destructive bill creation was performed during audit | Verified controls and route map |
| Stock | `shop.html#stock` | `/api/shops/:shopId/products` | Fixed | Direct `#stock` URL left Billing pane active | Repaired hash tab activation |
| Invoice | `shop.html#boi` | `/api/shops/:shopId/stock/bill-of-invoice` | Fixed | Direct `#boi` URL left Billing pane active | Repaired hash tab activation |
| Sales | `shop.html#sales` | `/api/shops/:shopId/bills` | Fixed | Direct `#sales` URL left Billing pane active | Repaired hash tab activation |
| Reports | `shop.html#reports` | `/api/reports` and `/api/reports/daily` | Fixed | Direct `#reports` URL left Billing pane active | Repaired hash tab activation |
| Owner Login | `login.html` | `/api/auth/login` | Fixed | Owner redirected to `/shop.html?shopId=null` before fallback | Require positive numeric `shopId` before shop redirect |

## Verification Results

Browser verification with Playwright:

- Login page loaded.
- Owner login now lands directly on `/dashboard.html`.
- Dashboard loaded with no console errors.
- Billing loaded with visible search and Create Bill controls.
- Stock deep link loaded with visible product controls and product rows.
- Invoice deep link loaded with visible Bill of Invoice controls.
- Sales deep link loaded with visible sales controls.
- Reports deep link loaded with visible report controls and report rows.
- Failed network responses: none.
- JavaScript console/page errors after repair: none.

Authenticated API verification:

| API | Status |
|---|---:|
| `/api/auth/me` | 200 |
| `/api/dashboard/summary` | 200 |
| `/api/shops` | 200 |
| `/api/shops/1/products?limit=3` | 200 |
| `/api/shops/1/stock/incoming` | 200 |
| `/api/shops/1/bills` | 200 |
| `/api/shops/1/expenses` | 200 |
| `/api/shops/1/employees` | 200 |
| `/api/reports?shopId=1` | 200 |

## Working URLs

| Page | URL |
|---|---|
| Home | `http://localhost:3000/` |
| Login | `http://localhost:3000/login.html` |
| Dashboard | `http://localhost:3000/dashboard.html` |
| Billing | `http://localhost:3000/shop.html?shopId=1#billing` |
| Stock | `http://localhost:3000/shop.html?shopId=1#stock` |
| Invoice / KSBCL | `http://localhost:3000/shop.html?shopId=1#boi` |
| Sales | `http://localhost:3000/shop.html?shopId=1#sales` |
| Reports | `http://localhost:3000/shop.html?shopId=1#reports` |
| Owner | `http://localhost:3000/owner.html` |

## Notes

- The root npm files are currently present as `package.json.backup` and `package-lock.json.backup`; the Python app itself starts directly with `python3 python_server.py`.
- The AI chat widget depends on the separate chatbot backend at `LOCAL_AI_BASE_URL`, default `http://localhost:4000`.
- Billing creation was not exercised with a live test bill to avoid adding fake business data.
