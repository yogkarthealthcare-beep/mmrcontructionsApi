import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import jwt from 'jsonwebtoken';
import {
  ensureCustomerApprovalSchema,
  hasCustomerApprovalAuditColumns,
  resetSchemaCheckCache,
  isSponsorApprovalFeatureEnabled
} from './services/customerApprovalAuthority.service.js';
import customerEnrollmentRouter, { setDatabaseClient as setEnrollmentDb } from './routes/customer-enrollment.routes.js';
import bookingWorkflowRouter, { setDatabaseClient as setBookingDb } from './routes/booking-workflow.routes.js';

const JWT_SECRET = 'test_secret_for_http_routes_12345';
const JWT_ADMIN_SECRET = 'test_admin_secret_for_http_routes_12345';
process.env.JWT_SECRET = JWT_SECRET;
process.env.JWT_ADMIN_SECRET = JWT_ADMIN_SECRET;
process.env.ENABLE_SPONSOR_CUSTOMER_APPROVAL = 'true';

async function runHttpTestSuite() {
  console.log('================================================================');
  console.log('  MMR CONSTRUCTIONS: HTTP-LEVEL ROUTE TEST SUITE (PHASE 1B/1C)');
  console.log('  Engine: Real Express HTTP Server + In-Memory PostgreSQL (PGlite)');
  console.log('================================================================\n');

  const pglite = new PGlite();

  // 1. Create schema (including migration 20261020000000 columns)
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
      is_verified BOOLEAN DEFAULT false,
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
      email_1 VARCHAR(150),
      application_status VARCHAR(50) DEFAULT 'Pending',
      payment_status VARCHAR(50) DEFAULT 'Pending',
      verified_by VARCHAR(150),
      is_final_submitted BOOLEAN DEFAULT TRUE,
      form_date DATE DEFAULT CURRENT_DATE,
      approved_by_user_id INTEGER,
      approved_by_member_id VARCHAR(50),
      approved_by_name VARCHAR(150),
      approved_by_role VARCHAR(50),
      approved_at TIMESTAMPTZ,
      rejected_by_user_id INTEGER,
      reject_reason TEXT,
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
      verified_by VARCHAR(150),
      verified_by_admin_id INTEGER,
      rejection_note TEXT,
      admin_remarks TEXT,
      reupload_requested BOOLEAN DEFAULT FALSE,
      verified_by_user_id INTEGER,
      verifier_member_id VARCHAR(50),
      verifier_name VARCHAR(150),
      verifier_role VARCHAR(50),
      verified_at TIMESTAMPTZ,
      rejected_by_user_id INTEGER,
      reject_reason TEXT,
      rejected_at TIMESTAMPTZ,
      uploaded_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS user_kyc_profiles (
      id SERIAL PRIMARY KEY,
      user_id INTEGER UNIQUE NOT NULL,
      status VARCHAR(30) DEFAULT 'Submitted',
      admin_remarks TEXT,
      reviewed_by_admin_id INTEGER,
      reviewed_at TIMESTAMPTZ,
      reviewed_by_user_id INTEGER,
      reviewer_member_id VARCHAR(50),
      reviewer_name VARCHAR(150),
      reviewer_role VARCHAR(50),
      rejected_by_user_id INTEGER,
      reject_reason TEXT,
      rejected_at TIMESTAMPTZ,
      submitted_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id SERIAL PRIMARY KEY,
      actor_type VARCHAR(50),
      actor_id INTEGER,
      actor_name VARCHAR(150),
      module VARCHAR(50),
      action VARCHAR(50),
      target_id VARCHAR(50),
      details JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Wrap PGlite to match postgres.js template tag interface with fragment support
  const sql = (strings, ...values) => {
    if (!strings || (strings.length === 1 && strings[0] === '')) {
      const empty = Promise.resolve([]);
      empty.__fragment = true;
      empty.sql = '';
      empty.values = [];
      return empty;
    }

    let queryText = '';
    const params = [];

    const process = (strs, vals) => {
      for (let i = 0; i < strs.length; i++) {
        queryText += strs[i];
        if (i < vals.length) {
          const v = vals[i];
          if (v && v.__fragment !== undefined) {
            queryText += v.sql;
            params.push(...v.values);
          } else {
            params.push(v);
            queryText += `$${params.length}`;
          }
        }
      }
    };

    process(strings, values);

    // Re-index params correctly if nested fragments were expanded
    let paramCounter = 1;
    const finalSql = queryText.replace(/\$(\d+)/g, () => `$${paramCounter++}`);

    const promise = pglite.query(finalSql, params).then(res => res.rows);
    promise.__fragment = true;
    promise.sql = finalSql;
    promise.values = params;
    return promise;
  };

  await ensureCustomerApprovalSchema(sql);

  // Set active database on routers
  setEnrollmentDb(sql);
  setBookingDb(sql);

  // 2. Seed Test Users & Entities
  await pglite.exec(`
    -- User 1: Admin (MMR00001, Suraj Kumar Verma)
    INSERT INTO users (user_id, member_id, user_type, full_name, mobile_no, role, account_status)
    VALUES (1, 'MMR00001', 'Admin', 'Suraj Kumar Verma', '9999999999', 'SuperAdmin', 'Active');

    -- User 10: Associate A (MMR00010)
    INSERT INTO users (user_id, member_id, user_type, full_name, mobile_no, role, account_status)
    VALUES (10, 'MMR00010', 'Associate', 'Associate A', '9888888810', 'Associate', 'Active');

    -- User 20: Associate B (MMR00020)
    INSERT INTO users (user_id, member_id, user_type, full_name, mobile_no, role, account_status)
    VALUES (20, 'MMR00020', 'Associate', 'Associate B', '9888888820', 'Associate', 'Active');

    -- User 30: Team Member TM1 under Associate A (MMR00030)
    INSERT INTO users (user_id, member_id, user_type, full_name, mobile_no, role, sponsor_user_id, referred_by_user_id, account_status)
    VALUES (30, 'MMR00030', 'Team Member', 'Team Member TM1', '9888888830', 'Team Member', 10, 10, 'Active');

    INSERT INTO team_members (id, team_member_uid, associate_id, associate_name, user_id, slot_number, full_name, mobile_no, status)
    VALUES (30, 'MMR00030', 10, 'Associate A', 30, 1, 'Team Member TM1', '9888888830', 'approved');

    -- User 40: Team Member TM2 under Associate B (MMR00040)
    INSERT INTO users (user_id, member_id, user_type, full_name, mobile_no, role, sponsor_user_id, referred_by_user_id, account_status)
    VALUES (40, 'MMR00040', 'Team Member', 'Team Member TM2', '9888888840', 'Team Member', 20, 20, 'Active');

    INSERT INTO team_members (id, team_member_uid, associate_id, associate_name, user_id, slot_number, full_name, mobile_no, status)
    VALUES (40, 'MMR00040', 20, 'Associate B', 40, 1, 'Team Member TM2', '9888888840', 'approved');

    -- User 50: Role-Conflict User (users.user_type='Associate', but in team_members under Associate A)
    INSERT INTO users (user_id, member_id, user_type, full_name, mobile_no, role, sponsor_user_id, account_status)
    VALUES (50, 'MMR00050', 'Associate', 'Conflict User C50', '9888888850', 'Associate', 10, 'Active');

    INSERT INTO team_members (id, team_member_uid, associate_id, associate_name, user_id, slot_number, full_name, mobile_no, status)
    VALUES (50, 'MMR00050', 10, 'Associate A', 50, 2, 'Conflict User C50', '9888888850', 'approved');

    -- Customer 101: Admin Direct Customer (C1)
    INSERT INTO users (user_id, member_id, user_type, full_name, mobile_no, sponsor_user_id, referred_by_user_id, account_status)
    VALUES (101, 'CUST00101', 'Customer', 'Customer C1 (Admin)', '9111111101', 1, 1, 'Pending');

    -- Customer 102: Associate A Direct Customer (C2)
    INSERT INTO users (user_id, member_id, user_type, full_name, mobile_no, sponsor_user_id, referred_by_user_id, account_status)
    VALUES (102, 'CUST00102', 'Customer', 'Customer C2 (Assoc A)', '9111111102', 10, 10, 'Pending');

    -- Customer 103: TM1 Customer (under Associate A) (C3)
    INSERT INTO users (user_id, member_id, user_type, full_name, mobile_no, sponsor_user_id, referred_by_user_id, account_status)
    VALUES (103, 'CUST00103', 'Customer', 'Customer C3 (TM1)', '9111111103', 30, 30, 'Pending');

    -- Customer 104: TM2 Customer (under Associate B) (C4)
    INSERT INTO users (user_id, member_id, user_type, full_name, mobile_no, sponsor_user_id, referred_by_user_id, account_status)
    VALUES (104, 'CUST00104', 'Customer', 'Customer C4 (TM2)', '9111111104', 40, 40, 'Pending');

    -- Seed Enrollment Submissions
    INSERT INTO customer_enrollment_submissions (id, user_id, application_no, applicant_name, mobile_1, application_status)
    VALUES 
      ('11111111-1111-1111-1111-111111111101', 101, 'APP-101', 'Customer C1 (Admin)', '9111111101', 'Pending'),
      ('11111111-1111-1111-1111-111111111102', 102, 'APP-102', 'Customer C2 (Assoc A)', '9111111102', 'Pending'),
      ('11111111-1111-1111-1111-111111111103', 103, 'APP-103', 'Customer C3 (TM1)', '9111111103', 'Pending'),
      ('11111111-1111-1111-1111-111111111104', 104, 'APP-104', 'Customer C4 (TM2)', '9111111104', 'Pending');

    -- Seed Documents
    INSERT INTO user_documents (document_id, user_id, document_type, file_path, review_status, is_verified)
    VALUES
      (1021, 102, 'Aadhaar Front', 'uploads/c2_aadhaar.jpg', 'Submitted', FALSE),
      (1031, 103, 'PAN Card', 'uploads/c3_pan.jpg', 'Submitted', FALSE);

    -- Seed KYC Profiles
    INSERT INTO user_kyc_profiles (id, user_id, status)
    VALUES
      (101, 101, 'Submitted'),
      (102, 102, 'Submitted'),
      (103, 103, 'Submitted'),
      (104, 104, 'Submitted');

    -- Synchronize sequences with max seeded values
    SELECT setval('users_user_id_seq', (SELECT MAX(user_id) FROM users));
    SELECT setval('user_kyc_profiles_id_seq', (SELECT MAX(id) FROM user_kyc_profiles));
    SELECT setval('user_documents_document_id_seq', (SELECT MAX(document_id) FROM user_documents));
    SELECT setval('team_members_id_seq', (SELECT MAX(id) FROM team_members));
  `);

  // 3. Generate JWT Tokens
  const tokens = {
    admin: jwt.sign({ admin_id: 1, role: 'SuperAdmin', member_id: 'MMR00001', full_name: 'Suraj Kumar Verma' }, JWT_ADMIN_SECRET, { expiresIn: '1h' }),
    financeStaff: jwt.sign({ admin_id: 50, user_id: 50, role: 'FinanceManager', member_id: 'MMR-STF-0050', full_name: 'Farhan Finance' }, JWT_ADMIN_SECRET, { expiresIn: '1h' }),
    assocA: jwt.sign({ user_id: 10, role: 'Associate', user_type: 'Associate', member_id: 'MMR00010', full_name: 'Associate A' }, JWT_SECRET, { expiresIn: '1h' }),
    assocB: jwt.sign({ user_id: 20, role: 'Associate', user_type: 'Associate', member_id: 'MMR00020', full_name: 'Associate B' }, JWT_SECRET, { expiresIn: '1h' }),
    tm1: jwt.sign({ user_id: 30, role: 'Team Member', user_type: 'Team Member', member_id: 'MMR00030', full_name: 'Team Member TM1' }, JWT_SECRET, { expiresIn: '1h' }),
    tm2: jwt.sign({ user_id: 40, role: 'Team Member', user_type: 'Team Member', member_id: 'MMR00040', full_name: 'Team Member TM2' }, JWT_SECRET, { expiresIn: '1h' })
  };

  // 4. Create Express App & Mount Real Routes
  const app = express();
  app.use(express.json());

  // Mount Customer Enrollment Router
  app.use('/api', customerEnrollmentRouter);

  // Mount Booking Workflow Router (contains PATCH /admin/kyc/:userId)
  app.use('/api', bookingWorkflowRouter);

  // Mount Assisted Customer Creation Route (matching server.js:8825)
  app.post(["/api/associate/customers", "/api/team-member/customers"], async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ success: false, message: 'Token required' });
    try {
      const decoded = jwt.verify(authHeader.split(' ')[1], JWT_SECRET);
      const { full_name, mobile_no, email } = req.body || {};
      if (!full_name || !mobile_no) return res.status(400).json({ success: false, message: "Required" });
      const cleanMobile = String(mobile_no).replace(/\D/g, "");
      const cleanEmail = email || `${cleanMobile}@mmr.com`;
      const isApprovalOn = isSponsorApprovalFeatureEnabled();
      const initialAccountStatus = isApprovalOn ? 'Pending' : 'Active';
      const initialKycStatus = isApprovalOn ? 'Submitted' : 'Approved';
      const kycRemarks = isApprovalOn ? 'Pending sponsor/admin verification' : 'Auto-approved on party enrollment';

      const [created] = await sql`
        INSERT INTO users (member_id, user_type, full_name, mobile_no, email, sponsor_user_id, referred_by_user_id, account_status)
        VALUES ('CUST-' || ${cleanMobile}, 'Customer', ${full_name}, ${cleanMobile}, ${cleanEmail}, ${decoded.user_id}, ${decoded.user_id}, ${initialAccountStatus})
        RETURNING user_id, member_id, account_status
      `;

      if (isApprovalOn) {
        await sql`
          INSERT INTO user_kyc_profiles (user_id, status, submitted_at, admin_remarks)
          VALUES (${created.user_id}, ${initialKycStatus}, NOW(), ${kycRemarks})
        `;
      } else {
        await sql`
          INSERT INTO user_kyc_profiles (user_id, status, submitted_at, reviewed_at, admin_remarks)
          VALUES (${created.user_id}, 'Approved', NOW(), NOW(), ${kycRemarks})
        `;
      }
      return res.json({ success: true, user: created });
    } catch (e) {
      console.error('[assisted signup error]:', e);
      return res.status(400).json({ success: false, message: e.message });
    }
  });

  // Mount Admin User Approval Route (from server.js)
  app.post('/api/admin/users/:id/approve', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ success: false, message: 'Admin token required' });
    try {
      const decoded = jwt.verify(authHeader.split(' ')[1], JWT_ADMIN_SECRET);
      const uid = Number(req.params.id);
      const adminId = decoded.admin_id || 1;
      const adminMemberId = decoded.member_id || 'MMR00001';
      const adminName = decoded.full_name || 'Admin';
      const adminRole = 'Admin';

      await sql`
        UPDATE users SET account_status = 'Active' WHERE user_id = ${uid}
      `;

      const hasAuditCols = await hasCustomerApprovalAuditColumns(sql);
      if (hasAuditCols) {
        await sql`
          UPDATE customer_enrollment_submissions 
          SET application_status = 'Approved', approved_by_user_id = ${adminId}, approved_by_member_id = ${adminMemberId},
              approved_by_name = ${adminName}, approved_by_role = ${adminRole}, approved_at = NOW(), verified_by = ${adminName}
          WHERE user_id = ${uid}
        `;
        await sql`
          UPDATE user_documents
          SET review_status = 'Approved', is_verified = TRUE, verified_by_user_id = ${adminId}, verifier_member_id = ${adminMemberId},
              verifier_name = ${adminName}, verifier_role = ${adminRole}, verified_at = NOW()
          WHERE user_id = ${uid}
        `;
        await sql`
          UPDATE user_kyc_profiles
          SET status = 'Approved', reviewed_by_user_id = ${adminId}, reviewer_member_id = ${adminMemberId},
              reviewer_name = ${adminName}, reviewer_role = ${adminRole}, reviewed_at = NOW()
          WHERE user_id = ${uid}
        `;
      } else {
        await sql`
          UPDATE customer_enrollment_submissions 
          SET application_status = 'Approved', verified_by = ${adminName}
          WHERE user_id = ${uid}
        `;
        await sql`
          UPDATE user_documents
          SET review_status = 'Approved', is_verified = TRUE, verified_by = ${adminName}
          WHERE user_id = ${uid}
        `;
        await sql`
          UPDATE user_kyc_profiles
          SET status = 'Approved', reviewed_at = NOW()
          WHERE user_id = ${uid}
        `;
      }

      return res.json({ success: true, message: 'User and all artifacts approved successfully' });
    } catch (e) {
      return res.status(401).json({ success: false, message: 'Invalid admin token' });
    }
  });

  // Start HTTP Server on dynamic port
  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  let passed = 0;
  let failed = 0;

  function assert(condition, testName) {
    if (condition) {
      console.log(`  [PASS] ${testName}`);
      passed++;
    } else {
      console.error(`  [FAIL] ${testName}`);
      failed++;
    }
  }

  try {
    // ════════════════════════════════════════════════════════════════
    // TEST GROUP 1: GET /api/portal/my-customers-for-approval
    // ════════════════════════════════════════════════════════════════
    console.log('--- TEST GROUP 1: GET /api/portal/my-customers-for-approval (HTTP 200 & Scoping) ---');
    
    // TM1 request
    const tm1Res = await fetch(`${baseUrl}/api/portal/my-customers-for-approval`, {
      headers: { Authorization: `Bearer ${tokens.tm1}` }
    });
    const tm1Data = await tm1Res.json();
    assert(tm1Res.status === 200, 'TM1 GET /portal/my-customers-for-approval returns HTTP 200');
    assert(tm1Data.data.some(c => c.user_id === 103), 'TM1 sees their own customer C3 (103)');
    assert(!tm1Data.data.some(c => c.user_id === 102), 'TM1 does NOT see Associate direct customer C2 (102)');
    assert(!tm1Data.data.some(c => c.user_id === 104), 'TM1 does NOT see Cross-TM customer C4 (104)');

    // Associate A request (sees own direct C2 AND downline TM1 customer C3)
    const assocARes = await fetch(`${baseUrl}/api/portal/my-customers-for-approval`, {
      headers: { Authorization: `Bearer ${tokens.assocA}` }
    });
    const assocAData = await assocARes.json();
    assert(assocARes.status === 200, 'Associate A GET /portal/my-customers-for-approval returns HTTP 200');
    assert(assocAData.data.some(c => c.user_id === 102 && c.relationship === 'DIRECT'), 'Associate A sees direct customer C2 with relationship=DIRECT');
    assert(assocAData.data.some(c => c.user_id === 103 && c.relationship === 'TEAM_MEMBER'), 'Associate A sees downline TM1 customer C3 with relationship=TEAM_MEMBER');
    assert(!assocAData.data.some(c => c.user_id === 104), 'Associate A does NOT see Associate B customer C4');

    // Admin request (sees all customers)
    const adminRes = await fetch(`${baseUrl}/api/portal/my-customers-for-approval`, {
      headers: { Authorization: `Bearer ${tokens.admin}` }
    });
    const adminData = await adminRes.json();
    assert(adminRes.status === 200, 'Admin GET /portal/my-customers-for-approval returns HTTP 200');
    assert(adminData.data.length >= 4, 'Admin sees all scoped customer records');

    // ════════════════════════════════════════════════════════════════
    // TEST GROUP 2: POST /api/portal/customers/:customerId/enrollment/approve
    // ════════════════════════════════════════════════════════════════
    console.log('\n--- TEST GROUP 2: POST /portal/customers/:customerId/enrollment/approve ---');

    // Sponsoring Associate A approves C2 (Allowed -> 200)
    const appC2Res = await fetch(`${baseUrl}/api/portal/customers/102/enrollment/approve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.assocA}`, 'Content-Type': 'application/json' }
    });
    assert(appC2Res.status === 200, 'Sponsoring Associate A approves C2 enrollment -> HTTP 200');
    
    // Verify DB audit record populated from JWT
    const [c2Sub] = await sql`SELECT approved_by_user_id, approved_by_name, approved_by_role, application_status FROM customer_enrollment_submissions WHERE user_id = 102`;
    assert(c2Sub.application_status === 'Approved', 'C2 application_status set to Approved');
    assert(c2Sub.approved_by_user_id === 10, 'C2 approved_by_user_id matches JWT user_id (10)');
    assert(c2Sub.approved_by_role === 'Associate', 'C2 approved_by_role is Associate');

    // Cross-Associate B attempts to approve C2 (Denied -> 403)
    const crossAssocRes = await fetch(`${baseUrl}/api/portal/customers/102/enrollment/approve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.assocB}`, 'Content-Type': 'application/json' }
    });
    assert(crossAssocRes.status === 403, 'Cross-Associate B denied on C2 -> HTTP 403');

    // TM1 attempts to approve Associate direct customer C2 (Denied -> 403)
    const tm1OnC2Res = await fetch(`${baseUrl}/api/portal/customers/102/enrollment/approve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.tm1}`, 'Content-Type': 'application/json' }
    });
    assert(tm1OnC2Res.status === 403, 'TM1 denied on Associate direct customer C2 -> HTTP 403');

    // ════════════════════════════════════════════════════════════════
    // TEST GROUP 3: POST /api/portal/customers/:customerId/enrollment/reject
    // ════════════════════════════════════════════════════════════════
    console.log('\n--- TEST GROUP 3: POST /portal/customers/:customerId/enrollment/reject ---');

    // Missing rejection reason -> HTTP 400
    const noReasonRes = await fetch(`${baseUrl}/api/portal/customers/103/enrollment/reject`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.tm1}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    assert(noReasonRes.status === 400, 'Missing rejection reason returns HTTP 400 Bad Request');

    // Sponsoring TM1 rejects C3 with reason -> HTTP 200
    const rejC3Res = await fetch(`${baseUrl}/api/portal/customers/103/enrollment/reject`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.tm1}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ rejectReason: 'Incomplete permanent address details' })
    });
    assert(rejC3Res.status === 200, 'Sponsoring TM1 rejects C3 with valid reason -> HTTP 200');

    const [c3Sub] = await sql`SELECT application_status, reject_reason, rejected_by_user_id FROM customer_enrollment_submissions WHERE user_id = 103`;
    assert(c3Sub.application_status === 'Rejected', 'C3 application_status set to Rejected');
    assert(c3Sub.reject_reason === 'Incomplete permanent address details', 'C3 reject_reason recorded');
    assert(c3Sub.rejected_by_user_id === 30, 'C3 rejected_by_user_id matches TM1 (30)');

    // Cross-TM2 attempts to reject C3 -> HTTP 403
    const crossTmRej = await fetch(`${baseUrl}/api/portal/customers/103/enrollment/reject`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.tm2}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ rejectReason: 'Unauthorized rejection' })
    });
    assert(crossTmRej.status === 403, 'Cross-TM2 denied rejection on C3 -> HTTP 403');

    // ════════════════════════════════════════════════════════════════
    // TEST GROUP 4: POST /api/portal/customers/:customerId/documents/:docId/verify
    // ════════════════════════════════════════════════════════════════
    console.log('\n--- TEST GROUP 4: POST /portal/customers/:customerId/documents/:docId/verify ---');

    // Associate A verifies C2 Aadhaar Front (doc 1021) -> HTTP 200
    const verDocRes = await fetch(`${baseUrl}/api/portal/customers/102/documents/1021/verify`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.assocA}`, 'Content-Type': 'application/json' }
    });
    assert(verDocRes.status === 200, 'Associate A verifies C2 document 1021 -> HTTP 200');

    const [doc1021] = await sql`SELECT review_status, is_verified, verified_by_user_id, verifier_role FROM user_documents WHERE document_id = 1021`;
    assert(doc1021.is_verified === true && doc1021.review_status === 'Approved', 'Doc 1021 marked is_verified=true and review_status=Approved');
    assert(doc1021.verified_by_user_id === 10, 'Doc 1021 verified_by_user_id matches Associate A (10)');

    // Cross-Associate B denied on C2 doc -> HTTP 403
    const crossDocVer = await fetch(`${baseUrl}/api/portal/customers/102/documents/1021/verify`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.assocB}`, 'Content-Type': 'application/json' }
    });
    assert(crossDocVer.status === 403, 'Cross-Associate B denied verifying C2 doc -> HTTP 403');

    // ════════════════════════════════════════════════════════════════
    // TEST GROUP 5: POST /api/portal/customers/:customerId/documents/:docId/reject
    // ════════════════════════════════════════════════════════════════
    console.log('\n--- TEST GROUP 5: POST /portal/customers/:customerId/documents/:docId/reject ---');

    // TM1 rejects C3 PAN card (doc 1031) with reason -> HTTP 200
    const rejDocRes = await fetch(`${baseUrl}/api/portal/customers/103/documents/1031/reject`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.tm1}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ rejectReason: 'Blurry PAN image, numbers not readable' })
    });
    assert(rejDocRes.status === 200, 'TM1 rejects C3 document 1031 -> HTTP 200');

    const [doc1031] = await sql`SELECT review_status, reject_reason, rejected_by_user_id FROM user_documents WHERE document_id = 1031`;
    assert(doc1031.review_status === 'Rejected', 'Doc 1031 set to Rejected');
    assert(doc1031.reject_reason === 'Blurry PAN image, numbers not readable', 'Doc 1031 reject_reason recorded');

    // ════════════════════════════════════════════════════════════════
    // TEST GROUP 6: POST /api/portal/customers/:customerId/kyc/verify
    // ════════════════════════════════════════════════════════════════
    console.log('\n--- TEST GROUP 6: POST /portal/customers/:customerId/kyc/verify ---');

    // Associate A verifies C2 KYC profile -> HTTP 200
    const verKycRes = await fetch(`${baseUrl}/api/portal/customers/102/kyc/verify`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.assocA}`, 'Content-Type': 'application/json' }
    });
    assert(verKycRes.status === 200, 'Associate A verifies C2 KYC -> HTTP 200');

    const [kyc102] = await sql`SELECT status, reviewed_by_user_id, reviewer_role FROM user_kyc_profiles WHERE user_id = 102`;
    assert(kyc102.status === 'Approved', 'C2 KYC profile set to Approved');
    assert(kyc102.reviewed_by_user_id === 10, 'C2 KYC reviewed_by_user_id matches Associate A (10)');

    // ════════════════════════════════════════════════════════════════
    // TEST GROUP 7: POST /api/portal/customers/:customerId/kyc/reject
    // ════════════════════════════════════════════════════════════════
    console.log('\n--- TEST GROUP 7: POST /portal/customers/:customerId/kyc/reject ---');

    // Associate Leader of TM1 (Associate A) rejects C3 KYC profile with reason -> HTTP 200
    const rejKycRes = await fetch(`${baseUrl}/api/portal/customers/103/kyc/reject`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.assocA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ rejectReason: 'Address mismatch on Aadhaar' })
    });
    assert(rejKycRes.status === 200, 'Associate Leader (Associate A) rejects TM1 customer C3 KYC -> HTTP 200');

    const [kyc103] = await sql`SELECT status, reject_reason, rejected_by_user_id FROM user_kyc_profiles WHERE user_id = 103`;
    assert(kyc103.status === 'Rejected', 'C3 KYC profile set to Rejected');
    assert(kyc103.reject_reason === 'Address mismatch on Aadhaar', 'C3 KYC reject_reason recorded');

    // ════════════════════════════════════════════════════════════════
    // TEST GROUP 8: Anti-Spoofing over HTTP (verifiedBy in body ignored)
    // ════════════════════════════════════════════════════════════════
    console.log('\n--- TEST GROUP 8: Anti-Spoofing over HTTP ---');

    // Re-approve C3 by Associate Leader with spoofed verifiedBy in body
    const spoofRes = await fetch(`${baseUrl}/api/portal/customers/103/enrollment/approve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.assocA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ verifiedBy: 'Spoofed Fake Admin 9999' })
    });
    assert(spoofRes.status === 200, 'Associate Leader re-approval succeeds -> HTTP 200');

    const [c3Audit] = await sql`SELECT approved_by_user_id, approved_by_name, approved_by_role, verified_by FROM customer_enrollment_submissions WHERE user_id = 103`;
    assert(c3Audit.approved_by_user_id === 10, 'DB stores JWT user_id (10), NOT spoofed body');
    assert(c3Audit.approved_by_name === 'Associate A', 'DB stores JWT actor name (Associate A)');
    assert(c3Audit.verified_by !== 'Spoofed Fake Admin 9999', 'Legacy verified_by does NOT accept spoofed body');

    // ════════════════════════════════════════════════════════════════
    // TEST GROUP 9: Out-of-Scope Customer ID Enforcement (HTTP 403 Matrix)
    // ════════════════════════════════════════════════════════════════
    console.log('\n--- TEST GROUP 9: Out-of-Scope Customer ID Enforcement (HTTP 403 Matrix) ---');

    // Non-existent customer ID
    const notFoundRes = await fetch(`${baseUrl}/api/portal/customers/999999/enrollment/approve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.assocA}`, 'Content-Type': 'application/json' }
    });
    assert(notFoundRes.status === 403, 'Non-existent customer returns HTTP 403 Forbidden');

    // TM1 attempting to approve Admin-sponsored customer C1 (101)
    const tm1OnAdminCust = await fetch(`${baseUrl}/api/portal/customers/101/enrollment/approve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.tm1}`, 'Content-Type': 'application/json' }
    });
    assert(tm1OnAdminCust.status === 403, 'TM1 denied on Admin-sponsored customer C1 -> HTTP 403');

    // Associate A attempting to approve Admin-sponsored customer C1 (101)
    const assocOnAdminCust = await fetch(`${baseUrl}/api/portal/customers/101/enrollment/approve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.assocA}`, 'Content-Type': 'application/json' }
    });
    assert(assocOnAdminCust.status === 403, 'Associate A denied on Admin-sponsored customer C1 -> HTTP 403');

    // Admin CAN approve Admin-sponsored customer C1 (101)
    const adminOnAdminCust = await fetch(`${baseUrl}/api/portal/customers/101/enrollment/approve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.admin}`, 'Content-Type': 'application/json' }
    });
    assert(adminOnAdminCust.status === 200, 'Admin ALLOWED on Admin-sponsored customer C1 -> HTTP 200');

    // ════════════════════════════════════════════════════════════════
    // TEST GROUP 10: Feature Flag OFF Behavior (Gap 5)
    // ════════════════════════════════════════════════════════════════
    console.log('\n--- TEST GROUP 10: Feature Flag OFF Behavior ---');

    // Toggle flag to false
    process.env.ENABLE_SPONSOR_CUSTOMER_APPROVAL = 'false';

    // Associate A attempts approval while flag is false -> HTTP 403
    const flagOffAssocRes = await fetch(`${baseUrl}/api/portal/customers/102/enrollment/approve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.assocA}`, 'Content-Type': 'application/json' }
    });
    const flagOffData = await flagOffAssocRes.json();
    assert(flagOffAssocRes.status === 403, 'When flag is OFF: Associate denied -> HTTP 403');
    assert(flagOffData.message.includes('disabled'), 'When flag is OFF: message mentions disabled policy');

    // TM1 attempts approval while flag is false -> HTTP 403
    const flagOffTmRes = await fetch(`${baseUrl}/api/portal/customers/103/enrollment/approve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.tm1}`, 'Content-Type': 'application/json' }
    });
    assert(flagOffTmRes.status === 403, 'When flag is OFF: Team Member denied -> HTTP 403');

    // Admin CAN STILL approve while flag is false -> HTTP 200
    const flagOffAdminRes = await fetch(`${baseUrl}/api/portal/customers/104/enrollment/approve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.admin}`, 'Content-Type': 'application/json' }
    });
    assert(flagOffAdminRes.status === 200, 'When flag is OFF: Admin STILL ALLOWED -> HTTP 200');

    // Restore flag for remaining tests
    process.env.ENABLE_SPONSOR_CUSTOMER_APPROVAL = 'true';

    // ════════════════════════════════════════════════════════════════
    // TEST GROUP 11: Legacy Admin Endpoints Integration & JWT Audit
    // ════════════════════════════════════════════════════════════════
    console.log('\n--- TEST GROUP 11: Legacy Admin Endpoints Still Work & Store JWT Audit ---');

    // 1. PATCH /api/admin/customer-enrollments/:id/status
    const adminPatchRes = await fetch(`${baseUrl}/api/admin/customer-enrollments/11111111-1111-1111-1111-111111111104/status`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokens.admin}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'Approved', verifiedBy: 'Spoofed String' })
    });
    assert(adminPatchRes.status === 200, 'PATCH /api/admin/customer-enrollments/:id/status returns HTTP 200');

    const [c4Sub] = await sql`SELECT approved_by_user_id, approved_by_name, approved_by_role, application_status FROM customer_enrollment_submissions WHERE id = '11111111-1111-1111-1111-111111111104'`;
    assert(c4Sub.application_status === 'Approved', 'C4 application_status is Approved');
    assert(c4Sub.approved_by_user_id === 1, 'C4 approved_by_user_id stores Admin ID (1) from JWT');
    assert(c4Sub.approved_by_role === 'Admin', 'C4 approved_by_role is Admin');

    // 2. POST /api/admin/users/:id/approve
    const adminUserApproveRes = await fetch(`${baseUrl}/api/admin/users/104/approve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.admin}`, 'Content-Type': 'application/json' }
    });
    assert(adminUserApproveRes.status === 200, 'POST /api/admin/users/:id/approve returns HTTP 200');

    const [u104] = await sql`SELECT account_status FROM users WHERE user_id = 104`;
    assert(u104.account_status === 'Active', 'User 104 account_status set to Active');

    // 3. PATCH /api/admin/kyc/:userId
    const adminKycPatchRes = await fetch(`${baseUrl}/api/admin/kyc/104`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokens.admin}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'Approved', remarks: 'Verified by Head Office Admin' })
    });
    assert(adminKycPatchRes.status === 200, 'PATCH /api/admin/kyc/:userId returns HTTP 200');

    const [kyc104] = await sql`SELECT status, reviewed_by_user_id, reviewer_role FROM user_kyc_profiles WHERE user_id = 104`;
    assert(kyc104.status === 'Approved', 'KYC 104 status set to Approved');
    assert(kyc104.reviewed_by_user_id === 1, 'KYC 104 reviewed_by_user_id stores Admin ID (1) from JWT');

    // ════════════════════════════════════════════════════════════════
    // TEST GROUP 12: Assisted Signup Default Behavior Matrix (Point 2)
    // ════════════════════════════════════════════════════════════════
    console.log('\n--- TEST GROUP 12: Assisted Signup Flag Matrix (Point 2) ---');

    // Case 1: Flag OFF -> customer enters Active with KYC Approved (Exact Legacy Behavior)
    process.env.ENABLE_SPONSOR_CUSTOMER_APPROVAL = 'false';
    const legacySignupRes = await fetch(`${baseUrl}/api/associate/customers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.assocA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ full_name: 'Legacy Auto Customer', mobile_no: '9988776655' })
    });
    const legacySignupData = await legacySignupRes.json();
    assert(legacySignupRes.status === 200, 'Assisted signup with flag OFF returns HTTP 200');
    assert(legacySignupData.user.account_status === 'Active', 'Assisted signup with flag OFF sets account_status to Active');

    const [legacyKyc] = await sql`SELECT status FROM user_kyc_profiles WHERE user_id = ${legacySignupData.user.user_id}`;
    assert(legacyKyc.status === 'Approved', 'Assisted signup with flag OFF sets KYC status to Approved (No admin wait)');

    // Case 2: Flag ON -> customer enters Pending with KYC Submitted (Explicit Approval Required)
    process.env.ENABLE_SPONSOR_CUSTOMER_APPROVAL = 'true';
    const newSignupRes = await fetch(`${baseUrl}/api/associate/customers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.assocA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ full_name: 'New Approval Customer', mobile_no: '9988776656' })
    });
    const newSignupData = await newSignupRes.json();
    assert(newSignupRes.status === 200, 'Assisted signup with flag ON returns HTTP 200');
    assert(newSignupData.user.account_status === 'Pending', 'Assisted signup with flag ON sets account_status to Pending');

    const [newKyc] = await sql`SELECT status FROM user_kyc_profiles WHERE user_id = ${newSignupData.user.user_id}`;
    assert(newKyc.status === 'Submitted', 'Assisted signup with flag ON sets KYC status to Submitted');

    // ════════════════════════════════════════════════════════════════
    // TEST GROUP 13: Staff Role Blanket Approval Prevention on Portal (Point 3)
    // ════════════════════════════════════════════════════════════════
    console.log('\n--- TEST GROUP 13: Staff Role Blanket Approval Prevention (Point 3) ---');

    // Reset C2 enrollment submission back to Pending for test
    await sql`UPDATE customer_enrollment_submissions SET application_status = 'Pending', approved_by_user_id = NULL WHERE user_id = 102`;

    // Staff role (FinanceManager) tries to approve C2 enrollment -> HTTP 403 Forbidden
    const staffApproveRes = await fetch(`${baseUrl}/api/portal/customers/102/enrollment/approve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.financeStaff}`, 'Content-Type': 'application/json' }
    });
    const staffApproveData = await staffApproveRes.json();
    assert(staffApproveRes.status === 403, 'Staff role (FinanceManager) DENIED blanket approval on portal -> HTTP 403');
    assert(staffApproveData.message.includes('Only that Associate or Admin may approve'), '403 response explains only Associate or Admin may approve');

    // SuperAdmin actor approves C2 enrollment -> HTTP 200 OK
    const adminApproveRes = await fetch(`${baseUrl}/api/portal/customers/102/enrollment/approve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.admin}`, 'Content-Type': 'application/json' }
    });
    assert(adminApproveRes.status === 200, 'SuperAdmin ALLOWED blanket approval on portal -> HTTP 200');

    // ════════════════════════════════════════════════════════════════
    // TEST GROUP 14: Pre-Migration Schema Resilience & Fail-Safe (Point 5)
    // ════════════════════════════════════════════════════════════════
    console.log('\n--- TEST GROUP 14: Pre-Migration Schema Resilience (Point 5) ---');

    // Drop column approved_by_user_id to simulate pre-migration state
    await pglite.exec(`ALTER TABLE customer_enrollment_submissions DROP COLUMN approved_by_user_id`);
    resetSchemaCheckCache();

    // 1. Portal approval endpoint returns HTTP 503 Service Unavailable when migration is missing
    const preMigPortalRes = await fetch(`${baseUrl}/api/portal/customers/103/enrollment/approve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.admin}`, 'Content-Type': 'application/json' }
    });
    const preMigPortalData = await preMigPortalRes.json();
    assert(preMigPortalRes.status === 503, 'Missing migration columns: Portal approval returns HTTP 503 Service Unavailable');
    assert(preMigPortalData.message.includes('20261020000000_customer_approval_hierarchy'), '503 message identifies missing migration');

    // 2. Legacy admin status update PATCH does NOT crash and returns HTTP 200
    const preMigPatchRes = await fetch(`${baseUrl}/api/admin/customer-enrollments/11111111-1111-1111-1111-111111111104/status`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokens.admin}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'Approved' })
    });
    assert(preMigPatchRes.status === 200, 'Missing migration columns: Legacy admin PATCH status does NOT crash -> HTTP 200');

    // 3. Legacy admin user approve POST does NOT crash and returns HTTP 200
    const preMigUserApproveRes = await fetch(`${baseUrl}/api/admin/users/104/approve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.admin}`, 'Content-Type': 'application/json' }
    });
    assert(preMigUserApproveRes.status === 200, 'Missing migration columns: Legacy admin POST approve does NOT crash -> HTTP 200');

    // Restore column and cache
    await pglite.exec(`ALTER TABLE customer_enrollment_submissions ADD COLUMN approved_by_user_id INTEGER`);
    resetSchemaCheckCache();

  } finally {
    server.close();
  }

  console.log('\n================================================================');
  console.log(`  HTTP TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runHttpTestSuite().catch(e => {
  console.error('Test suite uncaught error:', e);
  process.exit(1);
});
