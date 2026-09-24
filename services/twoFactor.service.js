import sql from "../db.js";
import { encrypt, decrypt } from "../utils/encryption.js";

export const DLT_OTP_TEMPLATES = [
  {
    id: "DEFAULT",
    name: "Default 2Factor SMS Template",
    displayName: "Default 2Factor SMS Route (Direct SMS)",
    dltTemplateId: "DIRECT_DEFAULT",
    header: "2FACTOR",
    communicationType: "Service Implicit",
    messageText: "XXXX is your verification OTP. Please do not share it with anyone.",
    placeholder: "XXXX",
    purpose: "Direct standard SMS delivery without custom DLT template mismatch",
    category: "AUTHENTICATION",
    status: "Approved",
    description: "Standard 2Factor SMS route. Sends pure SMS text message directly.",
  },
  {
    id: "OTP Verification",
    name: "OTP Verification",
    aliasName: "MMR OTP Verification",
    displayName: "OTP Verification (Header: MMRCTN | DLT ID: 1077327240019142677)",
    dltTemplateId: "1077327240019142677",
    header: "MMRCTN",
    communicationType: "Service Implicit",
    messageText: "MMR Construction and Developers: Your OTP for mobile number verification is {#num#}. This OTP is valid for 10 minutes. Please do not share it with anyone.",
    twoFactorMessageText: "XXXX is your OTP for MMR Construction and Developers mobile number verification. This OTP is valid for 10 minutes. Please do not share it with anyone.",
    placeholder: "{#num#} / XXXX",
    purpose: "Mobile number verification OTP",
    category: "AUTHENTICATION",
    status: "Approved",
    description: "Used for mobile number verification and phone confirmation.",
  },
  {
    id: "MMR OTP Verification",
    name: "MMR OTP Verification",
    aliasName: "OTP Verification",
    displayName: "MMR OTP Verification (Header: MMRCTN | DLT ID: 1077327240019142677)",
    dltTemplateId: "1077327240019142677",
    header: "MMRCTN",
    communicationType: "Service Implicit",
    messageText: "XXXX is your OTP for MMR Construction and Developers mobile number verification. This OTP is valid for 10 minutes. Please do not share it with anyone.",
    placeholder: "XXXX",
    purpose: "2Factor synchronized mobile verification OTP",
    category: "AUTHENTICATION",
    status: "Approved",
    description: "2Factor synchronized template for user registration and phone verification.",
  },
  {
    id: "Forgot Password OTP",
    name: "Forgot Password OTP",
    aliasName: "MMR Forgot Password OTP",
    displayName: "Forgot Password OTP (Header: MMRCTN | DLT ID: 1077411370018848441)",
    dltTemplateId: "1077411370018848441",
    header: "MMRCTN",
    communicationType: "Service Implicit",
    messageText: "MMR Construction and Developers: Your OTP to reset your account password is {#num#}. This OTP is valid for 10 minutes. Please do not share it with anyone.",
    twoFactorMessageText: "XXXX is your OTP to reset your MMR Construction and Developers account password. This OTP is valid for 10 minutes. Please do not share it with anyone.",
    placeholder: "{#num#} / XXXX",
    purpose: "Account password reset OTP",
    category: "SECURITY / RESET",
    status: "Approved",
    description: "Used to reset account password.",
  },
  {
    id: "MMR Forgot Password OTP",
    name: "MMR Forgot Password OTP",
    aliasName: "Forgot Password OTP",
    displayName: "MMR Forgot Password OTP (Header: MMRCTN | DLT ID: 1077411370018848441)",
    dltTemplateId: "1077411370018848441",
    header: "MMRCTN",
    communicationType: "Service Implicit",
    messageText: "XXXX is your OTP to reset your MMR Construction and Developers account password. This OTP is valid for 10 minutes. Please do not share it with anyone.",
    placeholder: "XXXX",
    purpose: "2Factor synchronized password reset OTP",
    category: "SECURITY / RESET",
    status: "Approved",
    description: "2Factor synchronized template for password recovery and account security resets.",
  },
  {
    id: "MMR Login OTP",
    name: "MMR Login OTP",
    displayName: "MMR Login OTP (Header: MMRCTN | DLT ID: 1077327240019142677)",
    dltTemplateId: "1077327240019142677",
    header: "MMRCTN",
    communicationType: "Service Implicit",
    messageText: "XXXX is your OTP for MMR Construction and Developers login. This OTP is valid for 10 minutes. Please do not share it with anyone.",
    placeholder: "XXXX",
    purpose: "OTP-based login",
    category: "AUTHENTICATION",
    status: "Approved",
    description: "2Factor synchronized template for OTP-based user login.",
  },
  {
    id: "Account Verification Confirmation",
    name: "Account Verification Confirmation",
    displayName: "Account Verification Confirmation (Header: MMRCTN | DLT ID: 1077145980024832603)",
    dltTemplateId: "1077145980024832603",
    header: "MMRCTN",
    communicationType: "Service Implicit",
    messageText: "MMR Construction and Developers: Your account has been verified successfully. Your User ID is {#alp#}. Thank you for choosing MMR Construction and Developers.",
    placeholder: "{#alp#}",
    purpose: "Account verification confirmation message",
    category: "CONFIRMATION",
    status: "Approved",
    description: "Notification sent upon successful account verification.",
  },
  {
    id: "Pending EMI Reminder",
    name: "Pending EMI Reminder",
    displayName: "Pending EMI Reminder (Header: MMRCDP | DLT ID: 1077177370024607423)",
    dltTemplateId: "1077177370024607423",
    header: "MMRCDP",
    communicationType: "Service Implicit",
    messageText: "MMR Construction and Developers: Dear {#alp#}, your EMI payment of Rs. {#alp#} is pending and was due on {#alp#}. Please make the payment at the earliest to keep your account up to date.",
    placeholder: "{#alp#}",
    purpose: "EMI payment due reminder notification",
    category: "FINANCIAL / REMINDER",
    status: "Approved",
    description: "Notification sent for pending EMI installments.",
  },
  {
    id: "EMI Payment Confirmation",
    name: "EMI Payment Confirmation",
    displayName: "EMI Payment Confirmation (Header: MMRCDP | DLT ID: 1077301680024625003)",
    dltTemplateId: "1077301680024625003",
    header: "MMRCDP",
    communicationType: "Service Implicit",
    messageText: "MMR Construction and Developers: Dear {#alp#}, your EMI payment of Rs. {#alp#} has been received successfully. Transaction reference: {#alp#}. Thank you.",
    placeholder: "{#alp#}",
    purpose: "EMI payment receipt confirmation notification",
    category: "FINANCIAL / RECEIPT",
    status: "Approved",
    description: "Notification sent upon receipt of EMI installment payment.",
  },
];

const APPROVED_TEMPLATES = DLT_OTP_TEMPLATES.map((t) => t.id);

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
        template_identifiers JSONB DEFAULT '{}'::jsonb,
        is_active BOOLEAN NOT NULL DEFAULT true,
        updated_by VARCHAR(100),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `;

    await sql`
      ALTER TABLE two_factor_config ADD COLUMN IF NOT EXISTS template_identifiers JSONB DEFAULT '{}'::jsonb;
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
    return "2Factor account does not have sufficient SMS OTP balance.";
  }
  if (detail.includes("template") || detail.includes("sender id")) {
    return "2Factor rejected the selected SMS template. Please use Default SMS Template or verify the approved DLT template name.";
  }
  if (detail.includes("expired")) {
    return "The OTP has expired. Please request a new OTP.";
  }
  if (detail.includes("mismatch") || detail.includes("invalid otp") || detail.includes("not match")) {
    return "OTP verification failed. The entered OTP does not match.";
  }
  if (detail.includes("limit") || detail.includes("flood") || detail.includes("too many")) {
    return "2Factor rate limit reached. Please wait before attempting again.";
  }
  return "2Factor SMS service request could not be completed. Please verify configuration and balance.";
};

export class TwoFactorService {
  /**
   * Get current 2Factor configuration status and complete DLT templates catalog.
   * NEVER returns the decrypted API key or encrypted secret.
   */
  async getConfig() {
    const [row] = await sql`SELECT id, provider, api_key_encrypted, template_identifiers, is_active, updated_at, updated_by FROM two_factor_config WHERE id = 1`;
    const isConfigured = Boolean(row?.api_key_encrypted && row.api_key_encrypted.trim().length > 0);
    const templateIdentifiers = (row?.template_identifiers && typeof row.template_identifiers === "object") ? row.template_identifiers : {};

    return {
      is_configured: isConfigured,
      masked_api_key: isConfigured ? "**************" : null,
      provider: row?.provider || "2Factor",
      is_active: row ? row.is_active : true,
      updated_at: row?.updated_at || null,
      template_identifiers: templateIdentifiers,
      approved_templates: DLT_OTP_TEMPLATES.map((t) => ({
        ...t,
        identifier: templateIdentifiers[t.id] || templateIdentifiers[t.name] || (t.id === "DEFAULT" ? "" : t.name),
        status: "Approved",
      })),
    };
  }

  /**
   * Encrypt and store the 2Factor API Key and optional template identifiers.
   */
  async saveConfig({ apiKey = null, templateIdentifiers = null, adminIdentifier = null }) {
    let encryptedKey = null;
    if (apiKey && typeof apiKey === "string" && apiKey.trim()) {
      const cleanKey = apiKey.trim();
      if (!cleanKey.includes("*")) {
        encryptedKey = encrypt(cleanKey);
        if (!encryptedKey) {
          throw new Error("Failed to encrypt API key securely.");
        }
      }
    }

    const [existing] = await sql`SELECT api_key_encrypted, template_identifiers FROM two_factor_config WHERE id = 1`;
    const finalEncryptedKey = encryptedKey || existing?.api_key_encrypted || null;
    
    let finalTemplateIdentifiers = existing?.template_identifiers || {};
    if (templateIdentifiers && typeof templateIdentifiers === "object") {
      finalTemplateIdentifiers = { ...finalTemplateIdentifiers, ...templateIdentifiers };
    }

    const [updated] = await sql`
      INSERT INTO two_factor_config (id, provider, api_key_encrypted, template_identifiers, is_active, updated_by, updated_at)
      VALUES (1, '2Factor', ${finalEncryptedKey}, ${JSON.stringify(finalTemplateIdentifiers)}::jsonb, true, ${adminIdentifier ? String(adminIdentifier) : null}, NOW())
      ON CONFLICT (id) DO UPDATE SET
        provider = '2Factor',
        api_key_encrypted = COALESCE(${finalEncryptedKey}, two_factor_config.api_key_encrypted),
        template_identifiers = ${JSON.stringify(finalTemplateIdentifiers)}::jsonb,
        is_active = true,
        updated_by = ${adminIdentifier ? String(adminIdentifier) : null},
        updated_at = NOW()
      RETURNING id, provider, is_active, updated_at;
    `;

    return {
      is_configured: Boolean(finalEncryptedKey),
      masked_api_key: finalEncryptedKey ? "**************" : null,
      provider: updated.provider,
      is_active: updated.is_active,
      updated_at: updated.updated_at,
      template_identifiers: finalTemplateIdentifiers,
    };
  }

  /**
   * Retrieve decrypted API Key and config internally for server-side API calls only.
   */
  async getConfigWithDecryptedKey() {
    const [row] = await sql`SELECT api_key_encrypted, template_identifiers, is_active FROM two_factor_config WHERE id = 1`;
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
    return {
      apiKey: decrypted,
      templateIdentifiers: row.template_identifiers || {},
    };
  }

  /**
   * Send Test OTP via official 2Factor SMS AUTOGEN API with dynamically selected DLT template.
   * STRICTLY SMS ONLY – NO VOICE CALL / NO OBD / NO CALL FALLBACK.
   */
  async sendTestOtp({ mobile, template = "DEFAULT", adminId = null }) {
    // 1. Validate Indian mobile
    const normalizedMobile = normalizeIndianMobile(mobile);
    if (!normalizedMobile) {
      throw new Error("Please enter a valid 10-digit Indian mobile number (e.g. 9876543210).");
    }

    // 2. Resolve template object from DLT templates catalog
    const cleanTemplateId = String(template || "DEFAULT").trim();
    const templateObj = DLT_OTP_TEMPLATES.find(
      (t) => t.id === cleanTemplateId || t.name === cleanTemplateId
    ) || DLT_OTP_TEMPLATES[0];

    // 3. Rate limiting / cooldown check
    const now = Date.now();
    const lastSent = sendCooldownMap.get(normalizedMobile);
    if (lastSent && now - lastSent < COOLDOWN_SECONDS * 1000) {
      const remainingSeconds = Math.ceil((COOLDOWN_SECONDS * 1000 - (now - lastSent)) / 1000);
      throw new Error(`Please wait ${remainingSeconds} seconds before sending another test OTP to this number.`);
    }

    // 4. Retrieve and decrypt API key & template identifiers server-side
    const { apiKey, templateIdentifiers } = await this.getConfigWithDecryptedKey();
    const targetPhone = `91${normalizedMobile}`;

    // 5. Construct official 2Factor SMS OTP URL (STRICTLY /SMS/ ROUTE - NO /VOICE/ ROUTE)
    // If DEFAULT or no custom template, call .../SMS/{phone}/AUTOGEN directly to avoid DLT template mismatch
    let endpointUrl = `https://2factor.in/API/V1/${encodeURIComponent(apiKey)}/SMS/${targetPhone}/AUTOGEN`;

    if (templateObj.id !== "DEFAULT") {
      const templateIdentifier = (templateIdentifiers && (templateIdentifiers[templateObj.id] || templateIdentifiers[templateObj.name]))
        ? String(templateIdentifiers[templateObj.id] || templateIdentifiers[templateObj.name]).trim()
        : templateObj.name;

      if (templateIdentifier && templateIdentifier !== "DEFAULT") {
        endpointUrl = `https://2factor.in/API/V1/${encodeURIComponent(apiKey)}/SMS/${targetPhone}/AUTOGEN/${encodeURIComponent(templateIdentifier)}`;
      }
    }

    let responseJson = null;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);

      const resp = await fetch(endpointUrl, {
        method: "GET",
        headers: {
          "Accept": "application/json",
        },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      responseJson = await resp.json();
    } catch (fetchErr) {
      const isTimeout = fetchErr.name === "AbortError";
      const errorMsg = isTimeout ? "2Factor request timed out. Please check network connection." : "2Factor SMS service is temporarily unavailable. Please try again.";

      // Safe debug logging (NEVER log apiKey, OTP, or secret)
      console.log(`[TwoFactor Debug]\n2Factor service: SMS OTP (AUTOGEN)\nTemplate: ${templateObj.name}\nHeader: ${templateObj.header}\nDLT ID: ${templateObj.dltTemplateId}\nMobile: ${maskMobile(normalizedMobile)}\nResponse status: failure (Network/Timeout)`);

      // Record audit failure
      await this.recordAuditLog({
        adminUserId: adminId,
        mobileNumber: maskMobile(normalizedMobile),
        template: templateObj.name,
        status: "Failed",
        errorCode: isTimeout ? "TIMEOUT" : "FETCH_ERROR",
        errorMessage: errorMsg,
      });

      throw new Error(errorMsg);
    }

    // Safe debug logging (NEVER log apiKey, OTP, or secret)
    const isSuccess = Boolean(responseJson && responseJson.Status === "Success");
    console.log(`[TwoFactor Debug]\n2Factor service: SMS OTP (AUTOGEN)\nTemplate: ${templateObj.name}\nHeader: ${templateObj.header}\nDLT ID: ${templateObj.dltTemplateId}\nMobile: ${maskMobile(normalizedMobile)}\nResponse status: ${isSuccess ? "success" : "failure"}`);

    // 6. Inspect 2Factor response
    if (isSuccess) {
      const sessionId = responseJson.Details;
      // Update cooldown timer
      sendCooldownMap.set(normalizedMobile, Date.now());

      // Record audit log
      await this.recordAuditLog({
        adminUserId: adminId,
        mobileNumber: maskMobile(normalizedMobile),
        template: templateObj.name,
        status: "Success",
        providerReferenceId: sessionId,
      });

      return {
        success: true,
        message: "Test OTP sent successfully via SMS text message.",
        provider: "2Factor",
        delivery_channel: "SMS",
        session_id: sessionId,
        mobile_masked: maskMobile(normalizedMobile),
        template: templateObj.name,
        template_id: templateObj.id,
        dlt_template_id: templateObj.dltTemplateId,
        header: templateObj.header,
        message_content: templateObj.messageText || templateObj.twoFactorMessageText,
        placeholder: templateObj.placeholder,
      };
    } else {
      const rawDetail = responseJson?.Details || "Unknown 2Factor error";
      const safeMsg = sanitizeProviderError(rawDetail);

      // Record audit failure
      await this.recordAuditLog({
        adminUserId: adminId,
        mobileNumber: maskMobile(normalizedMobile),
        template: templateObj.name,
        status: "Failed",
        errorCode: responseJson?.Status || "ERROR",
        errorMessage: safeMsg,
      });

      throw new Error(safeMsg);
    }
  }

  /**
   * Send custom backend-generated OTP via official 2Factor SMS API.
   * STRICTLY SMS ONLY – NO VOICE CALL / NO OBD / NO CALL FALLBACK.
   * Endpoint format: https://2factor.in/API/V1/{api_key}/SMS/{phone_number}/{otp_val}
   * or: https://2factor.in/API/V1/{api_key}/SMS/{phone_number}/{otp_val}/{template_name}
   */
  async sendCustomOtp({ mobile, otp, template = null, adminId = null, purpose = "Authentication" }) {
    const normalizedMobile = normalizeIndianMobile(mobile);
    if (!normalizedMobile) {
      throw new Error("Please enter a valid 10-digit Indian mobile number (e.g. 9876543210).");
    }

    const cleanOtp = String(otp || "").trim();
    if (!cleanOtp || !/^\d{4,8}$/.test(cleanOtp)) {
      throw new Error("Invalid numeric OTP code.");
    }

    const { apiKey, templateIdentifiers } = await this.getConfigWithDecryptedKey();
    const targetPhone = `91${normalizedMobile}`;

    let endpointUrl = `https://2factor.in/API/V1/${encodeURIComponent(apiKey)}/SMS/${targetPhone}/${encodeURIComponent(cleanOtp)}`;

    if (template && template !== "DEFAULT") {
      const templateIdentifier = (templateIdentifiers && templateIdentifiers[template])
        ? String(templateIdentifiers[template]).trim()
        : template;
      if (templateIdentifier && templateIdentifier !== "DEFAULT") {
        endpointUrl = `https://2factor.in/API/V1/${encodeURIComponent(apiKey)}/SMS/${targetPhone}/${encodeURIComponent(cleanOtp)}/${encodeURIComponent(templateIdentifier)}`;
      }
    }

    let responseJson = null;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);

      const resp = await fetch(endpointUrl, {
        method: "GET",
        headers: {
          "Accept": "application/json",
        },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      responseJson = await resp.json();
    } catch (fetchErr) {
      const isTimeout = fetchErr.name === "AbortError";
      const errorMsg = isTimeout ? "2Factor request timed out. Please check network connection." : "2Factor SMS service is temporarily unavailable. Please try again.";

      console.log(`[TwoFactor Debug]\n2Factor service: SMS OTP (Custom)\nPurpose: ${purpose}\nMobile: ${maskMobile(normalizedMobile)}\nResponse status: failure (Network/Timeout)`);

      await this.recordAuditLog({
        adminUserId: adminId,
        mobileNumber: maskMobile(normalizedMobile),
        template: template || purpose,
        status: "Failed",
        errorCode: isTimeout ? "TIMEOUT" : "FETCH_ERROR",
        errorMessage: errorMsg,
      });

      throw new Error(errorMsg);
    }

    const isSuccess = Boolean(responseJson && responseJson.Status === "Success");
    console.log(`[TwoFactor Debug]\n2Factor service: SMS OTP (Custom)\nPurpose: ${purpose}\nMobile: ${maskMobile(normalizedMobile)}\nResponse status: ${isSuccess ? "success" : "failure"}`);

    if (isSuccess) {
      const sessionId = responseJson.Details || "SMS_SENT";
      sendCooldownMap.set(normalizedMobile, Date.now());

      await this.recordAuditLog({
        adminUserId: adminId,
        mobileNumber: maskMobile(normalizedMobile),
        template: template || purpose,
        status: "Success",
        providerReferenceId: sessionId,
      });

      return {
        success: true,
        message: "OTP sent successfully via SMS text message.",
        provider: "2Factor",
        delivery_channel: "SMS",
        session_id: sessionId,
        mobile_masked: maskMobile(normalizedMobile),
        template: template || purpose,
      };
    } else {
      const rawDetail = responseJson?.Details || "Unknown 2Factor error";
      const safeMsg = sanitizeProviderError(rawDetail);

      await this.recordAuditLog({
        adminUserId: adminId,
        mobileNumber: maskMobile(normalizedMobile),
        template: template || purpose,
        status: "Failed",
        errorCode: responseJson?.Status || "ERROR",
        errorMessage: safeMsg,
      });

      throw new Error(safeMsg);
    }
  }

  /**
   * Verify Test OTP via official 2Factor SMS VERIFY API.
   */
  async verifyTestOtp({ sessionId, otp, adminId = null }) {
    if (!sessionId || !String(sessionId).trim()) {
      throw new Error("Session Reference ID is required for OTP verification.");
    }
    const cleanOtp = String(otp || "").trim();
    if (!cleanOtp || !/^\d{4,8}$/.test(cleanOtp)) {
      throw new Error("Please enter a valid numeric OTP.");
    }

    const { apiKey } = await this.getConfigWithDecryptedKey();

    // Format: https://2factor.in/API/V1/{api_key}/SMS/VERIFY/{session_id}/{otp_entered_by_user}
    const endpointUrl = `https://2factor.in/API/V1/${encodeURIComponent(apiKey)}/SMS/VERIFY/${encodeURIComponent(sessionId.trim())}/${encodeURIComponent(cleanOtp)}`;

    let responseJson = null;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);

      const resp = await fetch(endpointUrl, {
        method: "GET",
        headers: {
          "Accept": "application/json",
        },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      responseJson = await resp.json();
    } catch (fetchErr) {
      throw new Error("Failed to verify OTP with 2Factor. SMS service may be unreachable.");
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
