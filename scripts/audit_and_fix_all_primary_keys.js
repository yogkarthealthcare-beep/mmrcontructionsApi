import sql from "../db.js";

async function auditAndFixAllPrimaryKeys() {
  console.log("================================================================================");
  console.log("         AUDITING & FIXING ALL PRIMARY KEY CONSTRAINTS ON VPS POSTGRESQL        ");
  console.log("================================================================================");

  // 1. Get all tables in public schema
  const tables = await sql`
    SELECT table_name 
    FROM information_schema.tables 
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name;
  `;

  let fixedCount = 0;

  for (const { table_name } of tables) {
    const pkeys = await sql`
      SELECT constraint_name 
      FROM information_schema.table_constraints 
      WHERE table_schema = 'public' AND table_name = ${table_name} AND constraint_type = 'PRIMARY KEY';
    `;

    if (pkeys.length === 0) {
      // Find candidate primary key column
      const cols = await sql`
        SELECT column_name, data_type 
        FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = ${table_name}
        ORDER BY ordinal_position;
      `;

      let pkCandidate = null;
      
      // Look for table_id or id
      const singularName = table_name.replace(/s$/, ""); // e.g. sites -> site, plots -> plot
      const expectedIdName = `${singularName}_id`;

      for (const col of cols) {
        if (col.column_name === expectedIdName || col.column_name === "id" || col.column_name.endsWith("_id")) {
          pkCandidate = col.column_name;
          break;
        }
      }

      if (pkCandidate) {
        console.log(`Table '${table_name}' has NO Primary Key. Candidate column found: '${pkCandidate}'.`);
        try {
          await sql.unsafe(`ALTER TABLE "${table_name}" ADD PRIMARY KEY ("${pkCandidate}");`);
          console.log(`  -> ADDED PRIMARY KEY ("${pkCandidate}") to '${table_name}' ✅`);
          fixedCount++;
        } catch (err) {
          console.warn(`  -> Could not add Primary Key to '${table_name}':`, err.message);
        }
      } else {
        console.log(`Table '${table_name}' has NO Primary Key and no obvious ID column.`);
      }
    }
  }

  console.log("\n================================================================================");
  console.log(`🎉 AUDIT COMPLETE: ${fixedCount} Primary Keys added/repaired!                  `);
  console.log("================================================================================");
}

auditAndFixAllPrimaryKeys()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Audit Error:", err);
    process.exit(1);
  });
