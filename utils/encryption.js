import crypto from "crypto";
import "../config/loadEnv.js";

const ALGORITHM = "aes-256-cbc";
const IV_LENGTH = 16;

function getEncryptionKey() {
  const masterKey = process.env.PAYMENT_CONFIG_ENCRYPTION_KEY || process.env.ENCRYPT_KEY;
  if (!masterKey) {
    throw new Error("PAYMENT_CONFIG_ENCRYPTION_KEY or ENCRYPT_KEY is not defined in environment variables.");
  }
  // Standardize key length to 32 bytes (256 bits) using SHA-256
  return crypto.createHash("sha256").update(masterKey).digest();
}

/**
 * Encrypts a plaintext string.
 * @param {string} text
 * @returns {string|null} Encrypted text in the format "ivHex:encryptedHex"
 */
export function encrypt(text) {
  if (text === null || text === undefined || text === "") {
    return null;
  }
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  return iv.toString("hex") + ":" + encrypted;
}

/**
 * Decrypts an encrypted string.
 * @param {string} encryptedText - Encrypted text in the format "ivHex:encryptedHex"
 * @returns {string|null} Decrypted plaintext string
 */
export function decrypt(encryptedText) {
  if (!encryptedText) {
    return null;
  }
  try {
    const parts = encryptedText.split(":");
    if (parts.length !== 2) {
      throw new Error("Invalid encrypted text format.");
    }
    const iv = Buffer.from(parts[0], "hex");
    const encryptedData = parts[1];
    const key = getEncryptionKey();
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    let decrypted = decipher.update(encryptedData, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  } catch (error) {
    console.error("Decryption failed:", error.message);
    throw new Error("Failed to decrypt credentials. Ensure the correct encryption key is configured.");
  }
}
