require('dotenv').config();
const postgres = require('postgres');
const fs = require('fs');

async function dumpSchema() {
  const sql = postgres(process.env.DATABASE_URL);
  try {
    const tables = await sql`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `;
    
    let schema = {};
    for (const row of tables) {
      const tableName = row.table_name;
      const columns = await sql`
        SELECT column_name, data_type, is_nullable, column_default 
        FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = ${tableName}
      `;
      
      const constraints = await sql`
        SELECT 
          tc.constraint_type, tc.constraint_name, kcu.column_name, 
          ccu.table_name AS foreign_table_name,
          ccu.column_name AS foreign_column_name 
        FROM information_schema.table_constraints AS tc 
        JOIN information_schema.key_column_usage AS kcu 
          ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema 
        LEFT JOIN information_schema.constraint_column_usage AS ccu 
          ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema 
        WHERE tc.table_schema = 'public' AND tc.table_name = ${tableName}
      `;
      
      let rowCount = 0;
      try {
        const countRes = await sql.unsafe(`SELECT COUNT(*) as count FROM "${tableName}"`);
        rowCount = parseInt(countRes[0].count);
      } catch(e) {
        // ignore count errors
      }

      schema[tableName] = {
        columns: columns,
        constraints: constraints,
        rowCount: rowCount
      };
    }
    
    fs.writeFileSync('db_schema_dump.json', JSON.stringify(schema, null, 2));
    console.log('Schema dumped to db_schema_dump.json');
  } catch (err) {
    console.error('Error dumping schema:', err);
  } finally {
    process.exit();
  }
}

dumpSchema();
