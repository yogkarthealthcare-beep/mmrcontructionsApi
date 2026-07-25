import crypto from "crypto";
import sql from "../db.js";
import { encrypt, decrypt } from "../utils/encryption.js";
import repo from "../repositories/whatsapp.repository.js";

const mask = (value) => {
  if (!value) return null;
  const text = String(value);
  return text.length <= 8 ? "********" : `${text.slice(0, 4)}********${text.slice(-4)}`;
};

const normalizeMobile = (mobile, countryCode = "91") => {
  const digits = String(mobile || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 10) return `${countryCode}${digits}`;
  return digits;
};

const hashOtp = (otp) => crypto.createHash("sha256").update(String(otp)).digest("hex");

export class WhatsappService {
  maskSettings(settings) {
    if (!settings) return null;
    return {
      ...settings,
      access_token: mask(settings.encrypted_access_token ? decrypt(settings.encrypted_access_token) : null),
      api_secret: mask(settings.encrypted_api_secret ? decrypt(settings.encrypted_api_secret) : null),
      verify_token: mask(settings.encrypted_verify_token ? decrypt(settings.encrypted_verify_token) : null),
      encrypted_access_token: undefined,
      encrypted_api_secret: undefined,
      encrypted_verify_token: undefined,
    };
  }

  async getSettings(masked = true) {
    const settings = await repo.settings();
    return masked ? this.maskSettings(settings) : settings;
  }

  async saveSettings(body, adminId = null) {
    const updates = {
      is_enabled: Boolean(body.is_enabled),
      phone_number_id: body.phone_number_id || null,
      whatsapp_business_account_id: body.whatsapp_business_account_id || null,
      webhook_callback_url: body.webhook_callback_url || null,
      api_version: body.api_version || "v20.0",
      default_country_code: body.default_country_code || "91",
      otp_length: Number(body.otp_length || 6),
      otp_expiry_minutes: Number(body.otp_expiry_minutes || 10),
      resend_limit: Number(body.resend_limit || 3),
      max_attempts: Number(body.max_attempts || 5),
      queue_max_attempts: Number(body.queue_max_attempts || 3),
      updated_by_admin_id: adminId,
    };
    if (body.access_token && !String(body.access_token).includes("*")) updates.encrypted_access_token = encrypt(body.access_token);
    if (body.api_secret && !String(body.api_secret).includes("*")) updates.encrypted_api_secret = encrypt(body.api_secret);
    if (body.verify_token && !String(body.verify_token).includes("*")) updates.encrypted_verify_token = encrypt(body.verify_token);
    return this.maskSettings(await repo.upsertSettings(updates));
  }

  renderBody(template, variables = {}) {
    return String(template.template_body || "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) =>
      variables[key] === undefined || variables[key] === null ? "" : String(variables[key])
    );
  }

  templateComponents(template, variables = {}) {
    const names = Array.isArray(template.template_variables) ? template.template_variables : [];
    if (!names.length) return [];
    return [{
      type: "body",
      parameters: names.map((name) => ({ type: "text", text: String(variables[name] ?? "") })),
    }];
  }

  async sendTemplate({ to, templateKey, variables = {}, userId = null, queueId = null }) {
    const settings = await this.getSettings(false);
    if (!settings?.is_enabled) throw new Error("WhatsApp integration is disabled.");
    const accessToken = settings.encrypted_access_token ? decrypt(settings.encrypted_access_token) : "";
    if (!accessToken || !settings.phone_number_id) throw new Error("WhatsApp access token or phone number id is missing.");
    const template = await repo.templateByKey(templateKey);
    if (!template || template.is_active === false || template.status === "Inactive") throw new Error(`WhatsApp template ${templateKey} is inactive or missing.`);
    const mobile = normalizeMobile(to, settings.default_country_code);
    const payload = {
      messaging_product: "whatsapp",
      to: mobile,
      type: "template",
      template: {
        name: template.meta_template_name || template.template_key,
        language: { code: template.language || "en_US" },
        components: this.templateComponents(template, variables),
      },
    };
    const log = await repo.createMessageLog({
      queue_id: queueId,
      user_id: userId,
      mobile_no: mobile,
      template_key: templateKey,
      request_payload: payload,
      status: "Processing",
    });
    try {
      const url = `https://graph.facebook.com/${settings.api_version || "v20.0"}/${settings.phone_number_id}/messages`;
      const response = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error?.message || `WhatsApp API failed with ${response.status}`);
      const metaId = data?.messages?.[0]?.id || null;
      return repo.updateMessageLog(log.message_log_id, {
        meta_message_id: metaId,
        response_payload: data,
        status: "Sent",
        delivery_status: "sent",
        sent_at: new Date(),
      });
    } catch (error) {
      await repo.updateMessageLog(log.message_log_id, {
        status: "Failed",
        delivery_status: "failed",
        error_message: error.message,
        failed_at: new Date(),
      });
      throw error;
    }
  }

  async enqueue(templateKey, to, variables = {}, userId = null, createdByAdminId = null, priority = 5) {
    const settings = await this.getSettings(false);
    return repo.enqueue({
      template_key: templateKey,
      recipient_mobile: normalizeMobile(to, settings?.default_country_code || "91"),
      user_id: userId,
      payload: { variables },
      priority,
      max_attempts: settings?.queue_max_attempts || 3,
      created_by_admin_id: createdByAdminId,
    });
  }

  async processQueue(limit = 10) {
    const jobs = await repo.nextQueue(limit);
    const results = [];
    for (const job of jobs) {
      try {
        await this.sendTemplate({
          to: job.recipient_mobile,
          templateKey: job.template_key,
          variables: job.payload?.variables || {},
          userId: job.user_id,
          queueId: job.queue_id,
        });
        await repo.updateQueue(job.queue_id, { status: "Sent", processed_at: new Date(), last_error: null });
        results.push({ queue_id: job.queue_id, status: "Sent" });
      } catch (error) {
        const failed = Number(job.attempts) >= Number(job.max_attempts);
        await repo.updateQueue(job.queue_id, { status: failed ? "Failed" : "Pending", last_error: error.message });
        results.push({ queue_id: job.queue_id, status: failed ? "Failed" : "Pending", error: error.message });
      }
    }
    return results;
  }

  async generateOtp({ mobile, purpose = "Login", userId = null, ip = null, userAgent = null }) {
    const settings = await this.getSettings(false);
    const length = Number(settings?.otp_length || 6);
    const min = length === 4 ? 1000 : 100000;
    const max = length === 4 ? 9999 : 999999;
    const otp = String(Math.floor(min + Math.random() * (max - min + 1)));
    const mobileNo = normalizeMobile(mobile, settings?.default_country_code || "91");
    const [row] = await sql`
      INSERT INTO otp_master (mobile_no, user_id, purpose, otp_hash, otp_length, expires_at, max_attempts)
      VALUES (${mobileNo}, ${userId}, ${purpose}, ${hashOtp(otp)}, ${length}, NOW() + make_interval(mins => ${Number(settings?.otp_expiry_minutes || 10)}), ${Number(settings?.max_attempts || 5)})
      RETURNING *`;
    await sql`
      INSERT INTO otp_history (otp_id, mobile_no, purpose, action, success, ip_address, user_agent)
      VALUES (${row.otp_id}, ${mobileNo}, ${purpose}, 'Generate', TRUE, ${ip}, ${userAgent})`;
    await this.enqueue("otp", mobileNo, { otp, expiry_minutes: settings?.otp_expiry_minutes || 10 }, userId, null, 1);
    await this.processQueue(1).catch((error) => console.error("[WhatsApp OTP Send Error]", error.message));
    return { otp_id: row.otp_id, mobile_no: mobileNo, expires_at: row.expires_at };
  }

  async verifyOtp({ mobile, purpose = "Login", otp, ip = null, userAgent = null }) {
    const settings = await this.getSettings(false);
    const mobileNo = normalizeMobile(mobile, settings?.default_country_code || "91");
    const [row] = await sql`
      SELECT * FROM otp_master
      WHERE mobile_no = ${mobileNo} AND purpose = ${purpose} AND status = 'Active'
      ORDER BY created_at DESC LIMIT 1`;
    if (!row) throw new Error("Invalid or expired OTP.");
    if (new Date(row.expires_at) < new Date()) {
      await sql`UPDATE otp_master SET status = 'Expired', updated_at = NOW() WHERE otp_id = ${row.otp_id}`;
      throw new Error("OTP has expired.");
    }
    const success = row.otp_hash === hashOtp(otp);
    if (!success) {
      const attempts = Number(row.attempts) + 1;
      await sql`UPDATE otp_master SET attempts = ${attempts}, status = ${attempts >= Number(row.max_attempts) ? "Blocked" : "Active"}, updated_at = NOW() WHERE otp_id = ${row.otp_id}`;
      await sql`INSERT INTO otp_history (otp_id, mobile_no, purpose, action, success, failure_reason, ip_address, user_agent) VALUES (${row.otp_id}, ${mobileNo}, ${purpose}, 'Verify', FALSE, 'Invalid OTP', ${ip}, ${userAgent})`;
      throw new Error("Invalid OTP.");
    }
    await sql`UPDATE otp_master SET status = 'Verified', verified_at = NOW(), updated_at = NOW() WHERE otp_id = ${row.otp_id}`;
    await sql`INSERT INTO otp_history (otp_id, mobile_no, purpose, action, success, ip_address, user_agent) VALUES (${row.otp_id}, ${mobileNo}, ${purpose}, 'Verify', TRUE, ${ip}, ${userAgent})`;
    return { verified: true, otp_id: row.otp_id };
  }

  async handleWebhook(payload) {
    const entry = payload?.entry?.[0]?.changes?.[0]?.value;
    const status = entry?.statuses?.[0];
    const metaMessageId = status?.id || null;
    const eventType = status?.status || "message";
    await repo.createWebhookLog({ event_type: eventType, meta_message_id: metaMessageId, payload, processed: true });
    if (metaMessageId && ["sent", "delivered", "read", "failed"].includes(eventType)) {
      const update = { delivery_status: eventType };
      if (eventType === "delivered") update.delivered_at = new Date();
      if (eventType === "read") update.read_at = new Date();
      if (eventType === "failed") {
        update.status = "Failed";
        update.failed_at = new Date();
        update.error_message = status?.errors?.[0]?.message || "WhatsApp delivery failed";
      }
      await repo.updateMessageStatus(metaMessageId, update);
    }
    return { processed: true };
  }
}

export default new WhatsappService();
