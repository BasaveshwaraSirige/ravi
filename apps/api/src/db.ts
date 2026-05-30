import { Database } from "bun:sqlite";

export type Db = Database;

export function openDb(path: string) {
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  return db;
}

export async function migrate(db: Db, schemaPath: string) {
  const sql = await Bun.file(schemaPath).text();
  db.exec(sql);
  ensureColumn(db, "shops", "address", "TEXT");
  ensureColumn(db, "users", "shop_id", "INTEGER");
  ensureColumn(db, "products", "category", "TEXT");
  ensureColumn(db, "products", "size", "TEXT");
  ensureColumn(db, "products", "bottles_per_case", "INTEGER");
  ensureColumn(db, "stock_transactions", "invoice_no", "TEXT");
  ensureColumn(db, "stock_transactions", "doc_date", "TEXT");
  ensureColumn(db, "stock_transactions", "permit_no", "TEXT");
  ensureColumn(db, "stock_transactions", "vehicle_no", "TEXT");
  ensureColumn(db, "stock_transactions", "incoming_name", "TEXT");
  ensureColumn(db, "stock_transactions", "cases", "INTEGER");
  ensureColumn(db, "stock_transactions", "bottles", "INTEGER");
  ensureColumn(db, "stock_transactions", "source", "TEXT");
}

export function dateIso(d = new Date()) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function ensureColumn(db: Db, table: string, name: string, type: string) {
  const rows = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (rows.some((r) => r.name === name)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type};`);
}
