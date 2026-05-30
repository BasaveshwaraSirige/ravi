# Self-Hosted Local AI Module

This module runs entirely on your own server:

- Node.js backend: `apps/chatbot`
- Python forecasting service: `apps/forecasting`
- PostgreSQL database
- Ollama inference engine with local models only
- No AI API keys and no remote inference calls

## Architecture

```text
Browser dashboard
  -> Node.js REST API with JWT
    -> PostgreSQL billing data
    -> Ollama on localhost/private Docker network
    -> Python forecasting service
      -> PostgreSQL invoice, customer, and payment history
```

## API Endpoints

Authentication:

- `POST /api/auth/login`

Chat and business insight:

- `POST /api/chat`
- `GET /api/chat/sessions`
- `GET /api/chat/sessions/:sessionId`
- `GET /api/chat/sessions/:sessionId/export`
- `GET /api/models`

Forecasting:

- `GET /api/predictions/tomorrow-sales`
- `GET /api/predictions/weekly-revenue`
- `GET /api/predictions/monthly-revenue`
- `GET /api/predictions/tax-forecast`

Each forecast response includes:

- Selected best model
- Model backtest scores
- Predictions
- Confidence interval
- Trend analysis
- Business insights

## Local Model Setup

Install Ollama on the server and download at least one allowed local model:

```bash
ollama pull llama3
ollama pull qwen
ollama pull mistral
ollama pull gemma
```

Default model:

```bash
OLLAMA_MODEL=llama3
```

Allowed model prefixes:

```bash
ALLOWED_LOCAL_MODELS=llama3,qwen,mistral,gemma
```

## Run with Docker

```bash
docker compose up --build
```

Open:

```text
http://localhost:4000/forecast-dashboard.html
```

The first model download must be done once on the server. After that, inference uses the local model files.

## Run Manually

Backend:

```bash
cd apps/chatbot
cp .env.example .env
npm install
npm run migrate
npm start
```

Forecasting:

```bash
cd apps/forecasting
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 5001
```

## Security

- JWT authentication is required for all public AI and forecast endpoints.
- Staff users are restricted to their own `shop_id`.
- Owner users can view all shops or pass `shopId`.
- Billing tools use fixed parameterized SQL only.
- The model never receives database credentials.
- The model cannot generate or run SQL.
- Forecasting service is internal and requires `INTERNAL_SERVICE_TOKEN`.

## Database

PostgreSQL schema lives at:

```text
apps/chatbot/sql/schema.postgres.sql
```

Important tables:

- `invoices`
- `invoice_items`
- `payments`
- `customers`
- `products`
- `chat_sessions`
- `chat_messages`
- `chatbot_settings`
- `forecast_runs`
