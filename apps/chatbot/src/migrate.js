import { migrateChatbot, pool } from "./db.js";

await migrateChatbot();
await pool.end();
console.log("Local AI PostgreSQL schema migrated.");
