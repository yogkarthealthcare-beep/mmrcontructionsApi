import postgres from 'postgres';
import '../config/loadEnv.js';

const sql = postgres({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  username: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: 'require'
});

async function run() {
  try {
    const tables = [
      'investor_users',
      'investors',
      'investor_enrollments',
      'investor_deposits',
      'investor_documents',
      'investor_notifications',
      'investor_settlement_preferences',
      'investor_transactions',
      'investor_withdrawals',
      'audit_log'
    ];

    for (const t of tables) {
      console.log(`\n=== Table: ${t} ===`);
      const cols = await sql`
        SELECT column_name, data_type, udt_name 
        FROM information_schema.columns 
        WHERE table_name = ${t}
        ORDER BY ordinal_position
      `;
      for (const c of cols) {
        console.log(`  ${c.column_name}: ${c.data_type} (${c.udt_name})`);
      }
    }

    console.log('\nSample investor_enrollments:');
    const enrollments = await sql`SELECT * FROM investor_enrollments LIMIT 3`;
    console.log(enrollments);

    console.log('\nSample investor_users:');
    const users = await sql`SELECT id, full_name, email FROM investor_users LIMIT 3`;
    console.log(users);

    console.log('\nSample investors:');
    const inv = await sql`SELECT * FROM investors LIMIT 3`;
    console.log(inv);

  } catch (err) {
    console.error('Error:', err);
  } finally {
    await sql.end();
  }
}

run();
