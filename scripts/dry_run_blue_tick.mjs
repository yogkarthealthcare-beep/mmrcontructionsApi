import sql from "../db.js";

async function runDryRun() {
  console.log("=== DRY-RUN VERIFICATION & ENROLLMENT AUDIT REPORT ===");
  console.log("Database Host:", process.env.DB_HOST || "configured host");
  console.log("Timestamp:", new Date().toISOString());
  console.log("Mode: READ-ONLY (Zero writes/modifications)\n");

  try {
    // 1. Audit Users Table (Associates, Customers, Team Members)
    const userRows = await sql`
      SELECT 
        u.user_id,
        u.member_id,
        u.user_type,
        u.full_name,
        u.account_status,
        u.enrollment_status AS current_user_enrollment_status,
        u.is_verified AS current_user_is_verified,
        -- Associate Enrollment info
        ae.id AS ae_id,
        ae.status AS ae_status,
        ae.is_final_submitted AS ae_is_final_submitted,
        -- Customer Enrollment info
        ces.id AS ces_id,
        ces.application_status AS ces_app_status,
        ces.is_final_submitted AS ces_is_final_submitted,
        -- Team Member info
        tm.id AS tm_id,
        tm.status AS tm_status
      FROM users u
      LEFT JOIN LATERAL (
        SELECT id, status, is_final_submitted
        FROM associate_enrollment
        WHERE user_id = u.user_id 
           OR member_id = u.member_id 
           OR id = u.member_id
        ORDER BY created_at DESC LIMIT 1
      ) ae ON true
      LEFT JOIN LATERAL (
        SELECT id, application_status, is_final_submitted
        FROM customer_enrollment_submissions
        WHERE user_id = u.user_id
        ORDER BY created_at DESC LIMIT 1
      ) ces ON true
      LEFT JOIN LATERAL (
        SELECT id, status
        FROM team_members
        WHERE user_id = u.user_id
        ORDER BY created_at DESC LIMIT 1
      ) tm ON true
      ORDER BY u.user_type, u.user_id ASC
    `;

    console.log(`Audited ${userRows.length} users from 'users' table:\n`);

    const summary = {
      Associate: { total: 0, current_verified: 0, proposed_verified: 0, no_enrollment_count: 0, pending_count: 0, approved_count: 0 },
      Customer: { total: 0, current_verified: 0, proposed_verified: 0, no_enrollment_count: 0, submitted_count: 0 },
      "Team Member": { total: 0, current_verified: 0, proposed_verified: 0, active_count: 0, inactive_count: 0 },
      Other: { total: 0, current_verified: 0, proposed_verified: 0 }
    };

    const details = [];

    for (const u of userRows) {
      const role = u.user_type || "Other";
      if (!summary[role]) summary[role] = { total: 0, current_verified: 0, proposed_verified: 0 };
      summary[role].total++;

      let proposed_badge = false;
      let proposed_enroll_status = u.current_user_enrollment_status || "0";
      let reason = "";

      if (role === "Associate") {
        const aeApproved = u.ae_id && String(u.ae_status || "").toLowerCase() === "approved";
        const aeFinal = u.ae_id && Boolean(u.ae_is_final_submitted);

        if (!u.ae_id) {
          summary.Associate.no_enrollment_count++;
          proposed_enroll_status = "0";
          proposed_badge = false;
          reason = "No Associate Enrollment record exists in associate_enrollment";
        } else if (aeApproved && aeFinal) {
          summary.Associate.approved_count++;
          proposed_enroll_status = "Completed";
          proposed_badge = true;
          reason = "Associate Enrollment form is final-submitted AND approved by Admin";
        } else if (aeApproved) {
          summary.Associate.approved_count++;
          proposed_enroll_status = "Completed";
          proposed_badge = true;
          reason = "Associate Enrollment form is approved by Admin";
        } else {
          summary.Associate.pending_count++;
          proposed_enroll_status = "Pending";
          proposed_badge = false;
          reason = `Enrollment submitted but status is '${u.ae_status}' (Admin approval pending)`;
        }
      } else if (role === "Customer") {
        const cesFinal = u.ces_id && Boolean(u.ces_is_final_submitted);
        if (!u.ces_id) {
          summary.Customer.no_enrollment_count++;
          proposed_enroll_status = "0";
          proposed_badge = false;
          reason = "No Customer Enrollment record exists in customer_enrollment_submissions";
        } else if (cesFinal) {
          summary.Customer.submitted_count++;
          proposed_enroll_status = "Completed";
          proposed_badge = true;
          reason = "Customer Enrollment form has been finally submitted (no admin approval required)";
        } else {
          proposed_enroll_status = "Pending";
          proposed_badge = false;
          reason = "Customer Enrollment form drafted/in-progress but not final-submitted";
        }
      } else if (role === "Team Member") {
        const tmActive = u.tm_id && ["approved", "active"].includes(String(u.tm_status || "").toLowerCase());
        if (tmActive) {
          summary["Team Member"].active_count++;
          proposed_enroll_status = "Completed";
          proposed_badge = true;
          reason = `Team Member record active in team_members with status='${u.tm_status}'`;
        } else {
          summary["Team Member"].inactive_count++;
          proposed_enroll_status = "0";
          proposed_badge = false;
          reason = u.tm_id ? `Team Member status is '${u.tm_status}' (not active/approved)` : "No team_members record found";
        }
      }

      if (u.current_user_is_verified) summary[role].current_verified++;
      if (proposed_badge) summary[role].proposed_verified++;

      const isChanged = (Boolean(u.current_user_is_verified) !== proposed_badge) ||
                        (String(u.current_user_enrollment_status || "") !== proposed_enroll_status && !u.current_user_enrollment_status);

      details.push({
        user_id: u.user_id,
        member_id: u.member_id,
        full_name: u.full_name,
        role,
        account_status: u.account_status,
        current_enroll_status: u.current_user_enrollment_status,
        proposed_enroll_status,
        current_is_verified: Boolean(u.current_user_is_verified),
        proposed_badge,
        badge_diff: Boolean(u.current_user_is_verified) === proposed_badge ? "NO CHANGE" : (proposed_badge ? "WILL SHOW" : "WILL HIDE (Fix False-Positive)"),
        reason
      });
    }

    console.log("=== USERS ROLE SUMMARY ===");
    console.table(summary);

    // 2. Audit Investor Users
    const investorRows = await sql`
      SELECT 
        iu.id,
        iu.member_id,
        iu.full_name,
        iu.email,
        iu.status,
        iu.is_verified AS current_investor_is_verified,
        iu.enrollment_status AS current_investor_enrollment_status,
        ie.id AS ie_id,
        ie.app_status AS ie_app_status,
        ie.is_final_submitted AS ie_is_final_submitted
      FROM investor_users iu
      LEFT JOIN LATERAL (
        SELECT id, app_status, is_final_submitted
        FROM investor_enrollments
        WHERE investor_id = iu.id
        ORDER BY created_at DESC LIMIT 1
      ) ie ON true
      WHERE iu.deleted_at IS NULL
      ORDER BY iu.id ASC
    `;

    console.log(`\nAudited ${investorRows.length} investors from 'investor_users' table:`);

    const invDetails = [];
    let invCurrentVerified = 0;
    let invProposedVerified = 0;

    for (const inv of investorRows) {
      if (inv.current_investor_is_verified) invCurrentVerified++;
      const isApproved = inv.ie_id && String(inv.ie_app_status || "").toLowerCase() === "approved" && Boolean(inv.ie_is_final_submitted);
      const proposed_badge = isApproved;
      if (proposed_badge) invProposedVerified++;

      invDetails.push({
        id: inv.id,
        member_id: inv.member_id,
        full_name: inv.full_name,
        email: inv.email,
        current_is_verified: Boolean(inv.current_investor_is_verified),
        has_enrollment: Boolean(inv.ie_id),
        ie_app_status: inv.ie_app_status || "NONE",
        ie_final_submitted: Boolean(inv.ie_is_final_submitted),
        proposed_badge,
        badge_diff: Boolean(inv.current_investor_is_verified) === proposed_badge ? "NO CHANGE" : "WILL HIDE (Fix False-Positive: Email OTP was masquerading as verified badge)"
      });
    }

    console.log(`Investors: Total=${investorRows.length}, Current is_verified=true: ${invCurrentVerified}, Proposed Badge: ${invProposedVerified}`);

    // Print detailed records where a change will occur
    const changedUsers = details.filter(d => d.badge_diff !== "NO CHANGE");
    console.log(`\n=== USERS WITH BADGE STATUS DIFFERENCE (${changedUsers.length} records) ===`);
    console.table(changedUsers.map(u => ({
      ID: u.user_id,
      Name: u.full_name,
      Role: u.role,
      "Current Badge": u.current_is_verified,
      "Proposed Badge": u.proposed_badge,
      Change: u.badge_diff,
      Reason: u.reason
    })));

    const changedInvestors = invDetails.filter(d => d.badge_diff !== "NO CHANGE");
    console.log(`\n=== INVESTORS WITH BADGE STATUS DIFFERENCE (${changedInvestors.length} records) ===`);
    console.table(changedInvestors.map(i => ({
      ID: i.id,
      Name: i.full_name,
      "Current Badge": i.current_is_verified,
      "Proposed Badge": i.proposed_badge,
      Change: i.badge_diff
    })));

    console.log("\n=== DRY RUN COMPLETED SUCCESSFULLY ===");
    await sql.end();
    process.exit(0);
  } catch (err) {
    console.error("Dry Run Failed:", err);
    await sql.end().catch(() => {});
    process.exit(1);
  }
}

runDryRun();
