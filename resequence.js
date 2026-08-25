import 'dotenv/config';
import sql from './db.js';

async function fixSequence() {
  try {
    const users = await sql`SELECT user_id, member_id, invitation_code FROM users ORDER BY registered_at ASC`;
    let seq = 1;
    for (const u of users) {
      const newCode = "MMR" + String(seq).padStart(5, "0");
      if (u.member_id !== newCode || u.invitation_code !== newCode) {
        console.log(`Updating user ${u.user_id} from ${u.member_id} to ${newCode}`);
        
        // Ensure no conflict first by temporarily renaming if needed, but since we go in order, it might conflict with someone else who already has it.
        // Actually, just update to temporary first
        await sql`UPDATE users SET member_id = ${'TEMP' + u.user_id}, invitation_code = ${'TEMP' + u.user_id} WHERE user_id = ${u.user_id}`;
      }
      seq++;
    }
    
    seq = 1;
    for (const u of users) {
      const newCode = "MMR" + String(seq).padStart(5, "0");
      await sql`UPDATE users SET member_id = ${newCode}, invitation_code = ${newCode} WHERE user_id = ${u.user_id}`;
      seq++;
    }
    
    console.log("Successfully re-sequenced users.");
  } catch (e) {
    console.error(e);
  } finally {
    process.exit(0);
  }
}
fixSequence();
