import { z } from "zod";

export const chatRequestSchema = z.object({
  sessionId: z.string().uuid().optional(),
  message: z.string().min(1).max(2000),
  model: z.string().trim().max(80).optional()
});

export function sanitizeText(value, maxLength = 2000) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

export function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return "{}";
  }
}

export function looksLikePromptInjection(text) {
  const normalized = String(text || "").toLowerCase();
  return [
    "ignore previous",
    "ignore all previous",
    "developer message",
    "system prompt",
    "reveal your prompt",
    "show hidden instructions",
    "write sql",
    "run sql",
    "drop table",
    "delete from"
  ].some((needle) => normalized.includes(needle));
}

export function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    shopId: user.shopId ?? null
  };
}
