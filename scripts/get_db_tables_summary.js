import sql from "../db.js";
import fs from "fs";
import path from "path";

async function dumpDatabaseStructure() {
  try {
    console.log("Fetching all tables and views...");
    const tablesRes = await sql`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name ASC
    `;

    const viewsRes = await sql`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_type = 'VIEW'
      ORDER BY table_name ASC
    `;

    const tableNames = tablesRes.map(t => t.table_name);
    const viewNames = viewsRes.map(v => v.table_name);

    console.log("Fetching all column definitions in one query...");
    const allColumns = await sql`
      SELECT table_name, column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name ASC, ordinal_position ASC
    `;

    const columnsByTable = {};
    for (const col of allColumns) {
      if (!columnsByTable[col.table_name]) {
        columnsByTable[col.table_name] = [];
      }
      columnsByTable[col.table_name].push({
        name: col.column_name,
        type: col.data_type,
        nullable: col.is_nullable,
        default: col.column_default
      });
    }

    console.log("Fetching row counts...");
    const rowCountsRes = await sql`
      SELECT relname AS table_name, n_live_tup AS row_count
      FROM pg_stat_user_tables
    `;
    const countsMap = {};
    for (const r of rowCountsRes) {
      countsMap[r.table_name] = parseInt(r.row_count, 10);
    }

    const tablesDetail = tableNames.map(name => ({
      table: name,
      rowCount: countsMap[name] !== undefined ? countsMap[name] : 0,
      columns: columnsByTable[name] || []
    }));

    const outputData = {
      total_tables: tableNames.length,
      total_views: viewNames.length,
      views: viewNames,
      tables: tablesDetail
    };

    const outputPath = path.join(process.cwd(), "db_schema_dump.json");
    fs.writeFileSync(outputPath, JSON.stringify(outputData, null, 2));
    console.log(`Successfully saved schema dump to ${outputPath}`);
  } catch (err) {
    console.error("Error generating DB dump:", err);
  } finally {
    await sql.end();
  }
}

dumpDatabaseStructure();
