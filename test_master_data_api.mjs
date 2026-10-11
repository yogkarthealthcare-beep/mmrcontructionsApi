import { PGlite } from '@electric-sql/pglite';

async function testMasterDataLogic() {
  console.log('Testing Master Data SQL logic in PGlite...');
  const db = new PGlite();

  // Create sample tables
  await db.exec(`
    CREATE TABLE users (
      user_id SERIAL PRIMARY KEY,
      member_id VARCHAR(50),
      user_type VARCHAR(50) NOT NULL,
      full_name VARCHAR(150) NOT NULL,
      mobile_no VARCHAR(15) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE team_members (
      id SERIAL PRIMARY KEY,
      team_member_uid VARCHAR(30) UNIQUE NOT NULL,
      associate_id BIGINT NOT NULL,
      user_id INTEGER,
      full_name VARCHAR(150) NOT NULL
    );

    INSERT INTO users (member_id, user_type, full_name, mobile_no)
    VALUES ('MMR-ASC-0001', 'Associate', 'Suraj Verma', '7071951011'),
           ('MMR-TM-0004', 'Team Member', 'Golu Master', '8299209921');

    INSERT INTO team_members (team_member_uid, associate_id, user_id, full_name)
    VALUES ('MMR-TM-0004', 65, 2, 'Golu Master');
  `);

  // Test table listing
  const tables = await db.query(`
    SELECT table_name 
    FROM information_schema.tables 
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name ASC;
  `);
  console.log('Tables found:', tables.rows.map(r => r.table_name));

  // Test columns listing
  const cols = await db.query(`
    SELECT 
      c.column_name, 
      c.data_type, 
      c.is_nullable,
      CASE WHEN kcu.column_name IS NOT NULL THEN TRUE ELSE FALSE END AS is_primary_key
    FROM information_schema.columns c
    LEFT JOIN (
      SELECT k.column_name, k.table_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage k
        ON tc.constraint_name = k.constraint_name AND tc.table_schema = k.table_schema
      WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = 'public'
    ) kcu ON kcu.table_name = c.table_name AND kcu.column_name = c.column_name
    WHERE c.table_schema = 'public' AND c.table_name = 'users'
    ORDER BY c.ordinal_position ASC;
  `);
  console.log('Users columns:', cols.rows.map(r => `${r.column_name} (${r.data_type}, PK: ${r.is_primary_key})`));

  // Test search & pagination
  const searchVal = '%Golu%';
  const records = await db.query(`
    SELECT * FROM users 
    WHERE CAST(full_name AS TEXT) ILIKE $1 OR CAST(member_id AS TEXT) ILIKE $1
    ORDER BY user_id DESC
    LIMIT 25 OFFSET 0;
  `, [searchVal]);
  console.log('Filtered search records:', records.rows);

  // Test userType filtering
  const userType = 'associate';
  let pattern = `%${userType}%`;
  if (userType === 'associate') pattern = '%assoc%';
  else if (userType === 'team_member' || userType === 'team member') pattern = '%team%';
  else if (userType === 'customer') pattern = '%cust%';
  else if (userType === 'investor') pattern = '%invest%';

  const associateUsers = await db.query(`
    SELECT * FROM users
    WHERE LOWER(CAST(user_type AS TEXT)) LIKE $1
  `, [pattern]);
  console.log('Filtered by userType=associate:', associateUsers.rows.map(r => `${r.full_name} (${r.user_type})`));

  // Test cascade delete
  const userIdToDelete = 2;
  // Delete referencing in child table first
  await db.query(`DELETE FROM team_members WHERE user_id = $1`, [userIdToDelete]);
  await db.query(`DELETE FROM users WHERE user_id = $1`, [userIdToDelete]);

  const remainingUsers = await db.query(`SELECT COUNT(*) as count FROM users`);
  const remainingTm = await db.query(`SELECT COUNT(*) as count FROM team_members`);
  console.log('Remaining users:', remainingUsers.rows[0].count, 'Remaining team members:', remainingTm.rows[0].count);

  const passed = associateUsers.rows.length === 1 &&
                 associateUsers.rows[0].user_type === 'Associate' &&
                 Number(remainingUsers.rows[0].count) === 1 &&
                 Number(remainingTm.rows[0].count) === 0;

  console.log('\nMASTER DATA USERTYPE & CASCADE TEST:', passed ? 'PASS' : 'FAIL');
  process.exit(passed ? 0 : 1);
}

testMasterDataLogic().catch(console.error);
