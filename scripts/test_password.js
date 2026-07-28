import sql from "../db.js";
import bcrypt from "bcryptjs";

async function testPassword() {
  const [user] = await sql`SELECT password_hash FROM investor_users WHERE LOWER(email) = 'vikkirock8008@gmail.com'`;
  if (!user) {
    console.log("User not found!");
    process.exit(0);
  }

  console.log("Password Hash in DB:", user.password_hash);
  const commonPasswords = ["TestPassword123!", "12345678", "password", "Admin@123", "viki1234", "vikki1234", "vikkirock8008"];

  for (const pwd of commonPasswords) {
    const isMatch = await bcrypt.compare(pwd, user.password_hash);
    if (isMatch) {
      console.log(`\nMATCH FOUND! Password is: "${pwd}"`);
    }
  }

  process.exit(0);
}

testPassword();
