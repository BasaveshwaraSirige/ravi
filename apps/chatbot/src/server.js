import express from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import morgan from "morgan";
import path from "node:path";
import { config, assertProductionConfig } from "./config.js";
import { logger } from "./logger.js";
import { migrateChatbot } from "./db.js";
import authRoutes from "./routes/auth.js";
import chatRoutes from "./routes/chat.js";
import modelRoutes from "./routes/models.js";
import predictionRoutes from "./routes/predictions.js";
import { notFound, errorHandler } from "./middleware/errorHandler.js";

assertProductionConfig(logger);
await migrateChatbot();

const app = express();

app.disable("x-powered-by");
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(cors({ origin: config.webOrigin, credentials: true }));
app.use(compression());
app.use(express.json({ limit: "64kb" }));
app.use(morgan("combined"));
app.use(express.static(path.join(config.appRoot, "public")));

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "sr-groups-local-ai", engine: "ollama" });
});

app.use("/api/auth", authRoutes);
app.use("/api/chat", chatRoutes);
app.use("/api/models", modelRoutes);
app.use("/api/predictions", predictionRoutes);

app.use(notFound);
app.use(errorHandler);

app.listen(config.port, () => {
  logger.info("Local AI backend started", {
    port: config.port,
    ollamaBaseUrl: config.ollamaBaseUrl,
    defaultModel: config.ollamaModel
  });
});
