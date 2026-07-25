import express from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import sql from "../db.js";
import whatsapp from "../services/whatsapp.service.js";
import repo from "../repositories/whatsapp.repository.js";

const router = express.Router();
const ok = (res, data, message = "Success", status = 200) => res.status(status).json({ success: true, message, data });
const fail = (res, message, status = 500) => res.status(status).json({ success: false, message });

function adminAuth(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return fail(res, "Admin login required", 401);
  try {
    req.admin = jwt.verify(token, process.env.JWT_ADMIN_SECRET || process.env.JWT_SECRET);
    return next();
  } catch {
    return fail(res, "Invalid or expired admin token", 401);
  }
}

router.get("/admin/whatsapp/settings", adminAuth, async (_req, res) => {
  try { return ok(res, await whatsapp.getSettings(true)); } catch (error) { return fail(res, error.message); }
});

router.put("/admin/whatsapp/settings", adminAuth, async (req, res) => {
  try { return ok(res, await whatsapp.saveSettings(req.body, req.admin.admin_id), "WhatsApp settings saved."); }
  catch (error) { return fail(res, error.message, 400); }
});

router.post("/admin/whatsapp/test-message", adminAuth, async (req, res) => {
  try {
    const { mobile_no, template_key = "general_notification", variables = {}, message = "MMR WhatsApp test message" } = req.body;
    const row = await whatsapp.sendTemplate({ to: mobile_no, templateKey: template_key, variables: { message, ...variables } });
    return ok(res, row, "Test WhatsApp message sent.");
  } catch (error) { return fail(res, error.message, 400); }
});

router.get("/admin/whatsapp/templates", adminAuth, async (_req, res) => {
  try { return ok(res, await repo.templates()); } catch (error) { return fail(res, error.message); }
});

router.put("/admin/whatsapp/templates/:id", adminAuth, async (req, res) => {
  try {
    const payload = {
      template_name: req.body.template_name,
      template_category: req.body.template_category,
      language: req.body.language || "en_US",
      template_variables: Array.isArray(req.body.template_variables) ? req.body.template_variables : [],
      template_body: req.body.template_body,
      meta_template_name: req.body.meta_template_name || req.body.template_key,
      status: req.body.status || "Active",
      is_active: req.body.is_active !== false,
      updated_by_admin_id: req.admin.admin_id,
    };
    return ok(res, await repo.upsertTemplate(Number(req.params.id), payload), "Template updated.");
  } catch (error) { return fail(res, error.message, 400); }
});

router.patch("/admin/whatsapp/templates/:id/status", adminAuth, async (req, res) => {
  try {
    const isActive = Boolean(req.body.is_active);
    return ok(res, await repo.upsertTemplate(Number(req.params.id), { is_active: isActive, status: isActive ? "Active" : "Inactive", updated_by_admin_id: req.admin.admin_id }), "Template status updated.");
  } catch (error) { return fail(res, error.message, 400); }
});

router.get("/admin/whatsapp/logs", adminAuth, async (req, res) => {
  try {
    const rows = await sql`
      SELECT * FROM whatsapp_message_logs
      ORDER BY created_at DESC
      LIMIT ${Number(req.query.limit || 100)}`;
    return ok(res, rows);
  } catch (error) { return fail(res, error.message); }
});

router.get("/admin/whatsapp/queue", adminAuth, async (_req, res) => {
  try {
    const rows = await sql`SELECT * FROM notification_queue ORDER BY created_at DESC LIMIT 100`;
    return ok(res, rows);
  } catch (error) { return fail(res, error.message); }
});

router.post("/admin/whatsapp/queue/process", adminAuth, async (req, res) => {
  try { return ok(res, await whatsapp.processQueue(Number(req.body.limit || 10)), "Queue processed."); }
  catch (error) { return fail(res, error.message, 400); }
});

router.get("/admin/whatsapp/dashboard", adminAuth, async (_req, res) => {
  try { return ok(res, await repo.dashboard()); } catch (error) { return fail(res, error.message); }
});

router.post("/auth/whatsapp/send-otp", async (req, res) => {
  try {
    const result = await whatsapp.generateOtp({
      mobile: req.body.mobile_no,
      purpose: req.body.purpose || "Login",
      ip: req.ip,
      userAgent: req.headers["user-agent"] || null,
    });
    return ok(res, result, "OTP sent on WhatsApp.");
  } catch (error) { return fail(res, error.message, 400); }
});

router.post("/auth/whatsapp/verify-otp", async (req, res) => {
  try {
    return ok(res, await whatsapp.verifyOtp({
      mobile: req.body.mobile_no,
      purpose: req.body.purpose || "Login",
      otp: req.body.otp_code,
      ip: req.ip,
      userAgent: req.headers["user-agent"] || null,
    }), "OTP verified.");
  } catch (error) { return fail(res, error.message, 400); }
});

router.post("/auth/whatsapp/forgot-password", async (req, res) => {
  try {
    const mobile = String(req.body.mobile_no || "").replace(/\D/g, "");
    const [user] = await sql`SELECT user_id, mobile_no FROM users WHERE regexp_replace(mobile_no, '\\D', '', 'g') = ${mobile} LIMIT 1`;
    if (!user) return fail(res, "Mobile number is not registered.", 404);
    const result = await whatsapp.generateOtp({ mobile: user.mobile_no, purpose: "ResetPassword", userId: user.user_id, ip: req.ip, userAgent: req.headers["user-agent"] || null });
    return ok(res, result, "Password reset OTP sent on WhatsApp.");
  } catch (error) { return fail(res, error.message, 400); }
});

router.post("/auth/whatsapp/reset-password", async (req, res) => {
  try {
    const mobile = String(req.body.mobile_no || "").replace(/\D/g, "");
    const [user] = await sql`SELECT user_id, mobile_no FROM users WHERE regexp_replace(mobile_no, '\\D', '', 'g') = ${mobile} LIMIT 1`;
    if (!user) return fail(res, "Mobile number is not registered.", 404);
    await whatsapp.verifyOtp({ mobile: user.mobile_no, purpose: "ResetPassword", otp: req.body.otp_code, ip: req.ip, userAgent: req.headers["user-agent"] || null });
    const hash = await bcrypt.hash(req.body.new_password, 10);
    await sql`UPDATE users SET password_hash = ${hash}, updated_at = NOW() WHERE user_id = ${user.user_id}`;
    await whatsapp.enqueue("general_notification", user.mobile_no, { message: "Your MMR password has been reset successfully." }, user.user_id, null, 2);
    await whatsapp.processQueue(1).catch(() => {});
    return ok(res, {}, "Password reset successfully.");
  } catch (error) { return fail(res, error.message, 400); }
});

router.get("/whatsapp/webhook", async (req, res) => {
  const settings = await whatsapp.getSettings(false);
  let verifyToken = "";
  try { verifyToken = settings?.encrypted_verify_token ? (await import("../utils/encryption.js")).decrypt(settings.encrypted_verify_token) : ""; } catch {}
  if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === verifyToken) {
    return res.status(200).send(req.query["hub.challenge"]);
  }
  return res.sendStatus(403);
});

router.post("/whatsapp/webhook", async (req, res) => {
  try {
    await whatsapp.handleWebhook(req.body);
    return res.sendStatus(200);
  } catch (error) {
    console.error("[WhatsApp Webhook Error]", error);
    return res.sendStatus(200);
  }
});

export default router;

export const whatsappEvents = {
  enqueue: (...args) => whatsapp.enqueue(...args),
  processQueue: (...args) => whatsapp.processQueue(...args),
};
