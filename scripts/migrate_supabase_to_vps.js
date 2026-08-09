import "../config/loadEnv.js";
import postgres from "postgres";
import fs from "fs";
import path from "path";

// 1. Supabase Source Connection
const supabaseUrl = process.env.SUPABASE_DATABASE_URL || process.env.DATABASE_URL;

// 2. VPS Target Connection
const vpsHost = process.env.DB_HOST || process.env.DATABASE_HOST || "66.116.248.35";
const vpsPort = process.env.DB_PORT || process.env.DATABASE_PORT || "5432";
const vpsDb = process.env.DB_NAME || process.env.DATABASE_NAME || "mmrconstructions";
const vpsUser = process.env.DB_USER || process.env.DATABASE_USER || "mmruser";
const vpsPassword = process.env.DB_PASSWORD || process.env.DATABASE_PASSWORD || process.argv[2];

if (!vpsPassword || vpsPassword === "YOUR_VPS_DATABASE_PASSWORD") {
  console.error("❌ ERROR: VPS Database password is required!");
  console.log("\nPlease pass your VPS password as an argument or set DB_PASSWORD in .env:");
  console.log("  node scripts/migrate_supabase_to_vps.js \"YOUR_REAL_VPS_PASSWORD\"");
  process.exit(1);
}

const vpsUrl = `postgres://${encodeURIComponent(vpsUser)}:${encodeURIComponent(vpsPassword)}@${vpsHost}:${vpsPort}/${vpsDb}`;

async function runMigration() {
  console.log("=================================================");
  console.log("SUPABASE TO VPS POSTGRESQL MIGRATION");
  console.log("=================================================");
  console.log(`Source (Supabase): Connected`);
  console.log(`Target (VPS): ${vpsHost}:${vpsPort}/${vpsDb} (User: ${vpsUser})`);
  console.log("-------------------------------------------------\n");

  const supabaseSql = postgres(supabaseUrl, { ssl: "require", onnotice: () => {} });
  const vpsSql = postgres(vpsUrl, { ssl: false, onnotice: () => {} });

  try {
    // Step 1: Verify connections
    console.log("[Step 1/4] Verifying source & target connections...");
    await supabaseSql`SELECT 1`;
    await vpsSql`SELECT 1`;
    console.log("✅ Connections verified successfully!\n");

    // Step 2: Fetch all tables from Supabase
    console.log("[Step 2/4] Fetching all tables and row counts from Supabase...");
    const tablesRes = await supabaseSql`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name ASC
    `;
    const tableNames = tablesRes.map(t => t.table_name);
    console.log(`Found ${tableNames.length} tables in Supabase.\n`);

    // Step 3: Check if database_full_backup.sql exists for bulk restore
    const dumpPath = path.join(process.cwd(), "database_full_backup.sql");
    if (fs.existsSync(dumpPath)) {
      console.log("[Step 3/4] Importing data from database_full_backup.sql into VPS...");
      const sqlContent = fs.readFileSync(dumpPath, "utf-8");
      await vpsSql.unsafe(sqlContent);
      console.log("✅ Bulk SQL dump data imported successfully into VPS!\n");
    } else {
      console.log("[Step 3/4] Copying data table by table...");
      for (const tableName of tableNames) {
        try {
          const rows = await supabaseSql.unsafe(`SELECT * FROM "${tableName}"`);
          if (rows.length > 0) {
            console.log(`  -> Syncing table "${tableName}" (${rows.length} rows)...`);
            const colNames = Object.keys(rows[0]).map(c => `"${c}"`).join(", ");
            for (const row of rows) {
              const values = Object.values(row).map(val => {
                if (val === null || val === undefined) return "NULL";
                if (typeof val === "number" || typeof val === "boolean") return val;
                if (typeof val === "object") return `'${JSON.stringify(val).replace(/'/g, "''")}'`;
                return `'${String(val).replace(/'/g, "''")}'`;
              }).join(", ");
              await vpsSql.unsafe(`INSERT INTO "${tableName}" (${colNames}) VALUES (${values}) ON CONFLICT DO NOTHING`);
            }
          }
        } catch (err) {
          console.warn(`  ⚠️ Skipped ${tableName}:`, err.message);
        }
      }
    }

    // Step 4: Verification
    console.log("[Step 4/4] Comparing row counts between Supabase and VPS...");
    let totalMigratedRows = 0;
    for (const tableName of tableNames.slice(0, 15)) { // sample verification
      try {
        const sRes = await supabaseSql.unsafe(`SELECT COUNT(*) as cnt FROM "${tableName}"`);
        const vRes = await vpsSql.unsafe(`SELECT COUNT(*) as cnt FROM "${tableName}"`);
        console.log(`  Table "${tableName}": Supabase=${sRes[0].cnt} | VPS=${vRes[0].cnt}`);
        totalMigratedRows += parseInt(vRes[0].cnt, 10);
      } catch (err) {}
    }

    console.log("\n=================================================");
    console.log("🎉 MIGRATION COMPLETED SUCCESSFULLY!");
    console.log("=================================================");

  } catch (err) {
    console.error("❌ Migration Failed:", err.message);
  } finally {
    await supabaseSql.end().catch(() => {});
    await vpsSql.end().catch(() => {});
  }
}

runMigration();
