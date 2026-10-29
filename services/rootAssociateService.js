import sql from "../db.js";
import bcrypt from "bcryptjs";

export async function seedRootAssociateSuraj() {
  console.log("=== SEEDING / ENSURING ROOT ASSOCIATE #1: SURAJ KUMAR VERMA ===");

  const userId = 1;
  const memberId = "MMR00001";
  const fullName = "Suraj Kumar Verma";
  const email = "mmrconstructions@hotmail.com";
  const mobile = "7071951011";
  const inviteCode = "MMR0001";
  const panNo = "ABCDE1234F";
  const aadharNo = "123456789012";
  const fatherName = "Ram Kumar Verma";
  const dob = "1990-01-01";
  const gender = "Male";
  const defaultPassword = "password123";
  const passwordHash = await bcrypt.hash(defaultPassword, 10);

  // 1. Ensure associate_ranks has at least rank_id = 1
  try {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS associate_ranks (
        rank_id SERIAL PRIMARY KEY,
        rank_name VARCHAR(100) NOT NULL,
        required_sales NUMERIC(14,2) DEFAULT 0,
        commission_percent NUMERIC(5,2) DEFAULT 0
      )
    `);
    await sql`
      INSERT INTO associate_ranks (rank_id, rank_name, required_sales, commission_percent)
      VALUES (1, 'Associate', 0, 5)
      ON CONFLICT (rank_id) DO NOTHING
    `.catch(() => {});
  } catch (e) {
    console.warn("associate_ranks notice:", e.message);
  }

  // 2. Ensure User #1 exists and is root associate
  const [existingUser] = await sql`
    SELECT user_id, member_id, full_name, user_type FROM users 
    WHERE user_id = ${userId} OR member_id = ${memberId} OR member_id = 'MMR-ASC-0001'
    LIMIT 1
  `.catch(() => []);

  if (!existingUser) {
    console.log(`Inserting User #1 (${fullName})...`);
    await sql`
      INSERT INTO users (
        user_id, member_id, user_type, full_name, mobile_no, email,
        password_hash, is_otp_verified, is_verified, email_verified,
        account_status, is_active, invitation_code, sponsor_user_id,
        enrollment_status, father_name, date_of_birth, gender,
        pan_number, aadhar_number, registered_at, updated_at
      ) VALUES (
        ${userId}, ${memberId}, 'Associate', ${fullName}, ${mobile}, ${email},
        ${passwordHash}, true, true, true,
        'Active', true, ${inviteCode}, NULL,
        'Completed', ${fatherName}, ${dob}, ${gender},
        ${panNo}, ${aadharNo}, NOW(), NOW()
      )
      ON CONFLICT (user_id) DO UPDATE SET
        member_id = EXCLUDED.member_id,
        user_type = 'Associate',
        full_name = EXCLUDED.full_name,
        mobile_no = EXCLUDED.mobile_no,
        email = EXCLUDED.email,
        account_status = 'Active',
        is_active = true,
        is_verified = true,
        enrollment_status = 'Completed',
        father_name = EXCLUDED.father_name,
        date_of_birth = EXCLUDED.date_of_birth,
        gender = EXCLUDED.gender,
        pan_number = EXCLUDED.pan_number,
        aadhar_number = EXCLUDED.aadhar_number,
        sponsor_user_id = NULL
    `;
  } else {
    console.log(`Updating User #1 (${fullName})...`);
    await sql`
      UPDATE users SET
        member_id = ${memberId},
        user_type = 'Associate',
        full_name = ${fullName},
        mobile_no = ${mobile},
        email = ${email},
        account_status = 'Active',
        is_active = true,
        is_verified = true,
        enrollment_status = 'Completed',
        invitation_code = ${inviteCode},
        sponsor_user_id = NULL,
        father_name = ${fatherName},
        date_of_birth = ${dob},
        gender = ${gender},
        pan_number = ${panNo},
        aadhar_number = ${aadharNo},
        updated_at = NOW()
      WHERE user_id = ${existingUser.user_id}
    `;
  }

  // 3. Reset sequence for users table so new users get user_id > 1
  try {
    await sql.unsafe(`
      SELECT setval(pg_get_serial_sequence('users', 'user_id'), GREATEST((SELECT MAX(user_id) FROM users), 1), true)
    `);
  } catch (seqErr) {
    console.warn("Sequence reset notice:", seqErr.message);
  }

  // 4. Ensure associate_enrollment table has all columns
  try {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS associate_enrollment (
        id VARCHAR(50) PRIMARY KEY,
        user_id INTEGER,
        member_id VARCHAR(50),
        full_name VARCHAR(150),
        father_name VARCHAR(150),
        mother_name VARCHAR(150),
        spouse_name VARCHAR(150),
        dob DATE,
        gender VARCHAR(20),
        pan_no VARCHAR(20),
        aadhar_no VARCHAR(20),
        contact_no_1 VARCHAR(20),
        contact_no_2 VARCHAR(20),
        email VARCHAR(150),
        nationality VARCHAR(50) DEFAULT 'Indian',
        residential_status VARCHAR(50) DEFAULT 'Resident Individual',
        occupation VARCHAR(100) DEFAULT 'Business',
        annual_income VARCHAR(100) DEFAULT '₹10,00,000+',
        education VARCHAR(100) DEFAULT 'Graduate',
        category VARCHAR(50) DEFAULT 'General',
        religion VARCHAR(50) DEFAULT 'Hindu',
        status VARCHAR(20) DEFAULT 'approved',
        is_final_submitted BOOLEAN DEFAULT TRUE,
        terms_accepted BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  } catch (tErr) {
    console.warn("associate_enrollment create notice:", tErr.message);
  }

  // 5. Insert / Update associate_enrollment record for Suraj Kumar Verma
  try {
    const [existingEnr] = await sql`
      SELECT id FROM associate_enrollment 
      WHERE user_id = ${userId} OR id = ${memberId} OR id = 'MMR-ASC-0001' OR contact_no_1 = ${mobile} OR LOWER(email) = LOWER(${email})
      LIMIT 1
    `;

    const enrId = existingEnr?.id || memberId;

    if (!existingEnr) {
      await sql`
        INSERT INTO associate_enrollment (
          id, user_id, member_id, full_name, father_name, dob, gender,
          pan_no, aadhar_no, contact_no_1, email,
          nationality, residential_status, category, religion, occupation, annual_income, education,
          status, is_final_submitted, terms_accepted, created_at, updated_at
        ) VALUES (
          ${enrId}, ${userId}, ${memberId}, ${fullName}, ${fatherName}, ${dob}, ${gender},
          ${panNo}, ${aadharNo}, ${mobile}, ${email},
          'Indian', 'Resident Individual', 'General', 'Hindu', 'Business', '₹10,00,000+', 'Graduate',
          'approved', TRUE, TRUE, NOW(), NOW()
        )
      `;
    } else {
      await sql`
        UPDATE associate_enrollment SET
          user_id = ${userId},
          member_id = ${memberId},
          full_name = ${fullName},
          father_name = ${fatherName},
          dob = ${dob},
          gender = ${gender},
          pan_no = ${panNo},
          aadhar_no = ${aadharNo},
          contact_no_1 = ${mobile},
          email = ${email},
          nationality = 'Indian',
          residential_status = 'Resident Individual',
          category = 'General',
          religion = 'Hindu',
          occupation = 'Business',
          annual_income = '₹10,00,000+',
          education = 'Graduate',
          status = 'approved',
          is_final_submitted = TRUE,
          updated_at = NOW()
        WHERE id = ${enrId}
      `;
    }

    // 6. Address in associate_address
    try {
      await sql.unsafe(`
        CREATE TABLE IF NOT EXISTS associate_address (
          id SERIAL PRIMARY KEY,
          associate_id VARCHAR(50),
          address_type VARCHAR(20) DEFAULT 'permanent',
          local_address TEXT,
          city VARCHAR(100),
          state VARCHAR(100),
          country VARCHAR(100) DEFAULT 'India',
          pin_code VARCHAR(20)
        )
      `);
      await sql`DELETE FROM associate_address WHERE associate_id = ${enrId}`;
      await sql`
        INSERT INTO associate_address (associate_id, address_type, local_address, city, state, country, pin_code)
        VALUES 
          (${enrId}, 'permanent', 'Civil Lines, Kanpur', 'Kanpur', 'Uttar Pradesh', 'India', '208001'),
          (${enrId}, 'local', 'Civil Lines, Kanpur', 'Kanpur', 'Uttar Pradesh', 'India', '208001')
      `;
    } catch (addrErr) {
      console.warn("associate_address notice:", addrErr.message);
    }

    // 7. Bank Details in associate_bank_details
    try {
      await sql.unsafe(`
        CREATE TABLE IF NOT EXISTS associate_bank_details (
          id SERIAL PRIMARY KEY,
          associate_id VARCHAR(50),
          bank_name VARCHAR(150),
          branch_name VARCHAR(150),
          account_holder_name VARCHAR(150),
          account_no VARCHAR(50),
          ifsc_code VARCHAR(20)
        )
      `);
      await sql`DELETE FROM associate_bank_details WHERE associate_id = ${enrId}`;
      await sql`
        INSERT INTO associate_bank_details (associate_id, bank_name, branch_name, account_holder_name, account_no, ifsc_code)
        VALUES (${enrId}, 'State Bank of India', 'Kanpur Main Branch', ${fullName}, '3071951011001', 'SBIN0000123')
      `;
    } catch (bkErr) {
      console.warn("associate_bank_details notice:", bkErr.message);
    }

    // 8. Nominee in associate_nominee
    try {
      await sql.unsafe(`
        CREATE TABLE IF NOT EXISTS associate_nominee (
          id SERIAL PRIMARY KEY,
          associate_id VARCHAR(50),
          nominee_name VARCHAR(150),
          relationship VARCHAR(80),
          dob DATE,
          gender VARCHAR(20)
        )
      `);
      await sql`DELETE FROM associate_nominee WHERE associate_id = ${enrId}`;
      await sql`
        INSERT INTO associate_nominee (associate_id, nominee_name, relationship, dob, gender)
        VALUES (${enrId}, 'Family Nominee', 'Nominee', '1995-01-01', 'Female')
      `;
    } catch (nomErr) {
      console.warn("associate_nominee notice:", nomErr.message);
    }
  } catch (aeErr) {
    console.warn("associate_enrollment sync notice:", aeErr.message);
  }

  // 9. Ensure user_addresses
  try {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS user_addresses (
        address_id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        address_type VARCHAR(20) DEFAULT 'Permanent',
        address_line1 TEXT,
        city VARCHAR(100),
        state VARCHAR(100),
        pin_code VARCHAR(20),
        country VARCHAR(100) DEFAULT 'India'
      )
    `);
    const [existingUserAddr] = await sql`SELECT address_id FROM user_addresses WHERE user_id = ${userId} LIMIT 1`;
    if (!existingUserAddr) {
      await sql`
        INSERT INTO user_addresses (user_id, address_type, address_line1, city, state, pin_code, country)
        VALUES (${userId}, 'Permanent', 'Civil Lines, Kanpur', 'Kanpur', 'Uttar Pradesh', '208001', 'India')
      `;
    }
  } catch (uAddrErr) {
    console.warn("user_addresses notice:", uAddrErr.message);
  }

  // 10. Ensure user_bank_details
  try {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS user_bank_details (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        bank_name VARCHAR(150),
        account_holder_name VARCHAR(150),
        account_number VARCHAR(50),
        ifsc_code VARCHAR(20),
        branch_name VARCHAR(150)
      )
    `);
    const [existingUserBank] = await sql`SELECT id FROM user_bank_details WHERE user_id = ${userId} LIMIT 1`;
    if (!existingUserBank) {
      await sql`
        INSERT INTO user_bank_details (user_id, bank_name, account_holder_name, account_number, ifsc_code, branch_name)
        VALUES (${userId}, 'State Bank of India', ${fullName}, '3071951011001', 'SBIN0000123', 'Kanpur Main Branch')
      `;
    } else {
      await sql`
        UPDATE user_bank_details SET
          bank_name = 'State Bank of India',
          account_holder_name = ${fullName},
          account_number = '3071951011001',
          ifsc_code = 'SBIN0000123',
          branch_name = 'Kanpur Main Branch'
        WHERE user_id = ${userId}
      `;
    }
  } catch (uBkErr) {
    console.warn("user_bank_details notice:", uBkErr.message);
  }

  // 11. Ensure user_nominees
  try {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS user_nominees (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        nominee_name VARCHAR(150),
        relationship VARCHAR(80),
        dob DATE,
        gender VARCHAR(20)
      )
    `);
    const [existingUserNom] = await sql`SELECT id FROM user_nominees WHERE user_id = ${userId} LIMIT 1`;
    if (!existingUserNom) {
      await sql`
        INSERT INTO user_nominees (user_id, nominee_name, relationship, dob, gender)
        VALUES (${userId}, 'Family Nominee', 'Nominee', '1995-01-01', 'Female')
      `;
    }
  } catch (uNomErr) {
    console.warn("user_nominees notice:", uNomErr.message);
  }

  // 12. Ensure associate_sales_tracker
  try {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS associate_sales_tracker (
        tracker_id SERIAL PRIMARY KEY,
        associate_user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        total_gaj_sold NUMERIC(14,2) NOT NULL DEFAULT 0,
        total_commission_earned NUMERIC(14,2) NOT NULL DEFAULT 0,
        current_rank_id INTEGER,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    const [existingTracker] = await sql`SELECT tracker_id FROM associate_sales_tracker WHERE associate_user_id = ${userId} LIMIT 1`;
    if (!existingTracker) {
      await sql`
        INSERT INTO associate_sales_tracker (associate_user_id, total_gaj_sold, total_commission_earned, current_rank_id)
        VALUES (${userId}, 0, 0, 1)
      `;
    }
  } catch (trErr) {
    console.warn("associate_sales_tracker notice:", trErr.message);
  }

  // 13. Ensure associate_referral_links
  try {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS associate_referral_links (
        link_id SERIAL PRIMARY KEY,
        associate_user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        invite_code VARCHAR(50) NOT NULL UNIQUE,
        clicks_count INTEGER DEFAULT 0,
        signups_count INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    const [existingLink] = await sql`SELECT link_id FROM associate_referral_links WHERE associate_user_id = ${userId} LIMIT 1`;
    if (!existingLink) {
      await sql`
        INSERT INTO associate_referral_links (associate_user_id, invite_code, clicks_count, signups_count)
        VALUES (${userId}, ${inviteCode}, 0, 0)
        ON CONFLICT (invite_code) DO NOTHING
      `;
    }
  } catch (rfErr) {
    console.warn("associate_referral_links notice:", rfErr.message);
  }

  // 14. Ensure user_wallets
  try {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS user_wallets (
        wallet_id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL UNIQUE REFERENCES users(user_id) ON DELETE CASCADE,
        balance NUMERIC(14,2) NOT NULL DEFAULT 0,
        locked_balance NUMERIC(14,2) NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await sql`
      INSERT INTO user_wallets (user_id, balance, locked_balance, created_at, updated_at)
      VALUES (${userId}, 0, 0, NOW(), NOW())
      ON CONFLICT (user_id) DO NOTHING
    `.catch(() => {});
  } catch (wErr) {
    console.warn("user_wallets notice:", wErr.message);
  }

  console.log(`=== ROOT ASSOCIATE #1 (${fullName} - ${memberId}) ENSURED SUCCESSFULLY ===`);
  return {
    success: true,
    user_id: userId,
    member_id: memberId,
    full_name: fullName,
    email: email,
    mobile: mobile,
    account_status: "Active",
    enrollment_status: "Completed",
    address: "Civil Lines, Kanpur, Uttar Pradesh, 208001",
    bank: "State Bank of India (A/C: 3071951011001, IFSC: SBIN0000123)"
  };
}
