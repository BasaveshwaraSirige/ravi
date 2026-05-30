import type { Db } from "./db";
import { dateIso } from "./db";
import { envOptional } from "./env";
import { normalizePhoneNumbers, sendSms } from "./sms";

function asNumber(v: any) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export async function maybeNotifyLowStock(db: Db, shopId: number, productId: number) {
  const row = db
    .query(
      `SELECT p.name, p.current_qty, p.min_qty, s.name as shop_name
       FROM products p
       JOIN shops s ON s.id = p.shop_id
       WHERE p.id = ? AND p.shop_id = ?`
    )
    .get(productId, shopId) as any;
  if (!row) return;

  const current = asNumber(row.current_qty);
  const min = asNumber(row.min_qty);
  const isLow = current < min;

  if (!isLow) {
    db.query("DELETE FROM low_stock_alerts WHERE shop_id = ? AND product_id = ?").run(
      shopId,
      productId
    );
    return;
  }

  const today = dateIso(new Date());
  const already = db
    .query("SELECT last_notified_at FROM low_stock_alerts WHERE shop_id = ? AND product_id = ?")
    .get(shopId, productId) as { last_notified_at: string } | null;

  if (already && String(already.last_notified_at).startsWith(today)) return;

  const defaultCc = envOptional("PHONE_DEFAULT_COUNTRY_CODE") ?? "+91";
  const toList = normalizePhoneNumbers(envOptional("LOW_STOCK_ALERT_TO"), defaultCc);
  const body = `LOW STOCK: ${row.shop_name} - ${row.name} (Qty ${current.toFixed(
    2
  )} < Min ${min.toFixed(2)})`;

  for (const to of toList) {
    await sendSms(to, body);
  }

  db.query(
    "INSERT INTO low_stock_alerts (shop_id, product_id, last_notified_at) VALUES (?, ?, datetime('now','localtime')) ON CONFLICT(shop_id, product_id) DO UPDATE SET last_notified_at = datetime('now','localtime')"
  ).run(shopId, productId);
}
