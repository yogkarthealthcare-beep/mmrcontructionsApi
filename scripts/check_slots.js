import postgres from 'postgres';

const sql = postgres('postgres://mmruser:Admin%40333baeb00dA1@66.116.248.35:5432/mmrconstructions', { ssl: 'require' });

async function run() {
  try {
    const users = await sql`SELECT user_id, member_id, full_name, mobile_no, user_type, sponsor_user_id, account_status, is_active FROM users WHERE sponsor_user_id = 81 OR user_id = 81 ORDER BY user_id ASC`;
    console.log('USERS:', JSON.stringify(users, null, 2));

    const tms = await sql`SELECT id, slot_number, user_id, associate_id, team_member_uid, full_name, mobile_no, status, is_final_submitted FROM team_members WHERE associate_id = 81 ORDER BY slot_number ASC`;
    console.log('TEAM MEMBERS:', JSON.stringify(tms, null, 2));

    const allTms = await sql`SELECT id, slot_number, user_id, associate_id, team_member_uid, full_name, mobile_no, status, is_final_submitted FROM team_members ORDER BY id DESC LIMIT 10`;
    console.log('ALL RECENT TEAM MEMBERS:', JSON.stringify(allTms, null, 2));
  } catch (err) {
    console.error('ERROR:', err);
  } finally {
    process.exit(0);
  }
}
run();
