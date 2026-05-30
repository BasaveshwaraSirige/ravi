import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { queryOne } from "../db.js";
import { issueJwt } from "../middleware/auth.js";
import { tokenLimiter } from "../middleware/rateLimiters.js";
import { publicUser, sanitizeText } from "../utils/sanitize.js";

const router = Router();
const loginSchema = z.object({
  username: z.string().min(1).max(80),
  password: z.string().min(1).max(200)
});

router.post("/login", tokenLimiter, async (req, res, next) => {
  try {
    const body = loginSchema.parse(req.body || {});
    const user = await queryOne(
      `SELECT id, username, password_hash, role, shop_id AS "shopId"
       FROM users
       WHERE username = $1
       LIMIT 1`,
      [sanitizeText(body.username, 80)]
    );
    if (!user) return res.status(401).json({ ok: false, error: { message: "Invalid credentials" } });
    const valid = await bcrypt.compare(body.password, user.password_hash);
    if (!valid) return res.status(401).json({ ok: false, error: { message: "Invalid credentials" } });
    const token = issueJwt(user);
    return res.json({ ok: true, token, user: publicUser(user) });
  } catch (error) {
    return next(error);
  }
});

export default router;
