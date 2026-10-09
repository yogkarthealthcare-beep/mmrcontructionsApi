/**
 * Canonical User Types Constant (Backend)
 * Shared single source of truth for user type classification.
 */

export const USER_TYPES = Object.freeze({
  CUSTOMER: 'CUSTOMER',
  INVESTOR: 'INVESTOR',
  ASSOCIATE: 'ASSOCIATE',
  TEAM_MEMBER: 'TEAM_MEMBER'
});

/**
 * Normalizes any variation of user type to canonical uppercase enum
 * @param {string} type 
 * @returns {'CUSTOMER' | 'INVESTOR' | 'ASSOCIATE' | 'TEAM_MEMBER'}
 */
export function normalizeUserType(type) {
  if (!type) return USER_TYPES.CUSTOMER;
  const t = String(type).trim().toUpperCase().replace(/[\s\-_]+/g, '_');
  if (t === 'CUSTOMER' || t === 'CUS') return USER_TYPES.CUSTOMER;
  if (t === 'INVESTOR' || t === 'INV') return USER_TYPES.INVESTOR;
  if (t === 'ASSOCIATE' || t === 'ASC' || t === 'AGENT') return USER_TYPES.ASSOCIATE;
  if (t === 'TEAM_MEMBER' || t === 'TEAMMEMBER' || t === 'TM' || t === 'TEAM') return USER_TYPES.TEAM_MEMBER;
  return USER_TYPES.CUSTOMER;
}

/**
 * Formats canonical user type for database or display
 * @param {'CUSTOMER' | 'INVESTOR' | 'ASSOCIATE' | 'TEAM_MEMBER' | string} type 
 * @returns {string}
 */
export function formatDisplayUserType(type) {
  const norm = normalizeUserType(type);
  switch (norm) {
    case USER_TYPES.CUSTOMER: return 'Customer';
    case USER_TYPES.INVESTOR: return 'Investor';
    case USER_TYPES.ASSOCIATE: return 'Associate';
    case USER_TYPES.TEAM_MEMBER: return 'Team Member';
    default: return 'Customer';
  }
}
