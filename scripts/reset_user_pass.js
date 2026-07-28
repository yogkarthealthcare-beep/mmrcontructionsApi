import sql from "../db.js";
import bcrypt from "bcryptjs";

async function resetPass() {
  const targetEmail = 'vikkirock8008@gmail.com';
  const newPass = 'TestPass123!';

  const salt = await bcrypt.genSalt(10);
  const hash = await bcrypt.hash(newPass, salt);

  await sql`UPDATE investor_users SET password_hash = ${hash}, is_verified = true, status = 'active' WHERE LOWER(email) = ${targetEmail.toLowerCase()}`;
  console.log(`Password for ${targetEmail} updated successfully to: ${newPass}`);
  process.exit(0);
}

resetPass();
