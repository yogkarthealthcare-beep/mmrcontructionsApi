const postgres = require('postgres');
const sql = postgres({
  host: '66.116.248.35',
  port: 5432,
  database: 'mmrconstructions',
  username: 'mmruser',
  password: 'Admin@333baeb00dA1',
  max: 1
});

async function run() {
  try {
    const search = '';
    const status = '';
    const rank = '';
    const sponsor = '';
    const pageNumber = 1;
    const pageSize = 20;
    const searchTerm = `%${String(search || '').trim()}%`;

    console.log('searchTerm:', searchTerm);
    console.log("Checking DB users...");
    const allUsersCount = await sql`SELECT COUNT(*) FROM users`;
    console.log("Total users:", allUsersCount);

    const associateUsers = await sql`SELECT user_id, user_type FROM users WHERE user_type ILIKE 'Associate'`;
    console.log("Associate users count:", associateUsers.length);
    console.log("Sample associate user:", associateUsers[0]);

    const rows = await sql`
        SELECT u.user_id, u.member_id, u.full_name, u.email, u.mobile_no, u.account_status,
               u.invitation_code, u.registered_at, sp.full_name AS sponsor_name,
               COALESCE(r.rank_name, 'Associate') AS rank_name,
               COALESCE(t.total_gaj_sold, 0) AS total_gaj_sold,
               COALESCE(t.total_commission_earned, 0) AS total_commission_earned,
               COUNT(*) OVER() AS total_count
        FROM users u
        LEFT JOIN users sp ON sp.user_id = u.sponsor_user_id
        LEFT JOIN associate_sales_tracker t ON t.associate_user_id = u.user_id
        LEFT JOIN associate_ranks r ON r.rank_id = t.current_rank_id
        WHERE TRIM(u.user_type) ILIKE 'Associate'
          AND (${searchTerm} = '%%' OR u.full_name ILIKE ${searchTerm} OR u.member_id ILIKE ${searchTerm} OR u.mobile_no ILIKE ${searchTerm})
          AND (${String(status)} = '' OR u.account_status = ${String(status)})
          AND (${String(rank)} = '' OR r.rank_name = ${String(rank)})
          AND (${String(sponsor)} = '' OR sp.member_id = ${String(sponsor)} OR sp.full_name ILIKE ${`%${String(sponsor)}%`})
        ORDER BY u.registered_at DESC
        LIMIT ${pageSize} OFFSET ${(pageNumber - 1) * pageSize}`;

    console.log('Rows:', rows);
    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}
run();
