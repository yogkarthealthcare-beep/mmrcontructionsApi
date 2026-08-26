import sql from '../db.js';
async function run() {
  try {
    const res = await sql`SELECT trigger_name, action_statement FROM information_schema.triggers WHERE event_object_table = 'bookings'`;
    console.log("TRIGGERS ON bookings:", res);
    
    const res2 = await sql`SELECT trigger_name, action_statement FROM information_schema.triggers WHERE event_object_table = 'users'`;
    console.log("TRIGGERS ON users:", res2);
  } catch(e) {
    console.error(e);
  } finally {
    process.exit(0);
  }
}
run();
