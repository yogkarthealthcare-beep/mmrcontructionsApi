/**
 * MMR Construction & Developers Pvt. Ltd.
 * Shared Referral & Sponsor Code Resolver
 *
 * Single Source of Truth for resolving referral codes across all signup paths.
 * Rules:
 *  - Resolves invitation_code OR member_id OR associate_referral_links invite_code.
 *  - Case-insensitive trimming.
 *  - Strictly requires active Associate or Team Member accounts.
 *  - Rejects Customer accounts as referrers (400).
 *  - Supports empty code as DIRECT_SIGNUP.
 *  - Respects bookingApprovalConfig.REFERRAL_INVALID_CODE_MODE ('reject' vs 'silent_company_direct').
 */

import bookingApprovalConfig from '../config/bookingApproval.js';

export function normalizeReferralCode(code) {
  if (!code || typeof code !== 'string') return '';
  return code.replace(/\*/g, '').trim().toUpperCase();
}

/**
 * Resolves a referral/sponsor code against the database.
 * @param {object} sql - Postgres connection instance
 * @param {string} rawCode - Referral or sponsor code provided by user
 * @param {object} [options] - Options (e.g., allowDefaultFallback)
 * @returns {Promise<{valid: boolean, error?: string, status?: number, referrer?: object, source?: string, isEmpty?: boolean}>}
 */
export async function resolveReferralCode(sql, rawCode, options = {}) {
  const code = normalizeReferralCode(rawCode);
  const unpaddedTm = code.replace(/^MMR-TM-0*/i, 'MMR-TM-');
  const unpaddedAsc = code.replace(/^MMR-(ASC|A)-0*/i, 'MMR-ASC-');
  const unpaddedMmr = code.replace(/^MMR-0*/i, 'MMR');
  const isPureNumber = /^\d+$/.test(code);
  const numId = isPureNumber ? Number(code) : -1;

  // 1. Empty referral code -> Valid direct signup
  if (!code) {
    return {
      valid: true,
      isEmpty: true,
      referrer: null,
      userId: null,
      source: 'DIRECT_SIGNUP'
    };
  }

  // Ensure associate_referral_links table exists
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS associate_referral_links (
        id SERIAL PRIMARY KEY,
        associate_user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        invite_code VARCHAR(80) NOT NULL UNIQUE,
        referral_url TEXT,
        total_clicks INTEGER NOT NULL DEFAULT 0,
        total_registrations INTEGER NOT NULL DEFAULT 0,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
  } catch (_) {}

  // 2. Query users, associate links, and team members matching code
  let referrer = null;
  const [userReferrer] = await sql`
    SELECT u.user_id,
           COALESCE(NULLIF(TRIM(tm.full_name), ''), u.full_name) AS full_name,
           COALESCE(NULLIF(TRIM(tm.team_member_uid), ''), u.member_id) AS member_id,
           COALESCE(NULLIF(TRIM(u.invitation_code), ''), NULLIF(TRIM(tm.team_member_uid), ''), u.member_id) AS invitation_code,
           CASE WHEN tm.id IS NOT NULL THEN 'Team Member' ELSE u.user_type::text END AS user_type,
           COALESCE(u.account_status::text, tm.status::text, 'Active') AS account_status,
           u.email, u.mobile_no,
           tm.team_member_uid, tm.status AS tm_status,
           COALESCE(tm.associate_id, u.sponsor_user_id) AS associate_id,
           u.sponsor_user_id
    FROM users u
    LEFT JOIN associate_referral_links l
      ON l.associate_user_id = u.user_id AND l.is_active = TRUE
    LEFT JOIN team_members tm
      ON tm.user_id = u.user_id AND LOWER(COALESCE(tm.status::text, '')) IN ('active', 'approved')
    WHERE (
      UPPER(COALESCE(u.invitation_code, '')) = ${code}
      OR UPPER(COALESCE(u.member_id, '')) = ${code}
      OR UPPER(COALESCE(u.legacy_member_id, '')) = ${code}
      OR UPPER(COALESCE(tm.team_member_uid, '')) = ${code}
      OR UPPER(COALESCE(tm.team_member_uid, '')) = ${unpaddedTm}
      OR UPPER(regexp_replace(COALESCE(tm.team_member_uid, ''), '^MMR-TM-0*', 'MMR-TM-')) = ${unpaddedTm}
      OR UPPER(regexp_replace(COALESCE(u.member_id, ''), '^MMR-TM-0*', 'MMR-TM-')) = ${unpaddedTm}
      OR UPPER(regexp_replace(COALESCE(u.member_id, ''), '^MMR-(ASC|A)-0*', 'MMR-ASC-')) = ${unpaddedAsc}
      OR UPPER(regexp_replace(COALESCE(u.invitation_code, ''), '^MMR-(ASC|A)-0*', 'MMR-ASC-')) = ${unpaddedAsc}
      OR UPPER(regexp_replace(COALESCE(u.member_id, ''), '^MMR-(ASC|CUS|TM|[ACTM])-', 'MMR')) = ${code}
      OR UPPER(regexp_replace(COALESCE(tm.team_member_uid, ''), '^MMR-(ASC|CUS|TM|[ACTM])-', 'MMR')) = ${code}
      OR UPPER(regexp_replace(COALESCE(u.member_id, ''), '^MMR-[ACTM]-', 'MMR')) = ${code}
      OR UPPER(regexp_replace(COALESCE(u.member_id, ''), '^MMR-[AC]-', 'MMR')) = ${code}
      OR UPPER(COALESCE(l.invite_code, '')) = ${code}
      OR UPPER(COALESCE(regexp_replace(COALESCE(u.member_id, ''), '^MMR-0*', 'MMR'), '')) = ${unpaddedMmr}
      OR (${numId > 0} AND u.user_id = ${numId})
    )
    LIMIT 1`;

  referrer = userReferrer || null;

  // 2b. Direct team_members lookup if not resolved via users join
  if (!referrer) {
    const [tmDirect] = await sql`
      SELECT tm.id as tm_id, tm.user_id, tm.full_name, tm.team_member_uid,
             tm.status as tm_status, tm.email_id as email, tm.mobile_no,
             tm.associate_id
      FROM team_members tm
      WHERE LOWER(COALESCE(tm.status::text, 'approved')) IN ('active', 'approved')
        AND (
          UPPER(COALESCE(tm.team_member_uid, '')) = ${code}
          OR UPPER(COALESCE(tm.team_member_uid, '')) = ${unpaddedTm}
          OR UPPER(COALESCE(regexp_replace(COALESCE(tm.team_member_uid, ''), '^MMR-TM-0*', 'MMR-TM-'), '')) = ${unpaddedTm}
          OR UPPER(regexp_replace(COALESCE(tm.team_member_uid, ''), '^MMR-(ASC|CUS|TM|[ACTM])-', 'MMR')) = ${code}
          OR (${numId > 0} AND (tm.id = ${numId} OR tm.user_id = ${numId}))
        )
      LIMIT 1`.catch(() => []);

    if (tmDirect) {
      let uRow = null;
      if (tmDirect.user_id) {
        [uRow] = await sql`SELECT user_id, full_name, email, mobile_no, account_status, user_type FROM users WHERE user_id = ${tmDirect.user_id}`.catch(() => []);
      }
      referrer = {
        user_id: tmDirect.user_id || uRow?.user_id,
        full_name: tmDirect.full_name || uRow?.full_name || 'Team Member',
        member_id: tmDirect.team_member_uid,
        invitation_code: tmDirect.team_member_uid,
        user_type: 'Team Member',
        account_status: uRow?.account_status || tmDirect.tm_status || 'Active',
        email: tmDirect.email || uRow?.email,
        mobile_no: tmDirect.mobile_no || uRow?.mobile_no,
        team_member_uid: tmDirect.team_member_uid,
        associate_id: tmDirect.associate_id,
        sponsor_user_id: tmDirect.associate_id
      };
    }
  }

  // 3. Referrer found in database
  if (referrer) {
    const roleLower = String(referrer.user_type || '').toLowerCase();

    // Customer cannot refer
    if (roleLower === 'customer') {
      return {
        valid: false,
        error: 'Customers cannot refer. Only Associates and Team Members can refer.',
        status: 400,
        isCustomer: true
      };
    }

    // Must be active and either Associate or Team Member
    const isEligibleRole = ['associate', 'team member'].includes(roleLower) || Boolean(referrer.team_member_uid);
    const statusLower = String(referrer.account_status || referrer.tm_status || 'active').toLowerCase();
    const isActive = ['active', 'approved'].includes(statusLower);

    if (isEligibleRole && isActive) {
      const isTeamMember = Boolean(referrer.team_member_uid) || roleLower.includes('team member');
      const targetRole = options.userType || options.targetRole || null;
      if (isTeamMember && targetRole && String(targetRole).toLowerCase() !== 'customer') {
        return {
          valid: false,
          error: `Team Members can only refer Customers. This referral code cannot be used to register as ${targetRole}.`,
          status: 400,
          isRoleMismatch: true,
          referrer
        };
      }

      return {
        valid: true,
        referrer,
        userId: referrer.user_id,
        memberId: referrer.team_member_uid || referrer.member_id,
        fullName: referrer.full_name,
        invitationCode: referrer.team_member_uid || referrer.invitation_code || referrer.member_id,
        userType: referrer.team_member_uid ? 'Team Member' : (referrer.user_type || 'Associate'),
        associateId: referrer.associate_id || referrer.sponsor_user_id,
        source: 'REGISTRATION_CODE'
      };
    }

    // Found but inactive or ineligible
    const mode = String(bookingApprovalConfig.REFERRAL_INVALID_CODE_MODE || 'reject').toLowerCase();
    if (mode === 'reject') {
      return {
        valid: false,
        error: 'Referrer account is not active or eligible.',
        status: 400,
        isInactive: true
      };
    } else {
      // Fallback mode (silent_company_direct)
      return {
        valid: true,
        isFallbackDirect: true,
        referrer: null,
        userId: null,
        source: 'DIRECT_SIGNUP'
      };
    }
  }

  // 4. Fallback for default corporate sponsor if requested or configured
  const isDefaultCode = code === 'MMR0001' || code === 'MMR00001' || code === 'MMR3001' || code === 'MMR-ASC-0001' || code === 'MMR-ASC-00001';
  if ((options.allowDefaultFallback || isDefaultCode) && isDefaultCode) {
    const [defaultSponsor] = await sql`
      SELECT user_id, full_name, member_id, invitation_code, user_type, account_status
      FROM users
      WHERE user_id = 1 OR full_name ILIKE '%Suraj%'
      ORDER BY user_id ASC LIMIT 1`;
    if (defaultSponsor) {
      return {
        valid: true,
        referrer: defaultSponsor,
        userId: defaultSponsor.user_id,
        memberId: defaultSponsor.member_id || 'MMR-ASC-0001',
        fullName: defaultSponsor.full_name || 'Suraj Kumar Verma',
        invitationCode: defaultSponsor.invitation_code || 'MMR-ASC-0001',
        userType: defaultSponsor.user_type || 'Associate',
        source: 'REGISTRATION_CODE'
      };
    }
  }

  // 5. Code not found
  const invalidMode = String(bookingApprovalConfig.REFERRAL_INVALID_CODE_MODE || 'reject').toLowerCase();
  if (invalidMode === 'reject') {
    return {
      valid: false,
      error: 'Invalid referral code. Associate or Team Member not found.',
      status: 400
    };
  } else {
    // In silent_company_direct or direct mode, silently fall back to direct signup
    return {
      valid: true,
      isFallbackDirect: true,
      referrer: null,
      userId: null,
      source: 'DIRECT_SIGNUP'
    };
  }
}

export default {
  normalizeReferralCode,
  resolveReferralCode
};
