import sql from '../db.js';

async function updateGoluMaster() {
  console.log('================================================================');
  console.log('  MMR CONSTRUCTIONS: RECONCILING GOLU MASTER ID IN DATABASE');
  console.log('================================================================\n');

  try {
    // 1. Pre-check: Locate Golu Master
    console.log('STEP 1: Checking current record for Golu Master...');
    const users = await sql`
      SELECT u.user_id, u.member_id, u.user_type, u.full_name, u.mobile_no, u.sponsor_user_id
      FROM users u
      WHERE u.full_name ILIKE '%Golu%' 
         OR u.member_id ILIKE '%00006%'
      ORDER BY u.user_id ASC
    `;

    console.log('Found user records matching Golu:');
    console.table(users);

    if (!users || users.length === 0) {
      console.error('ERROR: No user found matching Golu Master.');
      process.exit(1);
    }

    const targetUser = users[0];
    const userId = targetUser.user_id;
    const oldMemberId = targetUser.member_id;

    console.log(`Target User Identified: ID #${userId}, Name: "${targetUser.full_name}", Current Member ID: "${oldMemberId}", Role: "${targetUser.user_type}"\n`);

    const existingTmRows = await sql`
      SELECT id, team_member_uid, user_id, associate_id, slot_number, full_name, mobile_no, status
      FROM team_members
      WHERE user_id = ${userId} 
         OR team_member_uid = ${oldMemberId}
         OR full_name ILIKE '%Golu%'
    `;

    console.log('Existing team_members row(s):');
    console.table(existingTmRows);

    // 2. Calculate next available canonical Team Member ID
    console.log('\nSTEP 2: Calculating next available canonical Team Member ID...');
    const [seqRes] = await sql`
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
          WHEN id_str ~* '^MMR-TM-[0-9]+$' THEN SUBSTRING(id_str FROM 8)::BIGINT
          WHEN id_str ~* '^MMR-TM-[0-9]+-[0-9]+$' THEN SUBSTRING(id_str FROM 13)::BIGINT
          WHEN id_str ~* '^TM-[0-9]+$' THEN SUBSTRING(id_str FROM 4)::BIGINT
          ELSE 0 END
      ), 0) + 1 AS next_seq
      FROM id_candidates
    `;

    const nextSeq = Number(seqRes?.next_seq || 1);
    const newMemberId = `MMR-TM-${String(nextSeq).padStart(4, '0')}`;
    console.log(`Next Canonical ID to be assigned: ${newMemberId}\n`);

    // 3. Execute Transaction
    console.log('STEP 3: Executing atomic transaction...');
    await sql.begin(async (tx) => {
      // A. Ensure legacy_member_id column exists
      await tx`ALTER TABLE users ADD COLUMN IF NOT EXISTS legacy_member_id VARCHAR(50);`;
      await tx`CREATE INDEX IF NOT EXISTS idx_users_legacy_member_id ON users(UPPER(legacy_member_id));`;

      // B. Update users table
      const [updatedUser] = await tx`
        UPDATE users
        SET legacy_member_id = COALESCE(legacy_member_id, ${oldMemberId}),
            member_id        = ${newMemberId},
            user_type        = 'Team Member',
            updated_at       = NOW()
        WHERE user_id = ${userId}
        RETURNING user_id, member_id, legacy_member_id, user_type, full_name
      `;
      console.log('  -> Updated users table:', updatedUser);

      // C. Update or insert team_members row
      if (existingTmRows.length > 0) {
        const updatedTm = await tx`
          UPDATE team_members
          SET team_member_uid = ${newMemberId},
              user_id         = ${userId},
              status          = 'approved',
              updated_at      = NOW()
          WHERE user_id = ${userId}
             OR team_member_uid = ${oldMemberId}
             OR full_name ILIKE '%Golu%'
          RETURNING id, team_member_uid, user_id, associate_id, slot_number, status
        `;
        console.log('  -> Updated team_members table:', updatedTm);
      } else {
        const sponsorId = targetUser.sponsor_user_id || 1;
        const [insertedTm] = await tx`
          INSERT INTO team_members (
            team_member_uid, associate_id, associate_name, user_id, slot_number,
            full_name, mobile_no, status, created_at, updated_at
          ) VALUES (
            ${newMemberId}, ${sponsorId}, 'Suraj Kumar Verma', ${userId}, 1,
            ${targetUser.full_name}, ${targetUser.mobile_no}, 'approved', NOW(), NOW()
          )
          RETURNING id, team_member_uid, user_id, associate_id, slot_number, status
        `;
        console.log('  -> Inserted team_members table:', insertedTm);
      }

      // D. Update user_wallets role
      try {
        await tx`
          UPDATE user_wallets
          SET user_role = 'Team Member'
          WHERE user_id = ${userId}
        `;
        console.log('  -> Updated user_wallets role to Team Member.');
      } catch (wErr) {
        console.log('  -> user_wallets update notice:', wErr.message);
      }
    });

    console.log('\nTRANSACTION COMMITTED SUCCESSFULLY!\n');

    // 4. Verification Post-Check
    console.log('STEP 4: Post-update verification check...');
    const postUser = await sql`
      SELECT u.user_id, u.member_id, u.legacy_member_id, u.user_type, u.full_name, u.mobile_no
      FROM users u
      WHERE u.user_id = ${userId}
    `;
    const postTm = await sql`
      SELECT tm.id, tm.team_member_uid, tm.user_id, tm.associate_id, tm.slot_number, tm.status
      FROM team_members tm
      WHERE tm.user_id = ${userId}
    `;

    console.log('Post-update Users record:');
    console.table(postUser);
    console.log('Post-update Team Members record:');
    console.table(postTm);

    console.log('================================================================');
    console.log(`  GOLU MASTER ID UPDATE COMPLETE: ${oldMemberId} -> ${newMemberId}`);
    console.log('================================================================\n');

  } catch (err) {
    console.error('ERROR during update:', err);
    process.exit(1);
  } finally {
    await sql.end({ timeout: 5 });
    process.exit(0);
  }
}

updateGoluMaster();
