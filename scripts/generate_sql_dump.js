import sql from "../db.js";
import fs from "fs";
import path from "path";

async function generateSqlDump() {
  try {
    console.log("Starting fast Database SQL Dump generation...");

    let dumpContent = "";
    dumpContent += `-- ========================================================\n`;
    dumpContent += `-- MMR CONSTRUCTIONS FULL DATABASE DUMP\n`;
    dumpContent += `-- Generated: ${new Date().toISOString()}\n`;
    dumpContent += `-- Database Engine: PostgreSQL\n`;
    dumpContent += `-- ========================================================\n\n`;
    dumpContent += `SET statement_timeout = 0;\n`;
    dumpContent += `SET client_encoding = 'UTF8';\n`;
    dumpContent += `SET standard_conforming_strings = on;\n`;
    dumpContent += `SET check_function_bodies = false;\n`;
    dumpContent += `SET client_min_messages = warning;\n`;
    dumpContent += `SET row_security = off;\n\n`;

    const tablesRes = await sql`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name ASC
    `;
    const tableNames = tablesRes.map(t => t.table_name);

    console.log(`Processing ${tableNames.length} tables...`);

    for (const tableName of tableNames) {
      try {
        const rows = await sql.unsafe(`SELECT * FROM "${tableName}"`);
        if (rows.length > 0) {
          dumpContent += `-- Table: "${tableName}" (${rows.length} rows)\n`;
          const colNames = Object.keys(rows[0]).map(c => `"${c}"`).join(", ");
          for (const row of rows) {
            const values = Object.values(row).map(val => {
              if (val === null || val === undefined) return "NULL";
              if (typeof val === "number" || typeof val === "boolean") return val;
              if (typeof val === "object") return `'${JSON.stringify(val).replace(/'/g, "''")}'`;
              return `'${String(val).replace(/'/g, "''")}'`;
            }).join(", ");
            dumpContent += `INSERT INTO "${tableName}" (${colNames}) VALUES (${values}) ON CONFLICT DO NOTHING;\n`;
          }
          dumpContent += "\n";
        }
      } catch (err) {
        // Skip view/system table errors silently
      }
    }

    const targetFile = path.join(process.cwd(), "..", "database_full_backup.sql");
    const targetFileApi = path.join(process.cwd(), "database_full_backup.sql");

    fs.writeFileSync(targetFile, dumpContent, "utf-8");
    fs.writeFileSync(targetFileApi, dumpContent, "utf-8");

    console.log(`FULL SQL DUMP SUCCESS: Saved to:\n 1. ${targetFile}\n 2. ${targetFileApi}`);
  } catch (err) {
    console.error("Error generating SQL dump:", err);
  } finally {
    await sql.end();
  }
}

generateSqlDump();
