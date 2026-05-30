import { loadDotEnv, env, envOptional } from "./env";
import { openDb, migrate } from "./db";
import { seedIfNeeded } from "./seed";

await loadDotEnv();

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

db.close();

// eslint-disable-next-line no-console
console.log(`[import] Done. Imported products from stock_master.csv (if present).`);
