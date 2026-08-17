import '../config/loadEnv.js';
import sql from '../db.js';

async function fixSequence() {
  console.log('Fixing otp_log primary key sequence in PostgreSQL database...');
  try {
    // 1. Check max id / otp_id in otp_log table
    const [maxRow] = await sql`
      SELECT 
        COALESCE(MAX(otp_id), 0) AS max_otp_id,
        COALESCE(MAX(id), 0) AS max_id
      FROM otp_log`;
    
    console.log('Current max_otp_id in otp_log:', maxRow.max_otp_id, 'max_id:', maxRow.max_id);

    // 2. Find sequences
    const seqs = await sql`
      SELECT sequence_name 
      FROM information_schema.sequences 
      WHERE sequence_name LIKE '%otp_log%' OR sequence_name LIKE '%otp%';
    `;
    console.log('Found sequences for otp:', seqs);

    const targetVal = Math.max(Number(maxRow.max_otp_id || 0), Number(maxRow.max_id || 0), 1000) + 100;

    for (const s of seqs) {
      const seqName = s.sequence_name;
      try {
        await sql.unsafe(`SELECT setval('${seqName}', ${targetVal}, false)`);
        console.log(`Successfully reset sequence ${seqName} to ${targetVal}`);
      } catch (err) {
        console.warn(`Failed to reset sequence ${seqName}:`, err.message);
      }
    }

    // 3. Force reset on otp_log_otp_id_seq or otp_log_id_seq if sequence name was pg standard
    try {
      await sql`SELECT setval(pg_get_serial_sequence('otp_log', 'otp_id'), ${targetVal}, false)`;
      console.log(`Successfully reset pg_get_serial_sequence for otp_id to ${targetVal}`);
    } catch (e1) {
      console.warn('Could not reset otp_id sequence via pg_get_serial_sequence:', e1.message);
    }

    try {
      await sql`SELECT setval(pg_get_serial_sequence('otp_log', 'id'), ${targetVal}, false)`;
      console.log(`Successfully reset id sequence via pg_get_serial_sequence:`, e2.message);
    } catch (e2) {
      console.warn('Could not reset id sequence via pg_get_serial_sequence:', e2.message);
    }

    // 4. Test insert into otp_log to ensure sequence works perfectly!
    console.log('Testing test insert into otp_log...');
    const [testRow] = await sql`
      INSERT INTO otp_log (user_type, reference_id, mobile, otp_code, purpose, expires_at)
      VALUES ('Test', 0, 'test_seq_check', '123456', 'SequenceTest', NOW() + INTERVAL '1 minute')
      RETURNING *;
    `;
    console.log('Test insert succeeded! Inserted otp_id:', testRow.otp_id || testRow.id);

    // Clean up test row
    await sql`DELETE FROM otp_log WHERE mobile = 'test_seq_check'`;
    console.log('Cleaned up test row.');

    console.log('Sequence fix completed successfully!');
  } catch (err) {
    console.error('Error fixing sequence:', err);
  } finally {
    process.exit(0);
  }
}

fixSequence();
