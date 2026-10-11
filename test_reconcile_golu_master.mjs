import { PGlite } from '@electric-sql/pglite';

async function testReconcileSql() {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE users (
      user_id SERIAL PRIMARY KEY,
      member_id VARCHAR(50),
      user_type VARCHAR(50) NOT NULL,
      full_name VARCHAR(150) NOT NULL,
      mobile_no VARCHAR(15) NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE team_members (
      id SERIAL PRIMARY KEY,
      team_member_uid VARCHAR(30) UNIQUE,
      associate_id BIGINT,
      user_id INTEGER,
      slot_number SMALLINT,
      full_name VARCHAR(150),
      mobile_no VARCHAR(15),
      status VARCHAR(20) DEFAULT 'approved',
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE user_wallets (
      id SERIAL PRIMARY KEY,
      user_id INTEGER UNIQUE,
      user_role VARCHAR(50)
    );

    INSERT INTO users (user_id, member_id, user_type, full_name, mobile_no)
    VALUES (1, 'MMR-ASC-0001', 'Associate', 'Suraj Kumar Verma', '7071951011'),
           (6, 'MMR-ASC-00006', 'Associate', 'Golu Master', '9876543210');

    INSERT INTO team_members (team_member_uid, associate_id, user_id, slot_number, full_name, mobile_no)
    VALUES ('MMR-ASC-00006', 1, 6, 1, 'Golu Master', '9876543210');

    INSERT INTO user_wallets (user_id, user_role) VALUES (6, 'Associate');
  `);

  console.log('--- Initial State ---');
  const initUser = await db.query(`SELECT user_id, member_id, user_type, full_name FROM users WHERE user_id = 6`);
  const initTm = await db.query(`SELECT team_member_uid, associate_id, slot_number, status FROM team_members WHERE user_id = 6`);
  console.log('User:', initUser.rows[0]);
  console.log('Team Member:', initTm.rows[0]);

  // Execute Non-Destructive Update
  await db.exec(`ALTER TABLE users ADD COLUMN IF NOT EXISTS legacy_member_id VARCHAR(50);`);

  const nextRes = await db.query(`
    WITH id_candidates AS (
      SELECT member_id AS id_str FROM users WHERE member_id ~* '^MMR-TM-[0-9]+$'
      UNION ALL
      SELECT team_member_uid AS id_str FROM team_members WHERE team_member_uid ~* '^MMR-TM-[0-9]+$'
    )
    SELECT COALESCE(MAX(SUBSTRING(id_str FROM 8)::bigint), 0) + 1 AS next_seq FROM id_candidates;
  `);
  const newId = 'MMR-TM-' + String(nextRes.rows[0].next_seq).padStart(4, '0');

  await db.query(`
    UPDATE users
    SET legacy_member_id = member_id,
        member_id = $1,
        user_type = 'Team Member',
        updated_at = NOW()
    WHERE user_id = 6;
  `, [newId]);

  await db.query(`
    UPDATE team_members
    SET team_member_uid = $1,
        status = 'approved',
        updated_at = NOW()
    WHERE user_id = 6;
  `, [newId]);

  await db.query(`
    UPDATE user_wallets
    SET user_role = 'Team Member'
    WHERE user_id = 6;
  `);

  console.log('\n--- Updated State ---');
  const updatedUser = await db.query(`SELECT user_id, member_id, legacy_member_id, user_type, full_name FROM users WHERE user_id = 6`);
  const updatedTm = await db.query(`SELECT team_member_uid, associate_id, slot_number, status FROM team_members WHERE user_id = 6`);
  const updatedWallet = await db.query(`SELECT user_role FROM user_wallets WHERE user_id = 6`);

  console.log('User:', updatedUser.rows[0]);
  console.log('Team Member:', updatedTm.rows[0]);
  console.log('Wallet Role:', updatedWallet.rows[0]);

  const success = updatedUser.rows[0].member_id === 'MMR-TM-0001' &&
                  updatedUser.rows[0].legacy_member_id === 'MMR-ASC-00006' &&
                  updatedUser.rows[0].user_type === 'Team Member' &&
                  updatedTm.rows[0].team_member_uid === 'MMR-TM-0001' &&
                  updatedWallet.rows[0].user_role === 'Team Member';

  console.log('\nVerification:', success ? 'ALL CHECKS PASSED' : 'FAILED');
  process.exit(success ? 0 : 1);
}

testReconcileSql().catch(console.error);
