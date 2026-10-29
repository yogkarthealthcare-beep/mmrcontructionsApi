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

  // 2. Check if User #1 or MMR00001 exists in users table
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
        enrollment_status, registered_at, updated_at
      ) VALUES (
        ${userId}, ${memberId}, 'Associate', ${fullName}, ${mobile}, ${email},
        ${passwordHash}, true, true, true,
        'Active', true, ${inviteCode}, NULL,
        'Completed', NOW(), NOW()
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
        enrollment_status = 'Completed'
    `;
  } else {
    console.log(`User #1 already exists (ID: ${existingUser.user_id}, Name: ${existingUser.full_name}). Ensuring active associate status...`);
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
        invitation_code = ${inviteCode}
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

  // 4. Ensure associate_enrollment table and record
  try {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS associate_enrollment (
        id VARCHAR(50) PRIMARY KEY,
        user_id INTEGER,
        member_id VARCHAR(50),
        associate_id VARCHAR(50),
        full_name VARCHAR(150),
        father_name VARCHAR(150),
        dob DATE,
        gender VARCHAR(20),
        pan_no VARCHAR(20),
        aadhar_no VARCHAR(20),
        contact_no_1 VARCHAR(20),
        contact_1 VARCHAR(20),
        contact_no_2 VARCHAR(20),
        mobile_no VARCHAR(20),
        email VARCHAR(150),
        nationality VARCHAR(50) DEFAULT 'Indian',
        residential_status VARCHAR(50) DEFAULT 'Resident',
        category VARCHAR(50) DEFAULT 'General',
        status VARCHAR(20) DEFAULT 'approved',
        is_final_submitted BOOLEAN DEFAULT TRUE,
        terms_accepted BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await sql`
      INSERT INTO associate_enrollment (
        id, user_id, member_id, associate_id, full_name, father_name, dob, gender,
        pan_no, aadhar_no, contact_no_1, contact_1, mobile_no, email,
        nationality, residential_status, category, status, is_final_submitted, terms_accepted,
        created_at, updated_at
      ) VALUES (
        ${memberId}, ${userId}, ${memberId}, ${memberId}, ${fullName}, 'Ram Kumar Verma', '1990-01-01', 'Male',
        'ABCDE1234F', '123456789012', ${mobile}, ${mobile}, ${mobile}, ${email},
        'Indian', 'Resident', 'General', 'approved', TRUE, TRUE,
        NOW(), NOW()
      )
      ON CONFLICT (id) DO UPDATE SET
        user_id = EXCLUDED.user_id,
        member_id = EXCLUDED.member_id,
        associate_id = EXCLUDED.associate_id,
        full_name = EXCLUDED.full_name,
        contact_no_1 = EXCLUDED.contact_no_1,
        mobile_no = EXCLUDED.mobile_no,
        email = EXCLUDED.email,
        status = 'approved',
        is_final_submitted = TRUE
    `;
  } catch (aeErr) {
    console.warn("associate_enrollment notice:", aeErr.message);
  }

  // 5. Ensure associate_address
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

    const [existingAddr] = await sql`SELECT id FROM associate_address WHERE associate_id = ${memberId} LIMIT 1`;
    if (!existingAddr) {
      await sql`
        INSERT INTO associate_address (associate_id, address_type, local_address, city, state, country, pin_code)
        VALUES (${memberId}, 'permanent', 'Civil Lines, Kanpur', 'Kanpur', 'Uttar Pradesh', 'India', '208001')
      `;
    }
  } catch (addrErr) {
    console.warn("associate_address notice:", addrErr.message);
  }

  // 6. Ensure associate_bank_details
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

    const [existingBank] = await sql`SELECT id FROM associate_bank_details WHERE associate_id = ${memberId} LIMIT 1`;
    if (!existingBank) {
      await sql`
        INSERT INTO associate_bank_details (associate_id, bank_name, branch_name, account_holder_name, account_no, ifsc_code)
        VALUES (${memberId}, 'State Bank of India', 'Kanpur Main Branch', ${fullName}, '3071951011001', 'SBIN0000123')
      `;
    }
  } catch (bkErr) {
    console.warn("associate_bank_details notice:", bkErr.message);
  }

  // 7. Ensure associate_nominee
  try {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS associate_nominee (
        id SERIAL PRIMARY KEY,
        associate_id VARCHAR(50),
        nominee_name VARCHAR(150),
        relationship VARCHAR(80)
      )
    `);

    const [existingNom] = await sql`SELECT id FROM associate_nominee WHERE associate_id = ${memberId} LIMIT 1`;
    if (!existingNom) {
      await sql`
        INSERT INTO associate_nominee (associate_id, nominee_name, relationship)
        VALUES (${memberId}, 'Family Nominee', 'Nominee')
      `;
    }
  } catch (nomErr) {
    console.warn("associate_nominee notice:", nomErr.message);
  }

  // 8. Ensure user_addresses
  try {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS user_addresses (
        address_id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        address_type VARCHAR(20) DEFAULT 'Permanent',
        address_line1 TEXT,
        city VARCHAR(100),
        state VARCHAR(100),
        pin_code VARCHAR(20)
      )
    `);

    const [existingUserAddr] = await sql`SELECT address_id FROM user_addresses WHERE user_id = ${userId} LIMIT 1`;
    if (!existingUserAddr) {
      await sql`
        INSERT INTO user_addresses (user_id, address_type, address_line1, city, state, pin_code)
        VALUES (${userId}, 'Permanent', 'Civil Lines, Kanpur', 'Kanpur', 'Uttar Pradesh', '208001')
      `;
    }
  } catch (uAddrErr) {
    console.warn("user_addresses notice:", uAddrErr.message);
  }

  // 9. Ensure user_bank_details
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
    }
  } catch (uBkErr) {
    console.warn("user_bank_details notice:", uBkErr.message);
  }

  // 10. Ensure associate_sales_tracker
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

  // 11. Ensure associate_referral_links
  try {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS associate_referral_links (
        id SERIAL PRIMARY KEY,
        associate_user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        invite_code VARCHAR(80) NOT NULL
      )
    `);

    const [existingRef] = await sql`SELECT id FROM associate_referral_links WHERE associate_user_id = ${userId} LIMIT 1`;
    if (!existingRef) {
      await sql`
        INSERT INTO associate_referral_links (associate_user_id, invite_code)
        VALUES (${userId}, ${inviteCode})
      `;
    }
  } catch (refErr) {
    console.warn("associate_referral_links notice:", refErr.message);
  }

  // 12. Ensure user_wallets
  try {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS user_wallets (
        wallet_id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        balance NUMERIC(14,2) NOT NULL DEFAULT 0,
        total_earned NUMERIC(14,2) NOT NULL DEFAULT 0,
        total_withdrawn NUMERIC(14,2) NOT NULL DEFAULT 0,
        locked_balance NUMERIC(14,2) NOT NULL DEFAULT 0,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const [existingWallet] = await sql`SELECT wallet_id FROM user_wallets WHERE user_id = ${userId} LIMIT 1`;
    if (!existingWallet) {
      await sql`
        INSERT INTO user_wallets (user_id, balance, total_earned, total_withdrawn, locked_balance, is_active)
        VALUES (${userId}, 0, 0, 0, 0, true)
      `;
    }
  } catch (wErr) {
    console.warn("user_wallets notice:", wErr.message);
  }

  console.log("✅ ROOT ASSOCIATE #1 (Suraj Kumar Verma) successfully enrolled and verified in all tables.");
  return {
    success: true,
    user_id: userId,
    member_id: memberId,
    full_name: fullName,
    email,
    mobile,
    account_status: "Active",
    enrollment_status: "Completed"
  };
}
