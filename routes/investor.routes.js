import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import multer from "multer";
import sql from "../db.js";
import { sendEmail } from "../emailService.js";
import { saveFileToVPS, deleteFileFromStorage } from "../services/fileStorage.service.js";
import { generateInvestorPdf } from "../services/investorPdfService.js";

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const okMime = ["application/pdf", "image/jpeg", "image/png", "image/webp", "image/jpg"].includes(file.mimetype);
    okMime ? cb(null, true) : cb(new Error("Only PDF, JPG, PNG, and WEBP files are supported."));
  },
});

// ── Helpers ───────────────────────────────────────────────────
const ok = (res, data, msg = "Success", status = 200) =>
  res.status(status).json({ success: true, message: msg, data });

const err = (res, msg = "Request failed", status = 400) =>
  res.status(status).json({ success: false, message: msg });

const strongPassword = (value = "") =>
  /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/.test(value);

const publicBaseUrl = () => (process.env.FRONTEND_URL || "https://mmrconstructions.in").replace(/\/$/, "");

const notifyInvestor = async (investorId, title, message, type = "info", tx = sql) => {
  await tx`
    INSERT INTO investor_notifications (investor_id, title, message, notification_type)
    VALUES (${investorId}, ${title}, ${message}, ${type})
  `;
};

let investorSchemaReady;
async function ensureInvestorSchema() {
  if (investorSchemaReady) return investorSchemaReady;
  investorSchemaReady = (async () => {
    await sql`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`;
    await sql`
      CREATE TABLE IF NOT EXISTS investor_users (
        id SERIAL PRIMARY KEY,
        full_name VARCHAR(255) NOT NULL,
        mobile_number VARCHAR(50) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        address TEXT,
        city VARCHAR(100),
        state VARCHAR(100),
        country VARCHAR(100) DEFAULT 'India',
        pincode VARCHAR(20),
        pan_number VARCHAR(50),
        aadhaar_number VARCHAR(50),
        bank_name VARCHAR(255),
        account_number VARCHAR(100),
        ifsc_code VARCHAR(50),
        nominee_name VARCHAR(255),
        available_balance NUMERIC(12,2) DEFAULT 0,
        total_investment NUMERIC(12,2) DEFAULT 0,
        total_deposits NUMERIC(12,2) DEFAULT 0,
        total_settlements NUMERIC(12,2) DEFAULT 0,
        total_earnings NUMERIC(12,2) DEFAULT 0,
        total_withdrawals NUMERIC(12,2) DEFAULT 0,
        status VARCHAR(50) DEFAULT 'pending_verification',
        is_verified BOOLEAN DEFAULT false,
        profile_picture_url TEXT,
        email_verification_token TEXT,
        email_verification_expires TIMESTAMPTZ,
        reset_otp VARCHAR(10),
        reset_otp_expires TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        deleted_at TIMESTAMPTZ
      )`;
    await sql`ALTER TABLE investor_users ADD COLUMN IF NOT EXISTS total_settlements NUMERIC(12,2) DEFAULT 0`;
    await sql`ALTER TABLE investor_users ADD COLUMN IF NOT EXISTS total_earnings NUMERIC(12,2) DEFAULT 0`;
    await sql`ALTER TABLE investor_users ADD COLUMN IF NOT EXISTS email_verification_token TEXT`;
    await sql`ALTER TABLE investor_users ADD COLUMN IF NOT EXISTS email_verification_expires TIMESTAMPTZ`;
    await sql`ALTER TABLE investor_users ADD COLUMN IF NOT EXISTS sponsor_invite_code VARCHAR(80)`;
    await sql`ALTER TABLE investor_users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`;
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_investor_users_mobile_unique ON investor_users(mobile_number) WHERE deleted_at IS NULL`;
    await sql`CREATE INDEX IF NOT EXISTS idx_investor_users_status ON investor_users(status)`;

    await sql`
      CREATE TABLE IF NOT EXISTS investor_deposits (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        investor_id INTEGER NOT NULL REFERENCES investor_users(id) ON DELETE CASCADE,
        amount NUMERIC(12,2) NOT NULL,
        payment_method VARCHAR(100) NOT NULL,
        gateway VARCHAR(50),
        transaction_reference VARCHAR(255),
        payment_screenshot_url TEXT,
        payment_screenshot_data BYTEA,
        payment_screenshot_mime_type VARCHAR(120),
        status VARCHAR(50) DEFAULT 'pending',
        admin_remarks TEXT,
        approved_by INTEGER,
        approved_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        deleted_at TIMESTAMPTZ
      )`;
    await sql`ALTER TABLE investor_deposits ADD COLUMN IF NOT EXISTS gateway VARCHAR(50)`;
    await sql`ALTER TABLE investor_deposits ADD COLUMN IF NOT EXISTS payment_screenshot_data BYTEA`;
    await sql`ALTER TABLE investor_deposits ADD COLUMN IF NOT EXISTS payment_screenshot_mime_type VARCHAR(120)`;
    await sql`ALTER TABLE investor_deposits ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`;
    await sql`ALTER TABLE investor_deposits ALTER COLUMN transaction_reference DROP NOT NULL`;

    await sql`
      CREATE TABLE IF NOT EXISTS investor_withdrawals (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        investor_id INTEGER NOT NULL REFERENCES investor_users(id) ON DELETE CASCADE,
        amount NUMERIC(12,2) NOT NULL,
        bank_name VARCHAR(255) NOT NULL,
        account_number VARCHAR(100) NOT NULL,
        ifsc_code VARCHAR(50) NOT NULL,
        remarks TEXT,
        status VARCHAR(50) DEFAULT 'pending',
        admin_remarks TEXT,
        approved_by INTEGER,
        approved_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )`;
    await sql`
      CREATE TABLE IF NOT EXISTS investor_transactions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        investor_id INTEGER NOT NULL REFERENCES investor_users(id) ON DELETE CASCADE,
        transaction_id VARCHAR(100) UNIQUE NOT NULL,
        type VARCHAR(50) NOT NULL,
        amount NUMERIC(12,2) NOT NULL,
        status VARCHAR(50) NOT NULL,
        payment_method VARCHAR(100),
        gateway VARCHAR(50),
        reference_number VARCHAR(255),
        remarks TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )`;
    await sql`ALTER TABLE investor_transactions ADD COLUMN IF NOT EXISTS gateway VARCHAR(50)`;

    await sql`
      CREATE TABLE IF NOT EXISTS investor_documents (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        investor_id INTEGER NOT NULL REFERENCES investor_users(id) ON DELETE CASCADE,
        document_type VARCHAR(80) NOT NULL,
        original_file_name VARCHAR(255) NOT NULL,
        mime_type VARCHAR(120) NOT NULL,
        file_size_bytes BIGINT NOT NULL,
        file_data BYTEA NOT NULL,
        status VARCHAR(50) DEFAULT 'pending',
        admin_remarks TEXT,
        reviewed_by INTEGER,
        reviewed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        deleted_at TIMESTAMPTZ
      )`;
    await sql`
      CREATE TABLE IF NOT EXISTS investor_settlement_preferences (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        investor_id INTEGER NOT NULL UNIQUE REFERENCES investor_users(id) ON DELETE CASCADE,
        frequency VARCHAR(30) NOT NULL CHECK (frequency IN ('monthly','half_yearly','yearly')),
        locked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )`;
    await sql`
      CREATE TABLE IF NOT EXISTS settlement_change_requests (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        investor_id INTEGER NOT NULL REFERENCES investor_users(id) ON DELETE CASCADE,
        current_frequency VARCHAR(30),
        requested_frequency VARCHAR(30) NOT NULL CHECK (requested_frequency IN ('monthly','half_yearly','yearly')),
        reason TEXT,
        status VARCHAR(50) DEFAULT 'pending',
        admin_remarks TEXT,
        reviewed_by INTEGER,
        reviewed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )`;
    await sql`
      CREATE TABLE IF NOT EXISTS investor_notifications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        investor_id INTEGER NOT NULL REFERENCES investor_users(id) ON DELETE CASCADE,
        title VARCHAR(180) NOT NULL,
        message TEXT NOT NULL,
        notification_type VARCHAR(50) DEFAULT 'info',
        is_read BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`;
    await sql`
      CREATE TABLE IF NOT EXISTS investor_enrollments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        investor_id INTEGER REFERENCES investor_users(id) ON DELETE SET NULL,
        form_no VARCHAR(100),
        form_date DATE,
        branch_code VARCHAR(100),
        branch_name VARCHAR(255),
        investor_enrollment_id VARCHAR(100),
        project_name VARCHAR(255),
        inv_first_name VARCHAR(100) NOT NULL,
        inv_middle_name VARCHAR(100),
        inv_surname VARCHAR(100),
        fh_first_name VARCHAR(100),
        fh_middle_name VARCHAR(100),
        fh_surname VARCHAR(100),
        dob DATE,
        age INTEGER,
        gender VARCHAR(20),
        occupation VARCHAR(100),
        occupation_other VARCHAR(255),
        address TEXT,
        city VARCHAR(100),
        state VARCHAR(100),
        pin_code VARCHAR(20),
        mobile VARCHAR(50) NOT NULL,
        alt_tel VARCHAR(50),
        email VARCHAR(255),
        pan VARCHAR(50),
        aadhar VARCHAR(50),
        amount NUMERIC(12,2),
        amount_words VARCHAR(255),
        payment_mode VARCHAR(100),
        txn_no VARCHAR(100),
        txn_date DATE,
        bank_branch VARCHAR(255),
        nominees JSONB,
        decl_date DATE,
        decl_place VARCHAR(100),
        decl_signature_name VARCHAR(255),
        first_applicant_name VARCHAR(255),
        joint_applicant_name VARCHAR(255),
        app_status VARCHAR(50) DEFAULT 'Pending',
        verified_by VARCHAR(255),
        payment_status VARCHAR(50),
        payment_status_date DATE,
        authorized_signatory VARCHAR(255),
        photo_url TEXT,
        signature_first_url TEXT,
        signature_joint_url TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )`;
    await sql`CREATE INDEX IF NOT EXISTS idx_investor_documents_investor ON investor_documents(investor_id, status)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_investor_deposits_status ON investor_deposits(status, created_at)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_investor_transactions_investor ON investor_transactions(investor_id, created_at)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_settlement_requests_status ON settlement_change_requests(status, created_at)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_investor_notifications_investor ON investor_notifications(investor_id, created_at)`;
  })().catch((error) => {
    investorSchemaReady = null;
    throw error;
  });
  return investorSchemaReady;
}

router.use(async (_req, res, next) => {
  try {
    await ensureInvestorSchema();
    next();
  } catch (error) {
    console.error("[Investor Schema Error]", error);
    return err(res, "Investor module is not available right now.");
  }
});

const isAdminPrincipal = (principal = {}) => {
  const adminRoles = new Set(["SuperAdmin", "FinanceManager", "SiteManager", "SupportStaff", "Admin", "admin", "super_admin"]);
  return Boolean(principal.admin_id || adminRoles.has(principal.role));
};

// ── Auth Middlewares ──────────────────────────────────────────
export function authInvestor(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ success: false, message: "No authentication token provided." });
  }
  const token = authHeader.split(" ")[1];
  const jwtSecret = process.env.JWT_SECRET || "mmr_constructions_jwt_secret_2026_key";
  try {
    const decoded = jwt.verify(token, jwtSecret);
    if (decoded.role !== "Investor" && decoded.user_type !== "Investor") {
      return res.status(403).json({ success: false, message: "Access restricted to Investors only." });
    }
    req.investor = decoded;
    next();
  } catch (e) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_ADMIN_SECRET || jwtSecret);
      if (decoded.role !== "Investor" && decoded.user_type !== "Investor") {
        return res.status(403).json({ success: false, message: "Access restricted to Investors only." });
      }
      req.investor = decoded;
      next();
    } catch {
      return res.status(401).json({ success: false, message: "Invalid or expired session token." });
    }
  }
}

function authAdmin(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ success: false, message: "No admin token provided." });
  }
  const token = authHeader.split(" ")[1];
  const adminSecret = process.env.JWT_ADMIN_SECRET || process.env.JWT_SECRET || "mmr_constructions_jwt_secret_2026_key";
  try {
    req.admin = jwt.verify(token, adminSecret);
    if (!isAdminPrincipal(req.admin)) {
      return res.status(403).json({ success: false, message: "Admin access required." });
    }
    next();
  } catch (e) {
    try {
      req.admin = jwt.verify(token, process.env.JWT_SECRET || "mmr_constructions_jwt_secret_2026_key");
      if (!isAdminPrincipal(req.admin)) {
        return res.status(403).json({ success: false, message: "Admin access required." });
      }
      next();
    } catch {
      return res.status(401).json({ success: false, message: "Invalid admin token." });
    }
  }
}

// ──────────────────────────────────────────────────────────────
//  INVESTOR AUTHENTICATION APIs
// ──────────────────────────────────────────────────────────────

// POST /api/investor/register (or /signup)
async function handleInvestorRegistration(req, res) {
  try {
    const {
      full_name,
      mobile_number,
      mobile_no,
      email,
      password,
      address,
      city,
      state,
      country,
      pincode,
      pan_number,
      aadhaar_number,
      bank_name,
      account_number,
      ifsc_code,
      nominee_name
    } = req.body;

    const rawMobile = mobile_number || mobile_no;

    if (!full_name || !rawMobile || !email || !password) {
      return err(res, "Full Name, Mobile Number, Email, and Password are required.", 400);
    }
    if (!/^\S+@\S+\.\S+$/.test(String(email))) return err(res, "Please enter a valid email address.", 400);
    if (!/^\d{10}$/.test(String(rawMobile).replace(/\D/g, ""))) return err(res, "Please enter a valid 10 digit mobile number.", 400);

    const cleanEmail = String(email).trim().toLowerCase();
    const cleanMobile = String(rawMobile).replace(/\D/g, "");
    const cleanMobile10 = cleanMobile.length >= 10 ? cleanMobile.slice(-10) : cleanMobile;

    const [dupInvestor] = await sql`
      SELECT id FROM investor_users WHERE deleted_at IS NULL AND (LOWER(email) = ${cleanEmail} OR RIGHT(regexp_replace(mobile_number, '\\D', '', 'g'), 10) = ${cleanMobile10}) LIMIT 1
    `;
    const [dupUser] = await sql`
      SELECT user_id FROM users WHERE LOWER(email) = ${cleanEmail} OR RIGHT(regexp_replace(mobile_no, '\\D', '', 'g'), 10) = ${cleanMobile10} LIMIT 1
    `;
    if (dupInvestor || dupUser) {
      return err(res, "An account (Customer, Associate, or Investor) with this Email or Mobile Number already exists.", 409);
    }

    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(password, salt);
    const otp = String(Math.floor(100000 + Math.random() * 900000));
    const expires = new Date(Date.now() + 15 * 60 * 1000);

    // Save pending registration
    await sql`
      CREATE TABLE IF NOT EXISTS pending_registrations (
        email TEXT PRIMARY KEY,
        mobile_no TEXT NOT NULL,
        user_type TEXT NOT NULL,
        full_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        sponsor_user_id INTEGER,
        sponsor_invite_code TEXT,
        optional_data JSONB NOT NULL DEFAULT '{}'::jsonb,
        otp_code TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;

    await sql`
      DELETE FROM pending_registrations WHERE email = ${cleanEmail} OR mobile_no = ${cleanMobile}`;

    await sql`
      INSERT INTO pending_registrations (
        email, mobile_no, user_type, full_name, password_hash, otp_code, expires_at
      ) VALUES (
        ${cleanEmail}, ${cleanMobile}, 'Investor', ${full_name.trim()}, ${password_hash}, ${otp}, ${expires}
      )`;

    try {
      await sendEmail({
        to: cleanEmail,
        subject: "Verify your MMR Constructions Investor account",
        html: `<p>Hello ${full_name.trim()},</p><p>Your OTP for Investor account registration is: <strong>${otp}</strong></p><p>This OTP expires in 15 minutes.</p>`
      });
    } catch (mailErr) {
      console.warn("[Investor Verification Mail Error]", mailErr.message);
    }

    return ok(res, { email: cleanEmail, mobile_number: cleanMobile }, "OTP sent to your email. Please verify OTP to activate your account.", 201);
  } catch (e) {
    console.error("Investor Signup Error:", e);
    return err(res, e.message || "Failed to process signup.");
  }
}

router.post("/investor/register", handleInvestorRegistration);
router.post("/investor/signup", handleInvestorRegistration);

// POST /api/investor/send-otp
router.post("/investor/send-otp", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !/^\S+@\S+\.\S+$/.test(String(email))) {
      return err(res, "Valid email address is required.", 400);
    }
    const cleanEmail = String(email).trim().toLowerCase();
    const [pending] = await sql`SELECT email, full_name FROM pending_registrations WHERE email = ${cleanEmail}`;
    if (!pending) {
      return err(res, "No pending registration found for this email.", 404);
    }
    const otp = String(Math.floor(100000 + Math.random() * 900000));
    const expires = new Date(Date.now() + 15 * 60 * 1000);
    await sql`
      UPDATE pending_registrations
      SET otp_code = ${otp}, attempts = 0, expires_at = ${expires}, updated_at = NOW()
      WHERE email = ${cleanEmail}`;

    await sendEmail({
      to: cleanEmail,
      subject: "MMR Constructions — Investor OTP Code",
      html: `<p>Hello ${pending.full_name},</p><p>Your OTP code is: <strong>${otp}</strong></p>`
    });
    return ok(res, { email: cleanEmail }, "OTP code sent to email.");
  } catch (e) {
    return err(res, "Failed to send OTP.");
  }
});

// POST /api/investor/verify-otp
router.post("/investor/verify-otp", async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) return err(res, "Email and OTP are required.", 400);

    const cleanEmail = String(email).trim().toLowerCase();
    const cleanOtp = String(otp).trim();

    const [pending] = await sql`SELECT * FROM pending_registrations WHERE email = ${cleanEmail}`;
    if (!pending) return err(res, "No pending registration found.", 400);
    if (new Date() > new Date(pending.expires_at)) return err(res, "OTP has expired.", 400);
    if (pending.otp_code !== cleanOtp) return err(res, "Invalid OTP.", 400);

    const [newInvestor] = await sql`
      INSERT INTO investor_users (
        full_name, mobile_number, email, password_hash, status, is_verified, created_at, updated_at
      ) VALUES (
        ${pending.full_name}, ${pending.mobile_no}, ${pending.email}, ${pending.password_hash},
        'active', true, NOW(), NOW()
      )
      RETURNING id, full_name, email, mobile_number, status, is_verified, created_at
    `;

    await sql`DELETE FROM pending_registrations WHERE email = ${cleanEmail}`;
    await notifyInvestor(newInvestor.id, "Account Activated", "Your investor account is now active.", "registration");

    return ok(res, newInvestor, "Investor account verified and activated successfully.");
  } catch (e) {
    console.error("Investor Verify OTP Error:", e);
    return err(res, "Failed to verify OTP.");
  }
});

// POST /api/investor/login
router.post("/investor/login", async (req, res) => {
  try {
    const { identifier, email, password } = req.body;
    const loginId = (identifier || email || "").trim().toLowerCase();

    if (!loginId || !password) {
      return err(res, "Please provide email/mobile and password.", 400);
    }

    const [user] = await sql`
      SELECT * FROM investor_users
      WHERE LOWER(email) = ${loginId} OR mobile_number = ${loginId}
      LIMIT 1
    `;

    if (!user) {
      return err(res, "Invalid credentials or investor account not found.", 401);
    }

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return err(res, "Invalid credentials.", 401);
    }

    if (!user.is_verified || user.status === "pending_verification") {
      return err(res, "Please verify your email before login.", 403);
    }
    if (user.status === "inactive" || user.status === "rejected") {
      return err(res, `Account is currently ${user.status}. Please contact support.`, 403);
    }

    const payload = {
      id: user.id,
      user_id: user.id,
      email: user.email,
      full_name: user.full_name,
      role: "Investor",
      user_type: "Investor"
    };

    const secret = process.env.JWT_SECRET || "mmr_constructions_jwt_secret_2026_key";
    const refreshSecret = process.env.JWT_REFRESH_SECRET || secret;
    const token = jwt.sign(payload, secret, {
      expiresIn: process.env.JWT_EXPIRES_IN || "7d"
    });
    const refresh_token = jwt.sign(payload, refreshSecret, {
      expiresIn: "30d"
    });

    const { password_hash, ...investorData } = user;

    return ok(res, {
      token,
      refresh_token,
      user: investorData
    }, "Investor login successful.");
  } catch (e) {
    console.error("Investor Login Error:", e);
    return err(res, e.message || "Failed to process login.");
  }
});

router.get("/investor/verify-email", async (req, res) => {
  try {
    const token = String(req.query.token || "").trim();
    if (!token) return err(res, "Verification token is required.", 400);
    const [investor] = await sql`
      SELECT id FROM investor_users
      WHERE email_verification_token = ${token}
        AND email_verification_expires > NOW()
        AND deleted_at IS NULL
      LIMIT 1`;
    if (!investor) return err(res, "Verification link is invalid or expired.", 400);
    const [updated] = await sql`
      UPDATE investor_users
      SET is_verified = TRUE, status = 'active', email_verification_token = NULL,
          email_verification_expires = NULL, updated_at = NOW()
      WHERE id = ${investor.id}
      RETURNING id, full_name, email, status, is_verified`;
    await notifyInvestor(updated.id, "Email Verified", "Your investor email has been verified successfully.", "success");
    return ok(res, updated, "Email verified successfully. You can login now.");
  } catch (e) {
    console.error("Investor Verify Email Error:", e);
    return err(res, "Failed to verify email.");
  }
});

// POST /api/investor/forgot-password
router.post("/investor/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return err(res, "Email address is required.", 400);

    const cleanEmail = email.trim().toLowerCase();
    const [user] = await sql`SELECT id, full_name, email FROM investor_users WHERE LOWER(email) = ${cleanEmail} LIMIT 1`;

    if (!user) {
      // Security best practice: don't reveal email existence
      return ok(res, null, "If an account exists with this email, reset instructions have been sent.");
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expires = new Date(Date.now() + 15 * 60 * 1000); // 15 mins

    await sql`
      UPDATE investor_users
      SET reset_otp = ${otp}, reset_otp_expires = ${expires}
      WHERE id = ${user.id}
    `;

    try {
      await sendEmail({
        to: user.email,
        subject: "MMR Constructions — Investor Password Reset OTP",
        html: `<p>Hello ${user.full_name},</p><p>Your Password Reset OTP is: <strong>${otp}</strong></p><p>Valid for 15 minutes.</p>`
      });
    } catch (mailErr) {
      console.warn("Mail send error:", mailErr.message);
    }

    return ok(res, { otpSent: true }, "Reset OTP sent to your registered email address.");
  } catch (e) {
    console.error("Forgot Password Error:", e);
    return err(res, "Failed to process password reset request.");
  }
});

// POST /api/investor/reset-password
router.post("/investor/reset-password", async (req, res) => {
  try {
    const { email, otp, new_password } = req.body;
    if (!email || !otp || !new_password) {
      return err(res, "Email, OTP, and New Password are required.", 400);
    }

    const cleanEmail = email.trim().toLowerCase();
    const [user] = await sql`
      SELECT id, reset_otp, reset_otp_expires FROM investor_users
      WHERE LOWER(email) = ${cleanEmail} LIMIT 1
    `;

    if (!user || user.reset_otp !== String(otp).trim()) {
      return err(res, "Invalid OTP or email.", 400);
    }

    if (new Date() > new Date(user.reset_otp_expires)) {
      return err(res, "OTP has expired. Please request a new one.", 400);
    }

    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(new_password, salt);

    await sql`
      UPDATE investor_users
      SET password_hash = ${password_hash}, reset_otp = NULL, reset_otp_expires = NULL, updated_at = NOW()
      WHERE id = ${user.id}
    `;

    return ok(res, null, "Password reset successfully! You can now login.");
  } catch (e) {
    console.error("Reset Password Error:", e);
    return err(res, "Failed to reset password.");
  }
});

// ──────────────────────────────────────────────────────────────
//  INVESTOR DASHBOARD & PORTAL APIs
// ──────────────────────────────────────────────────────────────

// GET /api/investor/dashboard
router.get("/investor/dashboard", authInvestor, async (req, res) => {
  try {
    const investorId = req.investor.id;

    const [user] = await sql`
      SELECT id, full_name, email, mobile_number, available_balance, total_investment, total_deposits, total_withdrawals, status, is_verified, profile_picture_url, created_at
      FROM investor_users WHERE id = ${investorId}
    `;

    if (!user) return err(res, "Investor user not found.", 44);

    const [{ count: txCount }] = await sql`
      SELECT COUNT(*) FROM investor_transactions WHERE investor_id = ${investorId}
    `;

    const recentTransactions = await sql`
      SELECT id, transaction_id, type, amount, status, payment_method, reference_number, created_at
      FROM investor_transactions
      WHERE investor_id = ${investorId}
      ORDER BY created_at DESC
      LIMIT 5
    `;

    return ok(res, {
      investor: user,
      summary: {
        total_investment: Number(user.total_investment || 0),
        available_balance: Number(user.available_balance || 0),
        total_deposits: Number(user.total_deposits || 0),
        total_withdrawals: Number(user.total_withdrawals || 0),
        total_transactions: parseInt(txCount, 10) || 0
      },
      recent_transactions: recentTransactions
    });
  } catch (e) {
    console.error("Investor Dashboard Error:", e);
    return err(res, "Failed to load investor dashboard.");
  }
});

// GET /api/investor/profile
router.get("/investor/profile", authInvestor, async (req, res) => {
  try {
    const [user] = await sql`
      SELECT id, full_name, mobile_number, email, address, city, state, country, pincode,
             pan_number, aadhaar_number, bank_name, account_number, ifsc_code, nominee_name,
             available_balance, total_investment, total_deposits, total_withdrawals,
             status, is_verified, profile_picture_url, created_at, updated_at
      FROM investor_users WHERE id = ${req.investor.id}
    `;
    if (!user) return err(res, "Investor not found.", 404);
    return ok(res, user);
  } catch (e) {
    return err(res, "Failed to fetch profile.");
  }
});

// PUT /api/investor/profile
router.put("/investor/profile", authInvestor, async (req, res) => {
  try {
    const { full_name, mobile_number, address, city, state, country, pincode, nominee_name, pan_number, aadhaar_number } = req.body;

    if (mobile_number && !/^\d{10}$/.test(String(mobile_number).replace(/\D/g, ""))) {
      return err(res, "Please enter a valid 10 digit mobile number.", 400);
    }
    if (mobile_number) {
      const cleanMob = String(mobile_number).replace(/\D/g, "");
      const cleanMob10 = cleanMob.length >= 10 ? cleanMob.slice(-10) : cleanMob;
      const [existingMobileInvestor] = await sql`
        SELECT id FROM investor_users
        WHERE RIGHT(regexp_replace(mobile_number, '\\D', '', 'g'), 10) = ${cleanMob10}
          AND id <> ${req.investor.id}
          AND deleted_at IS NULL
        LIMIT 1`;
      const [existingMobileUser] = await sql`
        SELECT user_id FROM users
        WHERE RIGHT(regexp_replace(mobile_no, '\\D', '', 'g'), 10) = ${cleanMob10}
        LIMIT 1`;
      if (existingMobileInvestor || existingMobileUser) {
        return err(res, "Mobile number is already registered to another account (Customer, Associate, or Investor).", 409);
      }
    }

    const [updated] = await sql`
      UPDATE investor_users
      SET full_name = COALESCE(${full_name}, full_name),
          mobile_number = COALESCE(${mobile_number ? String(mobile_number).replace(/\D/g, "") : null}, mobile_number),
          address = COALESCE(${address}, address),
          city = COALESCE(${city}, city),
          state = COALESCE(${state}, state),
          country = COALESCE(${country}, country),
          pincode = COALESCE(${pincode}, pincode),
          nominee_name = COALESCE(${nominee_name}, nominee_name),
          pan_number = COALESCE(${pan_number}, pan_number),
          aadhaar_number = COALESCE(${aadhaar_number}, aadhaar_number),
          updated_at = NOW()
      WHERE id = ${req.investor.id}
      RETURNING id, full_name, mobile_number, email, address, city, state, country, pincode, nominee_name, pan_number, aadhaar_number, profile_picture_url
    `;

    return ok(res, updated, "Profile updated successfully.");
  } catch (e) {
    return err(res, "Failed to update profile.");
  }
});

router.post("/investor/profile/photo", authInvestor, upload.single("profile_photo"), async (req, res) => {
  try {
    if (!req.file) return err(res, "Profile photo is required.", 400);
    const saved = await saveFileToVPS(req.file.buffer, { module: "investor", entityId: req.investor.id, entityType: "InvestorPhoto", originalName: req.file.originalname });
    const [updated] = await sql`
      UPDATE investor_users
      SET profile_picture_url = ${saved.url}, updated_at = NOW()
      WHERE id = ${req.investor.id}
      RETURNING id, profile_picture_url`;
    return ok(res, updated, "Profile photo updated successfully.");
  } catch (e) {
    return err(res, "Failed to update profile photo.");
  }
});

router.get("/investor/documents", authInvestor, async (req, res) => {
  try {
    const rows = await sql`
      SELECT id, document_type, original_file_name, mime_type, file_size_bytes, status,
             admin_remarks, reviewed_at, created_at, updated_at
      FROM investor_documents
      WHERE investor_id = ${req.investor.id} AND deleted_at IS NULL
      ORDER BY created_at DESC`;
    return ok(res, rows);
  } catch (e) {
    return err(res, "Failed to load investor documents.");
  }
});

router.post("/investor/documents", authInvestor, upload.single("document"), async (req, res) => {
  try {
    const documentType = String(req.body.document_type || "").trim();
    const allowedTypes = ["pan_card", "aadhaar_card", "passport_photo", "property_document", "supporting_document"];
    if (!allowedTypes.includes(documentType)) return err(res, "Invalid document type.", 400);
    if (!req.file) return err(res, "Document file is required.", 400);

    const [existingApproved] = await sql`
      SELECT id FROM investor_documents
      WHERE investor_id = ${req.investor.id}
        AND document_type = ${documentType}
        AND status = 'approved'
        AND deleted_at IS NULL
      LIMIT 1`;
    if (existingApproved) return err(res, "Approved documents cannot be replaced from investor panel.", 400);

    await sql`
      UPDATE investor_documents
      SET deleted_at = NOW(), updated_at = NOW()
      WHERE investor_id = ${req.investor.id}
        AND document_type = ${documentType}
        AND status <> 'approved'
        AND deleted_at IS NULL`;

    const saved = await saveFileToVPS(req.file.buffer, { module: "investor", entityId: req.investor.id, entityType: documentType, originalName: req.file.originalname });

    const [created] = await sql`
      INSERT INTO investor_documents (
        investor_id, document_type, original_file_name, mime_type, file_size_bytes, file_url, file_data, status
      ) VALUES (
        ${req.investor.id}, ${documentType}, ${req.file.originalname}, ${req.file.mimetype},
        ${req.file.size}, ${saved.url}, ${req.file.buffer}, 'pending'
      )
      RETURNING id, document_type, original_file_name, mime_type, file_size_bytes, status, created_at`;
    await notifyInvestor(req.investor.id, "Document Submitted", "Your document was uploaded and is pending admin review.", "document");
    return ok(res, created, "Document uploaded successfully.", 201);
  } catch (e) {
    console.error("Investor Document Upload Error:", e);
    return err(res, "Failed to upload document.");
  }
});

router.get("/investor/documents/:id/file", authInvestor, async (req, res) => {
  try {
    const [doc] = await sql`
      SELECT original_file_name, mime_type, file_data FROM investor_documents
      WHERE id = ${req.params.id} AND investor_id = ${req.investor.id} AND deleted_at IS NULL`;
    if (!doc) return err(res, "Document not found.", 404);
    res.setHeader("Content-Type", doc.mime_type);
    res.setHeader("Content-Disposition", `inline; filename="${doc.original_file_name.replace(/"/g, "")}"`);
    return res.send(doc.file_data);
  } catch (e) {
    return err(res, "Failed to load document.");
  }
});

router.delete("/investor/documents/:id", authInvestor, async (req, res) => {
  try {
    const [doc] = await sql`
      UPDATE investor_documents
      SET deleted_at = NOW(), updated_at = NOW()
      WHERE id = ${req.params.id}
        AND investor_id = ${req.investor.id}
        AND status <> 'approved'
        AND deleted_at IS NULL
      RETURNING id`;
    if (!doc) return err(res, "Only pending or rejected documents can be deleted.", 400);
    return ok(res, doc, "Document deleted successfully.");
  } catch (e) {
    return err(res, "Failed to delete document.");
  }
});

router.get("/investor/wallet", authInvestor, async (req, res) => {
  try {
    const [wallet] = await sql`
      SELECT available_balance AS current_balance, total_deposits, total_settlements,
             total_earnings, total_withdrawals
      FROM investor_users WHERE id = ${req.investor.id}`;
    const [lastTransaction] = await sql`
      SELECT transaction_id, type, amount, status, created_at
      FROM investor_transactions
      WHERE investor_id = ${req.investor.id}
      ORDER BY created_at DESC
      LIMIT 1`;
    return ok(res, { ...wallet, last_transaction: lastTransaction || null });
  } catch (e) {
    return err(res, "Failed to load wallet.");
  }
});

router.get("/investor/settlement-preference", authInvestor, async (req, res) => {
  try {
    const [preference] = await sql`
      SELECT * FROM investor_settlement_preferences WHERE investor_id = ${req.investor.id}`;
    const requests = await sql`
      SELECT * FROM settlement_change_requests
      WHERE investor_id = ${req.investor.id}
      ORDER BY created_at DESC LIMIT 10`;
    return ok(res, { preference: preference || null, requests });
  } catch (e) {
    return err(res, "Failed to load settlement preference.");
  }
});

router.post("/investor/settlement-preference", authInvestor, async (req, res) => {
  try {
    const frequency = String(req.body.frequency || "").trim();
    if (!["monthly", "half_yearly", "yearly"].includes(frequency)) return err(res, "Invalid settlement frequency.", 400);
    const [created] = await sql`
      INSERT INTO investor_settlement_preferences (investor_id, frequency)
      VALUES (${req.investor.id}, ${frequency})
      ON CONFLICT (investor_id) DO NOTHING
      RETURNING *`;
    if (!created) return err(res, "Settlement frequency can be selected only once. Please request an admin change.", 400);
    await notifyInvestor(req.investor.id, "Settlement Preference Saved", "Your settlement frequency has been locked.", "settlement");
    return ok(res, created, "Settlement preference saved.");
  } catch (e) {
    return err(res, "Failed to save settlement preference.");
  }
});

router.post("/investor/settlement-change-request", authInvestor, async (req, res) => {
  try {
    const requested = String(req.body.requested_frequency || "").trim();
    const reason = String(req.body.reason || "").trim();
    if (!["monthly", "half_yearly", "yearly"].includes(requested)) return err(res, "Invalid requested frequency.", 400);
    const [preference] = await sql`SELECT frequency FROM investor_settlement_preferences WHERE investor_id = ${req.investor.id}`;
    if (!preference) return err(res, "Please select your first settlement preference before requesting a change.", 400);
    const [pending] = await sql`
      SELECT id FROM settlement_change_requests
      WHERE investor_id = ${req.investor.id} AND status = 'pending'
      LIMIT 1`;
    if (pending) return err(res, "A settlement change request is already pending.", 400);
    const [created] = await sql`
      INSERT INTO settlement_change_requests (investor_id, current_frequency, requested_frequency, reason)
      VALUES (${req.investor.id}, ${preference.frequency}, ${requested}, ${reason || null})
      RETURNING *`;
    return ok(res, created, "Settlement change request submitted.", 201);
  } catch (e) {
    return err(res, "Failed to submit settlement change request.");
  }
});

router.get("/investor/notifications", authInvestor, async (req, res) => {
  try {
    const rows = await sql`
      SELECT * FROM investor_notifications
      WHERE investor_id = ${req.investor.id}
      ORDER BY created_at DESC
      LIMIT 100`;
    return ok(res, rows);
  } catch (e) {
    return err(res, "Failed to load notifications.");
  }
});

router.patch("/investor/notifications/:id/read", authInvestor, async (req, res) => {
  try {
    const [row] = await sql`
      UPDATE investor_notifications SET is_read = TRUE
      WHERE id = ${req.params.id} AND investor_id = ${req.investor.id}
      RETURNING id`;
    if (!row) return err(res, "Notification not found.", 404);
    return ok(res, row, "Notification marked as read.");
  } catch (e) {
    return err(res, "Failed to update notification.");
  }
});

// PUT /api/investor/change-password
router.put("/investor/change-password", authInvestor, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) {
      return err(res, "Current password and new password are required.", 400);
    }

    const [user] = await sql`SELECT password_hash FROM investor_users WHERE id = ${req.investor.id}`;
    const match = await bcrypt.compare(current_password, user.password_hash);
    if (!match) {
      return err(res, "Current password is incorrect.", 400);
    }

    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(new_password, salt);

    await sql`UPDATE investor_users SET password_hash = ${password_hash}, updated_at = NOW() WHERE id = ${req.investor.id}`;
    return ok(res, null, "Password changed successfully.");
  } catch (e) {
    return err(res, "Failed to change password.");
  }
});

// PUT /api/investor/bank-details
router.put("/investor/bank-details", authInvestor, async (req, res) => {
  try {
    const { bank_name, account_number, ifsc_code } = req.body;

    const [updated] = await sql`
      UPDATE investor_users
      SET bank_name = ${bank_name || null},
          account_number = ${account_number || null},
          ifsc_code = ${ifsc_code ? ifsc_code.trim().toUpperCase() : null},
          updated_at = NOW()
      WHERE id = ${req.investor.id}
      RETURNING id, bank_name, account_number, ifsc_code
    `;

    return ok(res, updated, "Bank details updated successfully.");
  } catch (e) {
    return err(res, "Failed to update bank details.");
  }
});

// POST /api/investor/deposit
router.post("/investor/deposit", authInvestor, upload.single("payment_screenshot"), async (req, res) => {
  try {
    const { amount, payment_method, gateway, transaction_reference, payment_screenshot_url } = req.body;
    const numAmount = Number(amount);

    if (isNaN(numAmount) || numAmount <= 0) {
      return err(res, "Please enter a valid deposit amount greater than zero.", 400);
    }
    if (!payment_method) {
      return err(res, "Payment Method is required.", 400);
    }
    if (payment_method !== "online" && !transaction_reference) {
      return err(res, "Transaction Reference / UTR Number is required for manual payment.", 400);
    }

    const investorId = req.investor.id;

    // Create Deposit request
    const [deposit] = await sql`
      INSERT INTO investor_deposits (
        investor_id, amount, payment_method, gateway, transaction_reference, payment_screenshot_url,
        payment_screenshot_data, payment_screenshot_mime_type, status
      ) VALUES (
        ${investorId}, ${numAmount}, ${payment_method}, ${gateway || null}, ${transaction_reference || null},
        ${payment_screenshot_url || null}, ${req.file?.buffer || null}, ${req.file?.mimetype || null}, 'pending'
      )
      RETURNING *
    `;

    // Create Transaction Record
    const txId = `DEP-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    await sql`
      INSERT INTO investor_transactions (
        investor_id, transaction_id, type, amount, status, payment_method, reference_number
      ) VALUES (
        ${investorId}, ${txId}, 'deposit', ${numAmount}, 'pending', ${payment_method}, ${transaction_reference || deposit.id}
      )
    `;
    await notifyInvestor(investorId, "Deposit Submitted", "Your deposit request is pending admin verification.", "deposit");

    return ok(res, deposit, "Deposit request submitted successfully! Awaiting admin approval.", 201);
  } catch (e) {
    console.error("Deposit Error:", e);
    return err(res, "Failed to submit deposit request.");
  }
});

router.get("/investor/deposits/:id/screenshot", authInvestor, async (req, res) => {
  try {
    const [deposit] = await sql`
      SELECT payment_screenshot_data, payment_screenshot_mime_type
      FROM investor_deposits
      WHERE id = ${req.params.id} AND investor_id = ${req.investor.id}`;
    if (!deposit?.payment_screenshot_data) return err(res, "Screenshot not found.", 404);
    res.setHeader("Content-Type", deposit.payment_screenshot_mime_type || "application/octet-stream");
    return res.send(deposit.payment_screenshot_data);
  } catch (e) {
    return err(res, "Failed to load payment screenshot.");
  }
});

// GET /api/investor/deposits
router.get("/investor/deposits", authInvestor, async (req, res) => {
  try {
    const deposits = await sql`
      SELECT * FROM investor_deposits
      WHERE investor_id = ${req.investor.id}
      ORDER BY created_at DESC
    `;
    return ok(res, deposits);
  } catch (e) {
    return err(res, "Failed to fetch deposits.");
  }
});

// POST /api/investor/withdraw
router.post("/investor/withdraw", authInvestor, async (req, res) => {
  try {
    const { amount, bank_name, account_number, ifsc_code, remarks } = req.body;
    const numAmount = Number(amount);

    if (isNaN(numAmount) || numAmount <= 0) {
      return err(res, "Please enter a valid withdrawal amount greater than zero.", 400);
    }

    const investorId = req.investor.id;

    // Check available balance
    const [user] = await sql`SELECT available_balance, bank_name, account_number, ifsc_code FROM investor_users WHERE id = ${investorId}`;
    if (!user) return err(res, "Investor account not found.", 404);

    const availBal = Number(user.available_balance || 0);
    if (numAmount > availBal) {
      return err(res, `Requested amount ₹${numAmount} exceeds available balance of ₹${availBal.toFixed(2)}.`, 400);
    }

    const bName = bank_name || user.bank_name;
    const accNum = account_number || user.account_number;
    const ifsc = ifsc_code || user.ifsc_code;

    if (!accNum || !ifsc) {
      return err(res, "Bank Account Number and IFSC Code are required.", 400);
    }

    // Create withdrawal request
    const [withdrawal] = await sql`
      INSERT INTO investor_withdrawals (
        investor_id, amount, bank_name, account_number, ifsc_code, remarks, status
      ) VALUES (
        ${investorId}, ${numAmount}, ${bName}, ${accNum}, ${ifsc ? ifsc.toUpperCase() : ''}, ${remarks || null}, 'pending'
      )
      RETURNING *
    `;

    // Create transaction record
    const txId = `WTH-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    await sql`
      INSERT INTO investor_transactions (
        investor_id, transaction_id, type, amount, status, payment_method, reference_number, remarks
      ) VALUES (
        ${investorId}, ${txId}, 'withdrawal', ${numAmount}, 'pending', 'Bank Transfer', ${withdrawal.id}, ${remarks || null}
      )
    `;

    return ok(res, withdrawal, "Withdrawal request submitted successfully! Awaiting admin processing.", 201);
  } catch (e) {
    console.error("Withdrawal Error:", e);
    return err(res, "Failed to submit withdrawal request.");
  }
});

// GET /api/investor/withdrawals
router.get("/investor/withdrawals", authInvestor, async (req, res) => {
  try {
    const withdrawals = await sql`
      SELECT * FROM investor_withdrawals
      WHERE investor_id = ${req.investor.id}
      ORDER BY created_at DESC
    `;
    return ok(res, withdrawals);
  } catch (e) {
    return err(res, "Failed to fetch withdrawals.");
  }
});

// GET /api/investor/payments or /transactions
async function handleInvestorTransactions(req, res) {
  try {
    const investorId = req.investor.id;
    const { search, type, status, page = 1, limit = 20 } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.max(1, Math.min(100, parseInt(limit, 10) || 20));
    const offset = (pageNum - 1) * limitNum;

    let query = sql`SELECT * FROM investor_transactions WHERE investor_id = ${investorId}`;

    if (search) {
      const s = `%${search.trim()}%`;
      query = sql`${query} AND (transaction_id ILIKE ${s} OR reference_number ILIKE ${s} OR payment_method ILIKE ${s})`;
    }
    if (type && type !== "all") {
      query = sql`${query} AND type = ${type}`;
    }
    if (status && status !== "all") {
      query = sql`${query} AND status = ${status}`;
    }

    const [{ count }] = await sql`SELECT COUNT(*) FROM (${query}) AS count_query`;
    const rows = await sql`${query} ORDER BY created_at DESC LIMIT ${limitNum} OFFSET ${offset}`;

    return ok(res, {
      items: rows,
      total: parseInt(count, 10),
      page: pageNum,
      limit: limitNum,
      total_pages: Math.ceil(parseInt(count, 10) / limitNum)
    });
  } catch (e) {
    console.error("Investor Payments Error:", e);
    return err(res, "Failed to fetch transaction history.");
  }
}

router.get("/investor/payments", authInvestor, handleInvestorTransactions);
router.get("/investor/transactions", authInvestor, handleInvestorTransactions);

// ──────────────────────────────────────────────────────────────
//  ADMIN INVESTOR PORTAL APIs
// ──────────────────────────────────────────────────────────────

// GET /api/admin/investors-portal
router.get("/admin/investors-portal", authAdmin, async (req, res) => {
  try {
    const { search, status, page = 1, limit = 20 } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.max(1, Math.min(1000, parseInt(limit, 10) || 20));
    const offset = (pageNum - 1) * limitNum;

    let query = sql`SELECT id, full_name, mobile_number, email, city, state, pan_number, bank_name, account_number, ifsc_code, available_balance, total_investment, total_deposits, total_withdrawals, status, is_verified, profile_picture_url, COALESCE(sponsor_invite_code, 'MMR00001') AS sponsor_invite_code, created_at FROM investor_users WHERE deleted_at IS NULL`;

    if (search) {
      const s = `%${search.trim()}%`;
      query = sql`${query} AND (full_name ILIKE ${s} OR email ILIKE ${s} OR mobile_number ILIKE ${s} OR pan_number ILIKE ${s} OR sponsor_invite_code ILIKE ${s})`;
    }
    if (status && status !== "all") {
      query = sql`${query} AND status = ${status}`;
    }

    const [{ count }] = await sql`SELECT COUNT(*) FROM (${query}) AS count_query`;
    const rows = await sql`${query} ORDER BY created_at DESC LIMIT ${limitNum} OFFSET ${offset}`;

    return ok(res, {
      items: rows,
      total: parseInt(count, 10),
      page: pageNum,
      limit: limitNum,
      total_pages: Math.ceil(parseInt(count, 10) / limitNum)
    });
  } catch (e) {
    console.error("Admin Investors Portal Error:", e);
    return err(res, "Failed to load investors list.");
  }
});

// PUT /api/admin/investors-portal/:id/status
router.put("/admin/investors-portal/:id/status", authAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, is_verified } = req.body;

    const [updated] = await sql`
      UPDATE investor_users
      SET status = COALESCE(${status}, status),
          is_verified = COALESCE(${is_verified}, is_verified),
          updated_at = NOW()
      WHERE id = ${id}
      RETURNING id, full_name, email, status, is_verified
    `;

    if (!updated) return err(res, "Investor account not found.", 404);

    // If investor profile exists in investors table, sync active status if deactivating
    if (status === 'inactive' || status === 'rejected') {
      await sql`UPDATE investors SET is_active = FALSE, updated_at = NOW() WHERE user_id = ${id}`;
    } else if (status === 'active' || status === 'approved') {
      await sql`UPDATE investors SET is_active = TRUE, updated_at = NOW() WHERE user_id = ${id}`;
    }

    return ok(res, updated, `Investor account updated to ${updated.status}.`);
  } catch (e) {
    console.error("[Update Investor Portal Status Error]", e);
    return err(res, "Failed to update investor status.");
  }
});

// GET /api/admin/investors-portal/deposits
router.get("/admin/investors-portal/deposits", authAdmin, async (req, res) => {
  try {
    const { status } = req.query;
    let query = sql`
      SELECT d.*, u.full_name as investor_name, u.email as investor_email, u.mobile_number as investor_mobile
      FROM investor_deposits d
      JOIN investor_users u ON d.investor_id = u.id
    `;
    if (status && status !== 'all') {
      query = sql`${query} WHERE d.status = ${status}`;
    }
    const rows = await sql`${query} ORDER BY d.created_at DESC`;
    return ok(res, rows);
  } catch (e) {
    return err(res, "Failed to fetch deposits.");
  }
});

// PUT /api/admin/investors-portal/deposits/:id/status
router.put("/admin/investors-portal/deposits/:id/status", authAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, admin_remarks } = req.body;

    if (!['approved', 'rejected'].includes(status)) {
      return err(res, "Status must be approved or rejected.", 400);
    }

    const [deposit] = await sql`SELECT * FROM investor_deposits WHERE id = ${id}`;
    if (!deposit) return err(res, "Deposit request not found.", 404);

    if (deposit.status !== 'pending') {
      return err(res, `Deposit request is already ${deposit.status}.`, 400);
    }

    const amount = Number(deposit.amount);

    if (status === 'approved') {
      // Update deposit status & investor balances atomically
      await sql.begin(async (tx) => {
        await tx`
          UPDATE investor_deposits
          SET status = 'approved', admin_remarks = ${admin_remarks || null}, approved_at = NOW(), updated_at = NOW()
          WHERE id = ${id}
        `;

        await tx`
          UPDATE investor_users
          SET available_balance = available_balance + ${amount},
              total_deposits = total_deposits + ${amount},
              total_investment = total_investment + ${amount},
              updated_at = NOW()
          WHERE id = ${deposit.investor_id}
        `;

        await tx`
          UPDATE investor_transactions
          SET status = 'approved', updated_at = NOW()
          WHERE investor_id = ${deposit.investor_id} AND reference_number = ${deposit.transaction_reference}
        `;
        await notifyInvestor(deposit.investor_id, "Deposit Approved", `Your deposit of ₹${amount.toFixed(2)} has been approved and credited.`, "success", tx);
      });
    } else {
      await sql.begin(async (tx) => {
        await tx`
          UPDATE investor_deposits
          SET status = 'rejected', admin_remarks = ${admin_remarks || null}, updated_at = NOW()
          WHERE id = ${id}
        `;

        await tx`
          UPDATE investor_transactions
          SET status = 'rejected', updated_at = NOW()
          WHERE investor_id = ${deposit.investor_id} AND reference_number = ${deposit.transaction_reference}
        `;
        await notifyInvestor(deposit.investor_id, "Deposit Rejected", admin_remarks || "Your deposit request was rejected by admin.", "error", tx);
      });
    }

    return ok(res, null, `Deposit request ${status} successfully.`);
  } catch (e) {
    console.error("Admin Deposit Status Error:", e);
    return err(res, "Failed to update deposit status.");
  }
});

router.get("/admin/investors-portal/documents", authAdmin, async (req, res) => {
  try {
    const { status, investor_id } = req.query;
    let query = sql`
      SELECT d.id, d.investor_id, d.document_type, d.original_file_name, d.mime_type,
             d.file_size_bytes, d.status, d.admin_remarks, d.reviewed_at, d.created_at,
             u.full_name AS investor_name, u.email AS investor_email, u.mobile_number AS investor_mobile
      FROM investor_documents d
      JOIN investor_users u ON u.id = d.investor_id
      WHERE d.deleted_at IS NULL`;
    if (status && status !== "all") query = sql`${query} AND d.status = ${status}`;
    if (investor_id) query = sql`${query} AND d.investor_id = ${Number(investor_id)}`;
    const rows = await sql`${query} ORDER BY d.created_at DESC`;
    return ok(res, rows);
  } catch (e) {
    return err(res, "Failed to load investor documents.");
  }
});

router.get("/admin/investors-portal/documents/:id/file", authAdmin, async (req, res) => {
  try {
    const [doc] = await sql`
      SELECT original_file_name, mime_type, file_data FROM investor_documents
      WHERE id = ${req.params.id} AND deleted_at IS NULL`;
    if (!doc) return err(res, "Document not found.", 404);
    res.setHeader("Content-Type", doc.mime_type);
    res.setHeader("Content-Disposition", `inline; filename="${doc.original_file_name.replace(/"/g, "")}"`);
    return res.send(doc.file_data);
  } catch (e) {
    return err(res, "Failed to load document.");
  }
});

router.put("/admin/investors-portal/documents/:id/status", authAdmin, async (req, res) => {
  try {
    const status = String(req.body.status || "").trim();
    const remarks = req.body.admin_remarks || null;
    if (!["approved", "rejected"].includes(status)) return err(res, "Status must be approved or rejected.", 400);
    const [doc] = await sql`
      UPDATE investor_documents
      SET status = ${status}, admin_remarks = ${remarks}, reviewed_by = ${req.admin.admin_id || null},
          reviewed_at = NOW(), updated_at = NOW()
      WHERE id = ${req.params.id} AND deleted_at IS NULL
      RETURNING id, investor_id, document_type, status`;
    if (!doc) return err(res, "Document not found.", 404);
    await notifyInvestor(
      doc.investor_id,
      status === "approved" ? "Document Approved" : "Document Rejected",
      status === "approved" ? `Your ${doc.document_type} document was approved.` : (remarks || `Your ${doc.document_type} document was rejected.`),
      status === "approved" ? "success" : "error"
    );
    return ok(res, doc, `Document ${status}.`);
  } catch (e) {
    return err(res, "Failed to update document status.");
  }
});

router.get("/admin/investors-portal/settlement-requests", authAdmin, async (req, res) => {
  try {
    const rows = await sql`
      SELECT r.*, u.full_name AS investor_name, u.email AS investor_email, u.mobile_number AS investor_mobile
      FROM settlement_change_requests r
      JOIN investor_users u ON u.id = r.investor_id
      ORDER BY r.created_at DESC`;
    return ok(res, rows);
  } catch (e) {
    return err(res, "Failed to load settlement change requests.");
  }
});

router.put("/admin/investors-portal/settlement-requests/:id/status", authAdmin, async (req, res) => {
  try {
    const status = String(req.body.status || "").trim();
    const remarks = req.body.admin_remarks || null;
    if (!["approved", "rejected"].includes(status)) return err(res, "Status must be approved or rejected.", 400);
    const [request] = await sql`SELECT * FROM settlement_change_requests WHERE id = ${req.params.id}`;
    if (!request) return err(res, "Settlement change request not found.", 404);
    if (request.status !== "pending") return err(res, `Request is already ${request.status}.`, 400);

    await sql.begin(async (tx) => {
      await tx`
        UPDATE settlement_change_requests
        SET status = ${status}, admin_remarks = ${remarks}, reviewed_by = ${req.admin.admin_id || null},
            reviewed_at = NOW(), updated_at = NOW()
        WHERE id = ${req.params.id}`;
      if (status === "approved") {
        await tx`
          UPDATE investor_settlement_preferences
          SET frequency = ${request.requested_frequency}, updated_at = NOW()
          WHERE investor_id = ${request.investor_id}`;
      }
      await notifyInvestor(
        request.investor_id,
        status === "approved" ? "Settlement Change Approved" : "Settlement Change Rejected",
        status === "approved" ? "Your settlement frequency change was approved." : (remarks || "Your settlement frequency change was rejected."),
        status === "approved" ? "success" : "error",
        tx
      );
    });
    return ok(res, null, `Settlement change request ${status}.`);
  } catch (e) {
    return err(res, "Failed to update settlement change request.");
  }
});

router.post("/admin/investors-portal/:id/wallet-adjustment", authAdmin, async (req, res) => {
  try {
    const investorId = Number(req.params.id);
    const amount = Number(req.body.amount);
    const direction = String(req.body.direction || "credit").trim();
    const remarks = String(req.body.remarks || "").trim();
    if (!Number.isFinite(amount) || amount <= 0) return err(res, "Enter a valid adjustment amount.", 400);
    if (!["credit", "debit"].includes(direction)) return err(res, "Direction must be credit or debit.", 400);

    const signedAmount = direction === "credit" ? amount : -amount;
    const txId = `ADJ-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    await sql.begin(async (tx) => {
      const [user] = await tx`SELECT available_balance FROM investor_users WHERE id = ${investorId} FOR UPDATE`;
      if (!user) throw new Error("Investor account not found.");
      if (direction === "debit" && Number(user.available_balance || 0) < amount) throw new Error("Insufficient investor balance.");
      await tx`
        UPDATE investor_users
        SET available_balance = available_balance + ${signedAmount}, updated_at = NOW()
        WHERE id = ${investorId}`;
      await tx`
        INSERT INTO investor_transactions (investor_id, transaction_id, type, amount, status, payment_method, remarks)
        VALUES (${investorId}, ${txId}, ${direction === "credit" ? "adjustment_credit" : "adjustment_debit"}, ${amount}, 'approved', 'Admin Adjustment', ${remarks || null})`;
      await notifyInvestor(investorId, "Wallet Adjustment", `Admin ${direction} adjustment of ₹${amount.toFixed(2)} was applied.`, "wallet", tx);
    });
    return ok(res, { transaction_id: txId }, "Wallet adjustment completed.");
  } catch (e) {
    return err(res, e.message || "Failed to adjust investor wallet.", 400);
  }
});

// GET /api/admin/investors-portal/withdrawals
router.get("/admin/investors-portal/withdrawals", authAdmin, async (req, res) => {
  try {
    const { status } = req.query;
    let query = sql`
      SELECT w.*, u.full_name as investor_name, u.email as investor_email, u.mobile_number as investor_mobile, u.available_balance as current_balance
      FROM investor_withdrawals w
      JOIN investor_users u ON w.investor_id = u.id
    `;
    if (status && status !== 'all') {
      query = sql`${query} WHERE w.status = ${status}`;
    }
    const rows = await sql`${query} ORDER BY w.created_at DESC`;
    return ok(res, rows);
  } catch (e) {
    return err(res, "Failed to fetch withdrawals.");
  }
});

// PUT /api/admin/investors-portal/withdrawals/:id/status
router.put("/admin/investors-portal/withdrawals/:id/status", authAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, admin_remarks } = req.body;

    if (!['approved', 'rejected'].includes(status)) {
      return err(res, "Status must be approved or rejected.", 400);
    }

    const [withdrawal] = await sql`SELECT * FROM investor_withdrawals WHERE id = ${id}`;
    if (!withdrawal) return err(res, "Withdrawal request not found.", 404);

    if (withdrawal.status !== 'pending') {
      return err(res, `Withdrawal request is already ${withdrawal.status}.`, 400);
    }

    const amount = Number(withdrawal.amount);

    if (status === 'approved') {
      const [user] = await sql`SELECT available_balance FROM investor_users WHERE id = ${withdrawal.investor_id}`;
      if (Number(user.available_balance) < amount) {
        return err(res, "Investor has insufficient balance for approval.", 400);
      }

      await sql.begin(async (tx) => {
        await tx`
          UPDATE investor_withdrawals
          SET status = 'approved', admin_remarks = ${admin_remarks || null}, approved_at = NOW(), updated_at = NOW()
          WHERE id = ${id}
        `;

        await tx`
          UPDATE investor_users
          SET available_balance = available_balance - ${amount},
              total_withdrawals = total_withdrawals + ${amount},
              updated_at = NOW()
          WHERE id = ${withdrawal.investor_id}
        `;

        await tx`
          UPDATE investor_transactions
          SET status = 'approved', updated_at = NOW()
          WHERE investor_id = ${withdrawal.investor_id} AND reference_number = ${id}
        `;
      });
    } else {
      await sql.begin(async (tx) => {
        await tx`
          UPDATE investor_withdrawals
          SET status = 'rejected', admin_remarks = ${admin_remarks || null}, updated_at = NOW()
          WHERE id = ${id}
        `;

        await tx`
          UPDATE investor_transactions
          SET status = 'rejected', updated_at = NOW()
          WHERE investor_id = ${withdrawal.investor_id} AND reference_number = ${id}
        `;
      });
    }

    return ok(res, null, `Withdrawal request ${status} successfully.`);
  } catch (e) {
    console.error("Admin Withdrawal Status Error:", e);
    return err(res, "Failed to update withdrawal status.");
  }
});

// GET /api/admin/investors-portal/transactions
router.get("/admin/investors-portal/transactions", authAdmin, async (req, res) => {
  try {
    const rows = await sql`
      SELECT t.*, u.full_name as investor_name, u.email as investor_email
      FROM investor_transactions t
      JOIN investor_users u ON t.investor_id = u.id
      ORDER BY t.created_at DESC
      LIMIT 100
    `;
    return ok(res, rows);
  } catch (e) {
    return err(res, "Failed to fetch transaction history.");
  }
});

// POST /api/investor/enroll
router.post("/investor/enroll", authInvestor, async (req, res) => {
  try {
    const investor_id = req.investor.id;
    const body = req.body;
    
    if (!body.invFirstName || !body.mobile) {
      return err(res, "First name and mobile number are required.");
    }

    const processBase64 = async (dataUrl, filename) => {
      if (!dataUrl) return null;
      const matches = dataUrl.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
      if (!matches || matches.length !== 3) return null;
      const buffer = Buffer.from(matches[2], 'base64');
      const fileUrl = await saveFileToVPS(buffer, filename, "investor", {
        entityId: investor_id,
        subCategory: "enrollments"
      });
      return fileUrl;
    };

    const photoUrl = await processBase64(body.photo, `photo_${Date.now()}.png`);
    const sigFirstUrl = await processBase64(body.signatureFirstApplicant, `sig1_${Date.now()}.png`);
    const sigJointUrl = await processBase64(body.signatureJointApplicant, `sig2_${Date.now()}.png`);

    const newRow = await sql`
      INSERT INTO investor_enrollments (
        investor_id, form_no, form_date, branch_code, branch_name, investor_enrollment_id, project_name,
        inv_first_name, inv_middle_name, inv_surname, fh_first_name, fh_middle_name, fh_surname,
        dob, age, gender, occupation, occupation_other, address, city, state, pin_code,
        mobile, alt_tel, email, pan, aadhar, amount, amount_words, payment_mode, txn_no, txn_date, bank_branch,
        nominees, decl_date, decl_place, decl_signature_name, first_applicant_name, joint_applicant_name,
        photo_url, signature_first_url, signature_joint_url
      ) VALUES (
        ${investor_id}, ${body.formNo || null}, ${body.formDate || null}, ${body.branchCode || null}, ${body.branchName || null}, ${body.investorId || null}, ${body.projectName || null},
        ${body.invFirstName}, ${body.invMiddleName || null}, ${body.invSurname || null}, ${body.fhFirstName || null}, ${body.fhMiddleName || null}, ${body.fhSurname || null},
        ${body.dob || null}, ${body.age || null}, ${body.gender || null}, ${body.occupation || null}, ${body.occupationOther || null}, ${body.address || null}, ${body.city || null}, ${body.state || null}, ${body.pinCode || null},
        ${body.mobile}, ${body.altTel || null}, ${body.email || null}, ${body.pan || null}, ${body.aadhar || null}, ${body.amount || null}, ${body.amountWords || null}, ${body.paymentMode || null}, ${body.txnNo || null}, ${body.txnDate || null}, ${body.bankBranch || null},
        ${body.nominees ? JSON.stringify(body.nominees) : null}, ${body.declDate || null}, ${body.declPlace || null}, ${body.declSignatureName || null}, ${body.firstApplicantName || null}, ${body.jointApplicantName || null},
        ${photoUrl || null}, ${sigFirstUrl || null}, ${sigJointUrl || null}
      ) RETURNING id
    `;

    // Mark enrollment_status as Completed in investor_users
    try {
      await sql`UPDATE investor_users SET enrollment_status = 'Completed' WHERE id = ${investor_id}`;
    } catch (e) {}

    return ok(res, newRow[0], "Investor enrollment submitted successfully.");
  } catch (e) {
    console.error("Investor Enrollment Error:", e);
    return err(res, "Failed to submit enrollment form.");
  }
});

// GET /api/investor/enroll/my
router.get("/investor/enroll/my", authInvestor, async (req, res) => {
  try {
    const investor_id = req.investor.id;
    const [row] = await sql`SELECT * FROM investor_enrollments WHERE investor_id = ${investor_id} ORDER BY created_at DESC LIMIT 1`;
    if (!row) {
      return ok(res, null, "No enrollment found.");
    }
    return ok(res, row);
  } catch (e) {
    console.error("GET /api/investor/enroll/my error:", e);
    return err(res, "Failed to fetch your enrollment.");
  }
});

// GET /api/investor/enrollment/:id/print
router.get("/investor/enrollment/:id/print", async (req, res) => {
  try {
    const id = String(req.params.id);
    const pdfBuffer = await generateInvestorPdf(id);

    const [enrollment] = await sql`SELECT investor_enrollment_id, form_date FROM investor_enrollments WHERE id = ${id}`;
    if (!enrollment) {
      return err(res, "Enrollment not found.", 404);
    }

    const dateStr = enrollment.form_date 
      ? new Date(enrollment.form_date).toISOString().split('T')[0] 
      : new Date().toISOString().split('T')[0];
    const fileName = `MMR-Investor-${enrollment.investor_enrollment_id}-${dateStr}.pdf`;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.end(pdfBuffer);
  } catch (error) {
    console.error("GET /api/investor/enrollment/:id/print error:", error);
    return err(res, error.message || "Failed to generate PDF.");
  }
});

// GET /api/admin/investor-enrollment and /api/admin/investor-enrollments (Admin - List all with search)
router.get(["/admin/investor-enrollment", "/admin/investor-enrollments"], authAdmin, async (req, res) => {
  try {
    const search = String(req.query.search || "").trim();
    let rows;
    if (search) {
      const s = `%${search}%`;
      rows = await sql`
        SELECT 
          u.id as investor_id,
          u.id as user_id,
          u.full_name,
          u.email,
          u.mobile_number as mobile_no,
          'Investor' as user_type,
          u.created_at as registered_at,
          u.status as account_status,
          e.id as submission_id,
          e.investor_enrollment_id,
          e.form_no,
          e.project_name,
          e.app_status,
          e.created_at as submitted_at,
          CASE WHEN e.id IS NOT NULL THEN 'Completed' ELSE COALESCE(u.enrollment_status, 'Pending') END as enrollment_status
        FROM investor_users u
        LEFT JOIN investor_enrollments e ON u.id = e.investor_id
        WHERE u.deleted_at IS NULL
          AND (
            u.full_name ILIKE ${s}
            OR u.mobile_number ILIKE ${s}
            OR u.email ILIKE ${s}
            OR e.investor_enrollment_id ILIKE ${s}
            OR e.form_no ILIKE ${s}
          )
        ORDER BY u.created_at DESC
      `;
    } else {
      rows = await sql`
        SELECT 
          u.id as investor_id,
          u.id as user_id,
          u.full_name,
          u.email,
          u.mobile_number as mobile_no,
          'Investor' as user_type,
          u.created_at as registered_at,
          u.status as account_status,
          e.id as submission_id,
          e.investor_enrollment_id,
          e.form_no,
          e.project_name,
          e.app_status,
          e.created_at as submitted_at,
          CASE WHEN e.id IS NOT NULL THEN 'Completed' ELSE COALESCE(u.enrollment_status, 'Pending') END as enrollment_status
        FROM investor_users u
        LEFT JOIN investor_enrollments e ON u.id = e.investor_id
        WHERE u.deleted_at IS NULL
        ORDER BY u.created_at DESC
      `;
    }
    return ok(res, rows);
  } catch (e) {
    console.error("GET /api/admin/investor-enrollment error:", e);
    return err(res, "Failed to fetch investor enrollments: " + e.message);
  }
});

// GET /api/admin/investor-enrollment/:id (Admin - Detail)
router.get("/admin/investor-enrollment/:id", authAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    let row;
    if (String(id).includes("-") || isNaN(Number(id))) {
      const [resRow] = await sql`SELECT * FROM investor_enrollments WHERE id = ${id}`;
      row = resRow;
    } else {
      const [resRow] = await sql`SELECT * FROM investor_enrollments WHERE id = ${id} OR investor_id = ${Number(id)} ORDER BY created_at DESC LIMIT 1`;
      row = resRow;
    }

    if (!row) {
      // Check if user exists in investor_users
      const [invUser] = await sql`SELECT * FROM investor_users WHERE id = ${Number(id) || 0} AND deleted_at IS NULL`;
      if (invUser) {
        return ok(res, {
          investor_id: invUser.id,
          inv_first_name: invUser.full_name,
          email: invUser.email,
          mobile: invUser.mobile_number,
          pan: invUser.pan_number,
          aadhar: invUser.aadhaar_number,
          address: invUser.address,
          city: invUser.city,
          state: invUser.state,
          pin_code: invUser.pincode,
          nominees: invUser.nominee_name ? [{ name: invUser.nominee_name, relationship: '', age: '', proportion: 100 }] : [],
          is_new: true
        });
      }
      return err(res, "Enrollment not found.", 404);
    }
    return ok(res, row);
  } catch (e) {
    return err(res, "Failed to fetch enrollment.");
  }
});

// PUT /api/admin/investor-enrollment/:id (Admin - Update)
router.put("/admin/investor-enrollment/:id", authAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const b = req.body;
    
    // We update everything the admin sends, since admin can modify anything.
    const [updated] = await sql`
      UPDATE investor_enrollments
      SET
        form_no = ${b.formNo || null}, form_date = ${b.formDate || null}, branch_code = ${b.branchCode || null}, branch_name = ${b.branchName || null}, investor_enrollment_id = ${b.investorId || null}, project_name = ${b.projectName || null},
        inv_first_name = ${b.invFirstName || null}, inv_middle_name = ${b.invMiddleName || null}, inv_surname = ${b.invSurname || null}, fh_first_name = ${b.fhFirstName || null}, fh_middle_name = ${b.fhMiddleName || null}, fh_surname = ${b.fhSurname || null},
        dob = ${b.dob || null}, age = ${b.age || null}, gender = ${b.gender || null}, occupation = ${b.occupation || null}, occupation_other = ${b.occupationOther || null}, address = ${b.address || null}, city = ${b.city || null}, state = ${b.state || null}, pin_code = ${b.pinCode || null},
        mobile = ${b.mobile || null}, alt_tel = ${b.altTel || null}, email = ${b.email || null}, pan = ${b.pan || null}, aadhar = ${b.aadhar || null}, amount = ${b.amount || null}, amount_words = ${b.amountWords || null}, payment_mode = ${b.paymentMode || null}, txn_no = ${b.txnNo || null}, txn_date = ${b.txnDate || null}, bank_branch = ${b.bankBranch || null},
        nominees = ${b.nominees ? JSON.stringify(b.nominees) : null}, decl_date = ${b.declDate || null}, decl_place = ${b.declPlace || null}, decl_signature_name = ${b.declSignatureName || null}, first_applicant_name = ${b.firstApplicantName || null}, joint_applicant_name = ${b.jointApplicantName || null},
        app_status = ${b.appStatus || 'Pending'}, verified_by = ${b.verifiedBy || null}, payment_status = ${b.paymentStatus || null}, payment_status_date = ${b.paymentStatusDate || null}, authorized_signatory = ${b.authorizedSignatory || null},
        updated_at = NOW()
      WHERE id = ${id}
      RETURNING *
    `;

    if (!updated) return err(res, "Enrollment not found.", 404);
    return ok(res, updated, "Investor enrollment updated successfully.");
  } catch (e) {
    console.error("Update Enrollment Error:", e);
    return err(res, "Failed to update enrollment.");
  }
});

// PUT /api/admin/investor-users/:id/status (Admin - Approve/Reject Investor)
router.put("/admin/investor-users/:id/status", authAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, is_verified } = req.body;
    
    if (!status) return err(res, "Status is required.");
    
    const [updated] = await sql`
      UPDATE investor_users
      SET status = ${status}, is_verified = ${is_verified === true}, updated_at = NOW()
      WHERE id = ${id}
      RETURNING *
    `;
    
    if (!updated) return err(res, "Investor user not found.", 404);
    return ok(res, updated, "Investor status updated successfully.");
  } catch (e) {
    return err(res, "Failed to update investor status.");
  }
});

// DELETE /api/admin/investor-enrollment/:id (Admin - Delete)
router.delete("/admin/investor-enrollment/:id", authAdmin, async (req, res) => {
  try {
    const { id: enrollmentId } = req.params;
    
    const [enrollment] = await sql`SELECT investor_id FROM investor_enrollments WHERE id = ${enrollmentId}`;
    if (!enrollment) return err(res, "Enrollment not found.", 404);
    
    const investorId = enrollment.investor_id;

    let profileImageUrl = null;
    let profileImagePublicId = null;

    await sql.begin(async tx => {
      // Find and delete the profile image from the investors table if it exists
      const [investorProfile] = await tx`SELECT profile_image_url, profile_image_public_id FROM investors WHERE user_id = ${investorId}`;
      if (investorProfile) {
        profileImageUrl = investorProfile.profile_image_url;
        profileImagePublicId = investorProfile.profile_image_public_id;
      }
      
      await tx`DELETE FROM investors WHERE user_id = ${investorId}`;
      await tx`DELETE FROM investor_deposits WHERE investor_id = ${investorId}`;
      await tx`DELETE FROM investor_documents WHERE investor_id = ${investorId}`;
      await tx`DELETE FROM investor_notifications WHERE investor_id = ${investorId}`;
      await tx`DELETE FROM investor_settlement_preferences WHERE investor_id = ${investorId}`;
      await tx`DELETE FROM investor_transactions WHERE investor_id = ${investorId}`;
      await tx`DELETE FROM investor_withdrawals WHERE investor_id = ${investorId}`;
      await tx`DELETE FROM investor_enrollments WHERE investor_id = ${investorId}`;
      await tx`DELETE FROM investor_users WHERE id = ${investorId}`;

      await tx`
        INSERT INTO audit_log (actor_type, actor_id, actor_name, module, action, target_table, target_record_id)
        VALUES ('Admin', ${req.admin.admin_id}, ${req.admin.full_name},
                'InvestorManagement', 'Deleted', 'investor_users', ${investorId})`;
    });

    if (profileImageUrl) {
      await deleteFileFromStorage(profileImageUrl, profileImagePublicId);
    }

    return ok(res, {}, "Investor deleted successfully.");
  } catch (e) {
    if (e.message === "Enrollment not found.") return err(res, e.message, 404);
    return err(res, "Failed to delete investor: " + e.message);
  }
});

export default router;
