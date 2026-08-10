import postgres from "postgres";
import "./config/loadEnv.js";

// Primary VPS Database URL builder
export const getDatabaseUrl = () => {
  const host = process.env.DATABASE_HOST || process.env.PGHOST || process.env.DB_HOST;
  const database = process.env.DATABASE_NAME || process.env.PGDATABASE || process.env.DB_NAME;
  const user = process.env.DATABASE_USER || process.env.PGUSER || process.env.DB_USER;
  const password = process.env.DATABASE_PASSWORD || process.env.PGPASSWORD || process.env.DB_PASSWORD;
  const port = process.env.DATABASE_PORT || process.env.PGPORT || process.env.DB_PORT || "5432";

  if (host && database && user) {
    const encodedUser = encodeURIComponent(user);
    const encodedPassword = password ? `:${encodeURIComponent(password)}` : "";
    return `postgres://${encodedUser}${encodedPassword}@${host}:${port}/${database}`;
  }

  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  throw new Error("Database configuration missing. Set DATABASE_HOST/DATABASE_NAME/DATABASE_USER/DATABASE_PASSWORD or DATABASE_URL.");
};

// Secondary Database URL builder (Alias to VPS DB)
export const getSupabaseDatabaseUrl = () => {
  return getDatabaseUrl();
};

export const getDatabaseConfig = () => {
  const host = process.env.DATABASE_HOST || process.env.PGHOST || process.env.DB_HOST || "localhost";
  const database = process.env.DATABASE_NAME || process.env.PGDATABASE || process.env.DB_NAME || "mmrconstructions";
  const port = process.env.DATABASE_PORT || process.env.PGPORT || process.env.DB_PORT || "5432";
  return { host, database, port };
};

const resolveSsl = (url) => {
  const value = String(process.env.DB_SSL || process.env.PGSSLMODE || "").toLowerCase();
  if (["disable", "false", "0", "no"].includes(value)) return false;
  if (["require", "true", "1", "yes"].includes(value)) return "require";

  if (/localhost|127\.0\.0\.1/i.test(url)) return false;
  return false;
};

const maxConnections = Number(process.env.DB_MAX_CONNECTIONS) || 20;

// Primary Connection Pool (VPS PostgreSQL)
const sql = postgres(getDatabaseUrl(), {
  max: maxConnections,
  idle_timeout: 30,
  connect_timeout: 10,
  ssl: resolveSsl(getDatabaseUrl()),
  onnotice: () => {},
});

// Secondary Connection Alias (Points to Primary VPS DB)
export const supabaseSql = sql;

export default sql;


