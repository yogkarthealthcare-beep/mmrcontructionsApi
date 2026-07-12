import postgres from "postgres";
import "./config/loadEnv.js";

export const getDatabaseUrl = () => {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  const host = process.env.PGHOST || process.env.DB_HOST;
  const database = process.env.PGDATABASE || process.env.DB_NAME;
  const user = process.env.PGUSER || process.env.DB_USER;
  const password = process.env.PGPASSWORD || process.env.DB_PASSWORD;
  const port = process.env.PGPORT || process.env.DB_PORT || "5432";

  if (!host || !database || !user) {
    throw new Error("Database configuration missing. Set DATABASE_URL or PGHOST/PGDATABASE/PGUSER.");
  }

  const encodedUser = encodeURIComponent(user);
  const encodedPassword = password ? `:${encodeURIComponent(password)}` : "";
  return `postgres://${encodedUser}${encodedPassword}@${host}:${port}/${database}`;
};

const resolveSsl = () => {
  const value = String(process.env.DB_SSL || process.env.PGSSLMODE || "").toLowerCase();
  if (["disable", "false", "0", "no"].includes(value)) return false;
  if (["require", "true", "1", "yes"].includes(value)) return "require";

  const url = getDatabaseUrl();
  return /supabase\.(co|com)|pooler\.supabase\.com/i.test(url) ? "require" : false;
};

const sql = postgres(getDatabaseUrl(), {
  ssl: resolveSsl(),
  onnotice: () => {},
});

export default sql;
