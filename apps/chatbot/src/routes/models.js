import { Router } from "express";
import { requireJwt } from "../middleware/auth.js";
import { listOllamaModels } from "../ollama.js";
import { config } from "../config.js";

const router = Router();

router.get("/", requireJwt, async (req, res, next) => {
  try {
    const installed = await listOllamaModels();
    const allowed = installed.filter((name) =>
      config.allowedModels.some((prefix) => name.toLowerCase().startsWith(prefix))
    );
    res.json({
      ok: true,
      defaultModel: config.ollamaModel,
      allowedPrefixes: config.allowedModels,
      installedModels: allowed
    });
  } catch (error) {
    next(error);
  }
});

export default router;
