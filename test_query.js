import postgres from 'postgres';
const sql = postgres(process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/mmrconstructions');

async function testQuery() {
  try {
    const associates = await sql`SELECT user_id, full_name, user_type FROM users WHERE user_type ILIKE 'Associate'`;
    console.log("Associates via ILIKE:", associates.length);
    
    const allUsers = await sql`SELECT user_id, full_name, user_type FROM users LIMIT 10`;
    console.log("Sample Users:", allUsers);
  } catch(e) {
    console.error(e);
  } finally {
    process.exit(0);
  }
}

testQuery();
