/**
 * Canonical User Types Constant & Database Enum Mapper (Backend TypeScript)
 * 
 * Code Constants: 'CUSTOMER' | 'INVESTOR' | 'ASSOCIATE' | 'TEAM_MEMBER'
 * Database Labels: 'Customer' | 'Associate' | 'Investor' | 'Team Member'
 */

export const USER_TYPES = {
  CUSTOMER: 'CUSTOMER',
  INVESTOR: 'INVESTOR',
  ASSOCIATE: 'ASSOCIATE',
  TEAM_MEMBER: 'TEAM_MEMBER'
} as const;

export type UserTypeCode = typeof USER_TYPES[keyof typeof USER_TYPES];
export type UserTypeDbLabel = 'Customer' | 'Associate' | 'Investor' | 'Team Member';

export const USER_TYPE_DB_MAP: Record<UserTypeCode, UserTypeDbLabel> = {
  [USER_TYPES.CUSTOMER]: 'Customer',
  [USER_TYPES.ASSOCIATE]: 'Associate',
  [USER_TYPES.TEAM_MEMBER]: 'Team Member',
  [USER_TYPES.INVESTOR]: 'Investor'
};

export const DB_TO_USER_TYPE_MAP: Record<string, UserTypeCode> = {
  'Customer': USER_TYPES.CUSTOMER,
  'Associate': USER_TYPES.ASSOCIATE,
  'Team Member': USER_TYPES.TEAM_MEMBER,
  'Investor': USER_TYPES.INVESTOR
};

export function normalizeUserType(input?: string | null): UserTypeCode {
  if (!input) return USER_TYPES.CUSTOMER;
  const s = String(input).trim().toUpperCase().replace(/[\s\-_]+/g, '_');
  if (s === 'CUSTOMER' || s === 'CUS') return USER_TYPES.CUSTOMER;
  if (s === 'ASSOCIATE' || s === 'ASC' || s === 'AGENT') return USER_TYPES.ASSOCIATE;
  if (s === 'TEAM_MEMBER' || s === 'TEAMMEMBER' || s === 'TM') return USER_TYPES.TEAM_MEMBER;
  if (s === 'INVESTOR' || s === 'INV') return USER_TYPES.INVESTOR;
  return USER_TYPES.CUSTOMER;
}

export function codeToDbUserType(codeConstant?: string | null): UserTypeDbLabel {
  const norm = normalizeUserType(codeConstant);
  return USER_TYPE_DB_MAP[norm] || 'Customer';
}

export function dbToCodeUserType(dbLabel?: string | null): UserTypeCode {
  if (!dbLabel) return USER_TYPES.CUSTOMER;
  return DB_TO_USER_TYPE_MAP[dbLabel] || normalizeUserType(dbLabel);
}

export function formatDisplayUserType(input?: string | null): string {
  return codeToDbUserType(input);
}
