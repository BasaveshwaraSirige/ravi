import jwt from "jsonwebtoken";
import { config } from "../config.js";

export function issueJwt(user) {
  return jwt.sign(
    {
      sub: String(user.id),
      username: user.username,
      role: user.role,
      shopId: user.shop_id ?? user.shopId ?? null
    },
    config.jwtSecret,
    { expiresIn: config.jwtTtl }
  );
}

export function requireJwt(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) {
    return res.status(401).json({ ok: false, error: { message: "Missing JWT token" } });
  }
  try {
    const decoded = jwt.verify(token, config.jwtSecret);
    req.user = {
      id: Number(decoded.sub),
      username: decoded.username,
      role: decoded.role,
      shopId: decoded.shopId ?? null
    };
    return next();
  } catch {
    return res.status(401).json({ ok: false, error: { message: "Invalid or expired JWT token" } });
  }
}

export function requireOwner(req, res, next) {
  if (req.user?.role !== "OWNER") {
    return res.status(403).json({ ok: false, error: { message: "Owner access required" } });
  }
  return next();
}
