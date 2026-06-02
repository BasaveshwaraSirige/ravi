import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

dotenv.config({
  path: path.resolve(process.cwd(), "../../.env")
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..");
const projectRoot = path.resolve(appRoot, "../..");

export const config = {
  appRoot,
  projectRoot,
  port: Number.parseInt(process.env.PORT || "4000", 10),
  databaseUrl: process.env.DATABASE_URL || "postgres://sr_user:sr_password@localhost:5432/sr_groups",
  jwtSecret: process.env.JWT_SECRET || "dev-only-change-this-secret",
  jwtTtl: process.env.JWT_TTL || "1h",
  webOrigin: process.env.WEB_ORIGIN || "http://localhost:3000",
  ollamaBaseUrl: (process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434").replace(/\/+$/, ""),
  ollamaModel: process.env.OLLAMA_MODEL || "qwen3",
  ollamaTemperature: Number.parseFloat(process.env.OLLAMA_TEMPERATURE || "0.2"),
  allowedModels: (process.env.ALLOWED_LOCAL_MODELS || "qwen3,qwen,llama3,mistral,gemma")
    .split(",")
    .map((model) => model.trim().toLowerCase())
    .filter(Boolean),
  maxChatHistory: Number.parseInt(process.env.MAX_CHAT_HISTORY || "16", 10),
  maxToolRows: Number.parseInt(process.env.MAX_TOOL_ROWS || "12", 10),
  billingApiUrl: (process.env.BILLING_API_URL || "http://127.0.0.1:3000").replace(/\/+$/, ""),
  billingApiTimeoutMs: Number.parseInt(process.env.BILLING_API_TIMEOUT_MS || "8000", 10),
  forecastingServiceUrl: (process.env.FORECASTING_SERVICE_URL || "http://127.0.0.1:5001").replace(/\/+$/, ""),
  internalServiceToken: process.env.INTERNAL_SERVICE_TOKEN || "dev-internal-token"
};

export function assertProductionConfig(logger) {
  if (process.env.NODE_ENV === "production") {
    if (config.jwtSecret === "dev-only-change-this-secret") {
      logger.error("JWT_SECRET must be changed in production.");
      process.exit(1);
    }
    if (config.internalServiceToken === "dev-internal-token") {
      logger.error("INTERNAL_SERVICE_TOKEN must be changed in production.");
      process.exit(1);
    }
  }
}
