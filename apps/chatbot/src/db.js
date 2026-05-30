import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { config } from "./config.js";

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 12,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000
});

export async function query(text, params = []) {
  const result = await pool.query(text, params);
  return result.rows;
}

export async function queryOne(text, params = []) {
  const rows = await query(text, params);
  return rows[0] || null;
}

export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const value = await fn(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function migrateChatbot() {
  const schemaPath = path.join(config.appRoot, "sql", "schema.postgres.sql");
  await pool.query(fs.readFileSync(schemaPath, "utf8"));
  await pool.query(
    `INSERT INTO chatbot_settings (key, value)
     VALUES ('model', $1), ('temperature', $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [config.ollamaModel, String(config.ollamaTemperature)]
  );
}
