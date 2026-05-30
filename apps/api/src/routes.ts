import type { Db } from "./db";
import { Router } from "./router";
import { jsonResponse, errorResponse, readJson } from "./http";
import {
  createSession,
  deleteSessionByToken,
  getSessionTokenFromRequest,
  loginWithPassword,
  requireAuth,
  setSessionCookie,
  clearSessionCookie
} from "./auth";
import { dateIso } from "./db";
import { maybeNotifyLowStock } from "./lowStock";
import { generateDailyStockSalesReport, sendDailyReportSmsLink } from "./reports";
import { env } from "./env";
import {
  canonicalSize,
  defaultSizeForCategory,
  isValidSizeForCategory,
  normalizeBottlesPerCase,
  normalizeCategory,
  normalizeSize,
  type ProductCategory
} from "./products";
import { unlink } from "node:fs/promises";
import { resolve, sep } from "node:path";

function asNumber(v: any) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function money(n: number) {
  return Number.isFinite(n) ? Number(n.toFixed(2)) : 0;
}

const _columnCache = new Map<string, boolean>();
function hasColumn(db: Db, table: string, column: string) {
  const key = `${table}.${column}`;
  const cached = _columnCache.get(key);
  if (cached !== undefined) return cached;
  if (!/^[A-Za-z0-9_]+$/.test(table) || !/^[A-Za-z0-9_]+$/.test(column)) return false;
  const rows = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
  const has = rows.some((r) => r.name === column);
  _columnCache.set(key, has);
  return has;
}

function safeResolve(rootAbs: string, urlPath: string) {
  if (urlPath.includes("\0")) return null;
  const abs = resolve(rootAbs, "." + urlPath);
  if (abs === rootAbs) return abs;
  if (!abs.startsWith(rootAbs + sep)) return null;
  return abs;
}

function parseShopId(params: Record<string, string>) {
  const shopId = Number.parseInt(params.shopId ?? "", 10);
  if (!Number.isFinite(shopId)) throw new Error("INVALID_SHOP");
  return shopId;
}

function parseProductId(params: Record<string, string>) {
  const productId = Number.parseInt(params.productId ?? "", 10);
  if (!Number.isFinite(productId)) throw new Error("INVALID_PRODUCT");
  return productId;
}

function requireShopAccess(user: { role: string; shopId: number | null }, shopId: number) {
  if (user.role === "OWNER") return;
  if (!user.shopId || user.shopId !== shopId) throw new Error("FORBIDDEN");
}

export function buildRouter(db: Db) {
  const r = new Router();

  r.on("GET", "/api/health", () => jsonResponse({ ok: true }));

  r.on("POST", "/api/auth/login", async ({ req }) => {
    const body = await readJson(req);
    const username = String(body?.username ?? "").trim();
    const password = String(body?.password ?? "");
    if (!username || !password) return errorResponse(400, "Missing username/password");

    const user = await loginWithPassword(db, username, password);
    if (!user) return errorResponse(401, "Invalid credentials");

    const session = createSession(db, user.id);
    const headers = new Headers();
    setSessionCookie(headers, session.token);
    return jsonResponse({ ok: true, user }, { headers });
  });

  r.on("POST", "/api/auth/logout", ({ req }) => {
    const token = getSessionTokenFromRequest(req);
    if (token) deleteSessionByToken(db, token);
    const headers = new Headers();
    clearSessionCookie(headers);
    return jsonResponse({ ok: true }, { headers });
  });

	  r.on("GET", "/api/auth/me", ({ req }) => {
	    try {
	      const user = requireAuth(db, req);
	      return jsonResponse({ ok: true, user, ai: { enabled: true, engine: "local-ollama" } });
	    } catch {
	      return errorResponse(401, "Unauthorized");
	    }
	  });

	  r.on("POST", "/api/ai/chat", ({ req }) => {
	    try {
	      requireAuth(db, req);
	      return errorResponse(501, "Local AI moved", "Use the self-hosted Node/Ollama service.");
	    } catch (e: any) {
	      const msg = String(e?.message ?? e);
	      if (msg === "UNAUTHORIZED") return errorResponse(401, "Unauthorized");
	      return errorResponse(500, "AI error", msg);
	    }
	  });

	  r.on("GET", "/api/shops", ({ req }) => {
	    try {
	      const user = requireAuth(db, req);
      const shops =
        user.role === "OWNER"
          ? (db.query("SELECT id, name, address FROM shops ORDER BY id").all() as any[])
          : (db
              .query("SELECT id, name, address FROM shops WHERE id = ? ORDER BY id")
              .all(user.shopId) as any[]);
      return jsonResponse({ ok: true, shops });
    } catch {
      return errorResponse(401, "Unauthorized");
    }
  });

  r.on("GET", "/api/dashboard/summary", ({ req, url }) => {
    try {
      const user = requireAuth(db, req);
      const date = url.searchParams.get("date") ?? dateIso(new Date());
      const shops =
        user.role === "OWNER"
          ? (db.query("SELECT id, name FROM shops ORDER BY id").all() as any[])
          : (db.query("SELECT id, name FROM shops WHERE id = ? ORDER BY id").all(user.shopId) as any[]);
      const perShop = shops.map((s) => computeDailySummary(db, s.id, date));
      const combined = combineSummaries(perShop);
      return jsonResponse({ ok: true, date, combined, shops: perShop });
    } catch (e) {
      return errorResponse(500, "Failed to build summary", String(e));
    }
  });

  r.on("GET", "/api/shops/:shopId/summary", ({ req, url, params }) => {
    try {
      const user = requireAuth(db, req);
      const date = url.searchParams.get("date") ?? dateIso(new Date());
      const shopId = parseShopId(params);
      requireShopAccess(user, shopId);
      const sum = computeDailySummary(db, shopId, date);
      return jsonResponse({ ok: true, date, summary: sum });
    } catch (e) {
      if (String((e as any)?.message ?? e) === "FORBIDDEN") return errorResponse(403, "Forbidden");
      return errorResponse(500, "Failed to build shop summary", String(e));
    }
  });

  // Products
  r.on("GET", "/api/shops/:shopId/products", ({ req, url, params }) => {
    try {
      const user = requireAuth(db, req);
      const shopId = parseShopId(params);
      requireShopAccess(user, shopId);
      const search = (url.searchParams.get("search") ?? "").trim();
      const startsWith = (url.searchParams.get("startsWith") ?? "").trim();
      const barcode = (url.searchParams.get("barcode") ?? "").trim();
      const categoryRaw = (url.searchParams.get("category") ?? "").trim();
      const sizeRaw = (url.searchParams.get("size") ?? "").trim();
      const size = canonicalSize(sizeRaw);
      const includeTotalRaw = (url.searchParams.get("includeTotal") ?? "").trim();
      const includeTotal = /^(1|true|yes)$/i.test(includeTotalRaw);
      const othersItemsOnlyRaw = (url.searchParams.get("othersItemsOnly") ?? "").trim();
      const othersItemsOnly = /^(1|true|yes)$/i.test(othersItemsOnlyRaw);
      const limitRaw = Number.parseInt((url.searchParams.get("limit") ?? "").trim(), 10);
      const offsetRaw = Number.parseInt((url.searchParams.get("offset") ?? "").trim(), 10);
      const limitParam = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 5000) : null;
      const offset = Number.isFinite(offsetRaw) ? Math.max(offsetRaw, 0) : 0;
      const nonStockOthersClause = "(size IS NULL AND current_qty = 0 AND min_qty = 0 AND barcode IS NULL)";

      const where: string[] = ["shop_id = ?"];
      const q: any[] = [shopId];
      let viewingOthersItems = false;

      if (categoryRaw && categoryRaw.toUpperCase() !== "ALL") {
        const key = categoryRaw.toUpperCase().replace(/[\s-]+/g, "_");
        if (key === "OTHERS_PLUS_GIN") {
          where.push(nonStockOthersClause);
          viewingOthersItems = true;
        } else {
          where.push("category = ?");
          q.push(normalizeCategory(key));
        }
      }

      if (othersItemsOnly && !viewingOthersItems) {
        where.push(nonStockOthersClause);
        viewingOthersItems = true;
      }

      if (!viewingOthersItems) {
        where.push(`NOT ${nonStockOthersClause}`);
      }

      if (size) {
        where.push("size = ?");
        q.push(size);
      }

      let rows: any[] = [];
      let total: number | undefined = undefined;
      if (barcode) {
        rows = db
          .query("SELECT * FROM products WHERE shop_id = ? AND barcode = ? LIMIT 1")
          .all(shopId, barcode) as any[];
      } else if (startsWith) {
        const startsWithLimit = limitParam ?? 80;
        rows = db
          .query(
            `SELECT * FROM products
             WHERE ${where.join(" AND ")} AND name LIKE ?
             ORDER BY name COLLATE NOCASE ASC, size ASC, id ASC
             LIMIT ? OFFSET ?`
          )
          .all(...q, `${startsWith}%`, startsWithLimit, offset) as any[];
        if (includeTotal) {
          const countRow = db
            .query(
              `SELECT COUNT(1) AS c
               FROM products
               WHERE ${where.join(" AND ")} AND name LIKE ?`
            )
            .get(...q, `${startsWith}%`) as any;
          total = Number(countRow?.c ?? 0);
        }
      } else if (search) {
        const searchLimit = limitParam ?? 50;
        rows = db
          .query(
            `SELECT * FROM products
             WHERE ${where.join(" AND ")} AND name LIKE ?
             ORDER BY name COLLATE NOCASE ASC, size ASC, id ASC
             LIMIT ? OFFSET ?`
          )
          .all(...q, `%${search}%`, searchLimit, offset) as any[];
        if (includeTotal) {
          const countRow = db
            .query(
              `SELECT COUNT(1) AS c
               FROM products
               WHERE ${where.join(" AND ")} AND name LIKE ?`
            )
            .get(...q, `%${search}%`) as any;
          total = Number(countRow?.c ?? 0);
        }
      } else {
        const plainLimit = limitParam ?? 200;
        rows = db
          .query(
            `SELECT * FROM products
             WHERE ${where.join(" AND ")}
             ORDER BY name COLLATE NOCASE ASC, size ASC, id ASC
             LIMIT ? OFFSET ?`
          )
          .all(...q, plainLimit, offset) as any[];
        if (includeTotal) {
          const countRow = db
            .query(
              `SELECT COUNT(1) AS c
               FROM products
               WHERE ${where.join(" AND ")}`
            )
            .get(...q) as any;
          total = Number(countRow?.c ?? 0);
        }
      }
      return jsonResponse(includeTotal ? { ok: true, products: rows, total } : { ok: true, products: rows });
    } catch (e) {
      if (String((e as any)?.message ?? e) === "FORBIDDEN") return errorResponse(403, "Forbidden");
      return errorResponse(500, "Failed to load products", String(e));
    }
  });

	  r.on("POST", "/api/shops/:shopId/products", async ({ req, params }) => {
	    try {
	      const user = requireAuth(db, req);
	      const shopId = parseShopId(params);
        requireShopAccess(user, shopId);
	      const body = await readJson(req);
	      const name = String(body?.name ?? "").trim();
	      if (!name) return errorResponse(400, "Product name required");

	      const quickAdd = String(body?.quickAdd ?? "").trim().toUpperCase();

	      let barcode = String(body?.barcode ?? "").trim() || null;
	      let sku = String(body?.sku ?? "").trim() || null;
        let unit = String(body?.unit ?? "unit").trim() || "unit";
        let category: ProductCategory = normalizeCategory(body?.category);
        let size: string | null = normalizeSize(category, body?.size);
        let bottlesPerCase = normalizeBottlesPerCase(category, size, body?.bottlesPerCase);
	      let salePrice = asNumber(body?.salePrice ?? body?.mrp ?? 0);
	      let costPrice = 0;
	      let minQty = asNumber(body?.minQty ?? 0);
	      let currentQty = asNumber(body?.currentQty ?? 0);

		      if (quickAdd === "OTHERS_ITEMS") {
		        // Always store in OTHERS so it shows under "Others Items" in the UI.
		        category = "OTHERS";
		        size = null;

		        // Keep quick-add minimal.
		        barcode = null;
		        sku = null;
		        unit = "unit";
		        bottlesPerCase = 0;
		        minQty = 0;
		        currentQty = 0;
		        costPrice = 0;
		      }

      const res = db
        .query(
          `INSERT INTO products (shop_id, sku, name, barcode, unit, category, size, bottles_per_case, sale_price, cost_price, min_qty, current_qty, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))`
        )
        .run(
          shopId,
          sku,
          name,
          barcode,
          unit,
          category,
          size,
          bottlesPerCase,
          salePrice,
          costPrice,
          minQty,
          currentQty
        );

	      const id = Number(res.lastInsertRowid);
	      db.query(
	        `INSERT INTO stock_transactions (shop_id, product_id, type, qty, note, user_id, created_at)
	         VALUES (?, ?, 'ADJUST', ?, 'Initial stock', ?, datetime('now','localtime'))`
	      ).run(shopId, id, currentQty, user.id);

      await maybeNotifyLowStock(db, shopId, id);
      return jsonResponse({ ok: true, id, category, size });
    } catch (e) {
      if (String((e as any)?.message ?? e) === "FORBIDDEN") return errorResponse(403, "Forbidden");
      return errorResponse(500, "Failed to create product", String(e));
    }
  });

	  r.on("PUT", "/api/shops/:shopId/products/:productId", async ({ req, params }) => {
	    try {
	      const user = requireAuth(db, req);
	      const shopId = parseShopId(params);
        requireShopAccess(user, shopId);
	      const productId = parseProductId(params);
	      const body = await readJson(req);

	      const name = String(body?.name ?? "").trim();
	      const barcode = String(body?.barcode ?? "").trim() || null;
	      const sku = String(body?.sku ?? "").trim() || null;
	      const unit = String(body?.unit ?? "unit").trim() || "unit";
	      const salePrice = asNumber(body?.salePrice ?? 0);
	      const minQty = asNumber(body?.minQty ?? 0);

      if (!name) return errorResponse(400, "Product name required");

      const existing = db
        .query("SELECT category, size, bottles_per_case FROM products WHERE id = ? AND shop_id = ?")
        .get(productId, shopId) as any;
      if (!existing) return errorResponse(404, "Product not found");

      const existingCategory = normalizeCategory(existing.category);
      const existingSize = canonicalSize(existing.size);
      const existingBpc = Number.parseInt(String(existing.bottles_per_case ?? "12"), 10);

      const category =
        body?.category === undefined ? existingCategory : normalizeCategory(body?.category);

      let size: string;
      if (body?.size !== undefined) {
        size = normalizeSize(category, body?.size);
      } else if (body?.category !== undefined) {
        size = isValidSizeForCategory(category, existingSize)
          ? (existingSize as string)
          : defaultSizeForCategory(category);
      } else {
        size = isValidSizeForCategory(existingCategory, existingSize)
          ? (existingSize as string)
          : defaultSizeForCategory(existingCategory);
      }

      const bpcInput =
        body?.bottlesPerCase === undefined
          ? Number.isFinite(existingBpc) && existingBpc > 0
            ? existingBpc
            : 12
          : body?.bottlesPerCase;
      const bottlesPerCase = normalizeBottlesPerCase(category, size, bpcInput);

      db.query(
        `UPDATE products
         SET sku = ?, name = ?, barcode = ?, unit = ?, category = ?, size = ?, bottles_per_case = ?, sale_price = ?, min_qty = ?, updated_at = datetime('now','localtime')
         WHERE id = ? AND shop_id = ?`
      ).run(
        sku,
        name,
        barcode,
        unit,
        category,
        size,
        bottlesPerCase,
        salePrice,
        minQty,
        productId,
        shopId
      );

	      await maybeNotifyLowStock(db, shopId, productId);
	      return jsonResponse({ ok: true });
	    } catch (e) {
	      if (String((e as any)?.message ?? e) === "FORBIDDEN") return errorResponse(403, "Forbidden");
	      return errorResponse(500, "Failed to update product", String(e));
	    }
	  });

	  r.on("DELETE", "/api/shops/:shopId/products/:productId", async ({ req, params }) => {
	    try {
	      const user = requireAuth(db, req);
	      const shopId = parseShopId(params);
	      requireShopAccess(user, shopId);
	      const productId = parseProductId(params);

	      const existing = db
	        .query("SELECT id FROM products WHERE id = ? AND shop_id = ?")
	        .get(productId, shopId) as any;
	      if (!existing) return errorResponse(404, "Product not found");

	      const usedInBills = db
	        .query("SELECT 1 FROM bill_items WHERE product_id = ? LIMIT 1")
	        .get(productId) as any;
	      if (usedInBills) return errorResponse(409, "Cannot delete product (used in bills)");

	      db.query("DELETE FROM products WHERE id = ? AND shop_id = ?").run(productId, shopId);
	      return jsonResponse({ ok: true });
	    } catch (e) {
	      const msg = String((e as any)?.message ?? e);
	      if (msg === "FORBIDDEN") return errorResponse(403, "Forbidden");
	      if (msg === "INVALID_SHOP") return errorResponse(400, "Invalid shopId");
	      if (msg === "INVALID_PRODUCT") return errorResponse(400, "Invalid productId");
	      return errorResponse(500, "Failed to delete product", String(e));
	    }
	  });

	  // KSBCL Bill of Invoice (cases + bottles)
	  r.on("POST", "/api/shops/:shopId/stock/bill-of-invoice", async ({ req, params }) => {
	    try {
	      const user = requireAuth(db, req);
      const shopId = parseShopId(params);
      requireShopAccess(user, shopId);
      const body = await readJson(req);
      const date = String(body?.date ?? "").trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return errorResponse(400, "Invalid date");
      const invoiceNoInput = String(body?.invoiceNo ?? "").trim();
      const permitNoInput = String(body?.permitNo ?? "").trim() || null;
      const vehicleRegNoInput = String(body?.vehicleRegNo ?? "").trim() || null;
      const productId = Number.parseInt(String(body?.productId ?? ""), 10);
      if (!Number.isFinite(productId)) return errorResponse(400, "Invalid productId");
      const cases = Number.parseInt(String(body?.cases ?? "0"), 10);
      const bottles = Number.parseInt(String(body?.bottles ?? "0"), 10);
      const c = Number.isFinite(cases) && cases >= 0 ? cases : 0;
      const b = Number.isFinite(bottles) && bottles >= 0 ? bottles : 0;
      if (c + b <= 0) return errorResponse(400, "Cases/Bottles required");

      const existingInvoiceForDate = db
        .query(
          `SELECT invoice_no, permit_no, vehicle_no
             FROM stock_transactions
            WHERE shop_id = ?
              AND type = 'IN'
              AND note = 'KSBCL BILL OF INVOICE'
              AND doc_date = ?
            LIMIT 1`
        )
        .get(shopId, date) as any;
      let invoiceNo = invoiceNoInput;
      let permitNo = permitNoInput;
      let vehicleRegNo = vehicleRegNoInput;
      if (!existingInvoiceForDate) {
        if (!invoiceNo) return errorResponse(400, "Invoice No required");
      } else {
        const existingInvoiceNo = String(existingInvoiceForDate.invoice_no ?? "").trim();
        const existingPermitNo = String(existingInvoiceForDate.permit_no ?? "").trim() || null;
        const existingVehicleNo = String(existingInvoiceForDate.vehicle_no ?? "").trim() || null;

        const invoiceMismatch = invoiceNoInput && invoiceNoInput !== existingInvoiceNo;
        const permitMismatch = permitNoInput !== null && permitNoInput !== existingPermitNo;
        const vehicleMismatch = vehicleRegNoInput !== null && vehicleRegNoInput !== existingVehicleNo;
        if (invoiceMismatch || permitMismatch || vehicleMismatch) {
          return errorResponse(409, "Invoice/Permit/Vehicle already set for this date");
        }

        invoiceNo = existingInvoiceNo;
        permitNo = existingPermitNo;
        vehicleRegNo = existingVehicleNo;
      }

      const p = db
        .query("SELECT category, size, bottles_per_case FROM products WHERE id = ? AND shop_id = ?")
        .get(productId, shopId) as any;
      if (!p) return errorResponse(404, "Product not found");
      const productCategory = normalizeCategory(p.category);
      const productSize = canonicalSize(p.size);
      const bottlesPerCase = normalizeBottlesPerCase(
        productCategory,
        productSize,
        p.bottles_per_case
      );

      const qty = c * bottlesPerCase + b;
      if (qty <= 0) return errorResponse(400, "Quantity must be > 0");

      db.query(
        "UPDATE products SET current_qty = current_qty + ?, updated_at = datetime('now','localtime') WHERE id = ? AND shop_id = ?"
      ).run(qty, productId, shopId);

      db.query(
        `INSERT INTO stock_transactions
          (shop_id, product_id, type, qty, note, doc_date, invoice_no, permit_no, vehicle_no, incoming_name, cases, bottles, source, user_id, created_at)
         VALUES
          (?, ?, 'IN', ?, 'KSBCL BILL OF INVOICE', ?, ?, ?, ?, 'KSBCL liquor depot', ?, ?, 'KSBCL', ?, datetime('now','localtime'))`
      ).run(shopId, productId, qty, date, invoiceNo, permitNo, vehicleRegNo, c, b, user.id);

      return jsonResponse({ ok: true });
    } catch (e) {
      if (String((e as any)?.message ?? e) === "FORBIDDEN") return errorResponse(403, "Forbidden");
      return errorResponse(500, "Failed bill of invoice", String(e));
    }
  });

  // Stock adjust
  r.on("POST", "/api/shops/:shopId/stock/adjust", async ({ req, params }) => {
    try {
      const user = requireAuth(db, req);
      const shopId = parseShopId(params);
      requireShopAccess(user, shopId);
      const body = await readJson(req);
      const productId = Number.parseInt(String(body?.productId ?? ""), 10);
      const newQty = asNumber(body?.newQty ?? 0);
      const note = String(body?.note ?? "Stock adjust").trim();
      if (!Number.isFinite(productId)) return errorResponse(400, "Invalid productId");

      const row = db
        .query("SELECT current_qty FROM products WHERE id = ? AND shop_id = ?")
        .get(productId, shopId) as any;
      if (!row) return errorResponse(404, "Product not found");
      const diff = newQty - asNumber(row.current_qty);

      db.query(
        "UPDATE products SET current_qty = ?, updated_at = datetime('now','localtime') WHERE id = ? AND shop_id = ?"
      ).run(newQty, productId, shopId);

	      db.query(
	        `INSERT INTO stock_transactions (shop_id, product_id, type, qty, note, user_id, created_at)
	         VALUES (?, ?, 'ADJUST', ?, ?, ?, datetime('now','localtime'))`
	      ).run(shopId, productId, diff, note, user.id);

      await maybeNotifyLowStock(db, shopId, productId);
      return jsonResponse({ ok: true });
    } catch (e) {
      if (String((e as any)?.message ?? e) === "FORBIDDEN") return errorResponse(403, "Forbidden");
      return errorResponse(500, "Failed stock adjust", String(e));
    }
  });

	  r.on("GET", "/api/shops/:shopId/stock/low", ({ req, params }) => {
	    try {
	      const user = requireAuth(db, req);
	      const shopId = parseShopId(params);
        requireShopAccess(user, shopId);
	      const rows = db
        .query(
          `SELECT id, name, barcode, current_qty, min_qty
           FROM products
           WHERE shop_id = ? AND current_qty < min_qty
           ORDER BY (min_qty - current_qty) DESC`
        )
        .all(shopId) as any[];
	      return jsonResponse({ ok: true, items: rows });
	    } catch (e) {
        if (String((e as any)?.message ?? e) === "FORBIDDEN") return errorResponse(403, "Forbidden");
	      return errorResponse(500, "Failed to load low stock", String(e));
	    }
	  });

	  r.on("GET", "/api/shops/:shopId/stock/incoming", ({ req, url, params }) => {
	    try {
	      const user = requireAuth(db, req);
	      const shopId = parseShopId(params);
        requireShopAccess(user, shopId);
	      const date = url.searchParams.get("date") ?? dateIso(new Date());
	      const rows = db
	        .query(
	          `SELECT st.id, st.created_at, st.doc_date, st.qty, st.note, st.invoice_no, st.permit_no, st.vehicle_no, st.incoming_name, st.cases, st.bottles, st.source,
	                  p.name as product_name, p.barcode as barcode, p.size as size
	           FROM stock_transactions st
	           JOIN products p ON p.id = st.product_id
	           WHERE st.shop_id = ? AND st.type = 'IN' AND COALESCE(st.doc_date, date(st.created_at)) = ?
	           ORDER BY st.created_at DESC
	           LIMIT 200`
	        )
	        .all(shopId, date) as any[];
	      return jsonResponse({ ok: true, date, rows });
	    } catch (e) {
        if (String((e as any)?.message ?? e) === "FORBIDDEN") return errorResponse(403, "Forbidden");
	      return errorResponse(500, "Failed to load incoming stock", String(e));
	    }
	  });

	  // Bills
	  r.on("POST", "/api/shops/:shopId/bills", async ({ req, params }) => {
	    try {
      const user = requireAuth(db, req);
      const shopId = parseShopId(params);
      requireShopAccess(user, shopId);
      const body = await readJson(req);
      const items = Array.isArray(body?.items) ? body.items : [];
      const paymentMethod = String(body?.paymentMethod ?? "CASH").toUpperCase();
      if (items.length === 0) return errorResponse(400, "No items");

      const result = createBill(db, {
        shopId,
        userId: user.id,
        items: items.map((it: any) => ({
          productId: Number.parseInt(String(it.productId ?? ""), 10),
          qty: asNumber(it.qty ?? 1)
        })),
        paymentMethod
      });

      for (const pid of result.updatedProductIds) {
        await maybeNotifyLowStock(db, shopId, pid);
      }

      return jsonResponse({ ok: true, bill: result.bill });
    } catch (e: any) {
      if (String(e?.message ?? e) === "FORBIDDEN") return errorResponse(403, "Forbidden");
      if (String(e?.message ?? e) === "INSUFFICIENT_STOCK") {
        return errorResponse(400, "Insufficient stock for one or more items");
      }
      return errorResponse(500, "Failed to create bill", String(e));
    }
  });

  r.on("GET", "/api/shops/:shopId/bills", ({ req, url, params }) => {
    try {
      const user = requireAuth(db, req);
      const shopId = parseShopId(params);
      requireShopAccess(user, shopId);
      const from = url.searchParams.get("from") ?? dateIso(new Date());
      const to = url.searchParams.get("to") ?? from;
      const rows = db
        .query(
          `SELECT id, bill_no, total, created_at, payment_method
           FROM bills
           WHERE shop_id = ? AND date(created_at) BETWEEN ? AND ?
           ORDER BY created_at DESC
           LIMIT 300`
        )
        .all(shopId, from, to) as any[];
      return jsonResponse({ ok: true, bills: rows });
    } catch (e) {
      if (String((e as any)?.message ?? e) === "FORBIDDEN") return errorResponse(403, "Forbidden");
      return errorResponse(500, "Failed to load bills", String(e));
    }
  });

  r.on("GET", "/api/shops/:shopId/bills/:billId", ({ req, params }) => {
    try {
      const user = requireAuth(db, req);
      const shopId = parseShopId(params);
      requireShopAccess(user, shopId);
      const billId = Number.parseInt(params.billId ?? "", 10);
      if (!Number.isFinite(billId)) return errorResponse(400, "Invalid billId");
      const bill = db.query("SELECT * FROM bills WHERE id = ? AND shop_id = ?").get(
        billId,
        shopId
      ) as any;
      if (!bill) return errorResponse(404, "Bill not found");
      const items = db
        .query(
          `SELECT bi.*, p.category as category, p.size as size
           FROM bill_items bi
           JOIN products p ON p.id = bi.product_id
           WHERE bi.bill_id = ?
           ORDER BY bi.id ASC`
        )
        .all(billId) as any[];
      return jsonResponse({ ok: true, bill, items });
    } catch (e) {
      if (String((e as any)?.message ?? e) === "FORBIDDEN") return errorResponse(403, "Forbidden");
      return errorResponse(500, "Failed to load bill", String(e));
    }
  });

  // Expenses
  r.on("POST", "/api/shops/:shopId/expenses", async ({ req, params }) => {
    try {
      const user = requireAuth(db, req);
      const shopId = parseShopId(params);
      requireShopAccess(user, shopId);
      const body = await readJson(req);
      const expenseDate = String(body?.expenseDate ?? dateIso(new Date()));
      const amount = asNumber(body?.amount ?? 0);
      const category = String(body?.category ?? "General").trim() || "General";
      const note = String(body?.note ?? "").trim() || null;
      if (!expenseDate || amount <= 0) return errorResponse(400, "Invalid expense");
      db.query(
        "INSERT INTO expenses (shop_id, expense_date, amount, category, note, user_id) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(shopId, expenseDate, amount, category, note, user.id);
      return jsonResponse({ ok: true });
    } catch (e) {
      if (String((e as any)?.message ?? e) === "FORBIDDEN") return errorResponse(403, "Forbidden");
      return errorResponse(500, "Failed to add expense", String(e));
    }
  });

  r.on("GET", "/api/shops/:shopId/expenses", ({ req, url, params }) => {
    try {
      const user = requireAuth(db, req);
      const shopId = parseShopId(params);
      requireShopAccess(user, shopId);
      const from = url.searchParams.get("from") ?? dateIso(new Date());
      const to = url.searchParams.get("to") ?? from;
      const rows = db
        .query(
          `SELECT id, expense_date, amount, category, note, created_at
           FROM expenses
           WHERE shop_id = ? AND expense_date BETWEEN ? AND ?
           ORDER BY expense_date DESC, created_at DESC
           LIMIT 300`
        )
        .all(shopId, from, to) as any[];
      return jsonResponse({ ok: true, expenses: rows });
    } catch (e) {
      if (String((e as any)?.message ?? e) === "FORBIDDEN") return errorResponse(403, "Forbidden");
      return errorResponse(500, "Failed to load expenses", String(e));
    }
  });

  // Employees
  r.on("POST", "/api/shops/:shopId/employees", async ({ req, params }) => {
    try {
      const user = requireAuth(db, req);
      const shopId = parseShopId(params);
      requireShopAccess(user, shopId);
      const body = await readJson(req);
      const name = String(body?.name ?? "").trim();
      if (!name) return errorResponse(400, "Name required");
      const age = body?.age !== undefined ? Number.parseInt(String(body.age), 10) : null;
      const address = String(body?.address ?? "").trim() || null;
      const idProof = String(body?.idProof ?? "").trim() || null;
      const experience = String(body?.experience ?? "").trim() || null;
      db.query(
        "INSERT INTO employees (shop_id, name, age, address, id_proof, experience) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(shopId, name, Number.isFinite(age as any) ? age : null, address, idProof, experience);
      return jsonResponse({ ok: true });
    } catch (e) {
      if (String((e as any)?.message ?? e) === "FORBIDDEN") return errorResponse(403, "Forbidden");
      return errorResponse(500, "Failed to add employee", String(e));
    }
  });

  r.on("GET", "/api/shops/:shopId/employees", ({ req, params }) => {
    try {
      const user = requireAuth(db, req);
      const shopId = parseShopId(params);
      requireShopAccess(user, shopId);
      const rows = db
        .query(
          `SELECT id, name, age, address, id_proof, experience, created_at
           FROM employees WHERE shop_id = ?
           ORDER BY created_at DESC`
        )
        .all(shopId) as any[];
      return jsonResponse({ ok: true, employees: rows });
    } catch (e) {
      if (String((e as any)?.message ?? e) === "FORBIDDEN") return errorResponse(403, "Forbidden");
      return errorResponse(500, "Failed to load employees", String(e));
    }
  });

	  // Reports
	  r.on("POST", "/api/reports/daily", async ({ req, url }) => {
	    try {
	      const user = requireAuth(db, req);
      const body = await readJson(req);
      const reportDate = String(
        body?.date ?? (url.searchParams.get("date") ?? dateIso(new Date()))
      );
      const requestedShopId =
        body?.shopId !== undefined && body?.shopId !== null ? Number.parseInt(String(body.shopId), 10) : null;
      const shopId = user.role === "OWNER" ? requestedShopId : user.shopId;
      const rep = await generateDailyStockSalesReport(db, {
        date: reportDate,
        shopId: Number.isFinite(shopId as any) ? (shopId as number) : null
      });
      await sendDailyReportSmsLink({
        fileName: rep.fileName,
        reportDate: rep.reportDate,
        shopId: rep.shopId
      });
      return jsonResponse({ ok: true, report: rep });
    } catch (e) {
      if (String((e as any)?.message ?? e) === "FORBIDDEN") return errorResponse(403, "Forbidden");
      return errorResponse(500, "Failed to generate daily report", String(e));
    }
  });

  r.on("DELETE", "/api/reports/:reportId", async ({ req, params }) => {
    try {
      const user = requireAuth(db, req);
      const reportId = Number.parseInt(params.reportId ?? "", 10);
      if (!Number.isFinite(reportId)) return errorResponse(400, "Invalid reportId");

      const report = db
        .query("SELECT id, shop_id, file_name FROM reports WHERE id = ?")
        .get(reportId) as any;
      if (!report) return errorResponse(404, "Report not found");

      if (user.role !== "OWNER") {
        if (!user.shopId) return errorResponse(403, "Forbidden");
        if (report.shop_id !== user.shopId) return errorResponse(403, "Forbidden");
      }

      const fileName = String(report.file_name ?? "");
      const reportsDir = env("REPORTS_DIR", "./apps/api/reports");
      const reportsDirAbs = resolve(reportsDir);

      if (/^[A-Za-z0-9._-]+\.pdf$/.test(fileName)) {
        const filePath = safeResolve(reportsDirAbs, "/" + fileName);
        if (!filePath) return errorResponse(500, "Invalid report file path");
        try {
          await unlink(filePath);
        } catch (e: any) {
          if (String(e?.code ?? "") !== "ENOENT") {
            return errorResponse(500, "Failed to delete report file", String(e?.message ?? e));
          }
        }
      }

      db.query("DELETE FROM reports WHERE id = ?").run(reportId);
      return jsonResponse({ ok: true });
    } catch (e) {
      return errorResponse(500, "Failed to delete report", String(e));
    }
  });

  r.on("GET", "/api/reports", ({ req, url }) => {
    try {
      const user = requireAuth(db, req);
      const shopIdParam = url.searchParams.get("shopId");
      const requestedShopId = shopIdParam ? Number.parseInt(shopIdParam, 10) : null;
      const shopId = user.role === "OWNER" ? requestedShopId : user.shopId;
      if (user.role !== "OWNER") {
        if (!user.shopId) return jsonResponse({ ok: true, reports: [] });
        if (requestedShopId !== null && requestedShopId !== user.shopId)
          return errorResponse(403, "Forbidden");
      }
      const rows = shopId
        ? (db
            .query("SELECT * FROM reports WHERE shop_id = ? ORDER BY created_at DESC LIMIT 50")
            .all(shopId) as any[])
        : (db.query("SELECT * FROM reports ORDER BY created_at DESC LIMIT 50").all() as any[]);
      return jsonResponse({ ok: true, reports: rows });
    } catch (e) {
      if (String((e as any)?.message ?? e) === "FORBIDDEN") return errorResponse(403, "Forbidden");
      return errorResponse(500, "Failed to list reports", String(e));
    }
  });

  return r;
}

function computeDailySummary(db: Db, shopId: number, date: string) {
  const shop = db.query("SELECT id, name FROM shops WHERE id = ?").get(shopId) as any;
  const salesRow = db
    .query(
      `SELECT
        COALESCE(SUM(total), 0) as sales_total
      FROM bills
      WHERE shop_id = ? AND date(created_at) = ?`
    )
    .get(shopId, date) as any;

  const salesTotal = asNumber(salesRow.sales_total);

  return {
    shopId: shop.id,
    shopName: shop.name,
    salesTotal: money(salesTotal)
  };
}

function combineSummaries(summaries: any[]) {
  const combined = {
    salesTotal: 0
  };
  for (const s of summaries) {
    combined.salesTotal += asNumber(s.salesTotal);
  }
  combined.salesTotal = money(combined.salesTotal);
  return combined;
}

function createBill(
  db: Db,
  opts: {
    shopId: number;
    userId: number;
    paymentMethod: string;
    items: { productId: number; qty: number }[];
  }
) {
  const updatedProductIds = new Set<number>();

  const tx = db.transaction(() => {
    const counter = db
      .query("SELECT next_bill_no FROM bill_counters WHERE shop_id = ?")
      .get(opts.shopId) as any;
    if (!counter) throw new Error("COUNTER_MISSING");
    const billNoInt = Number(counter.next_bill_no);
    const billNo = `${String(billNoInt).padStart(6, "0")}`;

    let subtotal = 0;

    type ItemRow = {
      productId: number;
      name: string;
      barcode: string | null;
      qty: number;
      unitPrice: number;
      costPrice: number;
      lineTotal: number;
      newQty: number;
    };
    const itemRows: ItemRow[] = [];

    for (const it of opts.items) {
      if (!Number.isFinite(it.productId) || it.qty <= 0) continue;
      const p = db
        .query(
          "SELECT id, name, barcode, sale_price, cost_price, current_qty FROM products WHERE id = ? AND shop_id = ?"
        )
        .get(it.productId, opts.shopId) as any;
      if (!p) continue;
      const currentQty = asNumber(p.current_qty);
      if (currentQty < it.qty) throw new Error("INSUFFICIENT_STOCK");
      const unitPrice = asNumber(p.sale_price);
      const costPrice = asNumber(p.cost_price);
      const lineTotal = it.qty * unitPrice;
      subtotal += lineTotal;
      itemRows.push({
        productId: p.id,
        name: String(p.name),
        barcode: p.barcode ?? null,
        qty: it.qty,
        unitPrice,
        costPrice,
        lineTotal,
        newQty: currentQty - it.qty
      });
    }

    if (itemRows.length === 0) throw new Error("NO_ITEMS");

    const total = subtotal;
    const billRes = hasColumn(db, "bills", "gst_total")
      ? db
          .query(
            `INSERT INTO bills (shop_id, bill_no, payment_method, subtotal, gst_total, total, user_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))`
          )
          .run(opts.shopId, billNo, opts.paymentMethod, subtotal, 0, total, opts.userId)
      : db
          .query(
            `INSERT INTO bills (shop_id, bill_no, payment_method, subtotal, total, user_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, datetime('now','localtime'))`
          )
          .run(opts.shopId, billNo, opts.paymentMethod, subtotal, total, opts.userId);

    const billId = Number(billRes.lastInsertRowid);
    const billItemsHaveGst = hasColumn(db, "bill_items", "gst_rate");
    for (const row of itemRows) {
      if (billItemsHaveGst) {
        db.query(
          `INSERT INTO bill_items (bill_id, product_id, name_snapshot, barcode_snapshot, qty, unit_price, cost_price, gst_rate, taxable_amount, gst_amount, line_total)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          billId,
          row.productId,
          row.name,
          row.barcode,
          row.qty,
          row.unitPrice,
          row.costPrice,
          0,
          row.lineTotal,
          0,
          row.lineTotal
        );
      } else {
        db.query(
          `INSERT INTO bill_items (bill_id, product_id, name_snapshot, barcode_snapshot, qty, unit_price, cost_price, line_total)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          billId,
          row.productId,
          row.name,
          row.barcode,
          row.qty,
          row.unitPrice,
          row.costPrice,
          row.lineTotal
        );
      }

      db.query("UPDATE products SET current_qty = ?, updated_at = datetime('now','localtime') WHERE id = ? AND shop_id = ?").run(
        row.newQty,
        row.productId,
        opts.shopId
      );

	      db.query(
	        `INSERT INTO stock_transactions (shop_id, product_id, type, qty, note, reference_bill_id, user_id, created_at)
	         VALUES (?, ?, 'OUT', ?, 'Sale', ?, ?, datetime('now','localtime'))`
	      ).run(opts.shopId, row.productId, -row.qty, billId, opts.userId);

      updatedProductIds.add(row.productId);
    }

    db.query("UPDATE bill_counters SET next_bill_no = next_bill_no + 1 WHERE shop_id = ?").run(
      opts.shopId
    );

    const bill = db.query("SELECT * FROM bills WHERE id = ?").get(billId) as any;
    return { bill };
  });

  const { bill } = tx();
  return { bill, updatedProductIds: [...updatedProductIds] };
}
