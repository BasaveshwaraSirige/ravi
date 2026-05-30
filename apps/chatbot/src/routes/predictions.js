import { Router } from "express";
import { requireJwt } from "../middleware/auth.js";
import { config } from "../config.js";

const router = Router();

const paths = new Set([
  "/tomorrow-sales",
  "/weekly-revenue",
  "/monthly-revenue",
  "/tax-forecast"
]);

async function proxyForecast(req, res, next) {
  try {
    if (!paths.has(req.path)) return res.status(404).json({ ok: false, error: { message: "Not found" } });
    const upstream = new URL(`${config.forecastingServiceUrl}/api/predictions${req.path}`);
    for (const [key, value] of Object.entries(req.query)) {
      if (typeof value === "string") upstream.searchParams.set(key, value);
    }
    const response = await fetch(upstream, {
      headers: {
        "x-internal-service-token": config.internalServiceToken,
        "x-user-id": String(req.user.id),
        "x-user-role": String(req.user.role),
        "x-user-shop-id": req.user.shopId == null ? "" : String(req.user.shopId)
      }
    });
    const data = await response.json();
    return res.status(response.status).json(data);
  } catch (error) {
    return next(error);
  }
}

router.get("/tomorrow-sales", requireJwt, proxyForecast);
router.get("/weekly-revenue", requireJwt, proxyForecast);
router.get("/monthly-revenue", requireJwt, proxyForecast);
router.get("/tax-forecast", requireJwt, proxyForecast);

export default router;
