/**
 * Shared Validation & Normalization Helpers for MMR Constructions API
 */

export const APPROVED_INDIAN_STATES = [
  "Haryana",
  "Punjab",
  "Rajasthan",
  "Gujarat",
  "Madhya Pradesh",
  "Andhra Pradesh",
  "Bihar",
  "Chhattisgarh",
  "Odisha",
  "Uttar Pradesh"
];

export const DEFAULT_STATE = "Uttar Pradesh";
export const DEFAULT_COUNTRY = "India";

/**
 * Normalizes a human name:
 * 1. Trims leading/trailing whitespace
 * 2. Collapses multiple spaces into a single space
 * 3. Converts each word to Title Case (e.g. "  vIkAs   rAjPuT  " -> "Vikas Rajput")
 */
export function normalizeHumanName(str) {
  if (!str || typeof str !== "string") return "";
  const cleaned = str.trim().replace(/\s+/g, " ");
  if (!cleaned) return "";
  return cleaned
    .split(" ")
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

/**
 * Checks if a string is a valid human name (strictly letters and spaces)
 */
export function isValidHumanName(str) {
  if (!str || typeof str !== "string") return false;
  const trimmed = str.trim();
  if (trimmed.length < 2) return false;
  return /^[A-Za-z]+(\s+[A-Za-z]+)*$/.test(trimmed);
}

/**
 * Calculates completed age in years from DOB string or Date
 */
export function calculateAge(dobVal) {
  if (!dobVal) return 0;
  let birthDate;
  if (typeof dobVal === "string") {
    // Check DD/MM/YYYY or DD-MM-YYYY
    const ddmmyyyy = dobVal.trim().match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
    if (ddmmyyyy) {
      const [, d, m, y] = ddmmyyyy;
      birthDate = new Date(`${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`);
    } else {
      birthDate = new Date(dobVal);
    }
  } else if (dobVal instanceof Date) {
    birthDate = dobVal;
  } else {
    return 0;
  }

  if (isNaN(birthDate.getTime())) return 0;

  const today = new Date();
  let age = today.getFullYear() - birthDate.getFullYear();
  const m = today.getMonth() - birthDate.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) {
    age--;
  }
  return age >= 0 ? age : 0;
}

export function isValidState(stateStr) {
  if (!stateStr) return true; // optional unless required by caller
  return APPROVED_INDIAN_STATES.some(s => s.toLowerCase() === String(stateStr).trim().toLowerCase());
}
