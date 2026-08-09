import "../config/loadEnv.js";
import postgres from "postgres";
import fs from "fs";
import path from "path";

const supabaseUrl = process.env.SUPABASE_DATABASE_URL || process.env.DATABASE_URL;

const vpsHost = process.env.DB_HOST || process.env.DATABASE_HOST || "66.116.248.35";
const vpsPort = process.env.DB_PORT || process.env.DATABASE_PORT || "5432";
const vpsDb = process.env.DB_NAME || process.env.DATABASE_NAME || "mmrconstructions";
const vpsUser = process.env.DB_USER || process.env.DATABASE_USER || "mmruser";
const vpsPassword = process.env.DB_PASSWORD || process.env.DATABASE_PASSWORD;

if (!vpsPassword || vpsPassword === "YOUR_VPS_DATABASE_PASSWORD") {
  console.error("❌ ERROR: VPS Database password missing!");
  process.exit(1);
}

const vpsUrl = `postgres://${encodeURIComponent(vpsUser)}:${encodeURIComponent(vpsPassword)}@${vpsHost}:${vpsPort}/${vpsDb}`;

async function runFastDataImport() {
  console.log("=================================================");
  console.log("BULK DATA IMPORT TO VPS POSTGRESQL");
  console.log("=================================================");

  const supabaseSql = postgres(supabaseUrl, { ssl: "require", onnotice: () => {} });
  const vpsSql = postgres(vpsUrl, { ssl: false, onnotice: () => {} });

  try {
    const dumpPath = path.join(process.cwd(), "..", "database_full_backup.sql");
    console.log(`Reading ${dumpPath}...`);
    const dumpSql = fs.readFileSync(dumpPath, "utf-8");

    console.log("Executing bulk SQL data import on VPS PostgreSQL...");
    await vpsSql.unsafe(dumpSql);
    console.log("✅ Bulk SQL Data Import Complete!\n");

    console.log("Verifying row counts on VPS Database...");
    const tablesRes = await vpsSql`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name ASC
    `;

    console.log(`\n=================================================`);
    console.log(`🎉 MIGRATION SUCCESSFUL! (${tablesRes.length} Tables Verified on VPS)`);
    console.log(`=================================================`);
    for (const t of tablesRes.slice(0, 15)) {
      const cntRes = await vpsSql.unsafe(`SELECT COUNT(*) as cnt FROM "${t.table_name}"`);
      console.log(`  Table "${t.table_name}": ${cntRes[0].cnt} rows`);
    }

  } catch (err) {
    console.error("\n❌ Import Error:", err.message);
  } finally {
    await supabaseSql.end().catch(() => {});
    await vpsSql.end().catch(() => {});
  }
}

runFastDataImport();
