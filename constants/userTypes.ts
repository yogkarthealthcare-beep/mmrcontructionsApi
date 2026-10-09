/**
 * Canonical User Types Constant (Backend TypeScript)
 * Shared single source of truth for user type classification.
 */

export const USER_TYPES = {
  CUSTOMER: 'CUSTOMER',
  INVESTOR: 'INVESTOR',
  ASSOCIATE: 'ASSOCIATE',
  TEAM_MEMBER: 'TEAM_MEMBER'
} as const;

export type UserType = typeof USER_TYPES[keyof typeof USER_TYPES];

/**
 * Normalizes any variation of user type to canonical uppercase enum
 */
export function normalizeUserType(type?: string | null): UserType {
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
 */
export function formatDisplayUserType(type?: string | null): string {
  const norm = normalizeUserType(type);
  switch (norm) {
    case USER_TYPES.CUSTOMER: return 'Customer';
    case USER_TYPES.INVESTOR: return 'Investor';
    case USER_TYPES.ASSOCIATE: return 'Associate';
    case USER_TYPES.TEAM_MEMBER: return 'Team Member';
    default: return 'Customer';
  }
}
