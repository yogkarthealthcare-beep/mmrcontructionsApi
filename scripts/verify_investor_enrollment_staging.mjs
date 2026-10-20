/**
 * Staging Database Verification Script for Investor Enrollment INSERT and UPDATE
 *
 * Usage:
 *   node scripts/verify_investor_enrollment_staging.mjs
 *
 * NOTE: DO NOT run against production! Run only against a local or staging database.
 */

import sql, { getDatabaseConfig } from "../db.js";

async function runStagingVerification() {
  const dbConfig = getDatabaseConfig();
  console.log("================================================================================");
  console.log("   INVESTOR ENROLLMENT SQL RUNTIME VERIFICATION (STAGING ONLY)");
  console.log("================================================================================\n");
  console.log(`Target Database Host: ${dbConfig.host} | Database Name: ${dbConfig.database}`);

  if (process.env.CONFIRM_STAGING !== "true") {
    console.error("\n[SAFETY ABORT]: This script performs test writes and must NEVER run against production!");
    console.error("To execute on a verified staging database, set environment variable CONFIRM_STAGING=true:\n");
    console.error("  $env:CONFIRM_STAGING=\"true\"; node scripts/verify_investor_enrollment_staging.mjs\n");
    process.exit(1);
  }

  const testMobile = "9999900001";
  const testEmail = "staging_investor_test@example.com";
  let createdInvestorUserId = null;
  let createdEnrollmentId = null;

  try {
    // 1. Ensure columns exist (same as runtime ensure in routes/investor.routes.js)
    console.log("1. Checking and ensuring table columns in investor_enrollments...");
    await sql`ALTER TABLE investor_enrollments ADD COLUMN IF NOT EXISTS ifsc_code VARCHAR(20)`;
    await sql`ALTER TABLE investor_enrollments ADD COLUMN IF NOT EXISTS account_number VARCHAR(100)`;
    await sql`ALTER TABLE investor_enrollments ADD COLUMN IF NOT EXISTS corr_address TEXT`;
    await sql`ALTER TABLE investor_enrollments ADD COLUMN IF NOT EXISTS corr_city VARCHAR(100)`;
    await sql`ALTER TABLE investor_enrollments ADD COLUMN IF NOT EXISTS corr_state VARCHAR(100)`;
    await sql`ALTER TABLE investor_enrollments ADD COLUMN IF NOT EXISTS corr_pin_code VARCHAR(20)`;
    await sql`ALTER TABLE investor_enrollments ADD COLUMN IF NOT EXISTS religion VARCHAR(50)`;
    await sql`ALTER TABLE investor_enrollments ADD COLUMN IF NOT EXISTS is_final_submitted BOOLEAN DEFAULT FALSE`;
    console.log("   Columns verified.\n");

    // 2. Prepare test investor in investor_users
    console.log("2. Preparing test user in investor_users...");
    let [invUser] = await sql`
      SELECT id FROM investor_users 
      WHERE email = ${testEmail} OR mobile_number = ${testMobile} 
      LIMIT 1
    `;
    if (!invUser) {
      const [newInv] = await sql`
        INSERT INTO investor_users (
          member_id, full_name, mobile_number, email, password_hash, status, is_verified, enrollment_status, created_at, updated_at
        ) VALUES (
          'INV-STAGING-999', 'Staging Test Investor', ${testMobile}, ${testEmail}, '$2a$12$eXampleHashOnlyForStagingTestXXXXXXXXXX',
          'active', true, 'Pending', NOW(), NOW()
        ) RETURNING id
      `;
      createdInvestorUserId = newInv.id;
    } else {
      createdInvestorUserId = invUser.id;
    }
    console.log(`   Test Investor User ID: ${createdInvestorUserId}\n`);

    // Clean up any pre-existing test enrollments for this investor
    await sql`DELETE FROM investor_enrollments WHERE investor_id = ${createdInvestorUserId}`;

    // 3. Test Draft INSERT (First-Time Save: isFinalSubmit = false)
    console.log("3. Executing First-Time Draft INSERT (is_final_submitted = false)...");
    const draftBody = {
      investorId: "INV-STAGING-999",
      formNo: "FORM-TEST-001",
      formDate: "2026-10-20",
      branchCode: "BR01",
      branchName: "Head Office",
      projectName: "MMR Enclave",
      invFirstName: "StagingTest",
      invMiddleName: "Kumar",
      invSurname: "Investor",
      fhFirstName: "Father",
      fhMiddleName: "Prasad",
      fhSurname: "Investor",
      dob: "1990-01-01",
      age: 36,
      gender: "Male",
      occupation: "Business",
      occupationOther: null,
      address: "123 Test Street",
      city: "Lucknow",
      state: "Uttar Pradesh",
      pinCode: "226001",
      corrAddress: "123 Test Street",
      corrCity: "Lucknow",
      corrState: "Uttar Pradesh",
      corrPinCode: "226001",
      religion: "Hindu",
      mobile: testMobile,
      altTel: "9999900002",
      email: testEmail,
      pan: "ABCDE1234F",
      aadhar: "123456789012",
      amount: 100000,
      amountWords: "One Lakh Rupees Only",
      paymentMode: "Cheque",
      txnNo: "CHQ123456",
      txnDate: "2026-10-20",
      bankBranch: "SBI Main Branch",
      ifscCode: "SBIN0001234",
      accountNumber: "12345678901",
      nominees: [{ name: "Nominee Test", relation: "Spouse", age: 34 }],
      declDate: "2026-10-20",
      declPlace: "Lucknow",
      declSignatureName: "StagingTest Investor",
      firstApplicantName: "StagingTest Investor",
      jointApplicantName: null,
      is_final_submitted: false,
      isFinalSubmit: false
    };

    const isFinalSubmitDraft = false;
    const photoUrl = "/uploads/test_photo.png";
    const sigFirstUrl = "/uploads/test_sig1.png";
    const sigJointUrl = null;

    // EXACT 50-column statement from routes/investor.routes.js:
    const [inserted] = await sql`
      INSERT INTO investor_enrollments (
        investor_id, form_no, form_date, branch_code, branch_name, investor_enrollment_id, project_name,
        inv_first_name, inv_middle_name, inv_surname, fh_first_name, fh_middle_name, fh_surname,
        dob, age, gender, occupation, occupation_other, address, city, state, pin_code,
        corr_address, corr_city, corr_state, corr_pin_code, religion,
        mobile, alt_tel, email, pan, aadhar, amount, amount_words, payment_mode, txn_no, txn_date, bank_branch, ifsc_code, account_number,
        nominees, decl_date, decl_place, decl_signature_name, first_applicant_name, joint_applicant_name,
        photo_url, signature_first_url, signature_joint_url, is_final_submitted
      ) VALUES (
        ${createdInvestorUserId}, ${draftBody.formNo || null}, ${draftBody.formDate || null}, ${draftBody.branchCode || null}, ${draftBody.branchName || null}, ${draftBody.investorId || null}, ${draftBody.projectName || null},
        ${draftBody.invFirstName}, ${draftBody.invMiddleName || null}, ${draftBody.invSurname || null}, ${draftBody.fhFirstName || null}, ${draftBody.fhMiddleName || null}, ${draftBody.fhSurname || null},
        ${draftBody.dob || null}, ${draftBody.age || null}, ${draftBody.gender || null}, ${draftBody.occupation || null}, ${draftBody.occupationOther || null}, ${draftBody.address || null}, ${draftBody.city || null}, ${draftBody.state || null}, ${draftBody.pinCode || null},
        ${draftBody.corrAddress || draftBody.corr_address || null}, ${draftBody.corrCity || draftBody.corr_city || null}, ${draftBody.corrState || draftBody.corr_state || null}, ${draftBody.corrPinCode || draftBody.corr_pin_code || null}, ${draftBody.religion || null},
        ${draftBody.mobile}, ${draftBody.altTel || null}, ${draftBody.email || null}, ${draftBody.pan || null}, ${draftBody.aadhar || null}, ${draftBody.amount || null}, ${draftBody.amountWords || null}, ${draftBody.paymentMode || null}, ${draftBody.txnNo || null}, ${draftBody.txnDate || null}, ${draftBody.bankBranch || null}, ${draftBody.ifscCode || draftBody.ifsc_code || null}, ${draftBody.accountNumber || draftBody.account_number || null},
        ${draftBody.nominees ? JSON.stringify(draftBody.nominees) : null}, ${draftBody.declDate || null}, ${draftBody.declPlace || null}, ${draftBody.declSignatureName || null}, ${draftBody.firstApplicantName || null}, ${draftBody.jointApplicantName || null},
        ${photoUrl || null}, ${sigFirstUrl || null}, ${sigJointUrl || null}, ${isFinalSubmitDraft}
      ) RETURNING id, is_final_submitted
    `;

    createdEnrollmentId = inserted.id;
    console.log("   INSERT succeeded!");
    console.log("   Inserted Row:", {
      id: inserted.id,
      is_final_submitted: inserted.is_final_submitted
    });

    if (inserted.is_final_submitted !== false) throw new Error("Verification failed: draft is_final_submitted is not false");
    console.log("   [PASS] Draft INSERT verified correctly.\n");

    // 4. Test Final Submit UPDATE (isFinalSubmit = true)
    console.log("4. Executing Final Submit UPDATE (is_final_submitted = true)...");
    const isFinalSubmitTrue = true;

    // EXACT update statement from routes/investor.routes.js:
    await sql`
      UPDATE investor_enrollments SET
        form_no = COALESCE(${draftBody.formNo || null}, form_no),
        form_date = COALESCE(${draftBody.formDate || null}, form_date),
        branch_code = ${draftBody.branchCode || null},
        branch_name = ${draftBody.branchName || null},
        project_name = ${draftBody.projectName || null},
        inv_first_name = ${draftBody.invFirstName},
        inv_middle_name = ${draftBody.invMiddleName || null},
        inv_surname = ${draftBody.invSurname || null},
        fh_first_name = ${draftBody.fhFirstName || null},
        fh_middle_name = ${draftBody.fhMiddleName || null},
        fh_surname = ${draftBody.fhSurname || null},
        dob = ${draftBody.dob || null},
        age = ${draftBody.age || null},
        gender = ${draftBody.gender || null},
        occupation = ${draftBody.occupation || null},
        occupation_other = ${draftBody.occupationOther || null},
        address = ${draftBody.address || null},
        city = ${draftBody.city || null},
        state = ${draftBody.state || null},
        pin_code = ${draftBody.pinCode || null},
        corr_address = ${draftBody.corrAddress || null},
        corr_city = ${draftBody.corrCity || null},
        corr_state = ${draftBody.corrState || null},
        corr_pin_code = ${draftBody.corrPinCode || null},
        religion = ${draftBody.religion || null},
        mobile = ${draftBody.mobile},
        alt_tel = ${draftBody.altTel || null},
        email = ${draftBody.email || null},
        pan = ${draftBody.pan || null},
        aadhar = ${draftBody.aadhar || null},
        amount = ${draftBody.amount || null},
        amount_words = ${draftBody.amountWords || null},
        payment_mode = ${draftBody.paymentMode || null},
        txn_no = ${draftBody.txnNo || null},
        txn_date = ${draftBody.txnDate || null},
        bank_branch = ${draftBody.bankBranch || null},
        ifsc_code = ${draftBody.ifscCode || null},
        account_number = ${draftBody.accountNumber || null},
        nominees = ${JSON.stringify(draftBody.nominees)},
        decl_date = ${draftBody.declDate || null},
        decl_place = ${draftBody.declPlace || null},
        decl_signature_name = ${draftBody.declSignatureName || null},
        first_applicant_name = ${draftBody.firstApplicantName || null},
        joint_applicant_name = ${draftBody.jointApplicantName || null},
        photo_url = COALESCE(${photoUrl}, photo_url),
        signature_first_url = COALESCE(${sigFirstUrl}, signature_first_url),
        signature_joint_url = COALESCE(${sigJointUrl}, signature_joint_url),
        is_final_submitted = (is_final_submitted OR ${isFinalSubmitTrue}),
        updated_at = NOW()
      WHERE id = ${createdEnrollmentId}
    `;

    const [updatedRow] = await sql`
      SELECT id, is_final_submitted
      FROM investor_enrollments
      WHERE id = ${createdEnrollmentId}
    `;

    console.log("   UPDATE succeeded!");
    console.log("   Updated Row:", {
      id: updatedRow.id,
      is_final_submitted: updatedRow.is_final_submitted
    });

    if (updatedRow.is_final_submitted !== true) throw new Error("Verification failed: updated is_final_submitted is not true");
    console.log("   [PASS] Final Submit UPDATE verified correctly.\n");

    console.log("================================================================================");
    console.log("   ALL VERIFICATIONS PASSED SUCCESSFULLY!");
    console.log("================================================================================\n");

  } catch (err) {
    console.error("Verification Error:", err);
    process.exitCode = 1;
  } finally {
    // 5. Cleanup test data
    console.log("5. Cleaning up staging test records...");
    if (createdEnrollmentId) {
      await sql`DELETE FROM investor_enrollments WHERE id = ${createdEnrollmentId}`.catch(() => {});
    }
    if (createdInvestorUserId) {
      await sql`DELETE FROM investor_enrollments WHERE investor_id = ${createdInvestorUserId}`.catch(() => {});
      await sql`DELETE FROM investor_users WHERE id = ${createdInvestorUserId}`.catch(() => {});
    }
    console.log("   Cleanup completed.");
    await sql.end().catch(() => {});
  }
}

runStagingVerification();
