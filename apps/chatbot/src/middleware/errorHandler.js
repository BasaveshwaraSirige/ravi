import { logger } from "../logger.js";

export function notFound(req, res) {
  res.status(404).json({ ok: false, error: { message: "Not found" } });
}

export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  logger.error("Request failed", {
    message: err.message,
    stack: err.stack,
    path: req.path,
    userId: req.user?.id
  });
  const status = Number.isInteger(err.status) ? err.status : 500;
  res.status(status).json({
    ok: false,
    error: {
      message: status >= 500 ? "Server error" : err.message,
      details: process.env.NODE_ENV === "production" ? undefined : err.details
    }
  });
}
