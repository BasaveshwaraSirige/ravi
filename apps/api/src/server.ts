import { loadDotEnv, env, envOptional } from "./env";
import { openDb, migrate } from "./db";
import { seedIfNeeded } from "./seed";
import { buildRouter } from "./routes";
import { notFound, errorResponse } from "./http";
import { getUserFromRequest } from "./auth";
import { serveStaticFile } from "./static";
import { scheduleDailyReports } from "./reports";
import { mkdir } from "node:fs/promises";
import { resolve, sep } from "node:path";

await loadDotEnv();

const port = Number.parseInt(env("PORT", "3000"), 10);
const dbPath = env("DATABASE_PATH", "./data/sr-groups.db");

await mkdir("./data", { recursive: true });

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

scheduleDailyReports(db);

const router = buildRouter(db);

const WEB_ROOT = "apps/web";
const WEB_ROOT_ABS = resolve(WEB_ROOT);
const PROTECTED_PAGES = new Set(["/dashboard.html", "/shop.html", "/owner.html", "/bill-print.html"]);
const REPORTS_DIR_ABS = resolve(env("REPORTS_DIR", "./apps/api/reports"));

function shouldProtect(pathname: string) {
  return PROTECTED_PAGES.has(pathname);
}

function safeResolve(rootAbs: string, urlPath: string) {
  if (urlPath.includes("\0")) return null;
  const abs = resolve(rootAbs, "." + urlPath);
  if (abs === rootAbs) return abs;
  if (!abs.startsWith(rootAbs + sep)) return null;
  return abs;
}

function redirect(to: string) {
  return new Response(null, { status: 302, headers: { location: to } });
}

// eslint-disable-next-line no-console
console.log(`SR Groups server listening on http://localhost:${port}`);

Bun.serve({
  port,
  fetch: async (req) => {
    const url = new URL(req.url);

    // Reports (PDF)
    if (url.pathname.startsWith("/reports/")) {
      const fileName = url.pathname.replace("/reports/", "");
      if (!/^[A-Za-z0-9._-]+\.pdf$/.test(fileName)) return notFound();
      const filePath = safeResolve(REPORTS_DIR_ABS, "/" + fileName);
      if (!filePath) return notFound();
      const res = await serveStaticFile(filePath);
      return res ?? notFound();
    }

    // API routes
    if (url.pathname.startsWith("/api/")) {
      try {
        const res = await router.handle(req);
        return res ?? notFound();
      } catch (e: any) {
        if (String(e?.message ?? e) === "UNAUTHORIZED") {
          return errorResponse(401, "Unauthorized");
        }
        return errorResponse(500, "Server error", String(e));
      }
    }

    // Protected pages redirect
    if (shouldProtect(url.pathname)) {
      const user = getUserFromRequest(db, req);
      if (!user) return redirect("/login.html");
    }

    // Static web
    const pathForWeb = url.pathname === "/" ? "/index.html" : url.pathname;
    const webPath = safeResolve(WEB_ROOT_ABS, pathForWeb);
    if (!webPath) return notFound();
    const staticRes = await serveStaticFile(webPath);
    return staticRes ?? notFound();
  }
});
