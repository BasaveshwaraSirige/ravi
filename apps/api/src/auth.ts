import type { Db } from "./db";
import { parseCookies, setCookie, clearCookie } from "./cookies";
import { sha256Hex, randomToken } from "./crypto";
import { env, envInt } from "./env";

export type AuthedUser = {
  id: number;
  username: string;
  role: "OWNER" | "STAFF";
  shopId: number | null;
};

export async function loginWithPassword(db: Db, username: string, password: string) {
  const row = db
    .query("SELECT id, username, password_hash, role, shop_id FROM users WHERE username = ?")
    .get(username) as
    | {
        id: number;
        username: string;
        password_hash: string;
        role: AuthedUser["role"];
        shop_id: number | null;
      }
    | null;

  if (!row) return null;
  const ok = await Bun.password.verify(password, row.password_hash);
  if (!ok) return null;
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    shopId: row.shop_id ?? null
  } satisfies AuthedUser;
}

export function createSession(db: Db, userId: number) {
  const token = randomToken(32);
  const tokenHash = sha256Hex(token);
  const ttlDays = envInt("SESSION_TTL_DAYS", 14);
  const expiresAt = new Date(Date.now() + ttlDays * 86400_000).toISOString();

  db.query(
    "INSERT INTO sessions (user_id, token_hash, expires_at, last_used_at) VALUES (?, ?, ?, datetime('now'))"
  ).run(userId, tokenHash, expiresAt);

  return { token, expiresAt };
}

export function deleteSessionByToken(db: Db, token: string) {
  const tokenHash = sha256Hex(token);
  db.query("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
}

export function setSessionCookie(headers: Headers, token: string) {
  const cookieName = env("SESSION_COOKIE_NAME", "sr_session");
  const secure = env("PUBLIC_BASE_URL", "http://localhost:3000").startsWith("https://");
  const ttlDays = envInt("SESSION_TTL_DAYS", 14);
  setCookie(headers, cookieName, token, {
    httpOnly: true,
    secure,
    sameSite: "Lax",
    path: "/",
    maxAgeSeconds: ttlDays * 86400
  });
}

export function clearSessionCookie(headers: Headers) {
  const cookieName = env("SESSION_COOKIE_NAME", "sr_session");
  clearCookie(headers, cookieName);
}

export function getSessionTokenFromRequest(req: Request) {
  const cookieName = env("SESSION_COOKIE_NAME", "sr_session");
  const cookies = parseCookies(req.headers.get("cookie"));
  return cookies[cookieName] ?? null;
}

export function getUserFromRequest(db: Db, req: Request): AuthedUser | null {
  const token = getSessionTokenFromRequest(req);
  if (!token) return null;
  const tokenHash = sha256Hex(token);

  const row = db
    .query(
      `SELECT u.id as id, u.username as username, u.role as role, u.shop_id as shopId
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND datetime(s.expires_at) > datetime('now')`
    )
    .get(tokenHash) as AuthedUser | null;

  if (!row) return null;
  db.query("UPDATE sessions SET last_used_at = datetime('now') WHERE token_hash = ?").run(
    tokenHash
  );
  return row;
}

export function requireAuth(db: Db, req: Request): AuthedUser {
  const u = getUserFromRequest(db, req);
  if (!u) throw new Error("UNAUTHORIZED");
  return u;
}
