const sql = require('./db.js').default; // Assuming ESM but required here... wait, use import since it's type module
(async () => {
  try {
    const { default: sql } = await import('./db.js');
    const users = await sql`SELECT user_id, full_name, user_type FROM users LIMIT 10`;
    console.log("Users:", users);

    const admins = await sql`SELECT * FROM information_schema.tables WHERE table_name LIKE '%admin%'`;
    console.log("Admin tables:", admins.map(a => a.table_name));

    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
