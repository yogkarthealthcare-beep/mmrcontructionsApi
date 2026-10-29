import { sendEmail } from '../emailService.js';
import sql from '../db.js';
import {
  generateCustomerEnrollmentEmailHtml,
  generateAssociateEnrollmentEmailHtml,
  generateInvestorEnrollmentEmailHtml,
  generateTeamMemberEnrollmentEmailHtml,
} from './enrollmentEmailTemplates.js';

/**
 * In-memory cooldown cache to prevent accidental duplicate confirmation emails.
 * Cooldown: 10 minutes per enrollmentType + identifier + email.
 */
const sentCache = new Map();
const COOLDOWN_MS = 10 * 60 * 1000;

function cleanOldCacheEntries() {
  const now = Date.now();
  for (const [key, timestamp] of sentCache.entries()) {
    if (now - timestamp > COOLDOWN_MS) {
      sentCache.delete(key);
    }
  }
}

function getCacheKey(type, id, email) {
  return `${String(type).toLowerCase()}:${String(id || 'no-id').trim()}:${String(email || '').toLowerCase().trim()}`;
}

function isDuplicateSend(type, id, email) {
  cleanOldCacheEntries();
  const key = getCacheKey(type, id, email);
  const lastSent = sentCache.get(key);
  if (lastSent && (Date.now() - lastSent < COOLDOWN_MS)) {
    return true;
  }
  return false;
}

function recordSentEmail(type, id, email) {
  const key = getCacheKey(type, id, email);
  sentCache.set(key, Date.now());
}

/**
 * Normalize enrollment type name
 */
function normalizeType(type = '') {
  const t = String(type).trim().toLowerCase().replace(/[-_]/g, ' ');
  if (t.includes('customer')) return 'Customer';
  if (t.includes('associate')) return 'Associate';
  if (t.includes('investor')) return 'Investor';
  if (t.includes('team')) return 'Team Member';
  return type;
}

/**
 * Validate email address format
 */
function isValidEmail(email) {
  if (!email || typeof email !== 'string') return false;
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email.trim());
}

/**
 * Helper to safely fetch Customer Enrollment data
 */
async function getCustomerData(submissionId, customData = {}) {
  let dbRecord = null;
  let dbNominees = [];

  if (submissionId) {
    try {
      const isNum = !isNaN(Number(submissionId));
      const rows = isNum
        ? await sql`SELECT * FROM customer_enrollment_submissions WHERE id = ${Number(submissionId)} LIMIT 1`
        : await sql`SELECT * FROM customer_enrollment_submissions WHERE application_no = ${String(submissionId)} LIMIT 1`;

      if (rows && rows.length > 0) {
        dbRecord = rows[0];
        try {
          dbNominees = await sql`
            SELECT nominee_name, relationship, date_of_birth, age, aadhar_no 
            FROM customer_nominees 
            WHERE submission_id = ${dbRecord.id}
          `;
        } catch (_) {
          dbNominees = [];
        }
      }
    } catch (e) {
      // Database might be unreachable or query failed; fallback gracefully to customData
      console.warn('[EnrollmentEmail] Could not query customer_enrollment_submissions from DB:', e.message);
    }
  }

  const merged = {
    ...(dbRecord || {}),
    ...customData,
    nominees: (customData.nominees && customData.nominees.length > 0)
      ? customData.nominees
      : (dbNominees.length > 0 ? dbNominees : (customData.nominees || []))
  };

  return merged;
}

/**
 * Helper to safely fetch Associate Enrollment data
 */
async function getAssociateData(associateId, customData = {}) {
  let dbRecord = null;
  let addresses = [];
  let bank = null;
  let nominee = null;
  let sponsor = null;

  if (associateId) {
    try {
      const isNum = !isNaN(Number(associateId));
      const rows = isNum
        ? await sql`SELECT * FROM associate_enrollment WHERE id = ${String(associateId)} OR user_id = ${Number(associateId)} LIMIT 1`
        : await sql`SELECT * FROM associate_enrollment WHERE id = ${String(associateId)} LIMIT 1`;

      if (rows && rows.length > 0) {
        dbRecord = rows[0];
        const ascId = dbRecord.id;

        try {
          addresses = await sql`SELECT * FROM associate_address WHERE associate_id = ${ascId}`;
        } catch (_) {}
        try {
          const [b] = await sql`SELECT * FROM associate_bank_details WHERE associate_id = ${ascId} LIMIT 1`;
          bank = b;
        } catch (_) {}
        try {
          const [n] = await sql`SELECT * FROM associate_nominee WHERE associate_id = ${ascId} LIMIT 1`;
          nominee = n;
        } catch (_) {}
        try {
          const [s] = await sql`SELECT * FROM associate_sponsor WHERE associate_id = ${ascId} LIMIT 1`;
          sponsor = s;
        } catch (_) {}
      }
    } catch (e) {
      console.warn('[EnrollmentEmail] Could not query associate_enrollment from DB:', e.message);
    }
  }

  const permAddr = addresses.find(a => a.address_type === 'permanent') || {};
  const localAddr = addresses.find(a => a.address_type === 'local') || {};

  const merged = {
    ...(dbRecord || {}),
    perm_address: permAddr.local_address || customData.permAddress || customData.perm_address,
    perm_city: permAddr.city || customData.permCity || customData.perm_city,
    perm_state: permAddr.state || customData.permState || customData.perm_state,
    perm_pin: permAddr.pin_code || customData.permPin || customData.perm_pin,
    perm_country: permAddr.country || customData.permCountry || 'India',

    local_address: localAddr.local_address || customData.localAddress || customData.local_address,
    local_city: localAddr.city || customData.localCity || customData.local_city,
    local_state: localAddr.state || customData.localState || customData.local_state,
    local_pin: localAddr.pin_code || customData.localPin || customData.local_pin,

    bank_name: bank?.bank_name || customData.bankName || customData.bank_name,
    account_holder_name: bank?.account_holder_name || customData.accHolder || customData.account_holder_name,
    account_no: bank?.account_no || customData.accNo || customData.account_no,
    ifsc_code: bank?.ifsc_code || customData.ifsc || customData.ifsc_code,
    micr_code: bank?.micr_code || customData.micr || customData.micr_code,
    branch_name: bank?.branch_name || customData.branchName || customData.branch_name,

    nominee_name: nominee?.nominee_name || customData.nomineeName || customData.nominee_name,
    nominee_dob: nominee?.dob || customData.nomineeDob || customData.nominee_dob,
    nominee_gender: nominee?.gender || customData.nomineeGender || customData.nominee_gender,
    nominee_relationship: nominee?.relationship || customData.nomineeRelationship || customData.nominee_relationship,
    nominee_pan_no: nominee?.pan_no || customData.nomineePanNo || customData.nominee_pan_no,
    nominee_aadhar_no: nominee?.aadhar_no || customData.nomineeAadharNo || customData.nominee_aadhar_no,
    nominee_address: nominee?.address || customData.nomineeAddress || customData.nominee_address,

    sponsor_name: sponsor?.sponsor_name || customData.sponsorName || customData.sponsor_name,
    sponsor_code: sponsor?.sponsor_code || customData.sponsorCode || customData.sponsor_code,
    sponsor_contact: sponsor?.sponsor_contact || customData.sponsorContact || customData.sponsor_contact,

    ...customData
  };

  return merged;
}

/**
 * Helper to safely fetch Investor Enrollment data
 */
async function getInvestorData(investorEnrollId, customData = {}) {
  let dbRecord = null;

  if (investorEnrollId) {
    try {
      const isNum = !isNaN(Number(investorEnrollId));
      const rows = isNum
        ? await sql`SELECT * FROM investor_enrollments WHERE id = ${Number(investorEnrollId)} LIMIT 1`
        : await sql`SELECT * FROM investor_enrollments WHERE investor_enrollment_id = ${String(investorEnrollId)} OR form_no = ${String(investorEnrollId)} LIMIT 1`;

      if (rows && rows.length > 0) {
        dbRecord = rows[0];
      }
    } catch (e) {
      console.warn('[EnrollmentEmail] Could not query investor_enrollments from DB:', e.message);
    }
  }

  const merged = {
    ...(dbRecord || {}),
    ...customData
  };

  return merged;
}

/**
 * Helper to safely fetch Team Member Enrollment data
 */
async function getTeamMemberData(teamMemberId, customData = {}) {
  let dbRecord = null;

  if (teamMemberId) {
    try {
      const isNum = !isNaN(Number(teamMemberId));
      const rows = isNum
        ? await sql`SELECT * FROM team_members WHERE id = ${Number(teamMemberId)} LIMIT 1`
        : await sql`SELECT * FROM team_members WHERE team_member_uid = ${String(teamMemberId)} LIMIT 1`;

      if (rows && rows.length > 0) {
        dbRecord = rows[0];
      }
    } catch (e) {
      console.warn('[EnrollmentEmail] Could not query team_members from DB:', e.message);
    }
  }

  const merged = {
    ...(dbRecord || {}),
    ...customData
  };

  return merged;
}

/**
 * Core function to build and send an Enrollment Confirmation Email
 *
 * @param {Object} options
 * @param {string} options.enrollmentType - 'Customer' | 'Associate' | 'Investor' | 'Team Member'
 * @param {string|number} [options.submissionId] - DB ID or application identifier
 * @param {string} [options.recipientEmail] - Target email address (if already known)
 * @param {boolean} [options.isFinalSubmit=true] - Whether submission is marked as final
 * @param {Object} [options.customData={}] - Form data already available in the caller
 * @param {boolean} [options.force=false] - Bypass duplicate cooldown check
 * @returns {Promise<Object>} Execution result { success, skipped, messageId, error }
 */
export async function sendEnrollmentConfirmationEmail({
  enrollmentType,
  submissionId,
  recipientEmail,
  isFinalSubmit = true,
  customData = {},
  force = false
}) {
  const normalizedType = normalizeType(enrollmentType);

  // 1. Guard against draft/partial submissions unless caller explicitly marked as final or forced
  if (isFinalSubmit === false) {
    console.log(`[EnrollmentEmail] Skipping confirmation email for ${normalizedType} #${submissionId}: Not a final submit.`);
    return { success: false, skipped: true, reason: 'not_final_submit' };
  }

  try {
    let data = {};
    let subject = '';
    let html = '';
    let targetEmail = (recipientEmail || '').trim();

    // 2. Fetch and aggregate data per enrollment type
    if (normalizedType === 'Customer') {
      data = await getCustomerData(submissionId, customData);
      if (!targetEmail) {
        targetEmail = data.email_1 || data.email1 || data.email || data.applicant_email || '';
      }
      const appNo = data.application_no || data.applicationNo || submissionId || 'Pending';
      subject = `MMR Constructions - Customer Enrollment Confirmation (${appNo})`;
      html = generateCustomerEnrollmentEmailHtml(data, {
        applicationNo: appNo,
        isFinalSubmit: true,
      });
    } else if (normalizedType === 'Associate') {
      data = await getAssociateData(submissionId, customData);
      if (!targetEmail) {
        targetEmail = data.email || data.contact_email || '';
      }
      const ascId = data.id || data.associateId || submissionId || 'Pending';
      subject = `MMR Constructions - Associate Partner Enrollment Confirmation (${ascId})`;
      html = generateAssociateEnrollmentEmailHtml(data, {
        associateId: ascId,
        isFinalSubmit: true,
      });
    } else if (normalizedType === 'Investor') {
      data = await getInvestorData(submissionId, customData);
      if (!targetEmail) {
        targetEmail = data.email || data.investor_email || '';
      }
      const invId = data.investor_enrollment_id || data.form_no || data.formNo || submissionId || 'Pending';
      subject = `MMR Constructions - Investor Enrollment Confirmation (${invId})`;
      html = generateInvestorEnrollmentEmailHtml(data, {
        investorEnrollmentId: invId,
        formNo: data.form_no || data.formNo,
        isFinalSubmit: true,
      });
    } else if (normalizedType === 'Team Member') {
      data = await getTeamMemberData(submissionId, customData);
      if (!targetEmail) {
        targetEmail = data.email_id || data.emailId || data.email || '';
      }
      const memberUid = data.team_member_uid || data.teamMemberUid || submissionId || 'Pending';
      const slotNum = data.slot_number || data.slotNumber || '—';
      subject = `MMR Constructions - Team Member Enrollment Confirmation (${memberUid})`;
      html = generateTeamMemberEnrollmentEmailHtml(data, {
        teamMemberUid: memberUid,
        slotNumber: slotNum,
        isFinalSubmit: true,
      });
    } else {
      console.warn(`[EnrollmentEmail] Unrecognized enrollment type: ${enrollmentType}`);
      return { success: false, skipped: true, reason: 'unknown_enrollment_type' };
    }

    targetEmail = (targetEmail || '').trim().toLowerCase();

    // 3. Validate recipient email
    if (!isValidEmail(targetEmail)) {
      console.warn(`[EnrollmentEmail] No valid recipient email found for ${normalizedType} #${submissionId}. (Found: "${targetEmail}")`);
      return { success: false, skipped: true, reason: 'invalid_email' };
    }

    // 4. Duplicate protection check (cooldown)
    const recordIdentifier = submissionId || data.application_no || data.id || data.team_member_uid || 'unknown';
    if (!force && isDuplicateSend(normalizedType, recordIdentifier, targetEmail)) {
      console.log(`[EnrollmentEmail] Cooldown active: Skipping duplicate email to ${targetEmail} for ${normalizedType} (${recordIdentifier})`);
      return { success: true, skipped: true, reason: 'duplicate_cooldown' };
    }

    // 5. Dispatch email via central emailService
    console.log(`[EnrollmentEmail] Dispatching ${normalizedType} confirmation email to ${targetEmail}...`);
    const emailResult = await sendEmail({
      to: targetEmail,
      subject,
      html,
    });

    recordSentEmail(normalizedType, recordIdentifier, targetEmail);
    console.log(`[EnrollmentEmail] Successfully sent ${normalizedType} enrollment confirmation to ${targetEmail}. MessageId: ${emailResult?.messageId}`);

    return {
      success: true,
      messageId: emailResult?.messageId,
      recipient: targetEmail,
      enrollmentType: normalizedType,
    };
  } catch (err) {
    // Non-blocking catch: Enrollment process MUST NEVER fail because of email transmission
    console.error(`[EnrollmentEmail] Error dispatching confirmation email for ${normalizedType}:`, err.message);
    return {
      success: false,
      error: err.message,
    };
  }
}

/**
 * Non-blocking wrapper for controllers and routes.
 * Schedules email dispatch immediately on the event loop without awaiting or throwing.
 *
 * @param {Object} options Same options as sendEnrollmentConfirmationEmail
 */
export function triggerEnrollmentEmailAsync(options) {
  setImmediate(async () => {
    try {
      await sendEnrollmentConfirmationEmail(options);
    } catch (err) {
      console.warn('[EnrollmentEmail] Async background delivery encountered error:', err.message);
    }
  });
}

