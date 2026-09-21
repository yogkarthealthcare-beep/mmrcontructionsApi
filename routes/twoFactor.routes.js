import express from "express";
import { adminAuth } from "../middleware/auth.middleware.js";
import twoFactorService from "../services/twoFactor.service.js";

const router = express.Router();

const ok = (res, data, message = "Success", status = 200) =>
  res.status(status).json({ success: true, message, data });

const fail = (res, message = "Server error", status = 500) =>
  res.status(status).json({ success: false, message });

/**
 * GET /api/admin/test-otp/config
 * Retrieves 2Factor configuration status (NEVER returns plaintext or encrypted API key)
 */
router.get("/admin/test-otp/config", adminAuth, async (_req, res) => {
  try {
    const config = await twoFactorService.getConfig();
    return ok(res, config);
  } catch (error) {
    return fail(res, error.message || "Failed to load 2Factor configuration.", 500);
  }
});

/**
 * POST /api/admin/test-otp/config
 * Encrypts and saves 2Factor API Key into PostgreSQL
 */
router.post("/admin/test-otp/config", adminAuth, async (req, res) => {
  try {
    const { api_key } = req.body || {};
    const adminId = req.admin?.admin_id || req.admin?.id || req.admin?.email || "Admin";
    const result = await twoFactorService.saveConfig(api_key, adminId);
    return ok(res, result, "2Factor API Key saved and encrypted successfully.");
  } catch (error) {
    return fail(res, error.message || "Failed to save 2Factor API Key.", 400);
  }
});

/**
 * POST /api/admin/test-otp/send
 * Sends a real test OTP to a mobile number using 2Factor AUTOGEN API
 */
router.post("/admin/test-otp/send", adminAuth, async (req, res) => {
  try {
    const { mobile, template } = req.body || {};
    const adminId = req.admin?.admin_id || req.admin?.id || req.admin?.email || "Admin";
    const result = await twoFactorService.sendTestOtp({ mobile, template, adminId });
    return ok(res, result, "Test OTP sent successfully.");
  } catch (error) {
    return fail(res, error.message || "Failed to send test OTP.", 400);
  }
});

/**
 * POST /api/admin/test-otp/verify
 * Verifies a received OTP against the 2Factor Session ID
 */
router.post("/admin/test-otp/verify", adminAuth, async (req, res) => {
  try {
    const { session_id, otp } = req.body || {};
    const adminId = req.admin?.admin_id || req.admin?.id || req.admin?.email || "Admin";
    const result = await twoFactorService.verifyTestOtp({ sessionId: session_id, otp, adminId });
    return ok(res, result, result.message || "OTP verification successful.");
  } catch (error) {
    return fail(res, error.message || "OTP verification failed.", 400);
  }
});

/**
 * GET /api/admin/test-otp/logs
 * Retrieves masked audit history of test OTP attempts
 */
router.get("/admin/test-otp/logs", adminAuth, async (req, res) => {
  try {
    const limit = Number(req.query.limit) || 20;
    const logs = await twoFactorService.getLogs(limit);
    return ok(res, logs);
  } catch (error) {
    return fail(res, error.message || "Failed to load audit logs.", 500);
  }
});

export default router;
