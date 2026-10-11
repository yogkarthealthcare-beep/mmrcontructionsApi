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

  // 2. Query users and associate links matching code
  const [referrer] = await sql`
    SELECT u.user_id, u.full_name, u.member_id, u.invitation_code, u.user_type, u.account_status, u.email, u.mobile_no
    FROM users u
    LEFT JOIN associate_referral_links l
      ON l.associate_user_id = u.user_id AND l.is_active = TRUE
    WHERE (
      UPPER(COALESCE(u.invitation_code, '')) = ${code}
      OR UPPER(COALESCE(u.member_id, '')) = ${code}
      OR UPPER(regexp_replace(COALESCE(u.member_id, ''), '^MMR-[ACTM]-', 'MMR')) = ${code}
      OR UPPER(regexp_replace(COALESCE(u.member_id, ''), '^MMR-[AC]-', 'MMR')) = ${code}
      OR UPPER(COALESCE(l.invite_code, '')) = ${code}
    )
    LIMIT 1`;

  // 3. Referrer found in database
  if (referrer) {
    // Customer cannot refer
    if (String(referrer.user_type).toLowerCase() === 'customer') {
      return {
        valid: false,
        error: 'Customers cannot refer. Only Associates and Team Members can refer.',
        status: 400,
        isCustomer: true
      };
    }

    // Must be active and either Associate or Team Member
    const isEligibleRole = ['Associate', 'Team Member'].includes(referrer.user_type);
    const isActive = ['Active', 'Approved'].includes(referrer.account_status);

    if (isEligibleRole && isActive) {
      return {
        valid: true,
        referrer,
        userId: referrer.user_id,
        memberId: referrer.member_id,
        fullName: referrer.full_name,
        invitationCode: referrer.invitation_code || referrer.member_id,
        userType: referrer.user_type,
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
  if (options.allowDefaultFallback && (code === 'MMR0001' || code === 'MMR00001' || code === 'MMR3001')) {
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
        memberId: defaultSponsor.member_id,
        fullName: defaultSponsor.full_name,
        invitationCode: defaultSponsor.invitation_code || 'MMR0001',
        userType: defaultSponsor.user_type,
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
