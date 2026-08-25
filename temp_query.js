import sql from './db.js';

(async () => {
  try {
    const rows = await sql`SELECT user_id, full_name, user_type, account_status, member_id, invitation_code FROM users WHERE member_id = 'MMR00004' OR member_id LIKE '%00004%'`;
    console.log(rows);
  } catch(e) {
    console.error(e);
  }
  process.exit(0);
})();
