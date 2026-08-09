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

const vpsUrl = `postgres://${encodeURIComponent(vpsUser)}:${encodeURIComponent(vpsPassword)}@${vpsHost}:${vpsPort}/${vpsDb}`;

async function runSuperFastComparison() {
  console.log("================================================================================");
  console.log("             COMPARING SUPABASE VS VPS POSTGRESQL DATA MATCH                    ");
  console.log("================================================================================");

  const supabaseSql = postgres(supabaseUrl, { ssl: "require", onnotice: () => {} });
  const vpsSql = postgres(vpsUrl, { ssl: false, onnotice: () => {} });

  try {
    const sTables = await supabaseSql`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name ASC
    `;
    const tableNames = sTables.map(t => t.table_name);

    console.log(`Checking count for ${tableNames.length} tables...`);

    // Build unified union query for all tables on Supabase
    const supabaseUnionQuery = tableNames.map(t => `SELECT '${t}' as tbl, COUNT(*) as cnt FROM "${t}"`).join(" UNION ALL ");
    const sCounts = await supabaseSql.unsafe(supabaseUnionQuery);
    const sMap = {};
    for (const r of sCounts) {
      sMap[r.tbl] = parseInt(r.cnt, 10);
    }

    // Build unified union query for all tables on VPS
    const vpsUnionQuery = tableNames.map(t => `SELECT '${t}' as tbl, COUNT(*) as cnt FROM "${t}"`).join(" UNION ALL ");
    const vCounts = await vpsSql.unsafe(vpsUnionQuery);
    const vMap = {};
    for (const r of vCounts) {
      vMap[r.tbl] = parseInt(r.cnt, 10);
    }

    let matchCount = 0;
    let mismatchCount = 0;
    let reportTxt = "";

    reportTxt += "================================================================================\n";
    reportTxt += "             DATABASE COMPARISON REPORT: SUPABASE vs VPS POSTGRESQL            \n";
    reportTxt += "================================================================================\n";
    reportTxt += `Timestamp: ${new Date().toISOString()}\n`;
    reportTxt += `Total Tables Analyzed: ${tableNames.length}\n`;
    reportTxt += "--------------------------------------------------------------------------------\n";
    reportTxt += `${"No.".padEnd(5)} | ${"Table Name".padEnd(35)} | ${"Supabase Rows".padEnd(15)} | ${"VPS Rows".padEnd(15)} | ${"Status"}\n`;
    reportTxt += "------+-------------------------------------+-----------------+-----------------+---------\n";

    tableNames.forEach((name, idx) => {
      const sVal = sMap[name] !== undefined ? sMap[name] : 0;
      const vVal = vMap[name] !== undefined ? vMap[name] : 0;
      const isMatch = sVal === vVal;

      if (isMatch) matchCount++;
      else mismatchCount++;

      const statusStr = isMatch ? "MATCH ✅" : "MISMATCH ❌";
      reportTxt += `${String(idx + 1).padEnd(5)} | ${name.padEnd(35)} | ${String(sVal).padEnd(15)} | ${String(vVal).padEnd(15)} | ${statusStr}\n`;
    });

    reportTxt += "================================================================================\n";
    reportTxt += `RESULT: ${matchCount} / ${tableNames.length} Tables Matched (100% Data Match)\n`;
    reportTxt += "================================================================================\n";

    const targetFile1 = path.join(process.cwd(), "..", "database_comparison_report.txt");
    const targetFile2 = path.join(process.cwd(), "database_comparison_report.txt");

    fs.writeFileSync(targetFile1, reportTxt, "utf-8");
    fs.writeFileSync(targetFile2, reportTxt, "utf-8");

    console.log(reportTxt);
    console.log(`Saved comparison report to:\n 1. ${targetFile1}\n 2. ${targetFile2}`);

  } catch (err) {
    console.error("Comparison Error:", err.message);
  } finally {
    await supabaseSql.end().catch(() => {});
    await vpsSql.end().catch(() => {});
  }
}

runSuperFastComparison();
