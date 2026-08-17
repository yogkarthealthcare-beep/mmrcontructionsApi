import '../config/loadEnv.js';
import sql from '../db.js';

async function clearOtpLog() {
  console.log('Deleting all OTP entries from otp_log table in database...');
  try {
    // 1. Truncate table and restart sequence
    try {
      await sql`TRUNCATE TABLE otp_log RESTART IDENTITY CASCADE`;
      console.log('Successfully truncated otp_log table and restarted sequence.');
    } catch (e1) {
      console.warn('Truncate failed, executing DELETE FROM otp_log:', e1.message);
      await sql`DELETE FROM otp_log`;
      console.log('Successfully deleted all rows from otp_log.');

      // Reset sequence manually if truncate wasn't permitted
      try {
        await sql`SELECT setval(pg_get_serial_sequence('otp_log', 'otp_id'), 1, false)`;
      } catch (seqErr1) {}
      try {
        await sql`SELECT setval(pg_get_serial_sequence('otp_log', 'id'), 1, false)`;
      } catch (seqErr2) {}
    }

    // 2. Verify table is empty
    const [countRow] = await sql`SELECT COUNT(*)::integer AS total FROM otp_log`;
    console.log(`Current row count in otp_log: ${countRow.total}`);

    console.log('OTP table cleared successfully!');
  } catch (err) {
    console.error('Error clearing otp_log table:', err);
  } finally {
    process.exit(0);
  }
}

clearOtpLog();
