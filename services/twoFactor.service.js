import sql from "../db.js";
import { encrypt, decrypt } from "../utils/encryption.js";

const APPROVED_TEMPLATES = [
  "MMR OTP Verification",
  "MMR Forgot Password OTP",
];

// In-memory cooldown tracker: mobile -> timestamp
const sendCooldownMap = new Map();
const COOLDOWN_SECONDS = 30;

/**
 * Mask a mobile number for safe display and logging (e.g. 98******21)
 */
export const maskMobile = (mobile) => {
  if (!mobile) return "";
  const cleaned = String(mobile).replace(/\D/g, "");
  if (cleaned.length < 6) return "******";
  const start = cleaned.slice(0, 2);
  const end = cleaned.slice(-2);
  const stars = "*".repeat(cleaned.length - 4);
  return `${start}${stars}${end}`;
};

/**
 * Normalize and validate Indian mobile number.
 * Returns 10-digit number or null if invalid.
 */
export const normalizeIndianMobile = (mobile) => {
  if (!mobile) return null;
  let digits = String(mobile).replace(/\D/g, "");
  // Handle leading 0 or 91
  if (digits.length === 11 && digits.startsWith("0")) {
    digits = digits.slice(1);
  } else if (digits.length === 12 && digits.startsWith("91")) {
    digits = digits.slice(2);
  }
  // Indian mobile must be 10 digits starting with 6, 7, 8, or 9
  if (/^[6-9]\d{9}$/.test(digits)) {
    return digits;
  }
  return null;
};

/**
 * Ensure database tables exist for 2Factor integration.
 */
export async function ensureTwoFactorTables() {
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS two_factor_config (
        id SERIAL PRIMARY KEY,
        provider VARCHAR(50) NOT NULL DEFAULT '2Factor',
        api_key_encrypted TEXT,
        is_active BOOLEAN NOT NULL DEFAULT true,
        updated_by VARCHAR(100),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `;

    await sql`
      INSERT INTO two_factor_config (id, provider, is_active, created_at, updated_at)
      VALUES (1, '2Factor', true, NOW(), NOW())
      ON CONFLICT (id) DO NOTHING;
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS two_factor_otp_logs (
        id BIGSERIAL PRIMARY KEY,
        admin_user_id VARCHAR(100),
        mobile_number VARCHAR(30) NOT NULL,
        template VARCHAR(100) NOT NULL,
        provider VARCHAR(50) NOT NULL DEFAULT '2Factor',
        status VARCHAR(50) NOT NULL,
        provider_reference_id VARCHAR(255),
        error_code VARCHAR(100),
        error_message TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS idx_two_factor_logs_created_at ON two_factor_otp_logs(created_at DESC);
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS idx_two_factor_logs_mobile ON two_factor_otp_logs(mobile_number);
    `;
  } catch (err) {
    console.error("[TwoFactor] Error ensuring tables:", err.message);
  }
}

/**
 * Convert raw provider errors into safe readable user messages without leaking keys.
 */
const sanitizeProviderError = (errorDetail = "") => {
  const detail = String(errorDetail).toLowerCase();
  if (detail.includes("invalid api key") || detail.includes("no account exists") || detail.includes("invalid key")) {
    return "2Factor API authentication failed. Please verify the API key.";
  }
  if (detail.includes("balance") || detail.includes("credit") || detail.includes("low")) {
    return "2Factor account does not have sufficient OTP balance.";
  }
  if (detail.includes("template") || detail.includes("sender id")) {
    return "2Factor rejected the selected OTP template. Verify the approved template configuration.";
  }
  if (detail.includes("expired")) {
    return "The OTP has expired. Please request a new test OTP.";
  }
  if (detail.includes("mismatch") || detail.includes("invalid otp") || detail.includes("not match")) {
    return "OTP verification failed. The entered OTP does not match.";
  }
  if (detail.includes("limit") || detail.includes("flood") || detail.includes("too many")) {
    return "2Factor rate limit reached. Please wait before attempting again.";
  }
  return "2Factor service request could not be completed. Please verify configuration and balance.";
};

export class TwoFactorService {
  /**
   * Get current 2Factor configuration status.
   * NEVER returns the decrypted API key or encrypted secret.
   */
  async getConfig() {
    const [row] = await sql`SELECT id, provider, api_key_encrypted, is_active, updated_at, updated_by FROM two_factor_config WHERE id = 1`;
    const isConfigured = Boolean(row?.api_key_encrypted && row.api_key_encrypted.trim().length > 0);

    return {
      is_configured: isConfigured,
      masked_api_key: isConfigured ? "**************" : null,
      provider: row?.provider || "2Factor",
      is_active: row ? row.is_active : true,
      updated_at: row?.updated_at || null,
      approved_templates: APPROVED_TEMPLATES.map((name) => ({
        name,
        status: "Approved",
      })),
    };
  }

  /**
   * Encrypt and store the 2Factor API Key.
   */
  async saveConfig(apiKey, adminIdentifier = null) {
    if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
      throw new Error("API Key is required.");
    }
    const cleanKey = apiKey.trim();
    if (cleanKey.includes("*")) {
      throw new Error("Cannot save masked placeholder. Please enter the actual API Key.");
    }

    const encryptedKey = encrypt(cleanKey);
    if (!encryptedKey) {
      throw new Error("Failed to encrypt API key securely.");
    }

    const [updated] = await sql`
      INSERT INTO two_factor_config (id, provider, api_key_encrypted, is_active, updated_by, updated_at)
      VALUES (1, '2Factor', ${encryptedKey}, true, ${adminIdentifier ? String(adminIdentifier) : null}, NOW())
      ON CONFLICT (id) DO UPDATE SET
        provider = '2Factor',
        api_key_encrypted = ${encryptedKey},
        is_active = true,
        updated_by = ${adminIdentifier ? String(adminIdentifier) : null},
        updated_at = NOW()
      RETURNING id, provider, is_active, updated_at;
    `;

    return {
      is_configured: true,
      masked_api_key: "**************",
      provider: updated.provider,
      is_active: updated.is_active,
      updated_at: updated.updated_at,
    };
  }

  /**
   * Retrieve decrypted API Key internally for server-side API calls only.
   */
  async getDecryptedApiKey() {
    const [row] = await sql`SELECT api_key_encrypted, is_active FROM two_factor_config WHERE id = 1`;
    if (!row || !row.api_key_encrypted) {
      throw new Error("2Factor API Key is not configured. Please save your API Key first.");
    }
    if (!row.is_active) {
      throw new Error("2Factor SMS integration is currently disabled in configuration.");
    }
    const decrypted = decrypt(row.api_key_encrypted);
    if (!decrypted) {
      throw new Error("Unable to decrypt 2Factor API credentials. Please re-save your API key.");
    }
    return decrypted;
  }

  /**
   * Send Test OTP via official 2Factor AUTOGEN API.
   */
  async sendTestOtp({ mobile, template, adminId = null }) {
    // 1. Validate Indian mobile
    const normalizedMobile = normalizeIndianMobile(mobile);
    if (!normalizedMobile) {
      throw new Error("Please enter a valid 10-digit Indian mobile number (e.g. 9876543210).");
    }

    // 2. Validate template
    const selectedTemplate = template ? String(template).trim() : APPROVED_TEMPLATES[0];
    if (!APPROVED_TEMPLATES.includes(selectedTemplate)) {
      throw new Error(`Invalid template selected. Approved templates are: ${APPROVED_TEMPLATES.join(", ")}`);
    }

    // 3. Rate limiting / cooldown check
    const now = Date.now();
    const lastSent = sendCooldownMap.get(normalizedMobile);
    if (lastSent && now - lastSent < COOLDOWN_SECONDS * 1000) {
      const remainingSeconds = Math.ceil((COOLDOWN_SECONDS * 1000 - (now - lastSent)) / 1000);
      throw new Error(`Please wait ${remainingSeconds} seconds before sending another test OTP to this number.`);
    }

    // 4. Retrieve and decrypt API key server-side
    const apiKey = await this.getDecryptedApiKey();

    // 5. Construct official 2Factor AUTOGEN URL
    // Format: https://2factor.in/API/V1/{api_key}/SMS/{phone_number}/AUTOGEN/{template_name}
    const targetPhone = `91${normalizedMobile}`;
    const endpointUrl = `https://2factor.in/API/V1/${encodeURIComponent(apiKey)}/SMS/${encodeURIComponent(targetPhone)}/AUTOGEN/${encodeURIComponent(selectedTemplate)}`;

    let responseJson = null;
    let httpStatus = 200;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);

      const resp = await fetch(endpointUrl, {
        method: "GET",
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      httpStatus = resp.status;
      responseJson = await resp.json();
    } catch (fetchErr) {
      const isTimeout = fetchErr.name === "AbortError";
      const errorMsg = isTimeout ? "2Factor request timed out. Please check network connection." : "2Factor service is temporarily unavailable. Please try again.";

      // Record audit failure
      await this.recordAuditLog({
        adminUserId: adminId,
        mobileNumber: maskMobile(normalizedMobile),
        template: selectedTemplate,
        status: "Failed",
        errorCode: isTimeout ? "TIMEOUT" : "FETCH_ERROR",
        errorMessage: errorMsg,
      });

      throw new Error(errorMsg);
    }

    // 6. Inspect 2Factor response
    if (responseJson && responseJson.Status === "Success") {
      const sessionId = responseJson.Details;
      // Update cooldown timer
      sendCooldownMap.set(normalizedMobile, Date.now());

      // Record audit log
      await this.recordAuditLog({
        adminUserId: adminId,
        mobileNumber: maskMobile(normalizedMobile),
        template: selectedTemplate,
        status: "Success",
        providerReferenceId: sessionId,
      });

      return {
        success: true,
        message: "Test OTP sent successfully.",
        provider: "2Factor",
        session_id: sessionId,
        mobile_masked: maskMobile(normalizedMobile),
        template: selectedTemplate,
      };
    } else {
      const rawDetail = responseJson?.Details || "Unknown 2Factor error";
      const safeMsg = sanitizeProviderError(rawDetail);

      // Record audit failure
      await this.recordAuditLog({
        adminUserId: adminId,
        mobileNumber: maskMobile(normalizedMobile),
        template: selectedTemplate,
        status: "Failed",
        errorCode: responseJson?.Status || "ERROR",
        errorMessage: safeMsg,
      });

      throw new Error(safeMsg);
    }
  }

  /**
   * Verify Test OTP via official 2Factor VERIFY API.
   */
  async verifyTestOtp({ sessionId, otp, adminId = null }) {
    if (!sessionId || !String(sessionId).trim()) {
      throw new Error("Session Reference ID is required for OTP verification.");
    }
    const cleanOtp = String(otp || "").trim();
    if (!cleanOtp || !/^\d{4,8}$/.test(cleanOtp)) {
      throw new Error("Please enter a valid numeric OTP.");
    }

    const apiKey = await this.getDecryptedApiKey();

    // Format: https://2factor.in/API/V1/{api_key}/SMS/VERIFY/{session_id}/{otp_entered_by_user}
    const endpointUrl = `https://2factor.in/API/V1/${encodeURIComponent(apiKey)}/SMS/VERIFY/${encodeURIComponent(sessionId.trim())}/${encodeURIComponent(cleanOtp)}`;

    let responseJson = null;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);

      const resp = await fetch(endpointUrl, {
        method: "GET",
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      responseJson = await resp.json();
    } catch (fetchErr) {
      throw new Error("Failed to verify OTP with 2Factor. Service may be unreachable.");
    }

    if (responseJson && responseJson.Status === "Success") {
      const details = String(responseJson.Details || "");
      if (details.toLowerCase().includes("matched") || details.toLowerCase().includes("success")) {
        await this.recordAuditLog({
          adminUserId: adminId,
          mobileNumber: "OTP Verification",
          template: "VERIFY",
          status: "Verified",
          providerReferenceId: sessionId,
        });

        return {
          success: true,
          message: "OTP verification successful. Provider verified code successfully.",
          provider: "2Factor",
        };
      }
    }

    const rawDetail = responseJson?.Details || "OTP verification failed.";
    const safeMsg = sanitizeProviderError(rawDetail);

    await this.recordAuditLog({
      adminUserId: adminId,
      mobileNumber: "OTP Verification",
      template: "VERIFY",
      status: "Mismatch",
      providerReferenceId: sessionId,
      errorMessage: safeMsg,
    });

    throw new Error(safeMsg);
  }

  /**
   * Record an audit log for test OTP operations.
   */
  async recordAuditLog({
    adminUserId = null,
    mobileNumber,
    template,
    status,
    providerReferenceId = null,
    errorCode = null,
    errorMessage = null,
  }) {
    try {
      await sql`
        INSERT INTO two_factor_otp_logs (
          admin_user_id,
          mobile_number,
          template,
          provider,
          status,
          provider_reference_id,
          error_code,
          error_message,
          created_at
        ) VALUES (
          ${adminUserId ? String(adminUserId) : null},
          ${mobileNumber},
          ${template},
          '2Factor',
          ${status},
          ${providerReferenceId},
          ${errorCode},
          ${errorMessage},
          NOW()
        );
      `;
    } catch (err) {
      console.error("[TwoFactor] Error saving audit log:", err.message);
    }
  }

  /**
   * Retrieve recent audit logs for the admin test page.
   */
  async getLogs(limit = 20) {
    const rows = await sql`
      SELECT id, admin_user_id, mobile_number, template, provider, status, provider_reference_id, error_code, error_message, created_at
      FROM two_factor_otp_logs
      ORDER BY created_at DESC
      LIMIT ${Math.min(Number(limit) || 20, 100)};
    `;
    return rows;
  }
}

export default new TwoFactorService();
