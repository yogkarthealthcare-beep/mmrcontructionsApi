import { PGlite } from '@electric-sql/pglite';

async function runParallelTest() {
  console.log('================================================================');
  console.log('  TEST: 10 CONCURRENT / PARALLEL REGISTRATIONS VIA PROMISE.ALL');
  console.log('================================================================');

  const db = new PGlite();

  // Create tables with UNIQUE constraint on member_id and team_member_uid
  await db.exec(`
    CREATE TABLE users (
      user_id SERIAL PRIMARY KEY,
      member_id VARCHAR(50) UNIQUE NOT NULL,
      user_type VARCHAR(50) NOT NULL,
      full_name VARCHAR(150) NOT NULL,
      mobile_no VARCHAR(15) NOT NULL,
      sponsor_user_id INTEGER
    );

    CREATE TABLE team_members (
      id SERIAL PRIMARY KEY,
      team_member_uid VARCHAR(30) UNIQUE NOT NULL,
      associate_id BIGINT NOT NULL,
      user_id INTEGER,
      slot_number SMALLINT,
      full_name VARCHAR(150) NOT NULL,
      mobile_no VARCHAR(15) NOT NULL,
      status VARCHAR(20) DEFAULT 'approved'
    );

    INSERT INTO users (user_id, member_id, user_type, full_name, mobile_no)
    VALUES (1, 'MMR-ASC-0001', 'Associate', 'Suraj Kumar Verma', '7071951011');
    SELECT setval('users_user_id_seq', (SELECT MAX(user_id) FROM users));
  `);

  // Shared implementation matching services/teamMemberService.js:generateTeamMemberId
  async function generateTeamMemberId(tx, attempt = 1) {
    await tx.exec(`SELECT pg_advisory_xact_lock(hashtext('team_member_id_generation'))`).catch(() => {});
    const res = await tx.query(`
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

    let nextSeq = Number(res.rows[0]?.next_seq || 1);
    if (attempt > 1) {
      nextSeq += (attempt - 1);
    }
    const formattedId = `MMR-TM-${String(nextSeq).padStart(4, "0")}`;
    const conflict = await tx.query(`
      SELECT 1 FROM users WHERE member_id = $1
      UNION ALL
      SELECT 1 FROM team_members WHERE team_member_uid = $1
      LIMIT 1
    `, [formattedId]);

    if (conflict.rows.length > 0 && attempt <= 5) {
      return generateTeamMemberId(tx, attempt + 1);
    }
    return formattedId;
  }

  // Simulate 10 simultaneous registration requests arriving concurrently
  console.log('Launching 10 concurrent registrations with Promise.all()...');
  const tasks = Array.from({ length: 10 }, (_, i) => i + 1);

  const startTime = Date.now();
  const registrationPromises = tasks.map(async (taskNum) => {
    // Each registration runs inside a transaction block
    return await db.transaction(async (tx) => {
      // 1. Generate ID under advisory lock
      const uid = await generateTeamMemberId(tx);

      // Simulate a small async delay/work (e.g. hashing password, external lookups)
      await new Promise(r => setTimeout(r, Math.floor(Math.random() * 15) + 5));

      // 2. Insert into users
      const uRes = await tx.query(`
        INSERT INTO users (member_id, user_type, full_name, mobile_no, sponsor_user_id)
        VALUES ($1, 'Team Member', 'Parallel User ' || $2, '98100000' || LPAD($2::text, 2, '0'), 1)
        RETURNING user_id, member_id
      `, [uid, taskNum]);

      const userId = uRes.rows[0].user_id;

      // 3. Insert into team_members
      await tx.query(`
        INSERT INTO team_members (team_member_uid, associate_id, user_id, slot_number, full_name, mobile_no)
        VALUES ($1, 1, $2, $3, $4, $5)
      `, [uid, userId, taskNum, `Parallel User ${taskNum}`, `98100000${String(taskNum).padStart(2, '0')}`]);

      return { taskNum, uid, userId };
    });
  });

  const results = await Promise.all(registrationPromises);
  const duration = Date.now() - startTime;

  console.log(`Completed in ${duration}ms\nResults:`);
  results.forEach(r => {
    console.log(`  Task #${String(r.taskNum).padStart(2, ' ')} -> Generated ID: ${r.uid} (User ID: ${r.userId})`);
  });

  const allUids = results.map(r => r.uid);
  const uniqueUids = new Set(allUids);

  // Check 1: Uniqueness
  const isUnique = uniqueUids.size === 10;
  console.log(`\nUniqueness Check: ${isUnique ? 'PASS (10/10 unique)' : `FAIL (${uniqueUids.size}/10 unique)`}`);

  // Check 2: Contiguous sequence
  // Sort IDs numerically
  const sortedIds = [...allUids].sort((a, b) => {
    const numA = parseInt(a.replace('MMR-TM-', ''), 10);
    const numB = parseInt(b.replace('MMR-TM-', ''), 10);
    return numA - numB;
  });

  const expectedSequence = Array.from({ length: 10 }, (_, i) => `MMR-TM-${String(i + 1).padStart(4, '0')}`);
  const isContiguous = JSON.stringify(sortedIds) === JSON.stringify(expectedSequence);
  console.log(`Contiguous Sequence Check: ${isContiguous ? 'PASS (MMR-TM-0001 through MMR-TM-0010 without gaps)' : 'FAIL'}`);
  console.log(`Expected: ${expectedSequence.join(', ')}`);
  console.log(`Actual:   ${sortedIds.join(', ')}`);

  // Verify database state directly
  const dbUsers = await db.query(`SELECT member_id FROM users WHERE user_type = 'Team Member' ORDER BY member_id ASC`);
  const dbTMs = await db.query(`SELECT team_member_uid FROM team_members ORDER BY team_member_uid ASC`);

  console.log(`\nDB Users Table Count: ${dbUsers.rows.length}`);
  console.log(`DB Team Members Table Count: ${dbTMs.rows.length}`);

  const passed = isUnique && isContiguous && dbUsers.rows.length === 10 && dbTMs.rows.length === 10;
  console.log('================================================================');
  console.log(`FINAL RESULT: ${passed ? 'PASS' : 'FAIL'}`);
  console.log('================================================================');

  process.exit(passed ? 0 : 1);
}

runParallelTest().catch(err => {
  console.error('[Parallel Test Error]:', err);
  process.exit(1);
});
