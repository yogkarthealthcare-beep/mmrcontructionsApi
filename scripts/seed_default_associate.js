import bcrypt from "bcryptjs";
import sql from "../db.js";

async function seedDefaultAssociate() {
  try {
    console.log("=== SEEDING DEFAULT 1ST ASSOCIATE: Suraj Kumar Verma ===");
    
    const email = "mmrconstructions@hotmail.com";
    const mobile_no = "7071951011";
    const full_name = "Suraj Kumar Verma";
    const rawPassword = "Mmr@2026";
    const passwordHash = await bcrypt.hash(rawPassword, 12);
    const member_id = "MMR-ASC-0001";
    const invitation_code = "MMR0001";

    // 1. Upsert in users table
    let [user] = await sql`
      SELECT user_id FROM users WHERE LOWER(email) = ${email.toLowerCase()} OR mobile_no = ${mobile_no} OR user_id = 1 OR member_id = ${member_id}
      LIMIT 1
    `;

    if (user) {
      console.log(`Found existing user (ID #${user.user_id}), updating details...`);
      const [updated] = await sql`
        UPDATE users SET
          full_name = ${full_name},
          email = ${email.toLowerCase()},
          mobile_no = ${mobile_no},
          password_hash = ${passwordHash},
          user_type = 'Associate',
          account_status = 'Active',
          member_id = ${member_id},
          invitation_code = ${invitation_code},
          is_active = TRUE,
          is_verified = TRUE,
          email_verified = TRUE,
          is_otp_verified = TRUE,
          updated_at = NOW()
        WHERE user_id = ${user.user_id}
        RETURNING user_id, member_id, full_name, email, mobile_no, user_type, account_status, invitation_code
      `;
      user = updated;
    } else {
      console.log("Creating new 1st Associate account...");
      const [inserted] = await sql`
        INSERT INTO users (
          user_id, member_id, full_name, email, mobile_no,
          user_type, account_status, invitation_code,
          password_hash, is_active, is_verified, email_verified, is_otp_verified, registered_at
        ) VALUES (
          1, ${member_id}, ${full_name}, ${email.toLowerCase()}, ${mobile_no},
          'Associate', 'Active', ${invitation_code},
          ${passwordHash}, TRUE, TRUE, TRUE, TRUE, NOW()
        )
        ON CONFLICT (user_id) DO UPDATE SET
          full_name = EXCLUDED.full_name,
          email = EXCLUDED.email,
          mobile_no = EXCLUDED.mobile_no,
          password_hash = EXCLUDED.password_hash,
          user_type = 'Associate',
          account_status = 'Active',
          member_id = EXCLUDED.member_id,
          invitation_code = EXCLUDED.invitation_code,
          is_active = TRUE
        RETURNING user_id, member_id, full_name, email, mobile_no, user_type, account_status, invitation_code
      `;
      user = inserted;
    }

    console.log("Associate account ready:", user);

    // 2. Ensure associate_referral_links entry exists
    const referralUrl = `https://mmrconstructions.in/signup?ref=${invitation_code}`;
    const [refLink] = await sql`
      INSERT INTO associate_referral_links (associate_user_id, invite_code, referral_url, is_active)
      VALUES (${user.user_id}, ${invitation_code}, ${referralUrl}, TRUE)
      ON CONFLICT (invite_code) DO UPDATE SET
        associate_user_id = EXCLUDED.associate_user_id,
        referral_url = EXCLUDED.referral_url,
        is_active = TRUE,
        updated_at = NOW()
      RETURNING *
    `;

    console.log("Associate referral link ready:", refLink);

    // 3. Try to ensure associate_profiles entry exists if table exists
    try {
      await sql`
        INSERT INTO associate_profiles (associate_user_id, rank, gaj_sales_count, total_earnings)
        VALUES (${user.user_id}, 'Associate', 0, 0)
        ON CONFLICT (associate_user_id) DO NOTHING
      `;
    } catch (profileErr) {
      console.log("associate_profiles table not active yet, skipping profile insertion.");
    }

    console.log("SUCCESS: Default Associate (Suraj Kumar Verma) configured successfully!");
    process.exit(0);
  } catch (e) {
    console.error("ERROR seeding default associate:", e);
    process.exit(1);
  }
}

seedDefaultAssociate();
