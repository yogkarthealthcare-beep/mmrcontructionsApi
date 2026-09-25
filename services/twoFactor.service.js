import sql from "../db.js";
import { encrypt, decrypt } from "../utils/encryption.js";

export const DLT_PE_ID = "1001269604652842094";
export const DLT_BUSINESS_NAME = "MMR CONSTRUCTION & DEVELOPERS";

/**
 * SOURCE OF TRUTH: 5 APPROVED DLT TEMPLATES ONLY (PE ID: 1001269604652842094)
 * Business: MMR CONSTRUCTION & DEVELOPERS
 */
export const DLT_OTP_TEMPLATES = [
  {
    id: "OTP Verification",
    name: "OTP Verification",
    displayName: "1. OTP Verification (Header: MMRCTN | CT ID: 1077327240019)",
    senderId: "MMRCTN Service",
    header: "MMRCTN",
    contentType: "Implicit",
    communicationType: "Implicit",
    messageText: "MMR Construction and Developers: Your OTP for mobile number verification is {#var#}. This OTP is valid for 10 minutes. Please do not share it with anyone.",
    peId: "1001269604652842094",
    ctId: "1077327240019",
    dltTemplateId: "1077327240019",
    placeholder: "{#var#} = OTP",
    variables: ["OTP"],
    purpose: "Mobile number verification OTP",
    category: "AUTHENTICATION",
    status: "Approved",
    description: "Your OTP for mobile number verification is {#var#}. This OTP is valid for 10 minutes.",
  },
  {
    id: "Forgot Password OTP",
    name: "Forgot Password OTP",
    displayName: "2. Forgot Password OTP (Header: MMRCTN | CT ID: 1077411370018)",
    senderId: "MMRCTN Service",
    header: "MMRCTN",
    contentType: "Implicit",
    communicationType: "Implicit",
    messageText: "MMR Construction and Developers: Your OTP to reset your account password is {#var#}. This OTP is valid for 10 minutes. Please do not share it with anyone.",
    peId: "1001269604652842094",
    ctId: "1077411370018",
    dltTemplateId: "1077411370018",
    placeholder: "{#var#} = OTP",
    variables: ["OTP"],
    purpose: "Account password reset OTP",
    category: "SECURITY / RESET",
    status: "Approved",
    description: "Your OTP to reset your account password is {#var#}. This OTP is valid for 10 minutes.",
  },
  {
    id: "Pending EMI Reminder",
    name: "Pending EMI Reminder",
    displayName: "3. Pending EMI Reminder (Header: MMRCDP | CT ID: 1077177370024)",
    senderId: "MMRCDP Service",
    header: "MMRCDP",
    contentType: "Implicit",
    communicationType: "Implicit",
    messageText: "MMR Construction and Developers: Dear {#var#}, your EMI payment of Rs. {#var#} is pending and was due on {#var#}. Please make the payment at the earliest to keep your account up to date.",
    peId: "1001269604652842094",
    ctId: "1077177370024",
    dltTemplateId: "1077177370024",
    placeholder: "{#var#} = Customer name, {#var#} = EMI amount, {#var#} = Due date",
    variables: ["Customer name", "EMI amount", "Due date"],
    purpose: "Pending EMI payment reminder notification",
    category: "FINANCIAL / REMINDER",
    status: "Approved",
    description: "Dear {#var#}, your EMI payment of Rs. {#var#} is pending and was due on {#var#}.",
  },
  {
    id: "EMI Payment Confirmation",
    name: "EMI Payment Confirmation",
    displayName: "4. EMI Payment Confirmation (Header: MMRCDP | CT ID: 1077301680024)",
    senderId: "MMRCDP Service",
    header: "MMRCDP",
    contentType: "Implicit",
    communicationType: "Implicit",
    messageText: "MMR Construction and Developers: Dear {#var#}, your EMI payment of Rs. {#var#} has been received successfully. Transaction reference: {#var#}. Thank you.",
    peId: "1001269604652842094",
    ctId: "1077301680024",
    dltTemplateId: "1077301680024",
    placeholder: "{#var#} = Customer name, {#var#} = EMI amount, {#var#} = Transaction reference",
    variables: ["Customer name", "EMI amount", "Transaction reference"],
    purpose: "EMI payment receipt confirmation notification",
    category: "FINANCIAL / RECEIPT",
    status: "Approved",
    description: "Dear {#var#}, your EMI payment of Rs. {#var#} has been received successfully. Transaction reference: {#var#}.",
  },
  {
    id: "Account Verification Confirmation",
    name: "Account Verification Confirmation",
    displayName: "5. Account Verification Confirmation (Header: MMRCTN | CT ID: 1077145980024)",
    senderId: "MMRCTN Service",
    header: "MMRCTN",
    contentType: "Implicit",
    communicationType: "Implicit",
    messageText: "MMR Construction and Developers: Your account has been verified successfully. Your User ID is {#var#}. Thank you for choosing MMR Construction and Developers.",
    peId: "1001269604652842094",
    ctId: "1077145980024",
    dltTemplateId: "1077145980024",
    placeholder: "{#var#} = User ID",
    variables: ["User ID"],
    purpose: "Account verification confirmation notification",
    category: "AUTHENTICATION / CONFIRMATION",
    status: "Approved",
    description: "Your account has been verified successfully. Your User ID is {#var#}.",
  },
];

const APPROVED_TEMPLATE_NAMES = DLT_OTP_TEMPLATES.map((t) => t.id);

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
        pe_id VARCHAR(50) DEFAULT '1001269604652842094',
        api_key_encrypted TEXT,
        template_identifiers JSONB DEFAULT '{}'::jsonb,
        is_active BOOLEAN NOT NULL DEFAULT true,
        updated_by VARCHAR(100),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `;

    await sql`
      ALTER TABLE two_factor_config ADD COLUMN IF NOT EXISTS pe_id VARCHAR(50) DEFAULT '1001269604652842094';
    `;
    await sql`
      ALTER TABLE two_factor_config ADD COLUMN IF NOT EXISTS template_identifiers JSONB DEFAULT '{}'::jsonb;
    `;

    await sql`
      INSERT INTO two_factor_config (id, provider, pe_id, is_active, created_at, updated_at)
      VALUES (1, '2Factor', '1001269604652842094', true, NOW(), NOW())
      ON CONFLICT (id) DO UPDATE SET
        pe_id = '1001269604652842094';
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
  if (detail.includes("template") || detail.includes("sender id") || detail.includes("dlt")) {
    return "2Factor rejected the SMS template. Please ensure the template is approved on the 2Factor DLT portal.";
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
   * Get current 2Factor configuration status and the 5 approved DLT templates catalog.
   * NEVER returns the decrypted API key or encrypted secret.
   */
  async getConfig() {
    const [row] = await sql`SELECT id, provider, pe_id, api_key_encrypted, template_identifiers, is_active, updated_at, updated_by FROM two_factor_config WHERE id = 1`;
    const isConfigured = Boolean(row?.api_key_encrypted && row.api_key_encrypted.trim().length > 0);
    const templateIdentifiers = (row?.template_identifiers && typeof row.template_identifiers === "object") ? row.template_identifiers : {};

    return {
      is_configured: isConfigured,
      masked_api_key: isConfigured ? "**************" : null,
      provider: row?.provider || "2Factor",
      pe_id: row?.pe_id || DLT_PE_ID,
      is_active: row ? row.is_active : true,
      updated_at: row?.updated_at || null,
      template_identifiers: templateIdentifiers,
      approved_templates: DLT_OTP_TEMPLATES.map((t) => ({
        ...t,
        identifier: templateIdentifiers[t.id] || templateIdentifiers[t.name] || t.name,
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
      INSERT INTO two_factor_config (id, provider, pe_id, api_key_encrypted, template_identifiers, is_active, updated_by, updated_at)
      VALUES (1, '2Factor', ${DLT_PE_ID}, ${finalEncryptedKey}, ${JSON.stringify(finalTemplateIdentifiers)}::jsonb, true, ${adminIdentifier ? String(adminIdentifier) : null}, NOW())
      ON CONFLICT (id) DO UPDATE SET
        provider = '2Factor',
        pe_id = ${DLT_PE_ID},
        api_key_encrypted = COALESCE(${finalEncryptedKey}, two_factor_config.api_key_encrypted),
        template_identifiers = ${JSON.stringify(finalTemplateIdentifiers)}::jsonb,
        is_active = true,
        updated_by = ${adminIdentifier ? String(adminIdentifier) : null},
        updated_at = NOW()
      RETURNING id, provider, pe_id, is_active, updated_at;
    `;

    return {
      is_configured: Boolean(finalEncryptedKey),
      masked_api_key: finalEncryptedKey ? "**************" : null,
      provider: updated.provider,
      pe_id: updated.pe_id,
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
   * Send Test SMS via official 2Factor SMS API using one of the 5 approved DLT templates.
   * STRICTLY SMS ONLY – NO VOICE CALL / NO OBD / NO CALL FALLBACK.
   */
  async sendTestOtp({ mobile, template = "OTP Verification", customVars = null, adminId = null }) {
    // 1. Validate Indian mobile
    const normalizedMobile = normalizeIndianMobile(mobile);
    if (!normalizedMobile) {
      throw new Error("Please enter a valid 10-digit Indian mobile number (e.g. 9876543210).");
    }

    // 2. Resolve template object from the 5 approved DLT templates
    const cleanTemplateId = String(template || "OTP Verification").trim();
    const templateObj = DLT_OTP_TEMPLATES.find(
      (t) => t.id.toLowerCase() === cleanTemplateId.toLowerCase() || t.name.toLowerCase() === cleanTemplateId.toLowerCase()
    ) || DLT_OTP_TEMPLATES[0];

    // 3. Rate limiting / cooldown check
    const now = Date.now();
    const lastSent = sendCooldownMap.get(normalizedMobile);
    if (lastSent && now - lastSent < COOLDOWN_SECONDS * 1000) {
      const remainingSeconds = Math.ceil((COOLDOWN_SECONDS * 1000 - (now - lastSent)) / 1000);
      throw new Error(`Please wait ${remainingSeconds} seconds before sending another test SMS to this number.`);
    }

    // 4. Retrieve and decrypt API key & template identifiers server-side
    const { apiKey, templateIdentifiers } = await this.getConfigWithDecryptedKey();
    const targetPhone = `91${normalizedMobile}`;

    const templateIdentifier = (templateIdentifiers && (templateIdentifiers[templateObj.id] || templateIdentifiers[templateObj.name]))
      ? String(templateIdentifiers[templateObj.id] || templateIdentifiers[templateObj.name]).trim()
      : templateObj.name;
    const encodedTemplate = encodeURIComponent(templateIdentifier).replace(/%20/g, "+");

    // 5. Construct official 2Factor SMS URL based on template category (STRICTLY /SMS/ ROUTE - NO /VOICE/ ROUTE)
    let endpointUrl = "";
    let isOtpRoute = false;

    if (templateObj.id === "OTP Verification" || templateObj.id === "Forgot Password OTP") {
      // 2Factor AUTOGEN SMS OTP Endpoint:
      // https://2factor.in/API/V1/{API_KEY}/SMS/{CLIENT_NUMBER}/AUTOGEN/{TEMPLATE_NAME}
      endpointUrl = `https://2factor.in/API/V1/${encodeURIComponent(apiKey)}/SMS/${targetPhone}/AUTOGEN/${encodedTemplate}`;
      isOtpRoute = true;
    } else if (templateObj.id === "Pending EMI Reminder") {
      // 3 variables: Customer name, EMI amount, Due date
      const var1 = (customVars && customVars[0]) ? encodeURIComponent(String(customVars[0]).trim()) : encodeURIComponent("Valued Customer");
      const var2 = (customVars && customVars[1]) ? encodeURIComponent(String(customVars[1]).trim()) : encodeURIComponent("15000");
      const var3 = (customVars && customVars[2]) ? encodeURIComponent(String(customVars[2]).trim()) : encodeURIComponent(new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }));
      endpointUrl = `https://2factor.in/API/V1/${encodeURIComponent(apiKey)}/SMS/${targetPhone}/${var1}/${var2}/${var3}/${encodedTemplate}`;
    } else if (templateObj.id === "EMI Payment Confirmation") {
      // 3 variables: Customer name, EMI amount, Transaction reference
      const var1 = (customVars && customVars[0]) ? encodeURIComponent(String(customVars[0]).trim()) : encodeURIComponent("Valued Customer");
      const var2 = (customVars && customVars[1]) ? encodeURIComponent(String(customVars[1]).trim()) : encodeURIComponent("15000");
      const var3 = (customVars && customVars[2]) ? encodeURIComponent(String(customVars[2]).trim()) : encodeURIComponent(`TXN${Math.floor(100000 + Math.random() * 900000)}`);
      endpointUrl = `https://2factor.in/API/V1/${encodeURIComponent(apiKey)}/SMS/${targetPhone}/${var1}/${var2}/${var3}/${encodedTemplate}`;
    } else if (templateObj.id === "Account Verification Confirmation") {
      // 1 variable: User ID
      const var1 = (customVars && customVars[0]) ? encodeURIComponent(String(customVars[0]).trim()) : encodeURIComponent(`MMR${Math.floor(1000 + Math.random() * 9000)}`);
      endpointUrl = `https://2factor.in/API/V1/${encodeURIComponent(apiKey)}/SMS/${targetPhone}/${var1}/${encodedTemplate}`;
    } else {
      endpointUrl = `https://2factor.in/API/V1/${encodeURIComponent(apiKey)}/SMS/${targetPhone}/AUTOGEN/${encodedTemplate}`;
      isOtpRoute = true;
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
      console.log(`[TwoFactor Debug]\n2Factor service: SMS Route\nTemplate: ${templateObj.name}\nHeader: ${templateObj.header}\nCT ID: ${templateObj.ctId}\nPE ID: ${DLT_PE_ID}\nMobile: ${maskMobile(normalizedMobile)}\nResponse status: failure (Network/Timeout)`);

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
    console.log(`[TwoFactor Debug]\n2Factor service: SMS Route\nTemplate: ${templateObj.name}\nHeader: ${templateObj.header}\nCT ID: ${templateObj.ctId}\nPE ID: ${DLT_PE_ID}\nMobile: ${maskMobile(normalizedMobile)}\nResponse status: ${isSuccess ? "success" : "failure"}`);

    // 6. Inspect 2Factor response
    if (isSuccess) {
      const sessionId = responseJson.Details || "SMS_SENT";
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
        message: `Test SMS sent successfully using approved template "${templateObj.name}".`,
        provider: "2Factor",
        delivery_channel: "SMS",
        session_id: sessionId,
        is_otp_route: isOtpRoute,
        mobile_masked: maskMobile(normalizedMobile),
        template: templateObj.name,
        template_id: templateObj.id,
        pe_id: DLT_PE_ID,
        ct_id: templateObj.ctId,
        dlt_template_id: templateObj.dltTemplateId,
        header: templateObj.header,
        sender_id: templateObj.senderId,
        content_type: templateObj.contentType,
        message_content: templateObj.messageText,
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
   * Send Forgot Password OTP via 2Factor official approved SMS template endpoint.
   * Pattern: https://2factor.in/API/V1/{API_KEY}/SMS/{CLIENT_NUMBER}/{OTP_VALUE}/Forgot+Password+OTP
   */
  async sendForgotPasswordOtp({ mobile, otp, adminId = null }) {
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

    const templateName = "Forgot Password OTP";
    const templateIdentifier = (templateIdentifiers && templateIdentifiers[templateName])
      ? String(templateIdentifiers[templateName]).trim()
      : templateName;
    const encodedTemplate = encodeURIComponent(templateIdentifier).replace(/%20/g, "+");

    // Construct approved 2Factor SMS URL: /SMS/{phone}/{otp}/Forgot+Password+OTP
    const endpointUrl = `https://2factor.in/API/V1/${encodeURIComponent(apiKey)}/SMS/${targetPhone}/${encodeURIComponent(cleanOtp)}/${encodedTemplate}`;

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
      const errorMsg = isTimeout
        ? "2Factor request timed out. Please check network connection."
        : "2Factor SMS service is temporarily unavailable. Please try again.";

      console.log(`[TwoFactor Debug]\n2Factor service: SMS OTP (Forgot Password)\nTemplate: ${templateName}\nHeader: MMRCTN\nCT ID: 1077411370018\nMobile: ${maskMobile(normalizedMobile)}\nResponse status: failure (Network/Timeout)`);

      await this.recordAuditLog({
        adminUserId: adminId,
        mobileNumber: maskMobile(normalizedMobile),
        template: templateName,
        status: "Failed",
        errorCode: isTimeout ? "TIMEOUT" : "FETCH_ERROR",
        errorMessage: errorMsg,
      });

      throw new Error(errorMsg);
    }

    const isSuccess = Boolean(responseJson && responseJson.Status === "Success");
    console.log(`[TwoFactor Debug]\n2Factor service: SMS OTP (Forgot Password)\nTemplate: ${templateName}\nHeader: MMRCTN\nCT ID: 1077411370018\nMobile: ${maskMobile(normalizedMobile)}\nResponse status: ${isSuccess ? "success" : "failure"}`);

    if (isSuccess) {
      const sessionId = responseJson.Details || "SMS_SENT";
      sendCooldownMap.set(normalizedMobile, Date.now());

      await this.recordAuditLog({
        adminUserId: adminId,
        mobileNumber: maskMobile(normalizedMobile),
        template: templateName,
        status: "Success",
        providerReferenceId: sessionId,
      });

      return {
        success: true,
        message: "Password reset OTP sent successfully via SMS text message.",
        provider: "2Factor",
        delivery_channel: "SMS",
        session_id: sessionId,
        mobile_masked: maskMobile(normalizedMobile),
        template: templateName,
        header: "MMRCTN",
        ct_id: "1077411370018",
      };
    } else {
      const rawDetail = responseJson?.Details || "Unknown 2Factor error";
      const safeMsg = sanitizeProviderError(rawDetail);

      await this.recordAuditLog({
        adminUserId: adminId,
        mobileNumber: maskMobile(normalizedMobile),
        template: templateName,
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
   * Endpoint format: https://2factor.in/API/V1/{api_key}/SMS/{phone_number}/{otp_val}/{template_name}
   */
  async sendCustomOtp({ mobile, otp, template = "OTP Verification", adminId = null, purpose = "Authentication" }) {
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

    const templateName = template || "OTP Verification";
    const templateIdentifier = (templateIdentifiers && templateIdentifiers[templateName])
      ? String(templateIdentifiers[templateName]).trim()
      : templateName;
    const encodedTemplate = encodeURIComponent(templateIdentifier).replace(/%20/g, "+");

    // Endpoint format: /SMS/{phone}/{otp}/{template}
    const endpointUrl = `https://2factor.in/API/V1/${encodeURIComponent(apiKey)}/SMS/${targetPhone}/${encodeURIComponent(cleanOtp)}/${encodedTemplate}`;

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

      console.log(`[TwoFactor Debug]\n2Factor service: SMS OTP (Custom)\nPurpose: ${purpose}\nTemplate: ${templateName}\nMobile: ${maskMobile(normalizedMobile)}\nResponse status: failure (Network/Timeout)`);

      await this.recordAuditLog({
        adminUserId: adminId,
        mobileNumber: maskMobile(normalizedMobile),
        template: templateName,
        status: "Failed",
        errorCode: isTimeout ? "TIMEOUT" : "FETCH_ERROR",
        errorMessage: errorMsg,
      });

      throw new Error(errorMsg);
    }

    const isSuccess = Boolean(responseJson && responseJson.Status === "Success");
    console.log(`[TwoFactor Debug]\n2Factor service: SMS OTP (Custom)\nPurpose: ${purpose}\nTemplate: ${templateName}\nMobile: ${maskMobile(normalizedMobile)}\nResponse status: ${isSuccess ? "success" : "failure"}`);

    if (isSuccess) {
      const sessionId = responseJson.Details || "SMS_SENT";
      sendCooldownMap.set(normalizedMobile, Date.now());

      await this.recordAuditLog({
        adminUserId: adminId,
        mobileNumber: maskMobile(normalizedMobile),
        template: templateName,
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
        template: templateName,
      };
    } else {
      const rawDetail = responseJson?.Details || "Unknown 2Factor error";
      const safeMsg = sanitizeProviderError(rawDetail);

      await this.recordAuditLog({
        adminUserId: adminId,
        mobileNumber: maskMobile(normalizedMobile),
        template: templateName,
        status: "Failed",
        errorCode: responseJson?.Status || "ERROR",
        errorMessage: safeMsg,
      });

      throw new Error(safeMsg);
    }
  }

  /**
   * Send Pending EMI Reminder SMS
   */
  async sendPendingEmiReminder({ mobile, customerName, emiAmount, dueDate, adminId = null }) {
    const normalizedMobile = normalizeIndianMobile(mobile);
    if (!normalizedMobile) {
      throw new Error("Please enter a valid 10-digit Indian mobile number.");
    }
    const { apiKey, templateIdentifiers } = await this.getConfigWithDecryptedKey();
    const targetPhone = `91${normalizedMobile}`;
    const templateName = "Pending EMI Reminder";
    const templateIdentifier = (templateIdentifiers && templateIdentifiers[templateName])
      ? String(templateIdentifiers[templateName]).trim()
      : templateName;
    const encodedTemplate = encodeURIComponent(templateIdentifier).replace(/%20/g, "+");

    const var1 = encodeURIComponent(String(customerName || "Customer").trim());
    const var2 = encodeURIComponent(String(emiAmount || "0").trim());
    const var3 = encodeURIComponent(String(dueDate || "").trim());

    const endpointUrl = `https://2factor.in/API/V1/${encodeURIComponent(apiKey)}/SMS/${targetPhone}/${var1}/${var2}/${var3}/${encodedTemplate}`;

    const resp = await fetch(endpointUrl, { method: "GET", headers: { "Accept": "application/json" } });
    const json = await resp.json();
    if (json?.Status === "Success") {
      await this.recordAuditLog({
        adminUserId: adminId,
        mobileNumber: maskMobile(normalizedMobile),
        template: templateName,
        status: "Success",
        providerReferenceId: json.Details,
      });
      return { success: true, message: "EMI reminder sent successfully via SMS.", details: json.Details };
    }
    throw new Error(sanitizeProviderError(json?.Details));
  }

  /**
   * Send EMI Payment Confirmation SMS
   */
  async sendEmiPaymentConfirmation({ mobile, customerName, emiAmount, txnRef, adminId = null }) {
    const normalizedMobile = normalizeIndianMobile(mobile);
    if (!normalizedMobile) {
      throw new Error("Please enter a valid 10-digit Indian mobile number.");
    }
    const { apiKey, templateIdentifiers } = await this.getConfigWithDecryptedKey();
    const targetPhone = `91${normalizedMobile}`;
    const templateName = "EMI Payment Confirmation";
    const templateIdentifier = (templateIdentifiers && templateIdentifiers[templateName])
      ? String(templateIdentifiers[templateName]).trim()
      : templateName;
    const encodedTemplate = encodeURIComponent(templateIdentifier).replace(/%20/g, "+");

    const var1 = encodeURIComponent(String(customerName || "Customer").trim());
    const var2 = encodeURIComponent(String(emiAmount || "0").trim());
    const var3 = encodeURIComponent(String(txnRef || "").trim());

    const endpointUrl = `https://2factor.in/API/V1/${encodeURIComponent(apiKey)}/SMS/${targetPhone}/${var1}/${var2}/${var3}/${encodedTemplate}`;

    const resp = await fetch(endpointUrl, { method: "GET", headers: { "Accept": "application/json" } });
    const json = await resp.json();
    if (json?.Status === "Success") {
      await this.recordAuditLog({
        adminUserId: adminId,
        mobileNumber: maskMobile(normalizedMobile),
        template: templateName,
        status: "Success",
        providerReferenceId: json.Details,
      });
      return { success: true, message: "EMI payment confirmation sent successfully via SMS.", details: json.Details };
    }
    throw new Error(sanitizeProviderError(json?.Details));
  }

  /**
   * Send Account Verification Confirmation SMS
   */
  async sendAccountVerificationConfirmation({ mobile, userId, adminId = null }) {
    const normalizedMobile = normalizeIndianMobile(mobile);
    if (!normalizedMobile) {
      throw new Error("Please enter a valid 10-digit Indian mobile number.");
    }
    const { apiKey, templateIdentifiers } = await this.getConfigWithDecryptedKey();
    const targetPhone = `91${normalizedMobile}`;
    const templateName = "Account Verification Confirmation";
    const templateIdentifier = (templateIdentifiers && templateIdentifiers[templateName])
      ? String(templateIdentifiers[templateName]).trim()
      : templateName;
    const encodedTemplate = encodeURIComponent(templateIdentifier).replace(/%20/g, "+");

    const var1 = encodeURIComponent(String(userId || "").trim());

    const endpointUrl = `https://2factor.in/API/V1/${encodeURIComponent(apiKey)}/SMS/${targetPhone}/${var1}/${encodedTemplate}`;

    const resp = await fetch(endpointUrl, { method: "GET", headers: { "Accept": "application/json" } });
    const json = await resp.json();
    if (json?.Status === "Success") {
      await this.recordAuditLog({
        adminUserId: adminId,
        mobileNumber: maskMobile(normalizedMobile),
        template: templateName,
        status: "Success",
        providerReferenceId: json.Details,
      });
      return { success: true, message: "Account verification confirmation sent successfully via SMS.", details: json.Details };
    }
    throw new Error(sanitizeProviderError(json?.Details));
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
          message: "OTP verification successful. 2Factor verified code successfully via SMS channel.",
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
