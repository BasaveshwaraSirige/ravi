# SR Groups – Liquor & Bar Management System

Full‑stack, responsive web application for **Ravi Liquor Shop**, **Aishwarya Bar**, and **S R Residency (Lodging)**, with secure login, billing, stock, sales reports, employees, low‑stock SMS alerts, and daily PDF stock+sales reports (includes **daily incoming stock** and KSBCL “Bill of Invoice”).

## Tech stack

- Backend: **Python 3** (standard-library HTTP API + static frontend hosting)
- Database: **SQLite** (standard-library `sqlite3`)
- Frontend: **Vanilla HTML/CSS/JS** (responsive, colorful, works in any modern browser)
- SMS: **Twilio** (optional; if not configured, SMS actions are logged)

## Quick start

1) Copy env file:

```bash
cp .env.example .env
```

2) Set at least:

- `ADMIN_PASSWORD` (required for first login)

3) Run:

```bash
python3 python_server.py
```

4) Open:

- `http://localhost:3000`

## Default login

On first run, the Python server auto-creates/updates these users:

- Username: `ADMIN_USERNAME` (default `owner`)
- Password: `ADMIN_PASSWORD` (default `owner123`)

And three unit users (separate password per business unit):

- Ravi Liquor Shop: `SHOP1_USERNAME` / `SHOP1_PASSWORD` (default `ravi` / `ravi123`)
- Aishwarya Bar: `SHOP2_USERNAME` / `SHOP2_PASSWORD` (default `aishwarya` / `aishwarya123`)
- S R Residency (Lodging): `SHOP3_USERNAME` / `SHOP3_PASSWORD` (default `srresidency` / `srresidency123`)

Change these in `.env` before first run.

If the old Bun server created password hashes, the Python server converts the seeded users to Python password hashes on startup. If you later change a password in `.env`, restart the Python server.

## Database schema

SQLite schema lives at:

- `apps/api/sql/schema.sql`

The DB file defaults to:

- `./data/sr-groups.db`

## API endpoints (high level)

Auth:
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`

Dashboard:
- `GET /api/dashboard/summary?date=YYYY-MM-DD`

Shops:
- `GET /api/shops`
- `GET /api/shops/:shopId/summary?date=YYYY-MM-DD`

Products / Stock:
- `GET /api/shops/:shopId/products?search=...&startsWith=...&barcode=...&category=...&size=...`
- `POST /api/shops/:shopId/products`
- `PUT /api/shops/:shopId/products/:productId`
- `POST /api/shops/:shopId/stock/bill-of-invoice` (KSBCL incoming stock: cases+bottles)
- `POST /api/shops/:shopId/stock/adjust`
- `GET /api/shops/:shopId/stock/low`
- `GET /api/shops/:shopId/stock/incoming?date=YYYY-MM-DD`

Billing:
- `POST /api/shops/:shopId/bills`
- `GET /api/shops/:shopId/bills?from=YYYY-MM-DD&to=YYYY-MM-DD`
- `GET /api/shops/:shopId/bills/:billId`

Expenses:
- `POST /api/shops/:shopId/expenses`
- `GET /api/shops/:shopId/expenses?from=YYYY-MM-DD&to=YYYY-MM-DD`

Employees:
- `POST /api/shops/:shopId/employees`
- `GET /api/shops/:shopId/employees`

Reports (PDF + SMS):
- `POST /api/reports/daily` (generate + optionally SMS)
- `GET /api/reports?shopId=...` (list)
- `DELETE /api/reports/:reportId` (delete)
- `GET /reports/:fileName` (download)

## Daily PDF + SMS

The Python server auto-generates a daily PDF of **stock + sales** at `DAILY_REPORT_TIME` and sends a link via SMS to `DAILY_REPORT_SMS_TO`.
SMS sends a **download link** (PDF delivery over SMS requires a hosted URL).

To enable SMS, set Twilio:

- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_FROM_NUMBER`

If Twilio isn’t configured, the system still generates PDFs and prints what it would send to logs.

## Self-hosted local AI and forecasting

The local AI module is fully self-hosted:

- Node.js REST backend: `apps/chatbot`
- Python forecasting service: `apps/forecasting`
- PostgreSQL billing database
- Ollama local model runtime
- Forecast dashboard: `http://localhost:4000/forecast-dashboard.html`

Run the full local AI stack:

```bash
docker compose up --build
```

See:

- `docs/self-hosted-ai.md`

The old Bun API files are kept only as reference while the Python server is the runnable app backend.
