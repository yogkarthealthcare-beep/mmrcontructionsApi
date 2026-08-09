import postgres from "postgres";
import fs from "fs";
import path from "path";

/**
 * Migration Script to transfer Database to a new server
 * Usage: node scripts/migrate_to_new_db.js "<NEW_DATABASE_URL>"
 */

const newDbUrl = process.argv[2] || process.env.NEW_DATABASE_URL;

if (!newDbUrl) {
  console.error("ERROR: New Database URL is required!");
  console.log("\nUsage:");
  console.log("  node scripts/migrate_to_new_db.js \"postgres://user:password@new-server-host:5432/dbname\"");
  process.exit(1);
}

async function runMigration() {
  console.log("Connecting to NEW Database Server...");
  const newSql = postgres(newDbUrl, {
    ssl: /supabase|neon|render|railway/i.test(newDbUrl) ? "require" : false,
    onnotice: () => {}
  });

  try {
    console.log("Reading database_full_backup.sql...");
    const dumpPath = path.join(process.cwd(), "..", "database_full_backup.sql");
    const sqlStatements = fs.readFileSync(dumpPath, "utf-8");

    console.log("Executing SQL Dump on NEW Database Server...");
    await newSql.unsafe(sqlStatements);
    console.log("MIGRATION COMPLETED SUCCESSFULLY! All tables & data transferred to new server.");
  } catch (err) {
    console.error("Migration Error:", err.message);
  } finally {
    await newSql.end();
  }
}

runMigration();
