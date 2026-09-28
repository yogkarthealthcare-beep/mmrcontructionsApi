import sql from "./db.js";

async function test() {
  try {
    const users = await sql`SELECT user_id, member_id, full_name, email, user_type, account_status FROM users WHERE LOWER(user_type::text) = 'associate' ORDER BY user_id`;
    console.log('Associates in DB:', users.length);
  } catch (e) {
    console.error(e.message);
  } finally {
    process.exit(0);
  }
}
test();


