
// backend/config/db.js
import dotenv from "dotenv";
import pkg from "pg";
dotenv.config();

const { Pool } = pkg;

const connectionString = process.env.DATABASE_URL;

const shouldUseSsl = (() => {
  const flag = String(process.env.DATABASE_SSL || "").toLowerCase();
  if (["true", "1", "yes"].includes(flag)) return true;
  if (["false", "0", "no"].includes(flag)) return false;

  if (!connectionString) return false;
  if (/sslmode=require/i.test(connectionString)) return true;
  if (/supabase\.(co|com)/i.test(connectionString)) return true;
  if (/pooler\.supabase\.com/i.test(connectionString)) return true;
  return false;
})();

export const pool = new Pool({
  connectionString,
  ssl: shouldUseSsl ? { rejectUnauthorized: false } : false,
});
