import { readFile } from "node:fs/promises";
import { loadDotEnv, env, envOptional } from "./env";
import { openDb, migrate } from "./db";
import { seedIfNeeded } from "./seed";

type ParsedItem = {
  name: string;
  mrp: number;
};

function cleanName(raw: string) {
  return raw
    .replace(/\u00a0/g, " ")
    .replace(/^ITEM NAME\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseMrp(raw: string) {
  const n = Number.parseFloat(raw.replace(/,/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100) / 100;
}

function itemKey(name: string, mrp: number) {
  const normalized = name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
  if (!normalized) return "";
  return `${normalized}|${mrp.toFixed(2)}`;
}

function parseItemsFromText(rawText: string) {
  const text = rawText.replace(/\r/g, "");
  const pages = text.split("\f");
  const parsed: ParsedItem[] = [];
  const seen = new Set<string>();

  let scannedPages = 0;
  let mismatchPages = 0;

  for (const page of pages) {
    const itemNamePos = page.indexOf("ITEM NAME");
    const itemCodePos = page.indexOf("ITEM CODE", itemNamePos + 1);
    const mrpPos = page.search(/\bMRP(?:\s*\(values in Rs\.\))?/i);
    if (itemNamePos < 0 || itemCodePos < 0 || mrpPos < 0) continue;

    scannedPages += 1;

    const itemBlock = page.slice(itemNamePos, itemCodePos);
    const mrpBlock = page.slice(mrpPos);

    const names = [...itemBlock.matchAll(/([\s\S]*?)\(\d{4}\)/g)]
      .map((m) => cleanName(m[1]))
      .filter(Boolean)
      .filter((name) => !/^Supplier\s*:/i.test(name))
      .filter((name) => /[A-Za-z]/.test(name));

    const mrps = [...mrpBlock.matchAll(/\d{1,3}(?:,\d{3})*(?:\.\d{2})/g)]
      .map((m) => parseMrp(m[0]))
      .filter((n): n is number => n !== null);

    if (!names.length || !mrps.length) continue;
    if (names.length !== mrps.length) mismatchPages += 1;

    const pairCount = Math.min(names.length, mrps.length);
    for (let i = 0; i < pairCount; i += 1) {
      const name = names[i];
      const mrp = mrps[i];
      const key = itemKey(name, mrp);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      parsed.push({ name, mrp });
    }
  }

  parsed.sort((a, b) => {
    const byName = a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
    if (byName !== 0) return byName;
    return a.mrp - b.mrp;
  });

  return { parsed, scannedPages, mismatchPages };
}

await loadDotEnv();

const sourcePath = process.argv[2] || "/Users/basaveshwaras/Downloads/KSBCL_full_extracted_text.txt";
const text = await readFile(sourcePath, "utf8");
const { parsed, scannedPages, mismatchPages } = parseItemsFromText(text);

if (parsed.length === 0) {
  // eslint-disable-next-line no-console
  console.log(`[import-others] No parsable rows found in ${sourcePath}`);
  process.exit(0);
}

const dbPath = env("DATABASE_PATH", "./data/sr-groups.db");
const db = openDb(dbPath);
await migrate(db, "apps/api/sql/schema.sql");

const adminUsername = env("ADMIN_USERNAME", "owner");
const adminPasswordEnv = envOptional("ADMIN_PASSWORD");
const adminPassword = adminPasswordEnv ?? "owner123";

const shop1PasswordEnv = envOptional("SHOP1_PASSWORD");
const shop2PasswordEnv = envOptional("SHOP2_PASSWORD");
const shop3PasswordEnv = envOptional("SHOP3_PASSWORD");
const shopUsers = [
  {
    shopName: "Ravi Liquor Shop",
    username: env("SHOP1_USERNAME", "ravi"),
    password: shop1PasswordEnv ?? "ravi123",
    rotatePassword: shop1PasswordEnv !== undefined
  },
  {
    shopName: "Aishwarya Bar",
    username: env("SHOP2_USERNAME", "aishwarya"),
    password: shop2PasswordEnv ?? "aishwarya123",
    rotatePassword: shop2PasswordEnv !== undefined
  },
  {
    shopName: "S R Residency",
    username: env("SHOP3_USERNAME", "srresidency"),
    password: shop3PasswordEnv ?? "srresidency123",
    rotatePassword: shop3PasswordEnv !== undefined
  }
];

await seedIfNeeded(db, {
  adminUsername,
  adminPassword,
  rotatePassword: adminPasswordEnv !== undefined,
  shopUsers
});

const shops = db.query("SELECT id, name FROM shops ORDER BY id").all() as { id: number; name: string }[];
if (!shops.length) {
  db.close();
  // eslint-disable-next-line no-console
  console.log("[import-others] No shops found.");
  process.exit(0);
}

const insertProduct = db.query(
  `INSERT INTO products (
    shop_id, sku, name, barcode, unit, category, size, bottles_per_case,
    sale_price, cost_price, min_qty, current_qty, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))`
);

const normalizeExisting = db.query(
  `UPDATE products
   SET
     sku = NULL,
     barcode = NULL,
     unit = 'unit',
     category = 'OTHERS',
     size = NULL,
     bottles_per_case = 0,
     cost_price = 0,
     min_qty = 0,
     current_qty = 0,
     updated_at = datetime('now','localtime')
   WHERE
     shop_id = ?
     AND size IS NULL
     AND current_qty = 0
     AND min_qty = 0
     AND barcode IS NULL`
);

const insertCounts: Array<{ shopId: number; shopName: string; inserted: number; normalized: number }> = [];

for (const shop of shops) {
  const existingRows = db
    .query(
      `SELECT name, sale_price
       FROM products
       WHERE
         shop_id = ?
         AND size IS NULL
         AND current_qty = 0
         AND min_qty = 0
         AND barcode IS NULL`
    )
    .all(shop.id) as { name: string; sale_price: number }[];
  const existingKeys = new Set<string>(
    existingRows
      .map((row) => itemKey(String(row.name ?? ""), Number(row.sale_price ?? 0)))
      .filter(Boolean)
  );

  let inserted = 0;
  let normalized = 0;
  const tx = db.transaction(() => {
    normalized = Number(normalizeExisting.run(shop.id).changes ?? 0);
    for (const item of parsed) {
      const key = itemKey(item.name, item.mrp);
      if (!key || existingKeys.has(key)) continue;

      insertProduct.run(
        shop.id,
        null,
        item.name,
        null,
        "unit",
        "OTHERS",
        null,
        0,
        item.mrp,
        0,
        0,
        0
      );

      existingKeys.add(key);
      inserted += 1;
    }
  });
  tx();

  insertCounts.push({ shopId: shop.id, shopName: shop.name, inserted, normalized });
}

db.close();

// eslint-disable-next-line no-console
console.log(
  `[import-others] Parsed ${parsed.length} unique name+MRP items from ${scannedPages} pages (mismatch pages: ${mismatchPages}).`
);
for (const row of insertCounts) {
  // eslint-disable-next-line no-console
  console.log(
    `[import-others] Shop ${row.shopId} (${row.shopName}): normalized ${row.normalized}, inserted ${row.inserted} items.`
  );
}
