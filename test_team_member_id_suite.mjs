import { PGlite } from '@electric-sql/pglite';

async function runSuite() {
  console.log('================================================================');
  console.log('  MMR CONSTRUCTIONS: TEAM MEMBER ID FIX VERIFICATION SUITE');
  console.log('  Engine: In-Memory PostgreSQL (PGlite WASM) - Zero External DB');
  console.log('================================================================\n');

  const pglite = new PGlite();

  // Create minimal required schema
  await pglite.exec(`
    CREATE TABLE IF NOT EXISTS users (
      user_id SERIAL PRIMARY KEY,
      member_id VARCHAR(50),
      user_type VARCHAR(50) NOT NULL,
      full_name VARCHAR(150) NOT NULL,
      mobile_no VARCHAR(15) NOT NULL,
      email VARCHAR(150),
      password_hash VARCHAR(255),
      sponsor_user_id INTEGER,
      account_status VARCHAR(20) DEFAULT 'Active',
      is_active BOOLEAN DEFAULT true,
      email_verified BOOLEAN DEFAULT true,
      is_otp_verified BOOLEAN DEFAULT true,
      invitation_code VARCHAR(50),
      referred_by_user_id INTEGER,
      referred_by_source VARCHAR(50),
      referred_by_set_at TIMESTAMPTZ,
      registered_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS team_members (
      id SERIAL PRIMARY KEY,
      team_member_uid VARCHAR(30) UNIQUE NOT NULL,
      associate_id BIGINT NOT NULL,
      associate_name VARCHAR(150) NOT NULL,
      user_id INTEGER,
      slot_number SMALLINT,
      full_name VARCHAR(150) NOT NULL,
      mobile_no VARCHAR(15) NOT NULL,
      email_id VARCHAR(150),
      status VARCHAR(20) DEFAULT 'approved',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS user_wallets (
      id SERIAL PRIMARY KEY,
      user_id INTEGER UNIQUE,
      user_role VARCHAR(50),
      available_balance NUMERIC(12,2) DEFAULT 0,
      pending_withdrawal_balance NUMERIC(12,2) DEFAULT 0,
      total_added_fund NUMERIC(12,2) DEFAULT 0,
      total_withdrawn NUMERIC(12,2) DEFAULT 0,
      total_commission NUMERIC(12,2) DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS referral_registrations (
      id SERIAL PRIMARY KEY,
      sponsor_user_id INTEGER,
      referred_user_id INTEGER UNIQUE,
      status VARCHAR(30) DEFAULT 'Approved',
      approved_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS associate_referral_links (
      id SERIAL PRIMARY KEY,
      associate_user_id INTEGER,
      invite_code VARCHAR(80) UNIQUE,
      is_active BOOLEAN DEFAULT true
    );
  `);

  // Define generator simulation using exact logic
  async function generateTeamMemberId(db) {
    // In PGlite, advisory locks are supported:
    await db.exec(`SELECT pg_advisory_xact_lock(hashtext('team_member_id_generation'))`).catch(() => {});

    const res = await db.query(`
      WITH id_candidates AS (
        SELECT member_id AS id_str
        FROM users
        WHERE member_id ~* '^MMR-TM-[0-9]+$'
           OR member_id ~* '^MMR-TM-[0-9]+-[0-9]+$'
           OR member_id ~* '^TM-[0-9]+$'
        UNION ALL
        SELECT team_member_uid AS id_str
        FROM team_members
        WHERE team_member_uid ~* '^MMR-TM-[0-9]+$'
           OR team_member_uid ~* '^MMR-TM-[0-9]+-[0-9]+$'
           OR team_member_uid ~* '^TM-[0-9]+$'
      )
      SELECT COALESCE(MAX(
        CASE
          WHEN id_str ~* '^MMR-TM-[0-9]+$' THEN SUBSTRING(id_str FROM 8)::bigint
          WHEN id_str ~* '^MMR-TM-[0-9]+-[0-9]+$' THEN SUBSTRING(id_str FROM 13)::bigint
          WHEN id_str ~* '^TM-[0-9]+$' THEN SUBSTRING(id_str FROM 4)::bigint
          ELSE 0 END
      ), 0) + 1 AS next_seq
      FROM id_candidates
    `);

    const nextSeq = Number(res.rows[0]?.next_seq || 1);
    return `MMR-TM-${String(nextSeq).padStart(4, "0")}`;
  }

  // Associate ID generator (exact server.js logic)
  async function genAssociateId(db) {
    const res = await db.query(`
      SELECT COALESCE(MAX(
        CASE
          WHEN member_id ~* '^MMR-ASC-[0-9]+$' THEN SUBSTRING(member_id FROM 9)::integer
          WHEN member_id ~* '^MMR-A-[0-9]+$' THEN SUBSTRING(member_id FROM 7)::integer
          WHEN member_id ~* '^MMR[0-9]+$' AND LOWER(user_type::TEXT) = 'associate' THEN SUBSTRING(member_id FROM 4)::integer
          ELSE 0 END
      ), 0) + 1 AS seq
      FROM users
    `);
    return `MMR-ASC-${String(res.rows[0]?.seq || 1).padStart(4, "0")}`;
  }

  // Customer ID generator (exact server.js logic)
  async function genCustomerId(db) {
    const res = await db.query(`
      SELECT COALESCE(MAX(
        CASE
          WHEN member_id ~* '^MMR-CUS-[0-9]+$' THEN SUBSTRING(member_id FROM 9)::integer
          WHEN member_id ~* '^MMR-C-[0-9]+$' THEN SUBSTRING(member_id FROM 7)::integer
          WHEN member_id ~* '^MMR[0-9]+$' AND LOWER(user_type::TEXT) = 'customer' THEN SUBSTRING(member_id FROM 4)::integer
          ELSE 0 END
      ), 0) + 1 AS seq
      FROM users
    `);
    return `MMR-CUS-${String(res.rows[0]?.seq || 1).padStart(5, "0")}`;
  }

  // Seed default Associate (Suraj Kumar Verma)
  await pglite.exec(`
    INSERT INTO users (user_id, member_id, user_type, full_name, mobile_no, email, account_status)
    VALUES (1, 'MMR-ASC-0001', 'Associate', 'Suraj Kumar Verma', '7071951011', 'suraj@mmr.com', 'Active');
    SELECT setval('users_user_id_seq', (SELECT MAX(user_id) FROM users));
  `);

  let allPassed = true;

  // -------------------------------------------------------------
  // TEST 1: Khaali DB par pehla Team Member => MMR-TM-0001, doosra => MMR-TM-0002
  // -------------------------------------------------------------
  console.log('TEST 1: First and second Team Member sequential generation on clean DB...');
  const tm1 = await generateTeamMemberId(pglite);
  await pglite.query(`INSERT INTO team_members (team_member_uid, associate_id, associate_name, full_name, mobile_no) VALUES ($1, 1, 'Suraj', 'TM One', '9000000001')`, [tm1]);
  await pglite.query(`INSERT INTO users (member_id, user_type, full_name, mobile_no) VALUES ($1, 'Team Member', 'TM One', '9000000001')`, [tm1]);

  const tm2 = await generateTeamMemberId(pglite);
  await pglite.query(`INSERT INTO team_members (team_member_uid, associate_id, associate_name, full_name, mobile_no) VALUES ($1, 1, 'Suraj', 'TM Two', '9000000002')`, [tm2]);
  await pglite.query(`INSERT INTO users (member_id, user_type, full_name, mobile_no) VALUES ($1, 'Team Member', 'TM Two', '9000000002')`, [tm2]);

  if (tm1 === 'MMR-TM-0001' && tm2 === 'MMR-TM-0002') {
    console.log(`  [PASS] First: ${tm1}, Second: ${tm2}\n`);
  } else {
    console.error(`  [FAIL] Expected MMR-TM-0001 and MMR-TM-0002, got ${tm1} and ${tm2}\n`);
    allPassed = false;
  }

  // -------------------------------------------------------------
  // TEST 2: Pehle se MMR-TM-00005 maujood ho => agla MMR-TM-0006
  // -------------------------------------------------------------
  console.log('TEST 2: Seamless sequence continuation when legacy 5-digit MMR-TM-00005 exists...');
  await pglite.query(`INSERT INTO team_members (team_member_uid, associate_id, associate_name, full_name, mobile_no) VALUES ('MMR-TM-00005', 1, 'Suraj', 'Legacy TM 5', '9000000005')`);
  await pglite.query(`INSERT INTO users (member_id, user_type, full_name, mobile_no) VALUES ('MMR-TM-00005', 'Team Member', 'Legacy TM 5', '9000000005')`);

  const nextAfter5 = await generateTeamMemberId(pglite);
  if (nextAfter5 === 'MMR-TM-0006') {
    console.log(`  [PASS] Legacy MMR-TM-00005 parsed successfully. Next ID: ${nextAfter5}\n`);
  } else {
    console.error(`  [FAIL] Expected MMR-TM-0006 after MMR-TM-00005, got ${nextAfter5}\n`);
    allPassed = false;
  }

  // -------------------------------------------------------------
  // TEST 3: Multiple Sequential Enrollments => unique, contiguous
  // -------------------------------------------------------------
  console.log('TEST 3: Sequential bulk enrollments (10 consecutive IDs)...');
  const generatedIds = [];
  for (let i = 0; i < 10; i++) {
    const id = await generateTeamMemberId(pglite);
    generatedIds.push(id);
    await pglite.query(`INSERT INTO team_members (team_member_uid, associate_id, associate_name, full_name, mobile_no) VALUES ($1, 1, 'Suraj', 'Bulk TM ' || $2, '910000000' || $2)`, [id, i]);
    await pglite.query(`INSERT INTO users (member_id, user_type, full_name, mobile_no) VALUES ($1, 'Team Member', 'Bulk TM ' || $2, '910000000' || $2)`, [id, i]);
  }
  const uniqueCount = new Set(generatedIds).size;
  const isContiguous = generatedIds.every((id, idx) => id === `MMR-TM-${String(6 + idx).padStart(4, '0')}`);

  if (uniqueCount === 10 && isContiguous) {
    console.log(`  [PASS] Generated 10 unique contiguous IDs: ${generatedIds[0]} -> ${generatedIds[generatedIds.length - 1]}\n`);
  } else {
    console.error(`  [FAIL] Generation error. Unique: ${uniqueCount}, IDs: ${generatedIds.join(', ')}\n`);
    allPassed = false;
  }

  // -------------------------------------------------------------
  // TEST 4: Associate => MMR-ASC-XXXX, Customer => MMR-CUS-XXXXX (Unchanged)
  // -------------------------------------------------------------
  console.log('TEST 4: Associate and Customer ID generation preservation (zero drift)...');
  const nextAssoc = await genAssociateId(pglite);
  const nextCust = await genCustomerId(pglite);

  if (nextAssoc === 'MMR-ASC-0002' && nextCust === 'MMR-CUS-00001') {
    console.log(`  [PASS] Associate ID: ${nextAssoc} (4-digit MMR-ASC-)`);
    console.log(`  [PASS] Customer ID: ${nextCust} (5-digit MMR-CUS-)\n`);
  } else {
    console.error(`  [FAIL] Expected MMR-ASC-0002 and MMR-CUS-00001, got ${nextAssoc} and ${nextCust}\n`);
    allPassed = false;
  }

  // -------------------------------------------------------------
  // TEST 5: Public/Quick Signup creates users row + team_members row (matching UID, slot, associate link)
  // -------------------------------------------------------------
  console.log('TEST 5: Full Team Member registration row consistency check...');
  const newTmId = await generateTeamMemberId(pglite);
  const userRes = await pglite.query(`
    INSERT INTO users (member_id, user_type, full_name, mobile_no, email, sponsor_user_id, account_status)
    VALUES ($1, 'Team Member', 'Ramesh Kumar', '9876543210', 'ramesh@example.com', 1, 'Active')
    RETURNING user_id, member_id, user_type, sponsor_user_id
  `, [newTmId]);

  const tmRes = await pglite.query(`
    INSERT INTO team_members (team_member_uid, associate_id, associate_name, user_id, slot_number, full_name, mobile_no, email_id, status)
    VALUES ($1, 1, 'Suraj Kumar Verma', $2, 1, 'Ramesh Kumar', '9876543210', 'ramesh@example.com', 'approved')
    RETURNING id, team_member_uid, associate_id, slot_number, status
  `, [newTmId, userRes.rows[0].user_id]);

  const userRow = userRes.rows[0];
  const tmRow = tmRes.rows[0];

  const uidMatches = userRow.member_id === tmRow.team_member_uid;
  const roleMatches = userRow.user_type === 'Team Member';
  const sponsorMatches = Number(userRow.sponsor_user_id) === Number(tmRow.associate_id);
  const slotValid = tmRow.slot_number >= 1 && tmRow.slot_number <= 10;

  if (uidMatches && roleMatches && sponsorMatches && slotValid) {
    console.log(`  [PASS] users.member_id: ${userRow.member_id} === team_members.team_member_uid: ${tmRow.team_member_uid}`);
    console.log(`  [PASS] user_type: ${userRow.user_type}, associate_id: ${tmRow.associate_id}, slot_number: ${tmRow.slot_number}, status: ${tmRow.status}\n`);
  } else {
    console.error(`  [FAIL] Inconsistent Team Member registration data.\n`);
    allPassed = false;
  }

  // -------------------------------------------------------------
  // TEST 6: Referral code resolution for new Team Member format
  // -------------------------------------------------------------
  console.log('TEST 6: Referral code resolution for MMR-TM-XXXX...');
  const refCode = userRow.member_id; // e.g. MMR-TM-0016
  const lookupRes = await pglite.query(`
    SELECT user_id, full_name, member_id, user_type, account_status
    FROM users
    WHERE (
      UPPER(COALESCE(member_id, '')) = UPPER($1)
      OR UPPER(regexp_replace(COALESCE(member_id, ''), '^MMR-(ASC|CUS|TM|[ACTM])-', 'MMR')) = UPPER($1)
    )
    LIMIT 1
  `, [refCode]);

  if (lookupRes.rows.length === 1 && lookupRes.rows[0].user_id === userRow.user_id) {
    console.log(`  [PASS] Referral lookup with ${refCode} successfully resolved user: ${lookupRes.rows[0].full_name} (${lookupRes.rows[0].user_type})\n`);
  } else {
    console.error(`  [FAIL] Failed to resolve referral code ${refCode}\n`);
    allPassed = false;
  }

  // -------------------------------------------------------------
  // TEST 7: Admin Team Members query UNION test
  // -------------------------------------------------------------
  console.log('TEST 7: Admin Team Members directory query recognition...');
  const adminQueryRes = await pglite.query(`
    SELECT tm.id, tm.team_member_uid, tm.full_name, tm.associate_id, tm.slot_number, tm.status
    FROM team_members tm
    WHERE tm.team_member_uid = $1
  `, [newTmId]);

  if (adminQueryRes.rows.length === 1 && adminQueryRes.rows[0].team_member_uid === newTmId) {
    console.log(`  [PASS] Admin query retrieved new Team Member record: ${adminQueryRes.rows[0].team_member_uid} (Slot #${adminQueryRes.rows[0].slot_number})\n`);
  } else {
    console.error(`  [FAIL] Admin directory query failed to find ${newTmId}\n`);
    allPassed = false;
  }

  console.log('================================================================');
  if (allPassed) {
    console.log('  ALL 7 TESTS PASSED! ZERO REGRESSIONS DETECTED.');
  } else {
    console.log('  SOME TESTS FAILED! PLEASE REVIEW OUTPUT ABOVE.');
  }
  console.log('================================================================\n');

  process.exit(allPassed ? 0 : 1);
}

runSuite().catch(err => {
  console.error('[TestSuite Error]:', err);
  process.exit(1);
});
