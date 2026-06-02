import { query, queryOne } from "../db.js";
import { config } from "../config.js";
import { sanitizeText } from "../utils/sanitize.js";

function nextParam(params, value) {
  params.push(value);
  return `$${params.length}`;
}

function shopFilter(user, alias = "i", explicitShopId = null, params = []) {
  if (user.role !== "OWNER") {
    return ` AND ${alias}.shop_id = ${nextParam(params, user.shopId)}`;
  }
  if (explicitShopId) {
    return ` AND ${alias}.shop_id = ${nextParam(params, explicitShopId)}`;
  }
  return "";
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function clampLimit(limit) {
  return Math.min(Math.max(Number.parseInt(String(limit || "8"), 10) || 8, 1), config.maxToolRows);
}

function extractDateRange(question) {
  const today = todayIso();
  const lower = String(question || "").toLowerCase();
  if (lower.includes("today")) return { from: today, to: today };
  if (lower.includes("week")) {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    return { from: d.toISOString().slice(0, 10), to: today };
  }
  if (lower.includes("month")) {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return { from: d.toISOString().slice(0, 10), to: today };
  }
  const date = String(question || "").match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (date) return { from: date[1], to: date[1] };
  return { from: today, to: today };
}

function extractInvoiceNo(question) {
  return String(question || "").match(/\b(?:bill|invoice)\s*(?:no|number|#)?\s*[:\-]?\s*(\d{1,12})\b/i)?.[1] || null;
}

function extractProductQuery(question) {
  const match =
    String(question || "").match(/\b(?:product|stock|item)\s+(?:name\s+)?([a-z0-9 &.'-]{2,40})/i) ||
    String(question || "").match(/\b(?:search|find)\s+([a-z0-9 &.'-]{2,40})/i);
  return sanitizeText(match?.[1] || question, 60);
}

export const billingTools = {
  async getRecentInvoices(user, args = {}) {
    const limit = clampLimit(args.limit);
    const range = args.from ? { from: args.from, to: args.to || args.from } : extractDateRange(args.question || "");
    const params = [range.from, range.to];
    const filter = shopFilter(user, "i", args.shopId, params);
    params.push(limit);
    return query(
      `SELECT i.id, i.invoice_no, COALESCE(c.name, 'Walk-in') AS customer_name,
              i.subtotal, i.tax_total, i.total, i.status, i.issued_at, s.name AS shop_name
       FROM invoices i
       JOIN shops s ON s.id = i.shop_id
       LEFT JOIN customers c ON c.id = i.customer_id
       WHERE i.issued_at::date BETWEEN $1::date AND $2::date ${filter}
       ORDER BY i.issued_at DESC
       LIMIT $${params.length}`,
      params
    );
  },

  async getInvoiceByNumber(user, args = {}) {
    const invoiceNo = sanitizeText(args.invoiceNo || extractInvoiceNo(args.question || "") || "", 32);
    if (!invoiceNo) return [];
    const params = [invoiceNo];
    const filter = shopFilter(user, "i", args.shopId, params);
    const invoice = await queryOne(
      `SELECT i.id, i.invoice_no, COALESCE(c.name, 'Walk-in') AS customer_name,
              i.subtotal, i.tax_total, i.total, i.status, i.issued_at, s.name AS shop_name
       FROM invoices i
       JOIN shops s ON s.id = i.shop_id
       LEFT JOIN customers c ON c.id = i.customer_id
       WHERE i.invoice_no = $1 ${filter}
       ORDER BY i.issued_at DESC
       LIMIT 1`,
      params
    );
    if (!invoice) return [];
    const items = await query(
      `SELECT item_name, qty, unit_price, tax_amount, line_total
       FROM invoice_items
       WHERE invoice_id = $1
       ORDER BY id ASC`,
      [invoice.id]
    );
    const payments = await query(
      `SELECT method, amount, paid_at
       FROM payments
       WHERE invoice_id = $1
       ORDER BY paid_at ASC`,
      [invoice.id]
    );
    return [{ ...invoice, items, payments }];
  },

  async getPaymentSummary(user, args = {}) {
    const range = args.from ? { from: args.from, to: args.to || args.from } : extractDateRange(args.question || "");
    const params = [range.from, range.to];
    const filter = shopFilter(user, "p", args.shopId, params);
    return query(
      `SELECT p.method, COUNT(*) AS payment_count, ROUND(SUM(p.amount), 2) AS total_amount
       FROM payments p
       WHERE p.paid_at::date BETWEEN $1::date AND $2::date ${filter}
       GROUP BY p.method
       ORDER BY total_amount DESC`,
      params
    );
  },

  async searchProducts(user, args = {}) {
    const productQuery = sanitizeText(args.query || extractProductQuery(args.question || ""), 60);
    const params = [`%${productQuery}%`];
    const filter = shopFilter(user, "p", args.shopId, params);
    params.push(clampLimit(args.limit));
    return query(
      `SELECT p.id, p.name, p.category, p.size, p.current_qty, p.sale_price, s.name AS shop_name
       FROM products p
       JOIN shops s ON s.id = p.shop_id
       WHERE p.name ILIKE $1 ${filter}
       ORDER BY p.name ASC, p.size ASC
       LIMIT $${params.length}`,
      params
    );
  },

  async getLowStockProducts(user, args = {}) {
    const params = [];
    const filter = shopFilter(user, "p", args.shopId, params);
    params.push(clampLimit(args.limit));
    return query(
      `SELECT p.name, p.category, p.size, p.current_qty, p.min_qty, s.name AS shop_name
       FROM products p
       JOIN shops s ON s.id = p.shop_id
       WHERE p.current_qty < p.min_qty ${filter}
       ORDER BY (p.min_qty - p.current_qty) DESC
       LIMIT $${params.length}`,
      params
    );
  },

  async getCustomerSummary(user, args = {}) {
    const customerQuery = sanitizeText(args.query || args.question || "", 80);
    const params = [`%${customerQuery}%`];
    const filter = shopFilter(user, "i", args.shopId, params);
    params.push(clampLimit(args.limit));
    return query(
      `SELECT COALESCE(c.name, 'Walk-in') AS customer_name,
              COUNT(i.id) AS invoice_count,
              ROUND(SUM(i.total), 2) AS total_amount,
              MAX(i.issued_at) AS last_invoice_at
       FROM invoices i
       LEFT JOIN customers c ON c.id = i.customer_id
       WHERE COALESCE(c.name, 'Walk-in') ILIKE $1 ${filter}
       GROUP BY COALESCE(c.name, 'Walk-in')
       ORDER BY total_amount DESC
       LIMIT $${params.length}`,
      params
    );
  },

  async getReports(user, args = {}) {
    const params = [];
    let where = "";
    if (user.role !== "OWNER") {
      where = `WHERE r.shop_id = ${nextParam(params, user.shopId)}`;
    } else if (args.shopId) {
      where = `WHERE r.shop_id = ${nextParam(params, args.shopId)}`;
    }
    params.push(clampLimit(args.limit));
    return query(
      `SELECT r.report_date, r.kind, r.file_name, r.created_at, s.name AS shop_name
       FROM reports r
       LEFT JOIN shops s ON s.id = r.shop_id
       ${where}
       ORDER BY r.created_at DESC
       LIMIT $${params.length}`,
      params
    );
  }
};

export function inferToolRequests(question) {
  const text = String(question || "").toLowerCase();
  const requests = [];

  if (/\b(invoice|bill)\b/.test(text)) {
    const invoiceNo = extractInvoiceNo(question);
    requests.push(invoiceNo ? { name: "getInvoiceByNumber", args: { invoiceNo, question } } : { name: "getRecentInvoices", args: { question } });
  }
  if (/\b(payment|cash|upi|card|method)\b/.test(text)) requests.push({ name: "getPaymentSummary", args: { question } });
  if (/\b(product|stock|item|price|rate|mrp)\b/.test(text)) requests.push({ name: "searchProducts", args: { question } });
  if (/\b(low stock|minimum|min qty|shortage)\b/.test(text)) requests.push({ name: "getLowStockProducts", args: { question } });
  if (/\b(customer|buyer)\b/.test(text)) requests.push({ name: "getCustomerSummary", args: { question } });
  if (/\b(report|pdf|daily report)\b/.test(text)) requests.push({ name: "getReports", args: { question } });

  return requests.slice(0, 4);
}

async function runLiveBillingTools(question, authToken) {
  if (!config.billingApiUrl || !authToken) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.billingApiTimeoutMs);
  try {
    const response = await fetch(`${config.billingApiUrl}/api/internal/ai/billing-tools`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({ question })
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(data?.error?.message || `Billing bridge failed (${response.status})`);
    }
    return Array.isArray(data?.results) ? data.results : [];
  } finally {
    clearTimeout(timeout);
  }
}

async function runPostgresBillingTools(user, question) {
  const requests = inferToolRequests(question);
  const results = [];
  for (const request of requests) {
    const fn = billingTools[request.name];
    if (!fn) {
      results.push({ name: request.name, error: "Tool not allowed" });
      continue;
    }
    try {
      results.push({ name: request.name, rows: await fn(user, request.args) });
    } catch (error) {
      results.push({ name: request.name, error: error.message });
    }
  }
  return results;
}

export async function runBillingTools(user, question, authToken = "") {
  try {
    const liveResults = await runLiveBillingTools(question, authToken);
    if (liveResults) return liveResults;
  } catch (error) {
    const fallback = await runPostgresBillingTools(user, question);
    return [{ name: "liveBillingBridge", error: error.message }, ...fallback];
  }
  return runPostgresBillingTools(user, question);
}
