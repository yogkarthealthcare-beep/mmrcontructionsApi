import { PGlite } from '@electric-sql/pglite';
import { canApproveCustomer, ensureCustomerApprovalSchema } from './services/customerApprovalAuthority.service.js';

async function runTestSuite() {
  console.log('================================================================');
  console.log('  MMR CONSTRUCTIONS: CUSTOMER APPROVAL HIERARCHY TEST SUITE');
  console.log('  Engine: In-Memory PostgreSQL (PGlite WASM) - Zero External DB');
  console.log('================================================================\n');

  const pglite = new PGlite();

  // Create minimal schema for testing
  await pglite.exec(`
    CREATE TABLE IF NOT EXISTS users (
      user_id SERIAL PRIMARY KEY,
      member_id VARCHAR(50),
      user_type VARCHAR(50) NOT NULL,
      full_name VARCHAR(150) NOT NULL,
      mobile_no VARCHAR(15) NOT NULL,
      email VARCHAR(150),
      sponsor_user_id INTEGER,
      referred_by_user_id INTEGER,
      account_status VARCHAR(20) DEFAULT 'Active',
      role VARCHAR(50),
      enrollment_status VARCHAR(20) DEFAULT '0',
      is_active BOOLEAN DEFAULT true,
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
      status VARCHAR(20) DEFAULT 'approved',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS customer_enrollment_submissions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id INTEGER,
      application_no VARCHAR(50),
      applicant_name VARCHAR(150) NOT NULL,
      mobile_1 VARCHAR(15) NOT NULL,
      application_status VARCHAR(50) DEFAULT 'Pending',
      verified_by VARCHAR(150),
      is_final_submitted BOOLEAN DEFAULT TRUE,
      approved_by_user_id INTEGER,
      approved_by_member_id VARCHAR(50),
      approved_by_name VARCHAR(150),
      approved_by_role VARCHAR(50),
      approved_at TIMESTAMPTZ,
      reject_reason TEXT,
      rejected_by_user_id INTEGER,
      rejected_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS user_documents (
      document_id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      document_type VARCHAR(50) NOT NULL,
      file_path TEXT NOT NULL,
      review_status VARCHAR(30) DEFAULT 'Submitted',
      is_verified BOOLEAN DEFAULT FALSE,
      is_active BOOLEAN DEFAULT TRUE,
      verified_by_user_id INTEGER,
      verifier_member_id VARCHAR(50),
      verifier_name VARCHAR(150),
      verifier_role VARCHAR(50),
      verified_at TIMESTAMPTZ,
      reject_reason TEXT,
      rejected_by_user_id INTEGER,
      rejected_at TIMESTAMPTZ,
      uploaded_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS user_kyc_profiles (
      id SERIAL PRIMARY KEY,
      user_id INTEGER UNIQUE NOT NULL,
      status VARCHAR(30) DEFAULT 'Submitted',
      admin_remarks TEXT,
      reviewed_by_user_id INTEGER,
      reviewer_member_id VARCHAR(50),
      reviewer_name VARCHAR(150),
      reviewer_role VARCHAR(50),
      reviewed_at TIMESTAMPTZ,
      reject_reason TEXT,
      rejected_by_user_id INTEGER,
      rejected_at TIMESTAMPTZ,
      submitted_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Ensure additive schema columns
  // Wrap PGlite to mimic postgres.js template tag interface
  const sql = async (strings, ...values) => {
    let query = strings[0];
    const params = [];
    for (let i = 0; i < values.length; i++) {
      params.push(values[i]);
      query += `$${params.length}` + strings[i + 1];
    }
    const res = await pglite.query(query, params);
    return res.rows;
  };

  await ensureCustomerApprovalSchema(sql);

  // Setup Test Data
  // 1. Admin: Suraj Kumar Verma (user_id: 1, MMR00001)
  await pglite.exec(`
    INSERT INTO users (user_id, member_id, user_type, full_name, mobile_no, role, account_status)
    VALUES (1, 'MMR00001', 'Admin', 'Suraj Kumar Verma', '9999999999', 'SuperAdmin', 'Active');

    -- 2. Associate A (user_id: 10, MMR-ASC-0010)
    INSERT INTO users (user_id, member_id, user_type, full_name, mobile_no, sponsor_user_id, referred_by_user_id, account_status)
    VALUES (10, 'MMR-ASC-0010', 'Associate', 'Amit Associate', '9888888881', 1, 1, 'Active');

    -- 3. Associate B (user_id: 11, MMR-ASC-0011, Unrelated)
    INSERT INTO users (user_id, member_id, user_type, full_name, mobile_no, sponsor_user_id, referred_by_user_id, account_status)
    VALUES (11, 'MMR-ASC-0011', 'Associate', 'Bikram Associate', '9888888882', 1, 1, 'Active');

    -- 4. Team Member TM1 (user_id: 20, MMR-TM-0001, Under Associate A)
    INSERT INTO users (user_id, member_id, user_type, full_name, mobile_no, sponsor_user_id, referred_by_user_id, account_status)
    VALUES (20, 'MMR-TM-0001', 'Team Member', 'Tarun TM1', '9777777771', 10, 10, 'Active');

    INSERT INTO team_members (team_member_uid, associate_id, associate_name, user_id, full_name, mobile_no, status)
    VALUES ('MMR-TM-0001', 10, 'Amit Associate', 20, 'Tarun TM1', '9777777771', 'approved');

    -- 5. Team Member TM2 (user_id: 21, MMR-TM-0002, Under Associate B)
    INSERT INTO users (user_id, member_id, user_type, full_name, mobile_no, sponsor_user_id, referred_by_user_id, account_status)
    VALUES (21, 'MMR-TM-0002', 'Team Member', 'Tanmay TM2', '9777777772', 11, 11, 'Active');

    INSERT INTO team_members (team_member_uid, associate_id, associate_name, user_id, full_name, mobile_no, status)
    VALUES ('MMR-TM-0002', 11, 'Bikram Associate', 21, 'Tanmay TM2', '9777777772', 'approved');

    -- 6. Team Member Solo TM_Solo (user_id: 22, MMR-TM-0003, directly under MMR00001, no associate)
    INSERT INTO users (user_id, member_id, user_type, full_name, mobile_no, sponsor_user_id, referred_by_user_id, account_status)
    VALUES (22, 'MMR-TM-0003', 'Team Member', 'Solo TM', '9777777773', 1, 1, 'Active');

    -- 7. Role Conflict User: user_type = 'Associate' in users table, but listed as approved member in team_members under Associate A (user_id: 25)
    INSERT INTO users (user_id, member_id, user_type, full_name, mobile_no, sponsor_user_id, referred_by_user_id, account_status)
    VALUES (25, 'MMR-ASC-0025', 'Associate', 'Conflict Rajesh', '9666666661', 10, 10, 'Active');

    INSERT INTO team_members (team_member_uid, associate_id, associate_name, user_id, full_name, mobile_no, status)
    VALUES ('MMR-TM-0025', 10, 'Amit Associate', 25, 'Conflict Rajesh', '9666666661', 'approved');

    -- 8. Inactive Associate (user_id: 30)
    INSERT INTO users (user_id, member_id, user_type, full_name, mobile_no, sponsor_user_id, referred_by_user_id, account_status)
    VALUES (30, 'MMR-ASC-0030', 'Associate', 'Inactive Inder', '9555555551', 1, 1, 'Inactive');

    -- 9. Inactive Team Member (user_id: 31, under Associate A)
    INSERT INTO users (user_id, member_id, user_type, full_name, mobile_no, sponsor_user_id, referred_by_user_id, account_status)
    VALUES (31, 'MMR-TM-0031', 'Team Member', 'Inactive Ishaan', '9555555552', 10, 10, 'Inactive');

    INSERT INTO team_members (team_member_uid, associate_id, associate_name, user_id, full_name, mobile_no, status)
    VALUES ('MMR-TM-0031', 10, 'Amit Associate', 31, 'Inactive Ishaan', '9555555552', 'inactive');

    -- 10. Inactive Team Member under Inactive Associate 30 (user_id: 32)
    INSERT INTO users (user_id, member_id, user_type, full_name, mobile_no, sponsor_user_id, referred_by_user_id, account_status)
    VALUES (32, 'MMR-TM-0032', 'Team Member', 'Sub-Inactive Sonu', '9555555553', 30, 30, 'Inactive');

    INSERT INTO team_members (team_member_uid, associate_id, associate_name, user_id, full_name, mobile_no, status)
    VALUES ('MMR-TM-0032', 30, 'Inactive Inder', 32, 'Sub-Inactive Sonu', '9555555553', 'inactive');

    -- Customers:
    -- C1: Admin customer (sponsored by 1)
    INSERT INTO users (user_id, member_id, user_type, full_name, mobile_no, sponsor_user_id, referred_by_user_id, account_status)
    VALUES (101, 'MMR-CUS-00101', 'Customer', 'Customer of Admin', '9111111101', 1, 1, 'Pending');

    -- C2: Associate A's customer (sponsored by 10)
    INSERT INTO users (user_id, member_id, user_type, full_name, mobile_no, sponsor_user_id, referred_by_user_id, account_status)
    VALUES (102, 'MMR-CUS-00102', 'Customer', 'Customer of Associate A', '9111111102', 10, 10, 'Pending');

    -- C3: TM1's customer (sponsored by 20, who is under Associate A)
    INSERT INTO users (user_id, member_id, user_type, full_name, mobile_no, sponsor_user_id, referred_by_user_id, account_status)
    VALUES (103, 'MMR-CUS-00103', 'Customer', 'Customer of TM1', '9111111103', 20, 20, 'Pending');

    -- C4: Solo TM's customer (sponsored by 22, no associate)
    INSERT INTO users (user_id, member_id, user_type, full_name, mobile_no, sponsor_user_id, referred_by_user_id, account_status)
    VALUES (104, 'MMR-CUS-00104', 'Customer', 'Customer of Solo TM', '9111111104', 22, 22, 'Pending');

    -- C5: Role Conflict user's customer (sponsored by 25)
    INSERT INTO users (user_id, member_id, user_type, full_name, mobile_no, sponsor_user_id, referred_by_user_id, account_status)
    VALUES (105, 'MMR-CUS-00105', 'Customer', 'Customer of Conflict User', '9111111105', 25, 25, 'Pending');

    -- C6: Customer of Inactive Associate (sponsored by 30)
    INSERT INTO users (user_id, member_id, user_type, full_name, mobile_no, sponsor_user_id, referred_by_user_id, account_status)
    VALUES (106, 'MMR-CUS-00106', 'Customer', 'Customer of Inactive Assoc', '9111111106', 30, 30, 'Pending');

    -- C7: Customer of Inactive TM with Active Associate Leader (sponsored by 31)
    INSERT INTO users (user_id, member_id, user_type, full_name, mobile_no, sponsor_user_id, referred_by_user_id, account_status)
    VALUES (107, 'MMR-CUS-00107', 'Customer', 'Customer of Inactive TM', '9111111107', 31, 31, 'Pending');

    -- C8: Customer of Inactive TM whose Associate Leader is ALSO inactive (sponsored by 32)
    INSERT INTO users (user_id, member_id, user_type, full_name, mobile_no, sponsor_user_id, referred_by_user_id, account_status)
    VALUES (108, 'MMR-CUS-00108', 'Customer', 'Customer of Double Inactive', '9111111108', 32, 32, 'Pending');
  `);

  process.env.ENABLE_SPONSOR_CUSTOMER_APPROVAL = 'true';

  let passCount = 0;
  let failCount = 0;

  function assert(condition, testName, detail = '') {
    if (condition) {
      console.log(`  [PASS] ${testName}`);
      passCount++;
    } else {
      console.error(`  [FAIL] ${testName} - ${detail}`);
      failCount++;
    }
  }

  // Actors
  const adminActor = { user_id: 1, admin_id: 1, role: 'SuperAdmin', member_id: 'MMR00001', full_name: 'Suraj Kumar Verma', is_admin: true };
  const associateAActor = { user_id: 10, member_id: 'MMR-ASC-0010', full_name: 'Amit Associate', user_type: 'Associate' };
  const associateBActor = { user_id: 11, member_id: 'MMR-ASC-0011', full_name: 'Bikram Associate', user_type: 'Associate' };
  const tm1Actor = { user_id: 20, member_id: 'MMR-TM-0001', full_name: 'Tarun TM1', user_type: 'Team Member' };
  const tm2Actor = { user_id: 21, member_id: 'MMR-TM-0002', full_name: 'Tanmay TM2', user_type: 'Team Member' };
  const soloTMActor = { user_id: 22, member_id: 'MMR-TM-0003', full_name: 'Solo TM', user_type: 'Team Member' };
  const conflictActor = { user_id: 25, member_id: 'MMR-ASC-0025', full_name: 'Conflict Rajesh', user_type: 'Associate' };
  const inactiveAssocActor = { user_id: 30, member_id: 'MMR-ASC-0030', full_name: 'Inactive Inder', user_type: 'Associate' };
  const inactiveTMActor = { user_id: 31, member_id: 'MMR-TM-0031', full_name: 'Inactive Ishaan', user_type: 'Team Member' };
  const inactiveTMUnderInactiveAssocActor = { user_id: 32, member_id: 'MMR-TM-0032', full_name: 'Sub-Inactive Sonu', user_type: 'Team Member' };
  const financeStaffActor = { user_id: 50, admin_id: 50, member_id: 'MMR-STF-0050', full_name: 'Farhan Finance', role: 'FinanceManager', is_admin: false };
  const supportStaffActor = { user_id: 51, admin_id: 51, member_id: 'MMR-STF-0051', full_name: 'Salma Support', role: 'SupportStaff', is_admin: false };

  console.log('--- TEST GROUP 1: Admin-sponsored Customer (C1) ---');
  {
    const rAdmin = await canApproveCustomer(sql, adminActor, 101);
    assert(rAdmin.allowed === true, 'Admin ALLOWED for Admin-sponsored customer');

    const rAssocA = await canApproveCustomer(sql, associateAActor, 101);
    assert(rAssocA.allowed === false, 'Associate A DENIED for Admin-sponsored customer', rAssocA.reason);

    const rTM1 = await canApproveCustomer(sql, tm1Actor, 101);
    assert(rTM1.allowed === false, 'Team Member TM1 DENIED for Admin-sponsored customer', rTM1.reason);
  }

  console.log('\n--- TEST GROUP 2: Associate-sponsored Customer (C2) ---');
  {
    const rAssocA = await canApproveCustomer(sql, associateAActor, 102);
    assert(rAssocA.allowed === true, 'Sponsoring Associate A ALLOWED for own customer');

    const rAssocB = await canApproveCustomer(sql, associateBActor, 102);
    assert(rAssocB.allowed === false, 'Unrelated Associate B DENIED for Associate A customer', rAssocB.reason);

    const rAdmin = await canApproveCustomer(sql, adminActor, 102);
    assert(rAdmin.allowed === true, 'Admin ALLOWED for Associate A customer');
  }

  console.log('\n--- TEST GROUP 3: Team Member-sponsored Customer (C3) ---');
  {
    const rTM1 = await canApproveCustomer(sql, tm1Actor, 103);
    assert(rTM1.allowed === true, 'Sponsoring Team Member TM1 ALLOWED for own customer');

    const rAssocA = await canApproveCustomer(sql, associateAActor, 103);
    assert(rAssocA.allowed === true, "TM1's Associate Leader (Associate A) ALLOWED for TM1 customer");

    const rAdmin = await canApproveCustomer(sql, adminActor, 103);
    assert(rAdmin.allowed === true, 'Admin ALLOWED for TM1 customer');

    const rTM2 = await canApproveCustomer(sql, tm2Actor, 103);
    assert(rTM2.allowed === false, 'Other Team Member TM2 DENIED for TM1 customer', rTM2.reason);

    const rAssocB = await canApproveCustomer(sql, associateBActor, 103);
    assert(rAssocB.allowed === false, 'Other Associate B DENIED for TM1 customer', rAssocB.reason);
  }

  console.log('\n--- TEST GROUP 4: Team Member with no Associate (C4) ---');
  {
    const rSoloTM = await canApproveCustomer(sql, soloTMActor, 104);
    assert(rSoloTM.allowed === true, 'Solo Team Member ALLOWED for own customer');

    const rAdmin = await canApproveCustomer(sql, adminActor, 104);
    assert(rAdmin.allowed === true, 'Admin ALLOWED for Solo Team Member customer');

    const rAssocA = await canApproveCustomer(sql, associateAActor, 104);
    assert(rAssocA.allowed === false, 'Unrelated Associate A DENIED for Solo TM customer', rAssocA.reason);
  }

  console.log('\n--- TEST GROUP 5: Role-Conflict User Resolution (C5) ---');
  {
    // Sponsor user_id 25 has users.user_type = 'Associate', but team_members row under Associate A (user_id 10)
    const rConflictSponsor = await canApproveCustomer(sql, conflictActor, 105);
    assert(rConflictSponsor.allowed === true, 'Role-conflict sponsor ALLOWED for own customer');

    const rLeader = await canApproveCustomer(sql, associateAActor, 105);
    assert(rLeader.allowed === true, 'Associate leader resolved via team_members table ALLOWED for role-conflict customer');

    const rOtherAssoc = await canApproveCustomer(sql, associateBActor, 105);
    assert(rOtherAssoc.allowed === false, 'Unrelated Associate B DENIED for role-conflict customer', rOtherAssoc.reason);

    const rAdmin = await canApproveCustomer(sql, adminActor, 105);
    assert(rAdmin.allowed === true, 'Admin ALLOWED for role-conflict customer');
  }

  console.log('\n--- TEST GROUP 6: Self-Approval Prevention ---');
  {
    // Customer tries to approve themselves
    const rSelf = await canApproveCustomer(sql, { user_id: 102, member_id: 'MMR-CUS-00102' }, 102);
    assert(rSelf.allowed === false && rSelf.reason.includes('Self-approval'), 'Self-approval strictly DENIED', rSelf.reason);
  }

  console.log('\n--- TEST GROUP 7: Inactive / Suspended Fallback ---');
  {
    // C6: sponsored by inactive Associate (30)
    const rInactiveAssoc = await canApproveCustomer(sql, inactiveAssocActor, 106);
    assert(rInactiveAssoc.allowed === false, 'Inactive Associate DENIED, falls back up chain', rInactiveAssoc.reason);

    const rAdminFallback1 = await canApproveCustomer(sql, adminActor, 106);
    assert(rAdminFallback1.allowed === true, 'Admin ALLOWED on fallback from inactive Associate');

    // C7: sponsored by inactive TM (31), whose leader is Associate A (10)
    const rInactiveTM = await canApproveCustomer(sql, inactiveTMActor, 107);
    assert(rInactiveTM.allowed === false, 'Inactive TM DENIED for own customer', rInactiveTM.reason);

    const rLeaderFallback = await canApproveCustomer(sql, associateAActor, 107);
    assert(rLeaderFallback.allowed === true, 'Associate Leader ALLOWED on fallback from inactive TM', rLeaderFallback.reason || JSON.stringify(rLeaderFallback));

    const rAdminFallback2 = await canApproveCustomer(sql, adminActor, 107);
    assert(rAdminFallback2.allowed === true, 'Admin ALLOWED on fallback from inactive TM');

    // Case 3: Inactive Team Member whose Associate Leader is ALSO inactive
    const rDoubleInactiveTM = await canApproveCustomer(sql, inactiveTMUnderInactiveAssocActor, 108);
    assert(rDoubleInactiveTM.allowed === false, 'Inactive TM (with inactive leader) DENIED for own customer', rDoubleInactiveTM.reason);

    const rDoubleInactiveLeader = await canApproveCustomer(sql, inactiveAssocActor, 108);
    assert(rDoubleInactiveLeader.allowed === false, 'Inactive Associate Leader DENIED for downline customer', rDoubleInactiveLeader.reason);

    const rAdminFallback3 = await canApproveCustomer(sql, adminActor, 108);
    assert(rAdminFallback3.allowed === true, 'Admin ALLOWED on fallback when both TM and Associate Leader are inactive');
  }

  console.log('\n--- TEST GROUP 8: Approver Identity from JWT (Anti-Spoofing) ---');
  {
    const result = await canApproveCustomer(sql, associateAActor, 102);
    assert(result.approver.userId === 10, 'Approver user_id matches JWT actor user_id (10)');
    assert(result.approver.memberId === 'MMR-ASC-0010', 'Approver member_id matches JWT actor member_id');
    assert(result.approver.fullName === 'Amit Associate', 'Approver fullName matches DB record for JWT actor');
    assert(result.actorRole === 'Associate', 'Approver role matches Associate');
  }

  console.log('\n--- TEST GROUP 9: Feature Flag Disabled Behavior ---');
  {
    process.env.ENABLE_SPONSOR_CUSTOMER_APPROVAL = 'false';
    const rAssocFlagOff = await canApproveCustomer(sql, associateAActor, 102);
    assert(rAssocFlagOff.allowed === false, 'Associate DENIED when feature flag is OFF', rAssocFlagOff.reason);

    const rTMFlagOff = await canApproveCustomer(sql, tm1Actor, 103);
    assert(rTMFlagOff.allowed === false, 'Team Member DENIED when feature flag is OFF', rTMFlagOff.reason);

    const rAdminFlagOff = await canApproveCustomer(sql, adminActor, 102);
    assert(rAdminFlagOff.allowed === true, 'Admin still ALLOWED when feature flag is OFF');
    process.env.ENABLE_SPONSOR_CUSTOMER_APPROVAL = 'true';
  }

  console.log('\n--- TEST GROUP 10: Rejection & Re-approval Flow ---');
  {
    // Simulate rejection of C2 by Associate A
    await pglite.query(`
      UPDATE customer_enrollment_submissions
      SET application_status = 'Rejected', reject_reason = 'Aadhar card photo blurry', rejected_by_user_id = 10, rejected_at = NOW()
      WHERE user_id = 102;
    `);

    // Anyone in the authorized chain (Associate A or Admin) can re-approve
    const rReapproveAssoc = await canApproveCustomer(sql, associateAActor, 102, 'enrollment');
    assert(rReapproveAssoc.allowed === true, 'Sponsoring Associate ALLOWED to re-approve previously rejected customer');

    const rReapproveAdmin = await canApproveCustomer(sql, adminActor, 102, 'enrollment');
    assert(rReapproveAdmin.allowed === true, 'Admin ALLOWED to re-approve previously rejected customer');

    const rReapproveOther = await canApproveCustomer(sql, associateBActor, 102, 'enrollment');
    assert(rReapproveOther.allowed === false, 'Unrelated Associate DENIED from re-approving rejected customer');
  }

  console.log('\n--- TEST GROUP 11: Out-of-Scope Customer ID Enforcement (HTTP 403 Matrix) ---');
  {
    // TM1 tries to approve Associate A's direct customer (out of scope)
    const rTMDirectAssoc = await canApproveCustomer(sql, tm1Actor, 102);
    assert(rTMDirectAssoc.allowed === false, 'Out-of-scope: Team Member DENIED for Associate direct customer');

    // TM2 tries to approve TM1's customer (out of scope cross-team)
    const rTMCross = await canApproveCustomer(sql, tm2Actor, 103);
    assert(rTMCross.allowed === false, 'Out-of-scope: Cross-Team Member DENIED');

    // Associate B tries to approve TM1's customer (out of scope cross-line)
    const rAssocCross = await canApproveCustomer(sql, associateBActor, 103);
    assert(rAssocCross.allowed === false, 'Out-of-scope: Cross-Associate DENIED for other TM customer');

    // Non-existent customer ID
    const rNonExistent = await canApproveCustomer(sql, associateAActor, 99999);
    assert(rNonExistent.allowed === false, 'Out-of-scope: Non-existent customer returns DENIED');
  }

  console.log('\n--- TEST GROUP 12: Staff Role Blanket Approval Prevention (Point 3) ---');
  {
    // Staff roles (financemanager, supportstaff) must NOT have blanket approval power for customers outside their sponsor chain
    const rFinanceOnAssoc = await canApproveCustomer(sql, financeStaffActor, 102);
    assert(rFinanceOnAssoc.allowed === false, 'Staff role (FinanceManager) DENIED blanket approval for Associate customer', rFinanceOnAssoc.reason);

    const rSupportOnTM = await canApproveCustomer(sql, supportStaffActor, 103);
    assert(rSupportOnTM.allowed === false, 'Staff role (SupportStaff) DENIED blanket approval for Team Member customer', rSupportOnTM.reason);

    // In contrast, full Admin / SuperAdmin has blanket approval power
    const rAdminOnAssoc = await canApproveCustomer(sql, adminActor, 102);
    assert(rAdminOnAssoc.allowed === true, 'Admin (SuperAdmin) ALLOWED blanket approval for Associate customer');

    const rAdminOnTM = await canApproveCustomer(sql, adminActor, 103);
    assert(rAdminOnTM.allowed === true, 'Admin (SuperAdmin) ALLOWED blanket approval for Team Member customer');
  }

  console.log('\n================================================================');
  console.log(`  RESULTS: ${passCount} PASSED, ${failCount} FAILED`);
  console.log('================================================================\n');

  if (failCount > 0) {
    process.exit(1);
  }
}

runTestSuite().catch(err => {
  console.error('Test Suite encountered error:', err);
  process.exit(1);
});
