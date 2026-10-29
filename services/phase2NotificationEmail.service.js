import sql from '../db.js';
import { sendEmail } from '../emailService.js';
import {
  dispatchEnrollmentInAppNotification,
  dispatchInvestorDepositInAppNotification
} from './inAppNotification.service.js';
import {
  generateCustomerStatusEmailHtml,
  generateAssociateStatusEmailHtml,
  generateTeamMemberStatusEmailHtml,
  generateInvestorStatusEmailHtml,
  generateInvestorDepositRequestEmailHtml,
  generateInvestorDepositAdminEmailHtml,
  generateInvestorDepositStatusEmailHtml,
} from './phase2EmailTemplates.js';

// Cooldown map to prevent accidental duplicate transmissions (5-minute cooldown)
const sentCache = new Map();
const COOLDOWN_MS = 5 * 60 * 1000;

function cleanOldCache() {
  const now = Date.now();
  for (const [key, time] of sentCache.entries()) {
    if (now - time > COOLDOWN_MS) {
      sentCache.delete(key);
    }
  }
}

function getCacheKey(category, id, email) {
  return `${category}:${String(id).trim()}:${String(email || '').toLowerCase().trim()}`;
}

function isDuplicate(category, id, email) {
  cleanOldCache();
  const key = getCacheKey(category, id, email);
  const last = sentCache.get(key);
  if (last && Date.now() - last < COOLDOWN_MS) {
    return true;
  }
  return false;
}

function markSent(category, id, email) {
  sentCache.set(getCacheKey(category, id, email), Date.now());
}

function isValidEmail(email) {
  if (!email || typeof email !== 'string') return false;
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email.trim());
}

async function getAdminEmail() {
  if (process.env.ADMIN_NOTIFICATION_EMAIL && isValidEmail(process.env.ADMIN_NOTIFICATION_EMAIL)) {
    return process.env.ADMIN_NOTIFICATION_EMAIL.trim();
  }

  try {
    const rows = await sql`
      SELECT email FROM users 
      WHERE (is_admin = TRUE OR user_type IN ('Admin', 'SuperAdmin')) 
        AND email IS NOT NULL AND email <> ''
      ORDER BY user_id ASC LIMIT 1
    `;
    if (rows && rows.length > 0 && isValidEmail(rows[0].email)) {
      return rows[0].email.trim();
    }
  } catch (_) {}

  return process.env.SMTP_USER || 'admin@mmrconstructions.in';
}

// ─────────────────────────────────────────────────────────────
// 1. CUSTOMER ENROLLMENT STATUS NOTIFICATION
// ─────────────────────────────────────────────────────────────

export async function notifyCustomerStatus(customerId, details = {}, status = 'approved') {
  try {
    let email = (details.email || details.email1 || details.userEmail || '').trim().toLowerCase();
    let name = details.customerName || details.applicant_name || details.full_name || 'Customer';
    let appNo = details.applicationNo || details.application_no || `MMR-CEF-${customerId}`;
    let memberId = details.memberId || details.member_id || null;
    let reason = details.reason || details.reject_reason || null;
    let approvedBy = details.approvedBy || details.approved_by_name || 'Verification Desk';

    if ((!email || !name) && customerId) {
      try {
        const [u] = await sql`
          SELECT full_name, email, member_id FROM users WHERE user_id = ${Number(customerId)} LIMIT 1
        `;
        if (u) {
          if (!email && u.email) email = u.email.trim().toLowerCase();
          if (u.full_name) name = u.full_name;
          if (!memberId && u.member_id) memberId = u.member_id;
        }

        const [sub] = await sql`
          SELECT application_no, applicant_name, email_1 FROM customer_enrollment_submissions 
          WHERE user_id = ${Number(customerId)} ORDER BY created_at DESC LIMIT 1
        `;
        if (sub) {
          if (!email && sub.email_1) email = sub.email_1.trim().toLowerCase();
          if (sub.application_no) appNo = sub.application_no;
          if (sub.applicant_name) name = sub.applicant_name;
        }
      } catch (_) {}
    }

    if (!isValidEmail(email)) {
      console.warn(`[Phase2Email] Cannot send customer status to #${customerId}: No valid email found.`);
      return { success: false, skipped: true, reason: 'invalid_email' };
    }

    const normStatus = String(status).toLowerCase().trim();
    const isApproved = ['approved', 'completed'].includes(normStatus);

    if (isDuplicate(`customer_status_${normStatus}`, customerId, email)) {
      return { success: true, skipped: true, reason: 'duplicate_cooldown' };
    }

    const html = generateCustomerStatusEmailHtml({
      customerName: name,
      applicationNo: appNo,
      status: normStatus,
      reason,
      memberId,
      approvedBy,
      updatedAt: new Date(),
    });

    const subject = isApproved
      ? `MMR Constructions - Customer Enrollment Approved (${appNo})`
      : `MMR Constructions - Customer Enrollment Update (${appNo})`;

    await sendEmail({ to: email, subject, html });
    markSent(`customer_status_${normStatus}`, customerId, email);
    console.log(`[Phase2Email] Customer enrollment status (${normStatus}) email sent to ${email}`);

    return { success: true };
  } catch (err) {
    console.error('[Phase2Email] notifyCustomerStatus error:', err.message);
    return { success: false, error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────
// 2. ASSOCIATE PARTNER STATUS NOTIFICATION
// ─────────────────────────────────────────────────────────────

export async function notifyAssociateStatus(associateId, details = {}, status = 'approved') {
  try {
    let email = (details.email || details.userEmail || '').trim().toLowerCase();
    let name = details.associateName || details.full_name || 'Associate Partner';
    let memberId = details.memberId || details.member_id || null;
    let reason = details.reason || details.reject_reason || null;
    let approvedBy = details.approvedBy || 'Executive Committee';

    if ((!email || !name) && associateId) {
      try {
        const isNum = !isNaN(Number(associateId));
        const [a] = isNum
          ? await sql`SELECT * FROM associate_enrollment WHERE id = ${String(associateId)} OR user_id = ${Number(associateId)} LIMIT 1`
          : await sql`SELECT * FROM associate_enrollment WHERE id = ${String(associateId)} LIMIT 1`;

        if (a) {
          if (!email && a.email) email = a.email.trim().toLowerCase();
          if (a.full_name) name = a.full_name;
          if (a.member_id) memberId = a.member_id;
        }

        if (!email && a?.user_id) {
          const [u] = await sql`SELECT full_name, email, member_id FROM users WHERE user_id = ${a.user_id} LIMIT 1`;
          if (u?.email) email = u.email.trim().toLowerCase();
          if (!name && u?.full_name) name = u.full_name;
          if (!memberId && u?.member_id) memberId = u.member_id;
        }
      } catch (_) {}
    }

    if (!isValidEmail(email)) {
      console.warn(`[Phase2Email] Cannot send associate status to #${associateId}: No valid email found.`);
      return { success: false, skipped: true, reason: 'invalid_email' };
    }

    const normStatus = String(status).toLowerCase().trim();
    const isApproved = ['approved', 'active', 'completed'].includes(normStatus);

    if (isDuplicate(`associate_status_${normStatus}`, associateId, email)) {
      return { success: true, skipped: true, reason: 'duplicate_cooldown' };
    }

    const html = generateAssociateStatusEmailHtml({
      associateName: name,
      associateId: String(associateId),
      memberId,
      status: normStatus,
      reason,
      approvedBy,
      updatedAt: new Date(),
    });

    const subject = isApproved
      ? `MMR Constructions - Associate Partner Account Activated (${associateId})`
      : `MMR Constructions - Associate Partner Status Update (${associateId})`;

    await sendEmail({ to: email, subject, html });
    markSent(`associate_status_${normStatus}`, associateId, email);
    console.log(`[Phase2Email] Associate status (${normStatus}) email sent to ${email}`);

    return { success: true };
  } catch (err) {
    console.error('[Phase2Email] notifyAssociateStatus error:', err.message);
    return { success: false, error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────
// 3. TEAM MEMBER STATUS NOTIFICATION
// ─────────────────────────────────────────────────────────────

export async function notifyTeamMemberStatus(teamMemberId, details = {}, status = 'approved') {
  try {
    let email = (details.email_id || details.email || details.userEmail || '').trim().toLowerCase();
    let name = details.teamMemberName || details.full_name || 'Team Member';
    let memberUid = details.team_member_uid || details.teamMemberUid || String(teamMemberId);
    let slotNumber = details.slot_number || details.slotNumber || '—';
    let associateName = details.associateName || null;
    let reason = details.reason || details.rejection_reason || null;
    let approvedBy = details.authorizedSignatoryName || details.approvedBy || 'Associate / Admin';

    if ((!email || !name) && teamMemberId) {
      try {
        const isNum = !isNaN(Number(teamMemberId));
        const [tm] = isNum
          ? await sql`SELECT * FROM team_members WHERE id = ${Number(teamMemberId)} LIMIT 1`
          : await sql`SELECT * FROM team_members WHERE team_member_uid = ${String(teamMemberId)} LIMIT 1`;

        if (tm) {
          if (!email && tm.email_id) email = tm.email_id.trim().toLowerCase();
          if (tm.full_name) name = tm.full_name;
          if (tm.team_member_uid) memberUid = tm.team_member_uid;
          if (tm.slot_number) slotNumber = tm.slot_number;

          if (tm.associate_id) {
            const [asc] = await sql`SELECT full_name FROM users WHERE user_id = ${tm.associate_id} LIMIT 1`;
            if (asc?.full_name) associateName = asc.full_name;
          }
        }
      } catch (_) {}
    }

    if (!isValidEmail(email)) {
      console.warn(`[Phase2Email] Cannot send team member status to #${teamMemberId}: No valid email found.`);
      return { success: false, skipped: true, reason: 'invalid_email' };
    }

    const normStatus = String(status).toLowerCase().trim();
    const isApproved = ['approved', 'active'].includes(normStatus);

    if (isDuplicate(`team_member_status_${normStatus}`, teamMemberId, email)) {
      return { success: true, skipped: true, reason: 'duplicate_cooldown' };
    }

    const html = generateTeamMemberStatusEmailHtml({
      teamMemberName: name,
      teamMemberUid: memberUid,
      slotNumber,
      associateName,
      status: normStatus,
      reason,
      approvedBy,
      updatedAt: new Date(),
    });

    const subject = isApproved
      ? `MMR Constructions - Team Member Approved & Slot Confirmed (${memberUid})`
      : `MMR Constructions - Team Member Status Update (${memberUid})`;

    await sendEmail({ to: email, subject, html });
    markSent(`team_member_status_${normStatus}`, teamMemberId, email);
    console.log(`[Phase2Email] Team member status (${normStatus}) email sent to ${email}`);

    return { success: true };
  } catch (err) {
    console.error('[Phase2Email] notifyTeamMemberStatus error:', err.message);
    return { success: false, error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────
// 4. INVESTOR STATUS NOTIFICATION
// ─────────────────────────────────────────────────────────────

export async function notifyInvestorStatus(investorId, details = {}, status = 'approved') {
  try {
    let email = (details.email || details.userEmail || '').trim().toLowerCase();
    let name = details.investorName || details.full_name || 'Investor';
    let reason = details.reason || details.rejection_reason || null;
    let approvedBy = details.approvedBy || 'Investor Relations Board';

    if ((!email || !name) && investorId) {
      try {
        const [u] = await sql`
          SELECT full_name, email FROM investor_users WHERE id = ${Number(investorId)} LIMIT 1
        `;
        if (u) {
          if (!email && u.email) email = u.email.trim().toLowerCase();
          if (u.full_name) name = u.full_name;
        }
      } catch (_) {}
    }

    if (!isValidEmail(email)) {
      console.warn(`[Phase2Email] Cannot send investor status to #${investorId}: No valid email found.`);
      return { success: false, skipped: true, reason: 'invalid_email' };
    }

    const normStatus = String(status).toLowerCase().trim();
    const isApproved = ['approved', 'active', 'completed'].includes(normStatus);

    if (isDuplicate(`investor_status_${normStatus}`, investorId, email)) {
      return { success: true, skipped: true, reason: 'duplicate_cooldown' };
    }

    const html = generateInvestorStatusEmailHtml({
      investorName: name,
      investorId: String(investorId),
      status: normStatus,
      reason,
      approvedBy,
      updatedAt: new Date(),
    });

    const subject = isApproved
      ? `MMR Constructions - Investor Account Verified (#${investorId})`
      : `MMR Constructions - Investor Account Status Update (#${investorId})`;

    await sendEmail({ to: email, subject, html });
    markSent(`investor_status_${normStatus}`, investorId, email);
    console.log(`[Phase2Email] Investor status (${normStatus}) email sent to ${email}`);

    return { success: true };
  } catch (err) {
    console.error('[Phase2Email] notifyInvestorStatus error:', err.message);
    return { success: false, error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────
// 5. INVESTOR DEPOSIT REQUEST & STATUS NOTIFICATIONS
// ─────────────────────────────────────────────────────────────

export async function notifyInvestorDepositRequest(depositId, details = {}) {
  try {
    let email = (details.email || details.investor_email || '').trim().toLowerCase();
    let name = details.investorName || details.full_name || 'Investor';
    const investorId = details.investor_id || details.investorId || '—';
    const amount = Number(details.amount || 0);
    const paymentMethod = details.payment_method || details.paymentMethod || 'Bank Transfer';
    const transactionReference = details.transaction_reference || details.transactionReference || '—';
    const requestedAt = details.created_at || new Date();

    if ((!email || !name) && details.investor_id) {
      try {
        const [u] = await sql`
          SELECT full_name, email FROM investor_users WHERE id = ${Number(details.investor_id)} LIMIT 1
        `;
        if (u) {
          if (!email && u.email) email = u.email.trim().toLowerCase();
          if (u.full_name) name = u.full_name;
        }
      } catch (_) {}
    }

    // 1. Send User Acknowledgment
    if (isValidEmail(email)) {
      if (!isDuplicate('deposit_req_user', depositId, email)) {
        const userHtml = generateInvestorDepositRequestEmailHtml({
          investorName: name,
          depositId: String(depositId),
          amount,
          paymentMethod,
          transactionReference,
          requestedAt,
        });
        await sendEmail({
          to: email,
          subject: `MMR Constructions - Deposit Request Received (${depositId})`,
          html: userHtml,
        });
        markSent('deposit_req_user', depositId, email);
        console.log(`[Phase2Email] Investor deposit request acknowledgment sent to ${email}`);
      }
    }

    // 2. Send Admin Alert
    const adminEmail = await getAdminEmail();
    if (isValidEmail(adminEmail)) {
      if (!isDuplicate('deposit_req_admin', depositId, adminEmail)) {
        const adminHtml = generateInvestorDepositAdminEmailHtml({
          investorName: name,
          investorId: String(investorId),
          depositId: String(depositId),
          amount,
          paymentMethod,
          transactionReference,
          requestedAt,
        });
        await sendEmail({
          to: adminEmail,
          subject: `[Admin Alert] New Investor Deposit: ₹${amount.toLocaleString('en-IN')} - ${name}`,
          html: adminHtml,
        });
        markSent('deposit_req_admin', depositId, adminEmail);
        console.log(`[Phase2Email] Investor deposit admin alert sent to ${adminEmail}`);
      }
    }

    return { success: true };
  } catch (err) {
    console.error('[Phase2Email] notifyInvestorDepositRequest error:', err.message);
    return { success: false, error: err.message };
  }
}

export async function notifyInvestorDepositStatus(depositId, details = {}, status = 'approved') {
  try {
    let email = (details.email || details.investor_email || '').trim().toLowerCase();
    let name = details.investorName || details.full_name || 'Investor';
    const amount = Number(details.amount || 0);
    const adminRemarks = details.admin_remarks || details.adminRemarks || null;
    let updatedBalance = Number(details.updatedBalance || 0);

    if (details.investor_id) {
      try {
        const [u] = await sql`
          SELECT full_name, email, available_balance FROM investor_users WHERE id = ${Number(details.investor_id)} LIMIT 1
        `;
        if (u) {
          if (!email && u.email) email = u.email.trim().toLowerCase();
          if (u.full_name) name = u.full_name;
          if (!updatedBalance && u.available_balance) updatedBalance = Number(u.available_balance);
        }
      } catch (_) {}
    }

    if (!isValidEmail(email)) {
      console.warn(`[Phase2Email] Cannot send deposit status to #${depositId}: No valid email found.`);
      return { success: false, skipped: true, reason: 'invalid_email' };
    }

    const normStatus = String(status).toLowerCase().trim();
    const isApproved = normStatus === 'approved';

    if (isDuplicate(`deposit_status_${normStatus}`, depositId, email)) {
      return { success: true, skipped: true, reason: 'duplicate_cooldown' };
    }

    const html = generateInvestorDepositStatusEmailHtml({
      investorName: name,
      depositId: String(depositId),
      amount,
      status: normStatus,
      adminRemarks,
      updatedBalance,
      approvedAt: new Date(),
    });

    const subject = isApproved
      ? `MMR Constructions - Deposit Approved & Wallet Credited (${depositId})`
      : `MMR Constructions - Deposit Request Declined (${depositId})`;

    await sendEmail({ to: email, subject, html });
    markSent(`deposit_status_${normStatus}`, depositId, email);
    console.log(`[Phase2Email] Investor deposit status (${normStatus}) email sent to ${email}`);

    return { success: true };
  } catch (err) {
    console.error('[Phase2Email] notifyInvestorDepositStatus error:', err.message);
    return { success: false, error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────
// NON-BLOCKING ASYNC TRIGGER DELEGATORS
// ─────────────────────────────────────────────────────────────

export function triggerCustomerStatusEmailAsync(customerId, details = {}, status = 'approved') {
  setImmediate(async () => {
    try {
      await notifyCustomerStatus(customerId, details, status);
    } catch (err) {
      console.warn('[Phase2Email] Async customer status email error:', err.message);
    }
  });
}

export function triggerAssociateStatusEmailAsync(associateId, details = {}, status = 'approved') {
  setImmediate(async () => {
    try {
      await notifyAssociateStatus(associateId, details, status);
    } catch (err) {
      console.warn('[Phase2Email] Async associate status email error:', err.message);
    }
  });
}

export function triggerTeamMemberStatusEmailAsync(teamMemberId, details = {}, status = 'approved') {
  setImmediate(async () => {
    try {
      await notifyTeamMemberStatus(teamMemberId, details, status);
    } catch (err) {
      console.warn('[Phase2Email] Async team member status email error:', err.message);
    }
  });
}

export function triggerInvestorStatusEmailAsync(investorId, details = {}, status = 'approved') {
  setImmediate(async () => {
    try {
      await notifyInvestorStatus(investorId, details, status);
    } catch (err) {
      console.warn('[Phase2Email] Async investor status email error:', err.message);
    }
  });
}

export function triggerInvestorDepositRequestEmailAsync(depositId, details = {}) {
  setImmediate(async () => {
    try {
      await notifyInvestorDepositRequest(depositId, details);
    } catch (err) {
      console.warn('[Phase2Email] Async investor deposit request email error:', err.message);
    }
  });
}

export function triggerInvestorDepositStatusEmailAsync(depositId, details = {}, status = 'approved') {
  setImmediate(async () => {
    try {
      await notifyInvestorDepositStatus(depositId, details, status);
    } catch (err) {
      console.warn('[Phase2Email] Async investor deposit status email error:', err.message);
    }
  });
}

