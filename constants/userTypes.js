/**
 * Canonical User Types Constant & Database Enum Mapper (Backend)
 * 
 * Code Constants: 'CUSTOMER' | 'INVESTOR' | 'ASSOCIATE' | 'TEAM_MEMBER'
 * Database Labels: 'Customer' | 'Associate' | 'Investor' | 'Team Member'
 */

export const USER_TYPES = Object.freeze({
  CUSTOMER: 'CUSTOMER',
  INVESTOR: 'INVESTOR',
  ASSOCIATE: 'ASSOCIATE',
  TEAM_MEMBER: 'TEAM_MEMBER'
});

export const USER_TYPE_DB_MAP = Object.freeze({
  [USER_TYPES.CUSTOMER]: 'Customer',
  [USER_TYPES.ASSOCIATE]: 'Associate',
  [USER_TYPES.TEAM_MEMBER]: 'Team Member',
  [USER_TYPES.INVESTOR]: 'Investor'
});

export const DB_TO_USER_TYPE_MAP = Object.freeze({
  'Customer': USER_TYPES.CUSTOMER,
  'Associate': USER_TYPES.ASSOCIATE,
  'Team Member': USER_TYPES.TEAM_MEMBER,
  'Investor': USER_TYPES.INVESTOR
});

/**
 * Maps any input / alias into canonical uppercase code constant
 * @param {string} input 
 * @returns {'CUSTOMER' | 'INVESTOR' | 'ASSOCIATE' | 'TEAM_MEMBER'}
 */
export function normalizeUserType(input) {
  if (!input) return USER_TYPES.CUSTOMER;
  const s = String(input).trim().toUpperCase().replace(/[\s\-_]+/g, '_');
  if (s === 'CUSTOMER' || s === 'CUS') return USER_TYPES.CUSTOMER;
  if (s === 'ASSOCIATE' || s === 'ASC' || s === 'AGENT') return USER_TYPES.ASSOCIATE;
  if (s === 'TEAM_MEMBER' || s === 'TEAMMEMBER' || s === 'TM') return USER_TYPES.TEAM_MEMBER;
  if (s === 'INVESTOR' || s === 'INV') return USER_TYPES.INVESTOR;
  return USER_TYPES.CUSTOMER;
}

/**
 * Maps code constant (or user input) to exact PostgreSQL DB enum label
 * @param {string} codeConstant 
 * @returns {'Customer' | 'Associate' | 'Team Member' | 'Investor'}
 */
export function codeToDbUserType(codeConstant) {
  const norm = normalizeUserType(codeConstant);
  return USER_TYPE_DB_MAP[norm] || 'Customer';
}

/**
 * Maps PostgreSQL DB enum label to code constant
 * @param {string} dbLabel 
 * @returns {'CUSTOMER' | 'INVESTOR' | 'ASSOCIATE' | 'TEAM_MEMBER'}
 */
export function dbToCodeUserType(dbLabel) {
  return DB_TO_USER_TYPE_MAP[dbLabel] || normalizeUserType(dbLabel);
}

/**
 * Formats canonical user type for UI display
 * @param {string} input 
 * @returns {'Customer' | 'Associate' | 'Team Member' | 'Investor'}
 */
export function formatDisplayUserType(input) {
  return codeToDbUserType(input);
}
