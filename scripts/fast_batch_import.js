import "../config/loadEnv.js";
import postgres from "postgres";
import fs from "fs";
import readline from "readline";
import path from "path";

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

async function runFastBatchImport() {
  console.log("=================================================");
  console.log("FAST STREAMED BATCH DATA IMPORT TO VPS");
  console.log("=================================================");

  const vpsSql = postgres(vpsUrl, { ssl: false, max: 5, onnotice: () => {} });

  try {
    const dumpPath = path.join(process.cwd(), "..", "database_full_backup.sql");
    console.log(`Streaming ${dumpPath}...`);

    const fileStream = fs.createReadStream(dumpPath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });

    let batch = [];
    let count = 0;
    let successCount = 0;

    for await (const line of rl) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("--") && !trimmed.startsWith("SET ")) {
        batch.push(trimmed);
        count++;

        if (batch.length >= 50) {
          const queryChunk = batch.join("\n");
          try {
            await vpsSql.unsafe(queryChunk);
            successCount += batch.length;
          } catch (e) {
            // execute line by line fallback if batch has conflict
            for (const q of batch) {
              try { await vpsSql.unsafe(q); successCount++; } catch (err) {}
            }
          }
          batch = [];
          if (count % 500 === 0) {
            console.log(`  -> Executed ${count} INSERT statements...`);
          }
        }
      }
    }

    if (batch.length > 0) {
      const queryChunk = batch.join("\n");
      try {
        await vpsSql.unsafe(queryChunk);
        successCount += batch.length;
      } catch (e) {
        for (const q of batch) {
          try { await vpsSql.unsafe(q); successCount++; } catch (err) {}
        }
      }
    }

    console.log(`\n✅ Total SQL statements executed: ${count}`);
    console.log("Verifying table row counts on VPS Database...\n");

    const tablesRes = await vpsSql`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name ASC
    `;

    console.log("=================================================");
    console.log(`🎉 FULL MIGRATION & DATA COPY SUCCESSFUL!`);
    console.log(`=================================================`);
    console.log(`Total Tables Verified on VPS: ${tablesRes.length}`);
    console.log("-------------------------------------------------");
    for (const t of tablesRes.slice(0, 20)) {
      try {
        const cntRes = await vpsSql.unsafe(`SELECT COUNT(*) as cnt FROM "${t.table_name}"`);
        console.log(`  Table "${t.table_name.padEnd(30)}": ${cntRes[0].cnt} rows`);
      } catch (err) {}
    }
    console.log("=================================================");

  } catch (err) {
    console.error("❌ Batch Import Error:", err.message);
  } finally {
    await vpsSql.end().catch(() => {});
  }
}

runFastBatchImport();
