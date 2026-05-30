import type { Db } from "./db";
import { dateIso } from "./db";
import { env, envBool, envOptional } from "./env";
import { randomToken } from "./crypto";
import { normalizePhoneNumbers, sendSms } from "./sms";
import { pdfFromLines } from "./pdf";
import { mkdir } from "node:fs/promises";

function moneyRs(n: number) {
  return `Rs ${n.toFixed(2)}`;
}

function asNumber(v: any) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function leftCell(v: any, width: number) {
  const s = String(v ?? "");
  return s.length > width ? s.slice(0, width) : s.padEnd(width, " ");
}

function rightCell(v: any, width: number) {
  const s = String(v ?? "");
  return s.length > width ? s.slice(0, width) : s.padStart(width, " ");
}

function wrapCell(v: any, width: number) {
  const text = String(v ?? "").trim();
  if (!text) return [""];
  const words = text.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let current = "";

  for (const wordRaw of words) {
    let word = wordRaw;
    if (word.length > width) {
      if (current) {
        out.push(current);
        current = "";
      }
      while (word.length > width) {
        out.push(word.slice(0, width));
        word = word.slice(width);
      }
      current = word;
      continue;
    }
    if (!current) {
      current = word;
      continue;
    }
    if (current.length + 1 + word.length <= width) {
      current += ` ${word}`;
    } else {
      out.push(current);
      current = word;
    }
  }

  if (current) out.push(current);
  return out.length ? out : [""];
}

function reportCategoryKey(v: any) {
  const raw = String(v ?? "OTHERS").trim().toUpperCase();
  if (!raw) return "OTHERS";
  return raw.replace(/[\s-]+/g, "_");
}

function reportCategoryLabel(v: any) {
  const key = reportCategoryKey(v);
  const labels: Record<string, string> = {
    WHISKEY: "Whiskey",
    BRANDY: "Brandy",
    RUM: "Rum",
    VODKA: "Vodka",
    BEER: "Beer",
    GIN: "Gin",
    WINE: "Wine",
    CARBONATED_WINE: "Carbonated Wine",
    OTHERS: "Others"
  };
  if (labels[key]) return labels[key];
  return key
    .split("_")
    .map((part) => (part ? part[0] + part.slice(1).toLowerCase() : part))
    .join(" ");
}

const REPORT_CATEGORY_SECTION_ORDER = [
  "WHISKEY",
  "BRANDY",
  "RUM",
  "VODKA",
  "GIN",
  "OTHERS",
  "BEER"
] as const;
type ReportCategorySection = (typeof REPORT_CATEGORY_SECTION_ORDER)[number];

function reportCategorySection(v: any): ReportCategorySection {
  const key = reportCategoryKey(v);
  switch (key) {
    case "WHISKEY":
    case "BRANDY":
    case "RUM":
    case "VODKA":
    case "GIN":
    case "BEER":
      return key;
    default:
      return "OTHERS";
  }
}

export async function generateDailyStockSalesReport(
  db: Db,
  opts: { date?: string; shopId?: number | null }
) {
  const reportDate = opts.date ?? dateIso(new Date());
  const shops = opts.shopId
    ? (db
        .query("SELECT id, name, address FROM shops WHERE id = ?")
        .all(opts.shopId) as { id: number; name: string; address: string | null }[])
    : (db.query("SELECT id, name, address FROM shops ORDER BY id").all() as {
        id: number;
        name: string;
        address: string | null;
      }[]);

  const lines: { text: string; bold?: boolean; size?: number; align?: "left" | "center" | "right" }[] = [];
  lines.push({ text: "DAILY STOCK & SALES REPORT", bold: true, size: 12, align: "center" });
  lines.push({ text: `Date: ${reportDate}`, bold: true, align: "center" });
  lines.push({ text: "" });

  for (const shop of shops) {
    lines.push({ text: `Shop: ${shop.name}`, bold: true, size: 13 });
    lines.push({ text: `Address: ${String(shop.address ?? "").trim() || "-"}` });
    lines.push({ text: "" });

    const sales = db
      .query(
        `SELECT
          COALESCE(SUM(total), 0) as sales_total
        FROM bills
        WHERE shop_id = ? AND date(created_at) = ?`
      )
      .get(shop.id, reportDate) as any;

    const salesTotal = asNumber(sales.sales_total);

    lines.push({ text: `Sales (Daily):   ${moneyRs(salesTotal)}` });
    lines.push({ text: "" });

    lines.push({ text: "Item-wise Stock + Incoming (Daily) - Category Wise:", bold: true });
    const w = {
      sno: 3,
      name: 13,
      size: 6,
      qty: 8,
      incoming: 8,
      totalStock: 6,
      sales: 7,
      bc: 8,
      mrp: 7,
      total: 9
    };
    const tableSep = `  +${"-".repeat(w.sno)}+${"-".repeat(w.name)}+${"-".repeat(w.size)}+${"-".repeat(
      w.qty
    )}+${"-".repeat(w.incoming)}+${"-".repeat(w.totalStock)}+${"-".repeat(w.sales)}+${"-".repeat(
      w.bc
    )}+${"-".repeat(w.mrp)}+${"-".repeat(w.total)}+`;
    const tableHead = `  |${leftCell("SNO", w.sno)}|${leftCell("ITEM NAME", w.name)}|${leftCell(
      "SIZE",
      w.size
    )}|${leftCell("IN-STK", w.qty)}|${leftCell("INCOMING", w.incoming)}|${leftCell(
      "TOTAL",
      w.totalStock
    )}|${leftCell(
      "SALES24",
      w.sales
    )}|${leftCell("BOTT+CAS", w.bc)}|${leftCell("MRP", w.mrp)}|${leftCell("TOTAL AMT", w.total)}|`;
    const products = db
      .query(
        `SELECT
           p.id,
           p.category,
           p.name,
           p.size,
           p.current_qty,
           p.sale_price,
           COALESCE(inc.in_qty, 0) AS incoming_qty,
           COALESCE(inc.in_cases, 0) AS incoming_cases,
           COALESCE(inc.in_bottles, 0) AS incoming_bottles,
           COALESCE(sales.sold_qty, 0) AS sold_qty
         FROM products p
         LEFT JOIN (
           SELECT
             st.product_id,
             COALESCE(SUM(st.qty), 0) AS in_qty,
             COALESCE(SUM(COALESCE(st.cases, 0)), 0) AS in_cases,
             COALESCE(SUM(COALESCE(st.bottles, 0)), 0) AS in_bottles
           FROM stock_transactions st
           WHERE
             st.shop_id = ?
             AND st.type = 'IN'
             AND COALESCE(st.doc_date, date(st.created_at)) = ?
           GROUP BY st.product_id
         ) inc ON inc.product_id = p.id
         LEFT JOIN (
           SELECT
             bi.product_id,
             COALESCE(SUM(bi.qty), 0) AS sold_qty
           FROM bill_items bi
           JOIN bills b ON b.id = bi.bill_id
           WHERE
             b.shop_id = ?
             AND date(b.created_at) = ?
           GROUP BY bi.product_id
         ) sales ON sales.product_id = p.id
         WHERE
           p.shop_id = ?
           AND NOT (p.size IS NULL AND p.current_qty = 0 AND p.min_qty = 0 AND p.barcode IS NULL)
         ORDER BY p.category COLLATE NOCASE ASC, p.name COLLATE NOCASE ASC, p.size ASC`
      )
      .all(shop.id, reportDate, shop.id, reportDate, shop.id) as any[];

    if (products.length === 0) {
      lines.push({ text: "  (No products yet)" });
    } else {
      const byCategory = new Map<ReportCategorySection, any[]>();
      for (const row of products) {
        const key = reportCategorySection(row.category);
        const list = byCategory.get(key) ?? [];
        list.push(row);
        byCategory.set(key, list);
      }

      let totalQty = 0;
      let totalIncoming = 0;
      let totalQtyAndIncoming = 0;
      let totalSales = 0;
      let totalAmount = 0;
      let totalCases = 0;
      let totalBottles = 0;

      for (const categoryKey of REPORT_CATEGORY_SECTION_ORDER) {
        const rows = byCategory.get(categoryKey) ?? [];
        if (!rows.length) continue;
        lines.push({ text: `Category: ${reportCategoryLabel(categoryKey)}`, bold: true });
        lines.push({ text: tableSep, bold: true, size: 10 });
        lines.push({ text: tableHead, bold: true, size: 10 });
        lines.push({ text: tableSep, bold: true, size: 10 });

        let categoryQty = 0;
        let categoryIncoming = 0;
        let categoryQtyAndIncoming = 0;
        let categorySales = 0;
        let categoryAmount = 0;
        let categoryCases = 0;
        let categoryBottles = 0;

        for (let i = 0; i < rows.length; i += 1) {
          const row = rows[i];
          const sr = rightCell(i + 1, w.sno);
          const size = leftCell(row.size ?? "", w.size);
          const qtyNum = asNumber(row.current_qty);
          const inNum = asNumber(row.incoming_qty);
          const totalStockNum = qtyNum + inNum;
          const salesNum = asNumber(row.sold_qty);
          const mrpNum = asNumber(row.sale_price);
          const amountNum = totalStockNum * mrpNum;
          const casesNum = Math.round(asNumber(row.incoming_cases));
          const bottlesNum = Math.round(asNumber(row.incoming_bottles));

          categoryQty += qtyNum;
          categoryIncoming += inNum;
          categoryQtyAndIncoming += totalStockNum;
          categorySales += salesNum;
          categoryAmount += amountNum;
          categoryCases += casesNum;
          categoryBottles += bottlesNum;

          totalQty += qtyNum;
          totalIncoming += inNum;
          totalQtyAndIncoming += totalStockNum;
          totalSales += salesNum;
          totalAmount += amountNum;
          totalCases += casesNum;
          totalBottles += bottlesNum;

          const qty = rightCell(qtyNum.toFixed(2), w.qty);
          const incomingQty = rightCell(inNum.toFixed(2), w.incoming);
          const totalQtyIncoming = rightCell(totalStockNum.toFixed(2), w.totalStock);
          const sales = rightCell(salesNum.toFixed(2), w.sales);
          const bc = rightCell(`${bottlesNum}+${casesNum}`, w.bc);
          const mrp = rightCell(mrpNum.toFixed(2), w.mrp);
          const amount = rightCell(amountNum.toFixed(2), w.total);
          const nameParts = wrapCell(row.name ?? "", w.name);
          for (let partIdx = 0; partIdx < nameParts.length; partIdx += 1) {
            const isFirst = partIdx === 0;
            lines.push({
              text: `  |${isFirst ? sr : rightCell("", w.sno)}|${leftCell(nameParts[partIdx], w.name)}|${
                isFirst ? size : leftCell("", w.size)
              }|${isFirst ? qty : rightCell("", w.qty)}|${isFirst ? incomingQty : rightCell("", w.incoming)}|${
                isFirst ? totalQtyIncoming : rightCell("", w.totalStock)
              }|${isFirst ? sales : rightCell("", w.sales)}|${isFirst ? bc : rightCell("", w.bc)}|${
                isFirst ? mrp : rightCell("", w.mrp)
              }|${isFirst ? amount : rightCell("", w.total)}|`,
              size: 10
            });
          }
          lines.push({ text: tableSep, size: 10 });
        }

        lines.push({
          text: `  |${rightCell("", w.sno)}|${leftCell("CAT TOTAL", w.name)}|${leftCell("", w.size)}|${rightCell(
            categoryQty.toFixed(2),
            w.qty
          )}|${rightCell(categoryIncoming.toFixed(2), w.incoming)}|${rightCell(
            categoryQtyAndIncoming.toFixed(2),
            w.totalStock
          )}|${rightCell(categorySales.toFixed(2), w.sales)}|${rightCell(
            `${categoryBottles}+${categoryCases}`,
            w.bc
          )}|${rightCell("", w.mrp)}|${rightCell(categoryAmount.toFixed(2), w.total)}|`,
          bold: true,
          size: 10
        });
        lines.push({ text: tableSep, bold: true, size: 10 });
        lines.push({ text: "" });
      }

      lines.push({ text: "Grand Total (All Categories):", bold: true });
      lines.push({ text: tableSep, bold: true, size: 10 });
      lines.push({
        text: `  |${rightCell("", w.sno)}|${leftCell("GRAND TOTAL", w.name)}|${leftCell(
          "",
          w.size
        )}|${rightCell(totalQty.toFixed(2), w.qty)}|${rightCell(totalIncoming.toFixed(2), w.incoming)}|${rightCell(
          totalQtyAndIncoming.toFixed(2),
          w.totalStock
        )}|${rightCell(totalSales.toFixed(2), w.sales)}|${rightCell(
          `${totalBottles}+${totalCases}`,
          w.bc
        )}|${rightCell("", w.mrp)}|${rightCell(totalAmount.toFixed(2), w.total)}|`,
        bold: true,
        size: 10
      });
      lines.push({ text: tableSep, bold: true, size: 10 });
    }

    lines.push({ text: "" });
    lines.push({ text: "------------------------------------------------------------" });
    lines.push({ text: "" });
  }

  const fileName = `${reportDate.replace(/-/g, "")}-${opts.shopId ? `shop${opts.shopId}-` : ""}${randomToken(10)}.pdf`;
  const reportsDir = env("REPORTS_DIR", "./apps/api/reports");
  await mkdir(reportsDir, { recursive: true });

  const bytes = pdfFromLines("A UNIT OF SR GROUPS", lines);
  await Bun.write(`${reportsDir}/${fileName}`, bytes);

  db.query(
    "INSERT INTO reports (report_date, shop_id, kind, file_name) VALUES (?, ?, 'DAILY_STOCK_SALES', ?)"
  ).run(reportDate, opts.shopId ?? null, fileName);

  return { fileName, reportDate, shopId: opts.shopId ?? null };
}

export async function sendDailyReportSmsLink(opts: {
  fileName: string;
  reportDate: string;
  shopId?: number | null;
}) {
  const baseUrl = env("PUBLIC_BASE_URL", "http://localhost:3000").replace(/\/+$/, "");
  const reportsPublic = envBool("REPORTS_PUBLIC", true);
  const link = reportsPublic ? `${baseUrl}/reports/${opts.fileName}` : `${baseUrl}/dashboard.html`;

  const defaultCc = envOptional("PHONE_DEFAULT_COUNTRY_CODE") ?? "+91";
  const toList = normalizePhoneNumbers(envOptional("DAILY_REPORT_SMS_TO"), defaultCc);
  const body = `SR Groups report (${opts.reportDate}) ready. Download: ${link}`;

  for (const to of toList) {
    await sendSms(to, body);
  }
}

export function scheduleDailyReports(db: Db) {
  const time = envOptional("DAILY_REPORT_TIME") ?? "21:00";
  const [hh, mm] = time.split(":").map((x) => Number.parseInt(x, 10));
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) {
    // eslint-disable-next-line no-console
    console.log(`[reports] Invalid DAILY_REPORT_TIME='${time}', skipping scheduler.`);
    return;
  }

  const scheduleNext = () => {
    const now = new Date();
    const next = new Date(now);
    next.setHours(hh, mm, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    const ms = next.getTime() - now.getTime();

    setTimeout(async () => {
      try {
        const rep = await generateDailyStockSalesReport(db, { date: dateIso(new Date()) });
        await sendDailyReportSmsLink({ fileName: rep.fileName, reportDate: rep.reportDate });
        // eslint-disable-next-line no-console
        console.log(`[reports] Generated daily report ${rep.fileName}`);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.log(`[reports] Daily report error:`, e);
      } finally {
        scheduleNext();
      }
    }, ms);

    // eslint-disable-next-line no-console
    console.log(`[reports] Next daily report scheduled at ${next.toString()}`);
  };

  scheduleNext();
}
