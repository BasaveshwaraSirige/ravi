import type { Db } from "./db";
import { normalizeCategory, normalizeSize, type ProductCategory } from "./products";

type SeedProduct = { name: string; size: string; category: ProductCategory };

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i] ?? "";
    if (ch === "\"") {
      if (inQuotes && line[i + 1] === "\"") {
        cur += "\"";
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function coerceImportedSize(category: ProductCategory, rawSize: string) {
  const s = String(rawSize ?? "").trim();
  if (!s) return s;
  const upper = s.toUpperCase();
  if (category === "BEER" && upper === "PINT") return "330 PINT";
  if (/^\d+$/.test(upper)) {
    const n = Number.parseInt(upper, 10);
    if (!Number.isFinite(n)) return s;
    if (category === "BEER") {
      if (n === 500) return "500 TIN";
      if (n === 330) return "330 TIN";
      if (n === 650) return "650ML";
      if (n === 275) return "275ML";
      return `${n}ML`;
    }
    return `${n}ML`;
  }
  return s;
}

async function loadStockMasterProducts(): Promise<SeedProduct[]> {
  const candidates = [
    `${process.cwd()}/stock_master.csv`,
    `${import.meta.dir}/../../../stock_master.csv`
  ];

  let text: string | null = null;
  for (const path of candidates) {
    const file = Bun.file(path);
    if (!(await file.exists())) continue;
    text = await file.text();
    break;
  }
  if (!text) return [];

  const lines = text.split(/\r?\n/);
  if (lines.length === 0) return [];

  const header = parseCsvLine(lines[0] ?? "");
  const idxCategory = header.indexOf("category");
  const idxName = header.indexOf("product_name");
  const idxSize = header.indexOf("size");
  const idxSizeMl = header.indexOf("size_ml");
  if (idxCategory === -1 || idxName === -1 || (idxSize === -1 && idxSizeMl === -1)) return [];

  const out: SeedProduct[] = [];
  const seen = new Set<string>();

  for (const rawLine of lines.slice(1)) {
    const line = rawLine.trim();
    if (!line) continue;
    const cols = parseCsvLine(line);
    const name = String(cols[idxName] ?? "").trim();
    if (!name) continue;

    const category = normalizeCategory(cols[idxCategory]);

    const rawSize = String(cols[idxSize !== -1 ? idxSize : idxSizeMl] ?? "").trim();
    const coerced = coerceImportedSize(category, rawSize);
    const size = normalizeSize(category, coerced);

    const key = `${category}|${name}|${size}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ category, name, size });
  }

  return out;
}

export async function seedIfNeeded(
  db: Db,
  opts: {
    adminUsername: string;
    adminPassword: string;
    rotatePassword?: boolean;
    shopUsers?: { shopName: string; username: string; password: string; rotatePassword?: boolean }[];
  }
) {
  const existing = db
    .query("SELECT id, password_hash FROM users WHERE username = ?")
    .get(opts.adminUsername) as { id: number; password_hash: string } | null;

  if (!existing) {
    const passwordHash = await Bun.password.hash(opts.adminPassword);
    db.query("INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'OWNER')").run(
      opts.adminUsername,
      passwordHash
    );
    // eslint-disable-next-line no-console
    console.log(
      `[seed] Created OWNER user '${opts.adminUsername}'. Change ADMIN_PASSWORD after first login.`
    );
  } else if (opts.rotatePassword) {
    const ok = await Bun.password.verify(opts.adminPassword, existing.password_hash);
    if (!ok) {
      const passwordHash = await Bun.password.hash(opts.adminPassword);
      db.query("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, existing.id);
      // eslint-disable-next-line no-console
      console.log(`[seed] Updated password for '${opts.adminUsername}' from ADMIN_PASSWORD.`);
    }
  }

  const shops = ["Ravi Liquor Shop", "Aishwarya Bar", "S R Residency"];
  const stockSeedShops = ["Ravi Liquor Shop", "Aishwarya Bar"];
  const shopAddresses: Record<string, string> = {
    "Ravi Liquor Shop":
      "SR complex no: 03,S.R(Sirige Rudramuniyappa) Ring Road,Rahim Nagara,challakere-577522",
    "Aishwarya Bar":
      "SH 48,near Government degree College ground, chitradurga Road, Challakere-577522",
    "S R Residency": "OPP Busstand, challakere,Karnataka 577522"
  };

  for (const name of shops) {
    const address = shopAddresses[name] ?? null;
    db.query("INSERT OR IGNORE INTO shops (name, address) VALUES (?, ?)").run(name, address);
    if (address) {
      db.query(
        "UPDATE shops SET address = ? WHERE name = ? AND (address IS NULL OR TRIM(address) = '')"
      ).run(address, name);
    }
  }

  const shopRows = db.query("SELECT id FROM shops").all() as { id: number }[];
  for (const { id } of shopRows) {
    db.query("INSERT OR IGNORE INTO bill_counters (shop_id, next_bill_no) VALUES (?, 1)").run(
      id
    );
  }

  const shopIdByName = new Map(
    (db.query("SELECT id, name FROM shops").all() as { id: number; name: string }[]).map((s) => [
      s.name,
      s.id
    ])
  );

  for (const su of opts.shopUsers ?? []) {
    const shopId = shopIdByName.get(su.shopName);
    if (!shopId) continue;
    const existingShopUser = db
      .query("SELECT id, password_hash FROM users WHERE username = ?")
      .get(su.username) as { id: number; password_hash: string } | null;

    if (!existingShopUser) {
      const passwordHash = await Bun.password.hash(su.password);
      db.query("INSERT INTO users (username, password_hash, role, shop_id) VALUES (?, ?, 'STAFF', ?)")
        .run(su.username, passwordHash, shopId);
      // eslint-disable-next-line no-console
      console.log(`[seed] Created STAFF user '${su.username}' for '${su.shopName}'.`);
    } else if (su.rotatePassword) {
      const ok = await Bun.password.verify(su.password, existingShopUser.password_hash);
      if (!ok) {
        const passwordHash = await Bun.password.hash(su.password);
        db.query("UPDATE users SET password_hash = ?, shop_id = ?, role = 'STAFF' WHERE id = ?").run(
          passwordHash,
          shopId,
          existingShopUser.id
        );
        // eslint-disable-next-line no-console
        console.log(`[seed] Updated password for '${su.username}' from env.`);
      } else {
        db.query("UPDATE users SET shop_id = ?, role = 'STAFF' WHERE id = ?").run(
          shopId,
          existingShopUser.id
        );
      }
    } else {
      db.query("UPDATE users SET shop_id = ?, role = 'STAFF' WHERE id = ?").run(
        shopId,
        existingShopUser.id
      );
    }
  }

  const defaultProducts: SeedProduct[] = [
    { name: "MH BRANDY", size: "1000ML", category: "BRANDY" },
    { name: "MH BRANDY", size: "750ML", category: "BRANDY" },
    { name: "MH BRANDY", size: "375ML", category: "BRANDY" },
    { name: "MH BRANDY", size: "180ML", category: "BRANDY" },
    { name: "MH BRANDY", size: "90ML", category: "BRANDY" },
    { name: "MORPHEUS BLUE", size: "180ML", category: "BRANDY" },
    { name: "MORPHEUS BLUE", size: "60ML", category: "BRANDY" },
    { name: "MC BRANDY", size: "180ML", category: "BRANDY" },
    { name: "MC BRANDY", size: "90ML", category: "BRANDY" },
    { name: "OLD ADMAIRAL BRANDY", size: "1000ML", category: "BRANDY" },
    { name: "OLD ADMAIRAL BRANDY", size: "180ML", category: "BRANDY" },
    { name: "OLD ADMAIRAL BRANDY", size: "90ML", category: "BRANDY" },
    { name: "MORPHEUS BRANDY", size: "750ML", category: "BRANDY" },
    { name: "MORPHEUS BRANDY", size: "180ML", category: "BRANDY" },
    { name: "MORPHEUS BRANDY", size: "60ML", category: "BRANDY" },
    { name: "HONEY BEE BRANDY", size: "180ML", category: "BRANDY" },
    { name: "HONEY BEE BRANDY", size: "90ML", category: "BRANDY" },
    { name: "BAGPIPER WHISKY", size: "750ML", category: "WHISKEY" },
    { name: "BAGPIPER WHISKY", size: "375ML", category: "WHISKEY" },
    { name: "BAGPIPER WHISKY", size: "180ML", category: "WHISKEY" },
    { name: "BAGPIPER WHISKY", size: "90ML", category: "WHISKEY" },
    { name: "BLENDORS PRIDE 4 ELEM WHISKY", size: "750ML", category: "WHISKEY" }
  ];

  const stockMasterProducts = await loadStockMasterProducts();
  const seedProducts: SeedProduct[] = [];
  const seedSeen = new Set<string>();
  for (const raw of [...defaultProducts, ...stockMasterProducts]) {
    const name = String(raw.name ?? "").trim();
    if (!name) continue;
    const category = normalizeCategory(raw.category);
    const size = normalizeSize(category, raw.size);
    const key = `${category}|${name}|${size}`;
    if (seedSeen.has(key)) continue;
    seedSeen.add(key);
    seedProducts.push({ name, category, size });
  }

  let insertedProducts = 0;
  for (const shopName of stockSeedShops) {
    const shopId = shopIdByName.get(shopName);
    if (!shopId) continue;
    for (const raw of seedProducts) {
      const name = raw.name;
      const size = raw.size;
      const category = raw.category;
      const existing = db
        .query(
          "SELECT id FROM products WHERE shop_id = ? AND name = ? AND category = ? AND COALESCE(size,'') = ? LIMIT 1"
        )
        .get(shopId, name, category, size) as any;
      if (existing) continue;
      db.query(
        "INSERT INTO products (shop_id, name, category, size, current_qty, sale_price, min_qty, updated_at) VALUES (?, ?, ?, ?, 0, 0, 0, datetime('now','localtime'))"
      ).run(shopId, name, category, size);
      insertedProducts += 1;
    }
  }
  if (insertedProducts > 0) {
    // eslint-disable-next-line no-console
    console.log(`[seed] Added ${insertedProducts} default products (qty=0) across stock shops.`);
  }
}
