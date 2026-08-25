import './config/loadEnv.js';
process.env.DB_SSL = 'require';
import sql from './db.js';

(async () => {
  try {
    const rows = await sql`SELECT user_id, full_name, email, user_type, account_status FROM users WHERE email IN ('test.vikasdotme@gmail.com', 'vikasdotme@gmail.com', 'vikasrajput0516@gmail.com')`;
    console.log("DB Rows (users):", rows);
    
    const pendingRows = await sql`SELECT email, user_type FROM pending_registrations WHERE email IN ('test.vikasdotme@gmail.com', 'vikasdotme@gmail.com', 'vikasrajput0516@gmail.com')`;
    console.log("DB Rows (pending_registrations):", pendingRows);
    
    process.exit(0);
  } catch (err) {
    console.error("Error:", err);
    process.exit(1);
  }
})();
