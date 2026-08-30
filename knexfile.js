import "./config/loadEnv.js";
import { getDatabaseUrl } from "./db.js";

// Determine SSL settings matching db.js resolveSsl but format for pg/knex
const getSslConfig = () => {
  const value = String(process.env.DB_SSL || process.env.PGSSLMODE || "").toLowerCase();
  if (["disable", "false", "0", "no"].includes(value)) return false;
  if (["require", "true", "1", "yes"].includes(value)) {
    return { rejectUnauthorized: false };
  }
  
  const url = getDatabaseUrl();
  if (/localhost|127\.0\.0\.1/i.test(url)) return false;
  
  // Default to SSL require (rejectUnauthorized: false) for remote hosts
  return { rejectUnauthorized: false };
};

export default {
  client: "pg",
  connection: {
    connectionString: getDatabaseUrl(),
    ssl: getSslConfig()
  },
  migrations: {
    directory: "./migrations"
  }
};
