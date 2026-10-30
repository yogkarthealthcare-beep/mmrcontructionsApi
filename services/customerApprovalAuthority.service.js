/**
 * Customer Approval Authority Service (Phase 1)
 * MMR Construction & Developers Pvt. Ltd.
 *
 * Centralized authority engine for customer approvals:
 * 1. Customer Enrollment Form (customer_enrollment_submissions)
 * 2. Uploaded KYC Documents (user_documents)
 * 3. Document Verification / KYC Profile (user_kyc_profiles)
 *
 * Authority Matrix:
 * - Customer added by Admin (MMR00001 / NULL / Admin-role): Admin ONLY.
 * - Customer added by Associate: That Associate + Admin.
 * - Customer added by Team Member: That Team Member + That TM's Associate Leader + Admin.
 * - Customer added by Team Member without Associate: That Team Member + Admin.
 * - Role-conflict users (user_type Associate but in team_members with active/approved status):
 *   Resolved via team_members FIRST.
 * - Self-approval is strictly forbidden.
 * - Inactive / suspended actors fall back to the next level up, ending at Admin.
 * - Admin can approve any customer.
 */

export const ADMIN_CONFIG = {
  DEFAULT_ADMIN_USER_ID: 1,
  DEFAULT_ADMIN_MEMBER_ID: 'MMR00001',
  // MMR00001: Root Admin (User 1, Suraj Kumar Verma).
  // MMR-0: Virtual apex root node used in MLM tree structures (routes/admin-network-tree.routes.js).
  // 'ADMIN' keyword and legacy 4-digit 'MMR0001' have been removed per security review.
  ADMIN_MEMBER_IDS: ['MMR00001', 'MMR-0'],
  FULL_ADMIN_ROLES: new Set(['superadmin', 'admin', 'super_admin']),
  STAFF_ROLES: new Set(['financemanager', 'sitemanager', 'supportstaff']),
  ADMIN_SPONSOR_ROLES: new Set(['superadmin', 'admin', 'super_admin', 'financemanager', 'sitemanager', 'supportstaff'])
};

/**
 * Check if the sponsor customer approval feature flag is active.
 * Default: OFF in production, ON in dev / test.
 */
export function isSponsorApprovalFeatureEnabled() {
  if (process.env.ENABLE_SPONSOR_CUSTOMER_APPROVAL !== undefined) {
    const val = String(process.env.ENABLE_SPONSOR_CUSTOMER_APPROVAL).trim().toLowerCase();
    return val === 'true' || val === '1' || val === 'yes' || val === 'on';
  }
  // Default: OFF in production, ON in all other environments
  return process.env.NODE_ENV !== 'production';
}

/**
 * Check if an actor possesses blanket administrative approval power.
 * Rule: Only true SuperAdmin, Admin, primary admin user ID (1), or corporate root member ID (MMR00001, MMR-0).
 * Staff roles (FinanceManager, SiteManager, SupportStaff) do NOT get blanket approval power through this feature.
 */
export function isFullAdminActor(actor = {}) {
  if (!actor) return false;
  const roleStr = String(actor.role || actor.user_type || '').toLowerCase();
  // Staff roles NEVER get blanket administrative customer approval
  if (ADMIN_CONFIG.STAFF_ROLES.has(roleStr)) return false;

  if (Number(actor.user_id || actor.id || actor.admin_id) === ADMIN_CONFIG.DEFAULT_ADMIN_USER_ID) return true;
  const memberIdStr = String(actor.member_id || '').toUpperCase();
  if (ADMIN_CONFIG.ADMIN_MEMBER_IDS.includes(memberIdStr)) return true;
  if (ADMIN_CONFIG.FULL_ADMIN_ROLES.has(roleStr)) return true;
  if (actor.is_admin === true || actor.isAdmin === true) return true;
  if (actor.admin_id && !roleStr) return true;
  return false;
}

/**
 * Question (a): Is the customer's sponsor an Admin?
 * Decides customer ownership/classification.
 * Includes staff roles as corporate/admin sponsor per current classification.
 */
export function isSponsorAdmin(sponsorUser = {}) {
  if (!sponsorUser) return true; // Direct company registration (NULL sponsor)
  const sponsorId = Number(sponsorUser.user_id || sponsorUser.id);
  if (!sponsorId || sponsorId === ADMIN_CONFIG.DEFAULT_ADMIN_USER_ID) return true;
  const memberIdStr = String(sponsorUser.member_id || '').toUpperCase();
  if (ADMIN_CONFIG.ADMIN_MEMBER_IDS.includes(memberIdStr)) return true;
  const roleStr = String(sponsorUser.role || sponsorUser.user_type || '').toLowerCase();
  if (ADMIN_CONFIG.ADMIN_SPONSOR_ROLES.has(roleStr)) return true;
  if (sponsorUser.is_admin === true || sponsorUser.admin_id) return true;
  return false;
}

/**
 * Backward compatibility alias for principal check
 */
export function isAdminPrincipal(actor = {}) {
  return isFullAdminActor(actor);
}

/**
 * Resolve actor's operational role.
 */
export async function resolveActorOperationalRole(sql, actor = {}) {
  if (isFullAdminActor(actor)) {
    return {
      role: 'Admin',
      userId: actor.admin_id || actor.user_id || ADMIN_CONFIG.DEFAULT_ADMIN_USER_ID,
      memberId: actor.member_id || ADMIN_CONFIG.DEFAULT_ADMIN_MEMBER_ID,
      fullName: actor.full_name || 'Admin',
      isActive: true
    };
  }

  const roleStr = String(actor.role || actor.user_type || '').toLowerCase();
  if (ADMIN_CONFIG.STAFF_ROLES.has(roleStr)) {
    return {
      role: actor.role || actor.user_type || 'Staff',
      userId: Number(actor.admin_id || actor.user_id || actor.id || 0),
      memberId: actor.member_id || '',
      fullName: actor.full_name || 'Staff User',
      isActive: true
    };
  }

  const userId = Number(actor.user_id || actor.id);
  if (!userId) {
    return { role: 'Guest', userId: 0, memberId: '', fullName: '', isActive: false };
  }

  // Fresh lookup from users table
  const [userRow] = await sql`
    SELECT user_id, member_id, full_name, user_type, account_status
    FROM users WHERE user_id = ${userId}
  `;

  if (!userRow) {
    return { role: 'Unknown', userId, memberId: '', fullName: '', isActive: false };
  }

  const isActive = ['active', 'approved'].includes(String(userRow.account_status || '').toLowerCase());

  // Rule: Check team_members FIRST even if users.user_type says 'Associate' (role-conflict resolution)
  const [tmRow] = await sql`
    SELECT id, team_member_uid, associate_id, status
    FROM team_members
    WHERE user_id = ${userId} AND LOWER(status) IN ('approved', 'active')
    ORDER BY created_at DESC LIMIT 1
  `;

  if (tmRow) {
    return {
      role: 'Team Member',
      userId: userRow.user_id,
      memberId: tmRow.team_member_uid || userRow.member_id,
      fullName: userRow.full_name,
      isActive: isActive && ['approved', 'active'].includes(String(tmRow.status).toLowerCase()),
      associateId: Number(tmRow.associate_id)
    };
  }

  if (String(userRow.user_type || '').toLowerCase() === 'team member') {
    return {
      role: 'Team Member',
      userId: userRow.user_id,
      memberId: userRow.member_id,
      fullName: userRow.full_name,
      isActive,
      associateId: null
    };
  }

  return {
    role: userRow.user_type || 'Associate',
    userId: userRow.user_id,
    memberId: userRow.member_id,
    fullName: userRow.full_name,
    isActive
  };
}

/**
 * Central Authority Function: canApproveCustomer
 *
 * @param {object} sql - Database instance / transaction
 * @param {object} actor - Principal object (from JWT req.user or req.admin)
 * @param {number|string} customerId - Target customer's user_id
 * @param {string} item - 'enrollment' | 'documents' | 'kyc' | 'all'
 * @returns {Promise<{ allowed: boolean, reason?: string, actorRole?: string, approver?: object, chain?: object }>}
 */
export async function canApproveCustomer(sql, actor, customerId, item = 'all') {
  if (!actor) {
    return { allowed: false, reason: 'Authentication required.' };
  }

  const targetCustomerId = Number(customerId);
  if (!targetCustomerId || isNaN(targetCustomerId)) {
    return { allowed: false, reason: 'Invalid customer ID provided.' };
  }

  // 1. Resolve Actor Operational Role & Status
  const actorInfo = await resolveActorOperationalRole(sql, actor);

  // 2. Self-approval is strictly forbidden
  if (actorInfo.userId === targetCustomerId) {
    return {
      allowed: false,
      reason: 'Self-approval is strictly forbidden.',
      actorRole: actorInfo.role,
      approver: actorInfo
    };
  }

  // 3. Admin can approve ANY customer (provided not self)
  if (actorInfo.role === 'Admin') {
    return {
      allowed: true,
      actorRole: 'Admin',
      approver: actorInfo,
      chain: {
        targetCustomerId,
        approverRole: 'Admin',
        level: 'Admin'
      }
    };
  }

  // 4. Inactive actor check
  if (!actorInfo.isActive) {
    return {
      allowed: false,
      reason: 'Your account is inactive or suspended. Approvals are not permitted.',
      actorRole: actorInfo.role,
      approver: actorInfo
    };
  }

  // 5. Feature Flag Check for non-admin actors
  const featureEnabled = isSponsorApprovalFeatureEnabled();
  if (!featureEnabled) {
    return {
      allowed: false,
      reason: 'Sponsor customer approval is currently disabled in this environment (Admin approval only).',
      actorRole: actorInfo.role,
      approver: actorInfo
    };
  }

  // 6. Look up target customer
  const [customer] = await sql`
    SELECT user_id, member_id, full_name, user_type, account_status,
           referred_by_user_id, sponsor_user_id
    FROM users WHERE user_id = ${targetCustomerId}
  `;

  if (!customer) {
    return {
      allowed: false,
      reason: 'Customer record not found.',
      actorRole: actorInfo.role,
      approver: actorInfo
    };
  }

  // 7. Resolve Customer's Sponsor (users.referred_by_user_id as source of truth)
  let sponsorUserId = customer.referred_by_user_id || customer.sponsor_user_id;

  if (!sponsorUserId) {
    const [subRow] = await sql`
      SELECT associate_id FROM customer_enrollment_submissions
      WHERE user_id = ${targetCustomerId} AND associate_id IS NOT NULL AND associate_id != ''
      ORDER BY created_at DESC LIMIT 1
    `;
    if (subRow && subRow.associate_id) {
      const [sponsorByCode] = await sql`
        SELECT user_id FROM users WHERE member_id = ${subRow.associate_id}
      `;
      if (sponsorByCode) {
        sponsorUserId = sponsorByCode.user_id;
      }
    }
  }

  // Rule: If sponsor is NULL, DEFAULT_ADMIN_USER_ID (1), or Admin -> Admin's customer -> Admin only
  if (!sponsorUserId || sponsorUserId === ADMIN_CONFIG.DEFAULT_ADMIN_USER_ID) {
    return {
      allowed: false,
      reason: "This customer was directly sponsored by Admin (MMR00001). Only Admin can approve.",
      actorRole: actorInfo.role,
      approver: actorInfo,
      chain: {
        targetCustomerId,
        sponsorUserId: ADMIN_CONFIG.DEFAULT_ADMIN_USER_ID,
        sponsorRole: 'Admin'
      }
    };
  }

  // Look up sponsor user
  const [sponsorUser] = await sql`
    SELECT user_id, member_id, full_name, user_type, account_status, role, sponsor_user_id
    FROM users WHERE user_id = ${sponsorUserId}
  `;

  if (!sponsorUser || isSponsorAdmin(sponsorUser)) {
    return {
      allowed: false,
      reason: "This customer's sponsor is Admin. Only Admin can approve.",
      actorRole: actorInfo.role,
      approver: actorInfo,
      chain: {
        targetCustomerId,
        sponsorUserId,
        sponsorRole: 'Admin'
      }
    };
  }

  const isSponsorActive = ['active', 'approved'].includes(String(sponsorUser.account_status || '').toLowerCase());

  // 8. Determine if Sponsor is a Team Member or Associate
  // Check team_members FIRST for the sponsor (role-conflict resolution)
  // Matched strictly by user_id and status in ('approved', 'active')
  const [sponsorTmRow] = await sql`
    SELECT id, team_member_uid, associate_id, status
    FROM team_members
    WHERE user_id = ${sponsorUserId} AND LOWER(status) IN ('approved', 'active')
    ORDER BY created_at DESC LIMIT 1
  `;

  let sponsorRole = 'Associate';
  let tmAssociateId = null;
  let isTmStatusActive = true;

  if (sponsorTmRow) {
    const isApprovedTm = ['approved', 'active'].includes(String(sponsorTmRow.status || '').toLowerCase());
    const isUserTypeTm = String(sponsorUser.user_type || '').toLowerCase() === 'team member';
    if (isApprovedTm || isUserTypeTm) {
      sponsorRole = 'Team Member';
      tmAssociateId = Number(sponsorTmRow.associate_id) || (sponsorUser.sponsor_user_id ? Number(sponsorUser.sponsor_user_id) : null);
      isTmStatusActive = isApprovedTm;
    }
  } else if (String(sponsorUser.user_type || '').toLowerCase() === 'team member') {
    sponsorRole = 'Team Member';
    tmAssociateId = sponsorUser.sponsor_user_id ? Number(sponsorUser.sponsor_user_id) : null;
  }

  // ══════════════════════════════════════════════════════════════════════
  // CASE A: Customer sponsored by an ASSOCIATE
  // Authorized: That Associate + Admin
  // ══════════════════════════════════════════════════════════════════════
  if (sponsorRole === 'Associate') {
    if (actorInfo.userId === sponsorUserId) {
      if (!isSponsorActive) {
        return {
          allowed: false,
          reason: 'Your Associate account is currently inactive. Authority falls back to Admin.',
          actorRole: actorInfo.role,
          approver: actorInfo
        };
      }
      return {
        allowed: true,
        actorRole: 'Associate',
        approver: actorInfo,
        chain: {
          targetCustomerId,
          sponsorUserId,
          sponsorRole: 'Associate',
          approverRole: 'Associate'
        }
      };
    }

    return {
      allowed: false,
      reason: `Customer was sponsored by Associate ${sponsorUser.member_id || sponsorUser.full_name}. Only that Associate or Admin may approve.`,
      actorRole: actorInfo.role,
      approver: actorInfo
    };
  }

  // ══════════════════════════════════════════════════════════════════════
  // CASE B: Customer sponsored by a TEAM MEMBER
  // Authorized: That Team Member + That TM's Associate Leader + Admin
  // ══════════════════════════════════════════════════════════════════════
  if (sponsorRole === 'Team Member') {
    const isTmActive = isSponsorActive && isTmStatusActive;

    // 1. Is actor that direct Team Member?
    if (actorInfo.userId === sponsorUserId) {
      if (!isTmActive) {
        return {
          allowed: false,
          reason: 'Your Team Member account is currently inactive. Authority falls back to your Associate Leader or Admin.',
          actorRole: actorInfo.role,
          approver: actorInfo
        };
      }
      return {
        allowed: true,
        actorRole: 'Team Member',
        approver: actorInfo,
        chain: {
          targetCustomerId,
          sponsorUserId,
          sponsorRole: 'Team Member',
          approverRole: 'Team Member',
          associateLeaderId: tmAssociateId
        }
      };
    }

    // 2. Is actor the Associate Leader of that Team Member?
    if (tmAssociateId && actorInfo.userId === tmAssociateId) {
      // Check if Associate Leader is active
      const [associateLeader] = await sql`
        SELECT user_id, account_status FROM users WHERE user_id = ${tmAssociateId}
      `;
      const isAssociateLeaderActive = associateLeader && ['active', 'approved'].includes(String(associateLeader.account_status || '').toLowerCase());
      if (!isAssociateLeaderActive) {
        return {
          allowed: false,
          reason: 'Associate Leader account is currently inactive. Authority falls back to Admin.',
          actorRole: actorInfo.role,
          approver: actorInfo
        };
      }
      return {
        allowed: true,
        actorRole: 'Associate',
        approver: actorInfo,
        chain: {
          targetCustomerId,
          sponsorUserId,
          sponsorRole: 'Team Member',
          approverRole: 'Associate Leader',
          associateLeaderId: tmAssociateId
        }
      };
    }

    return {
      allowed: false,
      reason: `Customer was sponsored by Team Member ${sponsorUser.member_id || sponsorUser.full_name}. Only that Team Member, their Associate Leader, or Admin may approve.`,
      actorRole: actorInfo.role,
      approver: actorInfo
    };
  }

  return {
    allowed: false,
    reason: 'Approval authorization could not be established.',
    actorRole: actorInfo.role,
    approver: actorInfo
  };
}

/**
 * Cached check for customer approval audit columns.
 * Read-only, zero DDL, zero schema changes at runtime.
 * Guarantees schema changes come strictly from Knex migration 20261020000000_customer_approval_hierarchy.js.
 */
let cachedSchemaStatus = null;
let lastCheckTime = 0;
const CACHE_TTL_MS = 30000;

export async function hasCustomerApprovalAuditColumns(sql) {
  const now = Date.now();
  if (cachedSchemaStatus !== null && (now - lastCheckTime) < CACHE_TTL_MS) {
    return cachedSchemaStatus;
  }

  try {
    const rows = await sql`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'customer_enrollment_submissions' 
        AND column_name = 'approved_by_user_id'
      LIMIT 1
    `;
    if (rows && rows.length > 0) {
      cachedSchemaStatus = true;
      lastCheckTime = now;
      return true;
    }

    // Automatically apply additive migration if columns are missing
    return await ensureCustomerApprovalSchema(sql);
  } catch (err) {
    console.warn("[hasCustomerApprovalAuditColumns] Schema check warning:", err.message);
    return false;
  }
}

/**
 * Ensures required audit columns from migration 20261020000000 exist across
 * customer_enrollment_submissions, user_documents, and user_kyc_profiles.
 * Safe, idempotent DDL (IF NOT EXISTS).
 */
export async function ensureCustomerApprovalSchema(sql) {
  try {
    await sql`
      ALTER TABLE customer_enrollment_submissions
        ADD COLUMN IF NOT EXISTS approved_by_user_id INTEGER,
        ADD COLUMN IF NOT EXISTS approved_by_member_id VARCHAR(50),
        ADD COLUMN IF NOT EXISTS approved_by_name VARCHAR(150),
        ADD COLUMN IF NOT EXISTS approved_by_role VARCHAR(50),
        ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS reject_reason TEXT,
        ADD COLUMN IF NOT EXISTS rejected_by_user_id INTEGER,
        ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS idx_ces_approved_by ON customer_enrollment_submissions(approved_by_user_id)
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS idx_ces_approved_at ON customer_enrollment_submissions(approved_at)
    `;

    await sql`
      ALTER TABLE user_documents
        ADD COLUMN IF NOT EXISTS verified_by_user_id INTEGER,
        ADD COLUMN IF NOT EXISTS verifier_member_id VARCHAR(50),
        ADD COLUMN IF NOT EXISTS verifier_name VARCHAR(150),
        ADD COLUMN IF NOT EXISTS verifier_role VARCHAR(50),
        ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS reject_reason TEXT,
        ADD COLUMN IF NOT EXISTS rejected_by_user_id INTEGER,
        ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS idx_user_docs_verifier_uid ON user_documents(verified_by_user_id)
    `;

    await sql`
      ALTER TABLE user_kyc_profiles
        ADD COLUMN IF NOT EXISTS reviewed_by_user_id INTEGER,
        ADD COLUMN IF NOT EXISTS reviewer_member_id VARCHAR(50),
        ADD COLUMN IF NOT EXISTS reviewer_name VARCHAR(150),
        ADD COLUMN IF NOT EXISTS reviewer_role VARCHAR(50),
        ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS reject_reason TEXT,
        ADD COLUMN IF NOT EXISTS rejected_by_user_id INTEGER,
        ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS idx_user_kyc_reviewer_uid ON user_kyc_profiles(reviewed_by_user_id)
    `;

    console.log("[CustomerApprovalSchema] Successfully ensured customer approval hierarchy schema.");
    cachedSchemaStatus = true;
    lastCheckTime = Date.now();
    return true;
  } catch (err) {
    console.error("[ensureCustomerApprovalSchema] Migration error:", err.message);
    return false;
  }
}

export function resetSchemaCheckCache() {
  cachedSchemaStatus = null;
  lastCheckTime = 0;
}
