import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import multer from "multer";
import sql from "../db.js";
import { sendEmail } from "../emailService.js";
import { saveFileToVPS, deleteFileFromStorage } from "../services/fileStorage.service.js";
import { deleteInvestorProfile } from "../services/profileCleanupService.js";
import { generateInvestorPdf } from "../services/investorPdfService.js";
import { triggerEnrollmentEmailAsync } from "../services/enrollmentEmail.service.js";
import { triggerWithdrawalRequestEmailsAsync, triggerWithdrawalStatusEmailsAsync } from "../services/businessNotificationEmail.service.js";
import { triggerInvestorStatusEmailAsync, triggerInvestorDepositRequestEmailAsync, triggerInvestorDepositStatusEmailAsync } from "../services/phase2NotificationEmail.service.js";
import { normalizeHumanName, isValidHumanName, calculateAge, isValidState } from "../utils/validationHelper.js";

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

export function formatStorageUrl(val) {
  if (!val) return null;
  let str = val;
  if (typeof str === "object") {
    str = str.url || str.relativePath || "";
  }
  if (typeof str === "string" && str.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(str.trim());
      str = parsed.url || parsed.relativePath || str;
    } catch {}
  }
  if (typeof str !== "string") return null;
  str = str.trim();
  if (!str || str === "[object Object]" || str === "null" || str === "undefined") return null;
  if (str.startsWith("http://") || str.startsWith("https://") || str.startsWith("data:")) {
    return str;
  }
  const baseUrl = (process.env.PUBLIC_API_URL || process.env.API_BASE_URL || "https://api.mmrconstructions.in").replace(/\/$/, "");
  if (str.startsWith("/")) {
    return `${baseUrl}${str}`;
  }
  return `${baseUrl}/${str}`;
}

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
        file_url TEXT,
        file_data BYTEA,
        status VARCHAR(50) DEFAULT 'pending',
        admin_remarks TEXT,
        reviewed_by INTEGER,
        reviewed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        deleted_at TIMESTAMPTZ
      )`;
    await sql`ALTER TABLE investor_documents ADD COLUMN IF NOT EXISTS file_url TEXT`;
    await sql`ALTER TABLE investor_documents ALTER COLUMN file_data DROP NOT NULL`;
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
    await sql`ALTER TABLE investor_enrollments ADD COLUMN IF NOT EXISTS ifsc_code VARCHAR(20)`;
    await sql`ALTER TABLE investor_enrollments ADD COLUMN IF NOT EXISTS account_number VARCHAR(100)`;
    await sql`ALTER TABLE investor_enrollments ADD COLUMN IF NOT EXISTS corr_address TEXT`;
    await sql`ALTER TABLE investor_enrollments ADD COLUMN IF NOT EXISTS corr_city VARCHAR(100)`;
    await sql`ALTER TABLE investor_enrollments ADD COLUMN IF NOT EXISTS corr_state VARCHAR(100)`;
    await sql`ALTER TABLE investor_enrollments ADD COLUMN IF NOT EXISTS corr_pin_code VARCHAR(20)`;
    await sql`ALTER TABLE investor_enrollments ADD COLUMN IF NOT EXISTS religion VARCHAR(50)`;
    await sql`ALTER TABLE investor_enrollments ADD COLUMN IF NOT EXISTS is_final_submitted BOOLEAN DEFAULT FALSE`;
    await sql`ALTER TABLE investor_enrollments ADD COLUMN IF NOT EXISTS rejection_reason TEXT`;
    await sql`ALTER TABLE investor_enrollments ADD COLUMN IF NOT EXISTS updated_by_user_id INTEGER`;

    await sql`ALTER TABLE investor_users ADD COLUMN IF NOT EXISTS enrollment_status VARCHAR(50) DEFAULT 'Pending'`;
    await sql`ALTER TABLE investor_users ADD COLUMN IF NOT EXISTS father_husband_name VARCHAR(255)`;
    await sql`ALTER TABLE investor_users ADD COLUMN IF NOT EXISTS date_of_birth DATE`;
    await sql`ALTER TABLE investor_users ADD COLUMN IF NOT EXISTS gender VARCHAR(20)`;
    await sql`ALTER TABLE investor_users ADD COLUMN IF NOT EXISTS alternate_mobile VARCHAR(50)`;
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
  const jwtSecret = process.env.JWT_SECRET;
  try {
    const decoded = jwt.verify(token, jwtSecret);
    if (decoded.role !== "Investor" && decoded.user_type !== "Investor") {
      return res.status(403).json({ success: false, message: "Access restricted to Investors only." });
    }
    req.investor = decoded;
    next();
  } catch (e) {
    return res.status(401).json({ success: false, message: "Invalid or expired session token." });
  }
}

function authAdmin(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ success: false, message: "No admin token provided." });
  }
  const token = authHeader.split(" ")[1];
  const adminSecret = process.env.JWT_ADMIN_SECRET || process.env.JWT_SECRET;
  try {
    req.admin = jwt.verify(token, adminSecret);
    if (!isAdminPrincipal(req.admin)) {
      return res.status(403).json({ success: false, message: "Admin access required." });
    }
    next();
  } catch (e) {
    return res.status(401).json({ success: false, message: "Invalid admin token." });
  }
}

export function authInvestorOrAdmin(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ success: false, message: "No authentication token provided." });
  }
  const token = authHeader.split(" ")[1];
  const jwtSecret = process.env.JWT_SECRET;
  const adminSecret = process.env.JWT_ADMIN_SECRET || jwtSecret;

  // 1. Try investor or user token signed with JWT_SECRET
  try {
    const decoded = jwt.verify(token, jwtSecret);
    if (decoded.role === "Investor" || decoded.user_type === "Investor") {
      req.investor = decoded;
      return next();
    }
    if (isAdminPrincipal(decoded)) {
      req.admin = decoded;
      return next();
    }
  } catch (e) {}

  // 2. Try admin token signed with adminSecret
  try {
    const decodedAdmin = jwt.verify(token, adminSecret);
    if (isAdminPrincipal(decodedAdmin)) {
      req.admin = decodedAdmin;
      return next();
    }
  } catch (e) {}

  return res.status(401).json({ success: false, message: "Invalid or expired session token." });
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
    const cleanName = String(full_name).trim();
    if (!/^[a-zA-Z]+(\s[a-zA-Z]+)*$/.test(cleanName)) {
      return err(res, "Full Name can only contain letters and single spaces (no numbers or special characters).", 400);
    }
    const cleanEmail = String(email).trim().toLowerCase();
    if (!/^[a-zA-Z0-9]+(\.[a-zA-Z0-9]+)*@[a-zA-Z0-9]+(\.[a-zA-Z0-9]+)+$/.test(cleanEmail)) {
      return err(res, "Valid email address is required (only letters, numbers, @ and dot allowed; no dash or special characters).", 400);
    }
    const cleanMobile = String(rawMobile).replace(/\D/g, "");
    if (!/^[6-9]\d{9}$/.test(cleanMobile)) {
      return err(res, "Please enter a valid 10-digit mobile number.", 400);
    }
    const cleanMobile10 = cleanMobile.slice(-10);

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

router.post(["/investor/register", "/investor/signup", "/investor/auth/register", "/investor/auth/signup"], handleInvestorRegistration);

// POST /api/investor/send-otp
router.post(["/investor/send-otp", "/investor/auth/send-otp"], async (req, res) => {
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
router.post(["/investor/verify-otp", "/investor/auth/verify-otp"], async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) return err(res, "Email and OTP are required.", 400);

    const cleanEmail = String(email).trim().toLowerCase();
    const cleanOtp = String(otp).trim();

    const [pending] = await sql`SELECT * FROM pending_registrations WHERE email = ${cleanEmail}`;
    if (!pending) return err(res, "No pending registration found.", 400);
    if (new Date() > new Date(pending.expires_at)) return err(res, "OTP has expired.", 400);
    if (pending.otp_code !== cleanOtp) return err(res, "Invalid OTP.", 400);

    const [invSeq] = await sql`
      SELECT COALESCE(MAX(
        CASE
          WHEN member_id ~* '^MMR-INV-[0-9]+$' THEN SUBSTRING(member_id FROM 9)::integer
          ELSE id END
      ), 0) + 1 AS seq
      FROM investor_users`;
    const memberId = `MMR-INV-${String(invSeq?.seq || 1).padStart(5, '0')}`;

    const [newInvestor] = await sql`
      INSERT INTO investor_users (
        member_id, full_name, mobile_number, email, password_hash, status, is_verified, enrollment_status, created_at, updated_at
      ) VALUES (
        ${memberId}, ${pending.full_name}, ${pending.mobile_no}, ${pending.email}, ${pending.password_hash},
        'active', true, '0', NOW(), NOW()
      )
      RETURNING id, member_id, full_name, email, mobile_number, status, is_verified, enrollment_status, created_at
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
router.post(["/investor/login", "/investor/auth/login"], async (req, res) => {
  try {
    const { identifier, email, password } = req.body;
    const loginId = (identifier || email || "").trim().toLowerCase();

    if (!loginId || !password) {
      return err(res, "Please provide email/mobile and password.", 400);
    }

    const [user] = await sql`
      SELECT * FROM investor_users
      WHERE LOWER(email) = ${loginId} 
         OR mobile_number = ${loginId}
         OR LOWER(COALESCE(member_id, '')) = ${loginId}
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

    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error("JWT_SECRET is not configured");
    const refreshSecret = process.env.JWT_REFRESH_SECRET || secret;
    const token = jwt.sign(payload, secret, {
      expiresIn: process.env.JWT_EXPIRES_IN || "30d"
    });
    const refresh_token = jwt.sign(payload, refreshSecret, {
      expiresIn: "60d"
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

const handleInvestorVerifyEmail = async (req, res) => {
  try {
    const token = String(req.query.token || req.body?.token || "").trim();
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
};
router.get(["/investor/verify-email", "/investor/auth/verify-email"], handleInvestorVerifyEmail);
router.post(["/investor/verify-email", "/investor/auth/verify-email"], handleInvestorVerifyEmail);

// POST /api/investor/forgot-password
router.post(["/investor/forgot-password", "/investor/auth/forgot-password"], async (req, res) => {
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
router.post(["/investor/reset-password", "/investor/auth/reset-password"], async (req, res) => {
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
      SELECT iu.id, iu.full_name, iu.email, iu.mobile_number, iu.available_balance, iu.total_investment, iu.total_deposits, iu.total_withdrawals, iu.status,
             CASE 
               WHEN ie.id IS NOT NULL AND ie.is_final_submitted = TRUE AND LOWER(COALESCE(ie.app_status, '')) = 'approved' THEN 'Completed' 
               WHEN ie.id IS NOT NULL THEN 'Submitted' 
               ELSE '0' 
             END AS enrollment_status,
             CASE WHEN ie.id IS NOT NULL AND ie.is_final_submitted = TRUE AND LOWER(COALESCE(ie.app_status, '')) = 'approved' THEN TRUE ELSE FALSE END AS is_verified,
             iu.profile_picture_url, iu.created_at
      FROM investor_users iu
      LEFT JOIN LATERAL (
        SELECT id, app_status, is_final_submitted
        FROM investor_enrollments
        WHERE investor_id = iu.id
        ORDER BY created_at DESC LIMIT 1
      ) ie ON true
      WHERE iu.id = ${investorId}
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
      SELECT iu.id, iu.full_name, iu.mobile_number, iu.email, iu.address, iu.city, iu.state, iu.country, iu.pincode,
             iu.pan_number, iu.aadhaar_number, iu.bank_name, iu.account_number, iu.ifsc_code, iu.nominee_name,
             iu.available_balance, iu.total_investment, iu.total_deposits, iu.total_withdrawals,
             iu.status,
             CASE 
               WHEN ie.id IS NOT NULL AND ie.is_final_submitted = TRUE AND LOWER(COALESCE(ie.app_status, '')) = 'approved' THEN 'Completed' 
               WHEN ie.id IS NOT NULL THEN 'Submitted' 
               ELSE '0' 
             END AS enrollment_status,
             CASE WHEN ie.id IS NOT NULL AND ie.is_final_submitted = TRUE AND LOWER(COALESCE(ie.app_status, '')) = 'approved' THEN TRUE ELSE FALSE END AS is_verified,
             iu.profile_picture_url, iu.created_at, iu.updated_at
      FROM investor_users iu
      LEFT JOIN LATERAL (
        SELECT id, app_status, is_final_submitted
        FROM investor_enrollments
        WHERE investor_id = iu.id
        ORDER BY created_at DESC LIMIT 1
      ) ie ON true
      WHERE iu.id = ${req.investor.id}
    `;
    if (!user) return err(res, "Investor not found.", 404);
    if (user.profile_picture_url) {
      user.profile_picture_url = formatStorageUrl(user.profile_picture_url);
    }
    return ok(res, user);
  } catch (e) {
    return err(res, "Failed to fetch profile.");
  }
});

// PUT /api/investor/profile
router.put("/investor/profile", authInvestor, async (req, res) => {
  try {
    let { full_name, mobile_number, address, city, state, country, pincode, nominee_name, pan_number, aadhaar_number } = req.body;

    if (full_name) {
      if (!isValidHumanName(full_name)) {
        return err(res, "Full Name must contain only alphabets and spaces (no numbers or special characters).", 400);
      }
      full_name = normalizeHumanName(full_name);
    }

    if (nominee_name) {
      if (!isValidHumanName(nominee_name)) {
        return err(res, "Nominee Name must contain only alphabets and spaces (no numbers or special characters).", 400);
      }
      nominee_name = normalizeHumanName(nominee_name);
    }

    if (state && !isValidState(state)) {
      return err(res, "Selected state is not valid. Please select from approved Indian states.", 400);
    }

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
      SELECT id, document_type, original_file_name, mime_type, file_size_bytes, file_url, status,
             admin_remarks, reviewed_at, created_at, updated_at
      FROM investor_documents
      WHERE investor_id = ${req.investor.id} AND deleted_at IS NULL
      ORDER BY created_at DESC`;
    const formatted = rows.map(r => ({
      ...r,
      file_url: formatStorageUrl(r.file_url) || `/api/investor/documents/${r.id}/file`
    }));
    return ok(res, formatted);
  } catch (e) {
    console.error("GET /api/investor/documents error:", e);
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

    const saved = await saveFileToVPS(req.file.buffer, {
      module: "investor",
      entityId: req.investor.id,
      subCategory: `documents/${documentType}`,
      entityType: documentType,
      originalName: req.file.originalname
    });

    const fullUrl = formatStorageUrl(saved.url || saved.relativePath);

    // Ensure columns exist on database table
    try {
      await sql`ALTER TABLE investor_documents ADD COLUMN IF NOT EXISTS file_url TEXT`;
      await sql`ALTER TABLE investor_documents ALTER COLUMN file_data DROP NOT NULL`;
    } catch {}

    const [created] = await sql`
      INSERT INTO investor_documents (
        investor_id, document_type, original_file_name, mime_type, file_size_bytes, file_url, file_data, status
      ) VALUES (
        ${req.investor.id}, ${documentType}, ${req.file.originalname}, ${req.file.mimetype},
        ${req.file.size}, ${fullUrl}, ${req.file.buffer}, 'pending'
      )
      RETURNING id, document_type, original_file_name, mime_type, file_size_bytes, file_url, status, created_at`;

    if (created) {
      created.file_url = formatStorageUrl(created.file_url);
    }

    if (documentType === 'passport_photo') {
      try {
        await sql`
          UPDATE investor_users 
          SET profile_picture_url = ${fullUrl}, updated_at = NOW() 
          WHERE id = ${req.investor.id}
        `;
      } catch {}
    }

    await notifyInvestor(req.investor.id, "Document Submitted", `Your ${documentType.replace('_', ' ')} was uploaded and is pending admin review.`, "document");
    return ok(res, created, "Document uploaded successfully.", 201);
  } catch (e) {
    console.error("Investor Document Upload Error:", e);
    return err(res, "Failed to upload document: " + e.message);
  }
});

router.get(["/investor/documents/:id", "/investor/documents/:id/file"], async (req, res) => {
  try {
    const docId = String(req.params.id || "").trim();
    const [doc] = await sql`
      SELECT original_file_name, mime_type, file_url, file_data 
      FROM investor_documents
      WHERE id::text = ${docId} AND deleted_at IS NULL
      LIMIT 1
    `;
    if (!doc) return err(res, "Document not found.", 404);

    if (doc.file_url) {
      const full = formatStorageUrl(doc.file_url);
      if (full && (full.startsWith("http://") || full.startsWith("https://"))) {
        return res.redirect(full);
      }
    }

    if (doc.file_data) {
      res.setHeader("Content-Type", doc.mime_type || "application/octet-stream");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      res.setHeader("Content-Disposition", `inline; filename="${(doc.original_file_name || 'document').replace(/"/g, "")}"`);
      return res.send(doc.file_data);
    }

    return err(res, "Document file not available.", 404);
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

router.get(["/investor/settlement-preference", "/investor/settlement"], authInvestor, async (req, res) => {
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

router.post(["/investor/settlement-preference", "/investor/settlement"], authInvestor, async (req, res) => {
  try {
    const frequency = String(req.body.frequency || req.body.preference || "").trim();
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

router.post(["/investor/settlement-change-request", "/investor/settlement/request"], authInvestor, async (req, res) => {
  try {
    const requested = String(req.body.requested_frequency || req.body.requestedFrequency || "").trim();
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

router.patch("/investor/notifications/read-all", authInvestor, async (req, res) => {
  try {
    await sql`
      UPDATE investor_notifications SET is_read = TRUE
      WHERE investor_id = ${req.investor.id} AND is_read = FALSE`;
    return ok(res, {}, "All investor notifications marked as read.");
  } catch (e) {
    return err(res, "Failed to update notifications.");
  }
});

// PUT & POST /api/investor/change-password
const handleInvestorChangePassword = async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) {
      return err(res, "Current password and new password are required.", 400);
    }

    const [user] = await sql`SELECT password_hash FROM investor_users WHERE id = ${req.investor.id}`;
    if (!user || !user.password_hash) {
      return err(res, "User not found.", 404);
    }
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
};
router.put("/investor/change-password", authInvestor, handleInvestorChangePassword);
router.post("/investor/change-password", authInvestor, handleInvestorChangePassword);

// PUT /api/investor/bank-details
router.put(["/investor/bank-details", "/investor/profile/bank"], authInvestor, async (req, res) => {
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

    let screenshotUrl = payment_screenshot_url || null;
    if (req.file) {
      const saved = await saveFileToVPS(req.file.buffer, {
        module: "investor",
        entityId: investorId,
        subCategory: "deposits",
        entityType: "DepositProof",
        originalName: req.file.originalname
      });
      screenshotUrl = formatStorageUrl(saved.url || saved.relativePath);
    }

    // Create Deposit request
    const [deposit] = await sql`
      INSERT INTO investor_deposits (
        investor_id, amount, payment_method, gateway, transaction_reference, payment_screenshot_url,
        payment_screenshot_data, payment_screenshot_mime_type, status
      ) VALUES (
        ${investorId}, ${numAmount}, ${payment_method}, ${gateway || null}, ${transaction_reference || null},
        ${screenshotUrl}, ${req.file?.buffer || null}, ${req.file?.mimetype || null}, 'pending'
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

    // Standalone Investor Deposit Request Email Dispatch
    triggerInvestorDepositRequestEmailAsync(deposit.id, {
      investor_id: investorId,
      investorName: req.investor?.full_name,
      email: req.investor?.email,
      amount: numAmount,
      payment_method: payment_method,
      transaction_reference: transaction_reference || deposit.transaction_reference
    });

    return ok(res, deposit, "Deposit request submitted successfully! Awaiting admin approval.", 201);
  } catch (e) {
    console.error("Deposit Error:", e);
    return err(res, "Failed to submit deposit request: " + e.message);
  }
});

router.get(["/investor/deposits/:id/screenshot", "/investor/deposits/:id/file"], async (req, res) => {
  try {
    const [deposit] = await sql`
      SELECT payment_screenshot_url, payment_screenshot_data, payment_screenshot_mime_type
      FROM investor_deposits
      WHERE id::text = ${req.params.id}
      LIMIT 1`;
    if (!deposit) return err(res, "Screenshot not found.", 404);

    if (deposit.payment_screenshot_url) {
      const full = formatStorageUrl(deposit.payment_screenshot_url);
      if (full && (full.startsWith("http://") || full.startsWith("https://"))) {
        return res.redirect(full);
      }
    }

    if (deposit.payment_screenshot_data) {
      res.setHeader("Content-Type", deposit.payment_screenshot_mime_type || "image/jpeg");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      return res.send(deposit.payment_screenshot_data);
    }
    return err(res, "Screenshot data not found.", 404);
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
    const formatted = deposits.map(d => ({
      ...d,
      payment_screenshot_url: formatStorageUrl(d.payment_screenshot_url) || (d.payment_screenshot_data ? `/api/investor/deposits/${d.id}/screenshot` : null)
    }));
    return ok(res, formatted);
  } catch (e) {
    return err(res, "Failed to fetch deposits.");
  }
});

// POST /api/investor/withdraw
router.post(["/investor/withdraw", "/investor/withdrawals"], authInvestor, async (req, res) => {
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

    // Standalone Investor Withdrawal Request Email Dispatch
    triggerWithdrawalRequestEmailsAsync(withdrawal.id, {
      user_id: req.investor.id,
      userName: req.investor.full_name,
      userEmail: req.investor.email,
      userRole: 'Investor',
      amount: numAmount,
      bankName: bank_name,
      accountNumber: account_number,
      ifscCode: ifsc_code
    });

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

    let query = sql`
      SELECT iu.id, iu.full_name, iu.mobile_number, iu.email, iu.city, iu.state, iu.pan_number, iu.bank_name, iu.account_number, iu.ifsc_code,
             iu.available_balance, iu.total_investment, iu.total_deposits, iu.total_withdrawals, iu.status,
             CASE WHEN ie.id IS NOT NULL AND ie.is_final_submitted = TRUE AND LOWER(COALESCE(ie.app_status, '')) = 'approved' THEN TRUE ELSE FALSE END AS is_verified,
             CASE 
               WHEN ie.id IS NOT NULL AND ie.is_final_submitted = TRUE AND LOWER(COALESCE(ie.app_status, '')) = 'approved' THEN 'Completed' 
               WHEN ie.id IS NOT NULL THEN 'Submitted' 
               ELSE '0' 
             END AS enrollment_status,
             iu.profile_picture_url, COALESCE(iu.sponsor_invite_code, 'MMR00001') AS sponsor_invite_code, iu.created_at
      FROM investor_users iu
      LEFT JOIN LATERAL (
        SELECT id, app_status, is_final_submitted
        FROM investor_enrollments
        WHERE investor_id = iu.id
        ORDER BY created_at DESC LIMIT 1
      ) ie ON true
      WHERE iu.deleted_at IS NULL`;

    if (search) {
      const s = `%${search.trim()}%`;
      query = sql`${query} AND (iu.full_name ILIKE ${s} OR iu.email ILIKE ${s} OR iu.mobile_number ILIKE ${s} OR iu.pan_number ILIKE ${s} OR iu.sponsor_invite_code ILIKE ${s})`;
    }
    if (status && status !== "all") {
      query = sql`${query} AND iu.status = ${status}`;
    }

    const [{ count }] = await sql`SELECT COUNT(*) FROM (${query}) AS count_query`;
    const rows = await sql`${query} ORDER BY iu.created_at DESC LIMIT ${limitNum} OFFSET ${offset}`;

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

    if (['approved', 'active', 'rejected'].includes(String(status).toLowerCase())) {
      triggerInvestorStatusEmailAsync(id, {
        investorName: updated.full_name,
        email: updated.email,
        reason: req.body?.reject_reason || req.body?.admin_remarks || null
      }, (status === 'approved' || status === 'active') ? 'approved' : 'rejected');
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
    const formatted = rows.map(r => ({
      ...r,
      file_url: formatStorageUrl(r.file_url) || `/api/admin/investors-portal/documents/${r.id}/file`
    }));
    return ok(res, formatted);
  } catch (e) {
    return err(res, "Failed to fetch deposits.");
  }
});

// PUT /api/admin/investors-portal/deposits/:id/status
router.put(["/admin/investors-portal/deposits/:id", "/admin/investors-portal/deposits/:id/status"], authAdmin, async (req, res) => {
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

    // Standalone Investor Deposit Status Email Dispatch
    triggerInvestorDepositStatusEmailAsync(id, {
      investor_id: deposit.investor_id,
      amount: amount,
      admin_remarks: admin_remarks
    }, status);

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
             d.file_size_bytes, d.file_url, d.status, d.admin_remarks, d.reviewed_at, d.created_at,
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

router.get(["/admin/investors-portal/documents/:id", "/admin/investors-portal/documents/:id/file"], async (req, res) => {
  try {
    const [doc] = await sql`
      SELECT original_file_name, mime_type, file_url, file_data FROM investor_documents
      WHERE id::text = ${req.params.id} AND deleted_at IS NULL LIMIT 1`;
    if (!doc) return err(res, "Document not found.", 404);

    if (doc.file_url) {
      const full = formatStorageUrl(doc.file_url);
      if (full && (full.startsWith("http://") || full.startsWith("https://"))) {
        return res.redirect(full);
      }
    }

    if (doc.file_data) {
      res.setHeader("Content-Type", doc.mime_type || "application/octet-stream");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      res.setHeader("Content-Disposition", `inline; filename="${(doc.original_file_name || 'document').replace(/"/g, "")}"`);
      return res.send(doc.file_data);
    }
    return err(res, "Document file not available.", 404);
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
router.put(["/admin/investors-portal/withdrawals/:id", "/admin/investors-portal/withdrawals/:id/status"], authAdmin, async (req, res) => {
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

    // Standalone Investor Withdrawal Status Email Dispatch
    triggerWithdrawalStatusEmailsAsync(id, {
      user_id: withdrawal.investor_id,
      userRole: 'Investor',
      amount: amount,
      rejection_reason: admin_remarks
    }, status);

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

    // 1. Mandatory Validations (Part 3A & 3B)
    const valErrors = {};
    if (!body.invFirstName || !String(body.invFirstName).trim()) {
      valErrors.invFirstName = "Investor First Name is required.";
    } else if (!isValidHumanName(body.invFirstName)) {
      valErrors.invFirstName = "First Name must contain only alphabets and spaces.";
    }

    if (body.invMiddleName && !isValidHumanName(body.invMiddleName)) {
      valErrors.invMiddleName = "Middle Name must contain only alphabets and spaces.";
    }

    if (!body.invSurname || !String(body.invSurname).trim()) {
      valErrors.invSurname = "Investor Surname is required.";
    } else if (!isValidHumanName(body.invSurname)) {
      valErrors.invSurname = "Surname must contain only alphabets and spaces.";
    }

    if (!body.fhFirstName || !String(body.fhFirstName).trim()) {
      valErrors.fhFirstName = "Father's/Husband's First Name is required.";
    } else if (!isValidHumanName(body.fhFirstName)) {
      valErrors.fhFirstName = "Father's First Name must contain only alphabets and spaces.";
    }

    if (body.fhMiddleName && !isValidHumanName(body.fhMiddleName)) {
      valErrors.fhMiddleName = "Father's Middle Name must contain only alphabets and spaces.";
    }

    if (!body.fhSurname || !String(body.fhSurname).trim()) {
      valErrors.fhSurname = "Father's/Husband's Surname is required.";
    } else if (!isValidHumanName(body.fhSurname)) {
      valErrors.fhSurname = "Father's Surname must contain only alphabets and spaces.";
    }

    if (!body.dob) {
      valErrors.dob = "Date of Birth is required.";
    } else {
      const age = calculateAge(body.dob);
      if (age < 18) {
        valErrors.dob = `Applicant must be at least 18 years old (current calculated age: ${age}).`;
      }
    }

    if (!body.address || !String(body.address).trim()) valErrors.address = "Permanent Address is required.";
    if (!body.city || !String(body.city).trim()) valErrors.city = "Permanent City is required.";
    if (!body.state || !isValidState(body.state)) valErrors.state = "Valid Indian State is required.";
    if (!body.pinCode || !/^[0-9]{6}$/.test(String(body.pinCode).trim())) valErrors.pinCode = "Pin Code must be exactly 6 digits.";

    const sameAsPerm = Boolean(body.sameAsPermanent === true || body.sameAsPermanent === 'true');
    if (!sameAsPerm) {
      if (!body.corrAddress || !String(body.corrAddress).trim()) valErrors.corrAddress = "Correspondence Address is required.";
      if (!body.corrCity || !String(body.corrCity).trim()) valErrors.corrCity = "Correspondence City is required.";
      if (!body.corrState || !isValidState(body.corrState)) valErrors.corrState = "Valid Correspondence State is required.";
      if (!body.corrPinCode || !/^[0-9]{6}$/.test(String(body.corrPinCode).trim())) valErrors.corrPinCode = "Correspondence Pin Code must be 6 digits.";
    }

    if (!body.mobile || !/^[6-9][0-9]{9}$/.test(String(body.mobile).replace(/\D/g, ""))) {
      valErrors.mobile = "Mobile number must be a valid 10-digit number starting with 6-9.";
    }
    if (body.altTel && !/^[6-9][0-9]{9}$/.test(String(body.altTel).replace(/\D/g, ""))) {
      valErrors.altTel = "Alt. Tel. No. must be a valid 10-digit number.";
    }
    if (!body.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(body.email).trim())) {
      valErrors.email = "Valid Email ID is required.";
    }

    if (!body.pan || !/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/i.test(String(body.pan).trim())) {
      valErrors.pan = "Valid PAN Card Number is required (e.g. ABCDE1234F).";
    }
    if (!body.aadhar || !/^[0-9]{12}$/.test(String(body.aadhar).trim().replace(/\s/g, ""))) {
      valErrors.aadhar = "Aadhaar Number must be exactly 12 digits.";
    }

    const numAmount = Number(body.amount);
    if (!body.amount || isNaN(numAmount) || numAmount <= 0) {
      valErrors.amount = "Investment Amount must be greater than 0.";
    }
    if (!body.paymentMode) {
      valErrors.paymentMode = "Payment Mode is required.";
    } else if (body.paymentMode !== "Cash") {
      if (!body.txnNo || !String(body.txnNo).trim()) valErrors.txnNo = "TXN / Cheque No. is required.";
      if (!body.txnDate) valErrors.txnDate = "Payment Date is required.";
    }

    if (!body.bankBranch || !String(body.bankBranch).trim()) valErrors.bankBranch = "Bank & Branch Name is required.";
    if (!body.accountNumber || !/^[0-9]{9,18}$/.test(String(body.accountNumber).trim())) {
      valErrors.accountNumber = "Account Number must be between 9 and 18 digits.";
    }
    if (!body.ifscCode || !/^[A-Z]{4}0[A-Z0-9]{6}$/i.test(String(body.ifscCode).trim())) {
      valErrors.ifscCode = "Valid IFSC Code is required (e.g. SBIN0001234).";
    }

    if (!body.declPlace || !String(body.declPlace).trim()) {
      valErrors.declPlace = "Place of signing is required.";
    }

    // Nominees check
    if (Array.isArray(body.nominees) && body.nominees.length > 0) {
      let filledRows = 0;
      let totalProp = 0;
      body.nominees.forEach((n, idx) => {
        if (n.name || n.relationship || n.age || n.proportion) {
          filledRows++;
          if (!n.name || !String(n.name).trim()) valErrors[`nominee_${idx}_name`] = `Nominee #${idx + 1} Name is required.`;
          if (!n.relationship || !String(n.relationship).trim()) valErrors[`nominee_${idx}_relationship`] = `Nominee #${idx + 1} Relationship is required.`;
          if (!n.age || Number(n.age) <= 0) valErrors[`nominee_${idx}_age`] = `Nominee #${idx + 1} Age is required.`;
          const prop = Number(n.proportion);
          if (isNaN(prop) || prop <= 0 || prop > 100) {
            valErrors[`nominee_${idx}_proportion`] = `Nominee #${idx + 1} Proportion must be 1-100%.`;
          } else {
            totalProp += prop;
          }
        }
      });
      if (filledRows > 0 && totalProp !== 100) {
        valErrors.nominees_total = `Total Nominee Proportion must be exactly 100% (current total: ${totalProp}%).`;
      }
    }

    const [existing] = await sql`
      SELECT id, is_final_submitted, app_status, photo_url, signature_first_url, signature_joint_url 
      FROM investor_enrollments 
      WHERE investor_id = ${investor_id} 
      ORDER BY created_at DESC LIMIT 1
    `;

    // Photo & Signature requirement check
    const hasPhoto = Boolean(body.photo || existing?.photo_url);
    const hasSig = Boolean(body.signature || body.declSignature || body.signatureFirstApplicant || existing?.signature_first_url);
    if (!hasPhoto) valErrors.photo = "Investor Passport-size photo is required.";
    if (!hasSig) valErrors.signature = "Investor Signature is required.";

    if (Object.keys(valErrors).length > 0) {
      return res.status(400).json({
        success: false,
        message: Object.values(valErrors)[0],
        errors: valErrors
      });
    }

    // Workflow Check (Part 3F)
    const isApproved = existing && String(existing.app_status).toLowerCase() === 'approved';
    const isRejected = existing && String(existing.app_status).toLowerCase() === 'rejected';

    if (existing && existing.is_final_submitted && !isRejected) {
      return res.status(403).json({
        success: false,
        message: isApproved 
          ? "Investor Enrollment is approved and permanently locked." 
          : "Investor Enrollment is final submitted and locked pending Admin approval."
      });
    }

    // Normalize Human Names
    body.invFirstName = normalizeHumanName(body.invFirstName);
    if (body.invMiddleName) body.invMiddleName = normalizeHumanName(body.invMiddleName);
    body.invSurname = normalizeHumanName(body.invSurname);
    body.fhFirstName = normalizeHumanName(body.fhFirstName);
    if (body.fhMiddleName) body.fhMiddleName = normalizeHumanName(body.fhMiddleName);
    body.fhSurname = normalizeHumanName(body.fhSurname);
    if (body.firstApplicantName) body.firstApplicantName = normalizeHumanName(body.firstApplicantName);
    if (body.jointApplicantName) body.jointApplicantName = normalizeHumanName(body.jointApplicantName);
    if (body.declSignatureName) body.declSignatureName = normalizeHumanName(body.declSignatureName);

    const processBase64 = async (dataUrl, filename) => {
      if (!dataUrl || typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) return null;
      const matches = dataUrl.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
      if (!matches || matches.length !== 3) return null;
      const buffer = Buffer.from(matches[2], 'base64');
      const saved = await saveFileToVPS(buffer, {
        originalName: filename,
        module: "investor",
        entityId: investor_id,
        subCategory: "enrollments"
      });
      return saved?.url || saved?.relativePath || null;
    };

    const extractUrl = (val) => {
      if (!val) return null;
      if (typeof val === "object") return val.url || val.relativePath || null;
      if (typeof val === "string" && val.trim().startsWith("{")) {
        try {
          const p = JSON.parse(val.trim());
          return p.url || p.relativePath || val;
        } catch {}
      }
      return typeof val === "string" ? val : null;
    };

    const photoUrl = (await processBase64(body.photo, `photo_${Date.now()}.png`)) 
      || (body.photo && !String(body.photo).startsWith("data:") ? extractUrl(body.photo) : null);

    const rawSigFirst = body.signatureFirstApplicant || body.signature || body.declSignature;
    const sigFirstUrl = (await processBase64(rawSigFirst, `sig1_${Date.now()}.png`)) 
      || (rawSigFirst && !String(rawSigFirst).startsWith("data:") ? extractUrl(rawSigFirst) : null);

    const rawSigJoint = body.signatureJointApplicant;
    const sigJointUrl = (await processBase64(rawSigJoint, `sig2_${Date.now()}.png`)) 
      || (rawSigJoint && !String(rawSigJoint).startsWith("data:") ? extractUrl(rawSigJoint) : null);

    const isFinalSubmit = body.is_final_submitted === true || body.is_final_submitted === 'true' || body.isFinalSubmit === true || body.isFinalSubmit === 'true';

    // Status logic:
    // If final submit: status becomes 'Hold/Pending KYC' (visible to admin approval queue)
    // If save/submit in review stage: status is 'Submitted' (NOT in admin pending queue)
    const newAppStatus = isFinalSubmit ? 'Hold/Pending KYC' : 'Submitted';

    // Fetch user's member_id to ensure investor_enrollment_id is always filled
    const [uRecord] = await sql`SELECT member_id FROM investor_users WHERE id = ${investor_id} LIMIT 1`;
    const invEnrollIdToSave = body.investorId || existing?.investor_enrollment_id || uRecord?.member_id || body.formNo || null;

    // Correspondence values
    const finalCorrAddress = sameAsPerm ? body.address : (body.corrAddress || body.address);
    const finalCorrCity = sameAsPerm ? body.city : (body.corrCity || body.city);
    const finalCorrState = sameAsPerm ? body.state : (body.corrState || body.state);
    const finalCorrPin = sameAsPerm ? body.pinCode : (body.corrPinCode || body.pinCode);

    let resultId;
    if (existing) {
      await sql`
        UPDATE investor_enrollments SET
          form_no = COALESCE(${body.formNo || null}, form_no),
          form_date = COALESCE(${body.formDate || null}, form_date),
          branch_code = ${body.branchCode || null},
          branch_name = ${body.branchName || null},
          investor_enrollment_id = COALESCE(${invEnrollIdToSave}, investor_enrollment_id),
          project_name = ${body.projectName || null},
          inv_first_name = ${body.invFirstName},
          inv_middle_name = ${body.invMiddleName || null},
          inv_surname = ${body.invSurname || null},
          fh_first_name = ${body.fhFirstName || null},
          fh_middle_name = ${body.fhMiddleName || null},
          fh_surname = ${body.fhSurname || null},
          dob = ${body.dob || null},
          age = ${body.age || null},
          gender = ${body.gender || 'M'},
          occupation = ${body.occupation || 'Service'},
          occupation_other = ${body.occupationOther || null},
          address = ${body.address || null},
          city = ${body.city || null},
          state = ${body.state || null},
          pin_code = ${body.pinCode || null},
          corr_address = ${finalCorrAddress || null},
          corr_city = ${finalCorrCity || null},
          corr_state = ${finalCorrState || null},
          corr_pin_code = ${finalCorrPin || null},
          religion = ${body.religion || null},
          mobile = ${body.mobile},
          alt_tel = ${body.altTel || null},
          email = ${body.email || null},
          pan = ${body.pan ? String(body.pan).toUpperCase() : null},
          aadhar = ${body.aadhar || null},
          amount = ${body.amount || null},
          amount_words = ${body.amountWords || null},
          payment_mode = ${body.paymentMode || null},
          txn_no = ${body.paymentMode === 'Cash' ? null : (body.txnNo || null)},
          txn_date = ${body.paymentMode === 'Cash' ? null : (body.txnDate || null)},
          bank_branch = ${body.bankBranch || null},
          ifsc_code = ${body.ifscCode ? String(body.ifscCode).toUpperCase() : null},
          account_number = ${body.accountNumber || null},
          nominees = ${body.nominees ? (typeof body.nominees === 'string' ? body.nominees : JSON.stringify(body.nominees)) : null},
          decl_date = ${body.declDate || null},
          decl_place = ${body.declPlace || null},
          decl_signature_name = ${body.declSignatureName || null},
          first_applicant_name = ${body.firstApplicantName || null},
          joint_applicant_name = ${body.jointApplicantName || null},
          photo_url = COALESCE(${photoUrl}, photo_url),
          signature_first_url = COALESCE(${sigFirstUrl}, signature_first_url),
          signature_joint_url = COALESCE(${sigJointUrl}, signature_joint_url),
          is_final_submitted = ${isFinalSubmit},
          app_status = ${newAppStatus},
          rejection_reason = ${isRejected ? null : existing.rejection_reason},
          updated_at = NOW()
        WHERE id = ${existing.id}
      `;
      resultId = existing.id;
    } else {
      const [newRow] = await sql`
        INSERT INTO investor_enrollments (
          investor_id, form_no, form_date, branch_code, branch_name, investor_enrollment_id, project_name,
          inv_first_name, inv_middle_name, inv_surname, fh_first_name, fh_middle_name, fh_surname,
          dob, age, gender, occupation, occupation_other, address, city, state, pin_code,
          corr_address, corr_city, corr_state, corr_pin_code, religion,
          mobile, alt_tel, email, pan, aadhar, amount, amount_words, payment_mode, txn_no, txn_date, bank_branch, ifsc_code, account_number,
          nominees, decl_date, decl_place, decl_signature_name, first_applicant_name, joint_applicant_name,
          photo_url, signature_first_url, signature_joint_url, is_final_submitted, app_status
        ) VALUES (
          ${investor_id}, ${body.formNo || null}, ${body.formDate || null}, ${body.branchCode || null}, ${body.branchName || null}, ${invEnrollIdToSave}, ${body.projectName || null},
          ${body.invFirstName}, ${body.invMiddleName || null}, ${body.invSurname || null}, ${body.fhFirstName || null}, ${body.fhMiddleName || null}, ${body.fhSurname || null},
          ${body.dob || null}, ${body.age || null}, ${body.gender || 'M'}, ${body.occupation || 'Service'}, ${body.occupationOther || null}, ${body.address || null}, ${body.city || null}, ${body.state || null}, ${body.pinCode || null},
          ${finalCorrAddress || null}, ${finalCorrCity || null}, ${finalCorrState || null}, ${finalCorrPin || null}, ${body.religion || null},
          ${body.mobile}, ${body.altTel || null}, ${body.email || null}, ${body.pan ? String(body.pan).toUpperCase() : null}, ${body.aadhar || null}, ${body.amount || null}, ${body.amountWords || null}, ${body.paymentMode || null}, ${body.paymentMode === 'Cash' ? null : (body.txnNo || null)}, ${body.paymentMode === 'Cash' ? null : (body.txnDate || null)}, ${body.bankBranch || null}, ${body.ifscCode ? String(body.ifscCode).toUpperCase() : null}, ${body.accountNumber || null},
          ${body.nominees ? (typeof body.nominees === 'string' ? body.nominees : JSON.stringify(body.nominees)) : null}, ${body.declDate || null}, ${body.declPlace || null}, ${body.declSignatureName || null}, ${body.firstApplicantName || null}, ${body.jointApplicantName || null},
          ${photoUrl || null}, ${sigFirstUrl || null}, ${sigJointUrl || null}, ${isFinalSubmit}, ${newAppStatus}
        ) RETURNING id
      `;
      resultId = newRow?.id;
    }

    // Auto-Sync to investor_users profile (Rule 3G)
    // NEVER overwrite email or mobile_number (auth identifiers)!
    // Non-empty values update profile; empty optional fields do NOT overwrite existing profile data.
    const fullName = [body.invFirstName, body.invMiddleName, body.invSurname].filter(Boolean).join(" ");
    const fhFullName = [body.fhFirstName, body.fhMiddleName, body.fhSurname].filter(Boolean).join(" ");
    let firstNomineeName = null;
    if (Array.isArray(body.nominees) && body.nominees.length > 0 && body.nominees[0].name) {
      firstNomineeName = body.nominees[0].name;
    }

    await sql`
      UPDATE investor_users
      SET
        full_name = COALESCE(NULLIF(${fullName}, ''), full_name),
        father_husband_name = COALESCE(NULLIF(${fhFullName}, ''), father_husband_name),
        date_of_birth = COALESCE(${body.dob ? new Date(body.dob) : null}, date_of_birth),
        gender = COALESCE(NULLIF(${body.gender || null}, ''), gender),
        alternate_mobile = COALESCE(NULLIF(${body.altTel || null}, ''), alternate_mobile),
        address = COALESCE(NULLIF(${body.address || null}, ''), address),
        city = COALESCE(NULLIF(${body.city || null}, ''), city),
        state = COALESCE(NULLIF(${body.state || null}, ''), state),
        pincode = COALESCE(NULLIF(${body.pinCode || null}, ''), pincode),
        pan_number = COALESCE(NULLIF(${body.pan ? String(body.pan).toUpperCase() : null}, ''), pan_number),
        aadhaar_number = COALESCE(NULLIF(${body.aadhar || null}, ''), aadhaar_number),
        bank_name = COALESCE(NULLIF(${body.bankBranch || null}, ''), bank_name),
        account_number = COALESCE(NULLIF(${body.accountNumber || null}, ''), account_number),
        ifsc_code = COALESCE(NULLIF(${body.ifscCode ? String(body.ifscCode).toUpperCase() : null}, ''), ifsc_code),
        nominee_name = COALESCE(NULLIF(${firstNomineeName}, ''), nominee_name),
        profile_picture_url = COALESCE(${photoUrl || null}, profile_picture_url),
        enrollment_status = ${isFinalSubmit ? 'Pending' : 'Submitted'},
        updated_at = NOW()
      WHERE id = ${investor_id}
    `;

    const [savedRecord] = await sql`
      SELECT photo_url, signature_first_url, signature_joint_url 
      FROM investor_enrollments 
      WHERE id = ${resultId}
    `;

    // Trigger investor enrollment confirmation email if final submit
    if (isFinalSubmit) {
      triggerEnrollmentEmailAsync({
        enrollmentType: "Investor",
        submissionId: resultId,
        recipientEmail: body.email || req.investor?.email,
        isFinalSubmit: true,
        customData: {
          ...body,
          id: resultId,
          investor_enrollment_id: invEnrollIdToSave,
          form_no: body.formNo || null,
          photo_url: savedRecord?.photo_url || photoUrl,
          signature_first_url: savedRecord?.signature_first_url || sigFirstUrl,
          signature_joint_url: savedRecord?.signature_joint_url || sigJointUrl
        }
      });
    }

    return ok(res, { 
      id: resultId, 
      is_final_submitted: isFinalSubmit, 
      app_status: newAppStatus,
      photo_url: formatStorageUrl(savedRecord?.photo_url || photoUrl),
      signature_first_url: formatStorageUrl(savedRecord?.signature_first_url || sigFirstUrl),
      signature_joint_url: formatStorageUrl(savedRecord?.signature_joint_url || sigJointUrl)
    }, 
      isFinalSubmit ? "Investor enrollment finalized successfully." : "Investor enrollment saved successfully in review mode."
    );
  } catch (e) {
    console.error("Investor Enrollment Error:", e);
    return err(res, "Failed to submit enrollment form: " + e.message);
  }
});

// GET /api/investor/enroll/my
router.get("/investor/enroll/my", authInvestor, async (req, res) => {
  try {
    const investor_id = req.investor.id;
    const [row] = await sql`
      SELECT ie.*, iu.profile_picture_url 
      FROM investor_enrollments ie
      LEFT JOIN investor_users iu ON ie.investor_id = iu.id
      WHERE ie.investor_id = ${investor_id} 
      ORDER BY ie.created_at DESC 
      LIMIT 1
    `;
    if (!row) {
      return ok(res, null, "No enrollment found.");
    }
    if (!row.photo_url && row.profile_picture_url) {
      row.photo_url = row.profile_picture_url;
    }
    row.photo_url = formatStorageUrl(row.photo_url);
    row.signature_first_url = formatStorageUrl(row.signature_first_url);
    row.signature_joint_url = formatStorageUrl(row.signature_joint_url);
    return ok(res, row);
  } catch (e) {
    console.error("GET /api/investor/enroll/my error:", e);
    return err(res, "Failed to fetch your enrollment.");
  }
});

// GET /api/investor/enrollment/:id/print
router.get("/investor/enrollment/:id/print", authInvestorOrAdmin, async (req, res) => {
  try {
    const rawId = String(req.params.id || "").trim();
    const numId = Number(rawId) || 0;

    const [enrollment] = await sql`
      SELECT ie.*, iu.member_id AS user_member_id
      FROM investor_enrollments ie
      LEFT JOIN investor_users iu ON ie.investor_id = iu.id
      WHERE (ie.id::text = ${rawId})
         OR (ie.investor_id = ${numId} AND ${numId} > 0)
         OR (ie.investor_enrollment_id = ${rawId})
         OR (ie.form_no = ${rawId})
         OR (iu.member_id = ${rawId})
      ORDER BY ie.created_at DESC
      LIMIT 1
    `;

    if (!enrollment) {
      return err(res, "Enrollment not found.", 404);
    }

    const isAdmin = Boolean(req.admin && isAdminPrincipal(req.admin));
    const isOwner = Boolean(req.investor && (Number(enrollment.investor_id) === Number(req.investor.id || req.investor.user_id)));

    if (!isAdmin && !isOwner) {
      return res.status(403).json({
        success: false,
        message: "Forbidden: You are not authorized to access this investor enrollment record."
      });
    }

    const pdfBuffer = await generateInvestorPdf(enrollment.id);

    const dateStr = enrollment.form_date 
      ? new Date(enrollment.form_date).toISOString().split('T')[0] 
      : new Date().toISOString().split('T')[0];
    const fileName = `MMR-Investor-${enrollment.investor_enrollment_id || 'Form'}-${dateStr}.pdf`;

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
          u.member_id,
          u.full_name,
          u.email,
          u.mobile_number as mobile_no,
          'Investor' as user_type,
          u.created_at as registered_at,
          u.status as account_status,
          e.id as submission_id,
          e.id as enrollment_id,
          e.investor_enrollment_id,
          e.form_no,
          e.form_date,
          e.branch_code,
          e.branch_name,
          e.project_name,
          e.inv_first_name,
          e.inv_surname,
          e.amount,
          e.payment_mode,
          e.payment_status,
          e.app_status,
          e.photo_url,
          e.signature_first_url,
          e.is_final_submitted,
          e.rejection_reason,
          e.created_at as submitted_at,
          CASE 
            WHEN e.id IS NOT NULL AND LOWER(COALESCE(e.app_status, '')) IN ('approved', 'completed') THEN 'Completed'
            WHEN e.id IS NOT NULL AND LOWER(COALESCE(e.app_status, '')) = 'rejected' THEN 'Rejected'
            WHEN e.id IS NOT NULL AND e.is_final_submitted = TRUE THEN 'Pending'
            WHEN e.id IS NOT NULL THEN 'Submitted'
            ELSE '0'
          END as enrollment_status,
          CASE WHEN e.id IS NOT NULL AND e.is_final_submitted = TRUE AND LOWER(COALESCE(e.app_status, '')) IN ('approved', 'completed') THEN TRUE ELSE FALSE END AS is_verified
        FROM investor_users u
        LEFT JOIN investor_enrollments e ON u.id = e.investor_id
        WHERE u.deleted_at IS NULL
          AND (
            u.full_name ILIKE ${s}
            OR u.mobile_number ILIKE ${s}
            OR u.email ILIKE ${s}
            OR u.member_id ILIKE ${s}
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
          u.member_id,
          u.full_name,
          u.email,
          u.mobile_number as mobile_no,
          'Investor' as user_type,
          u.created_at as registered_at,
          u.status as account_status,
          e.id as submission_id,
          e.id as enrollment_id,
          e.investor_enrollment_id,
          e.form_no,
          e.form_date,
          e.branch_code,
          e.branch_name,
          e.project_name,
          e.inv_first_name,
          e.inv_surname,
          e.amount,
          e.payment_mode,
          e.payment_status,
          e.app_status,
          e.photo_url,
          e.signature_first_url,
          e.is_final_submitted,
          e.rejection_reason,
          e.created_at as submitted_at,
          CASE 
            WHEN e.id IS NOT NULL AND LOWER(COALESCE(e.app_status, '')) IN ('approved', 'completed') THEN 'Completed'
            WHEN e.id IS NOT NULL AND LOWER(COALESCE(e.app_status, '')) = 'rejected' THEN 'Rejected'
            WHEN e.id IS NOT NULL AND e.is_final_submitted = TRUE THEN 'Pending'
            WHEN e.id IS NOT NULL THEN 'Submitted'
            ELSE '0'
          END as enrollment_status,
          CASE WHEN e.id IS NOT NULL AND e.is_final_submitted = TRUE AND LOWER(COALESCE(e.app_status, '')) IN ('approved', 'completed') THEN TRUE ELSE FALSE END AS is_verified
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
    const rawId = String(req.params.id || "").trim();
    const numId = Number(rawId) || 0;

    // 1. Comprehensive lookup: match by UUID, investor_id, investor_enrollment_id, form_no, or user member_id
    const [row] = await sql`
      SELECT ie.*,
             iu.id AS user_pk_id,
             iu.member_id AS user_member_id,
             iu.full_name AS user_full_name,
             iu.email AS user_email,
             iu.mobile_number AS user_mobile_number,
             iu.status AS user_account_status
      FROM investor_enrollments ie
      LEFT JOIN investor_users iu ON ie.investor_id = iu.id
      WHERE (ie.id::text = ${rawId})
         OR (ie.investor_id = ${numId} AND ${numId} > 0)
         OR (ie.investor_enrollment_id = ${rawId})
         OR (ie.form_no = ${rawId})
         OR (iu.id = ${numId} AND ${numId} > 0)
         OR (iu.member_id = ${rawId})
      ORDER BY ie.created_at DESC
      LIMIT 1
    `;

    if (row) {
      row.photo_url = formatStorageUrl(row.photo_url || row.profile_picture_url);
      row.signature_first_url = formatStorageUrl(row.signature_first_url);
      row.signature_joint_url = formatStorageUrl(row.signature_joint_url);
      return ok(res, row);
    }

    // 2. If no enrollment record exists yet, load basic investor user data
    const [invUser] = await sql`
      SELECT * FROM investor_users 
      WHERE ((id = ${numId} AND ${numId} > 0) OR member_id = ${rawId})
        AND deleted_at IS NULL
      LIMIT 1
    `;

    if (invUser) {
      return ok(res, {
        investor_id: invUser.id,
        investor_enrollment_id: invUser.member_id,
        inv_first_name: invUser.full_name,
        email: invUser.email,
        mobile: invUser.mobile_number,
        pan: invUser.pan_number,
        aadhar: invUser.aadhaar_number,
        address: invUser.address,
        city: invUser.city,
        state: invUser.state,
        pin_code: invUser.pincode,
        bank_branch: invUser.bank_name,
        account_number: invUser.account_number,
        ifsc_code: invUser.ifsc_code,
        nominees: invUser.nominee_name ? [{ name: invUser.nominee_name, relationship: '', age: '', proportion: 100 }] : [],
        photo_url: formatStorageUrl(invUser.profile_picture_url),
        is_new: true
      });
    }

    return err(res, "Enrollment not found.", 404);
  } catch (e) {
    console.error("GET /api/admin/investor-enrollment/:id error:", e);
    return err(res, "Failed to fetch enrollment: " + e.message);
  }
});

// PUT /api/admin/investor-enrollment/:id (Admin - Unlimited Edit & Save)
router.put("/admin/investor-enrollment/:id", authAdmin, async (req, res) => {
  try {
    const rawId = String(req.params.id || "").trim();
    const numId = Number(rawId) || 0;
    const b = req.body;

    // Comprehensive lookup to locate existing record
    const [existing] = await sql`
      SELECT ie.*, iu.id as user_pk_id, iu.member_id as user_member_id
      FROM investor_enrollments ie
      LEFT JOIN investor_users iu ON ie.investor_id = iu.id
      WHERE (ie.id::text = ${rawId})
         OR (ie.investor_id = ${numId} AND ${numId} > 0)
         OR (ie.investor_enrollment_id = ${rawId})
         OR (ie.form_no = ${rawId})
         OR (iu.id = ${numId} AND ${numId} > 0)
         OR (iu.member_id = ${rawId})
      ORDER BY ie.created_at DESC
      LIMIT 1
    `;

    // Process photo and signatures if base64 sent
    const processBase64 = async (dataUrl, filename) => {
      if (!dataUrl || typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) return dataUrl;
      const matches = dataUrl.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
      if (!matches || matches.length !== 3) return dataUrl;
      const buffer = Buffer.from(matches[2], 'base64');
      const saved = await saveFileToVPS(buffer, {
        originalName: filename,
        module: "investor",
        entityId: existing?.investor_id || numId,
        subCategory: "enrollments"
      });
      return saved?.url || saved?.relativePath || dataUrl;
    };

    const extractUrl = (val) => {
      if (!val) return null;
      if (typeof val === "object") return val.url || val.relativePath || null;
      if (typeof val === "string" && val.trim().startsWith("{")) {
        try {
          const p = JSON.parse(val.trim());
          return p.url || p.relativePath || val;
        } catch {}
      }
      return typeof val === "string" ? val : null;
    };

    let photoUrl = extractUrl(existing?.photo_url) || null;
    if (b.photo && typeof b.photo === "string" && b.photo.startsWith("data:")) {
      photoUrl = await processBase64(b.photo, `photo_${Date.now()}.png`);
    } else if (b.photo !== undefined) {
      photoUrl = extractUrl(b.photo);
    }

    let sigFirstUrl = extractUrl(existing?.signature_first_url) || null;
    if (b.signatureFirstApplicant && typeof b.signatureFirstApplicant === "string" && b.signatureFirstApplicant.startsWith("data:")) {
      sigFirstUrl = await processBase64(b.signatureFirstApplicant, `sig1_${Date.now()}.png`);
    } else if (b.signature && typeof b.signature === "string" && b.signature.startsWith("data:")) {
      sigFirstUrl = await processBase64(b.signature, `sig1_${Date.now()}.png`);
    } else if (b.signatureFirstApplicant !== undefined) {
      sigFirstUrl = extractUrl(b.signatureFirstApplicant);
    } else if (b.signature !== undefined) {
      sigFirstUrl = extractUrl(b.signature);
    }

    let sigJointUrl = extractUrl(existing?.signature_joint_url) || null;
    if (b.signatureJointApplicant && typeof b.signatureJointApplicant === "string" && b.signatureJointApplicant.startsWith("data:")) {
      sigJointUrl = await processBase64(b.signatureJointApplicant, `sig2_${Date.now()}.png`);
    } else if (b.signatureJointApplicant !== undefined) {
      sigJointUrl = extractUrl(b.signatureJointApplicant);
    }

    // Backend validation of mandatory fields (Part 3A & 3B)
    const missing = [];
    if (!b.invFirstName && !b.inv_first_name) missing.push("Investor First Name");
    if (!b.invSurname && !b.inv_surname) missing.push("Investor Surname");
    if (!b.fhFirstName && !b.fh_first_name) missing.push("Father's/Husband's First Name");
    if (!b.fhSurname && !b.fh_surname) missing.push("Father's/Husband's Surname");
    if (!b.dob && !b.date_of_birth) missing.push("Date of Birth");
    if (!b.address) missing.push("Permanent Address");
    if (!b.city) missing.push("City");
    if (!b.state) missing.push("State");
    if (!b.pinCode && !b.pin_code) missing.push("Pin Code");
    if (!b.mobile && !b.mobile_no && !b.mobile_number) missing.push("Mobile No.");
    if (!b.email) missing.push("Email ID");
    if (!b.pan && !b.pan_number) missing.push("PAN Card No.");
    if (!b.aadhar && !b.aadhaar_number) missing.push("Aadhaar Card No.");
    if (!b.amount || Number(b.amount) <= 0) missing.push("Investment Amount (> 0)");
    if (!b.paymentMode && !b.payment_mode) missing.push("Mode of Payment");
    if (b.paymentMode !== 'Cash' && b.payment_mode !== 'Cash') {
      if (!b.txnNo && !b.txn_no) missing.push("TXN / Cheque No.");
      if (!b.txnDate && !b.txn_date) missing.push("Payment Date");
    }
    if (!b.bankBranch && !b.bank_branch) missing.push("Bank & Branch");
    if (!b.accountNumber && !b.account_number) missing.push("Account Number");
    if (!b.ifscCode && !b.ifsc_code) missing.push("IFSC Code");
    if (!b.declPlace && !b.decl_place) missing.push("Place");
    if (!photoUrl) missing.push("Passport Photo");
    if (!sigFirstUrl) missing.push("Investor Signature");

    // Office Use validations (Part 3H.6)
    const appStatusVal = b.appStatus ?? b.app_status ?? existing?.app_status ?? 'Hold/Pending KYC';
    const isRejecting = String(appStatusVal).toLowerCase() === 'rejected';
    const rejectionReasonVal = b.rejectionReason ?? b.rejection_reason ?? existing?.rejection_reason ?? null;
    if (isRejecting && (!rejectionReasonVal || !String(rejectionReasonVal).trim())) {
      return res.status(400).json({
        success: false,
        message: "Application status 'Rejected' chunne par Reject Reason darj karna zaroori hai (Rejection reason is required when rejecting)."
      });
    }

    const paymentStatusVal = b.paymentStatus ?? b.payment_status ?? existing?.payment_status ?? null;
    const paymentStatusDateVal = b.paymentStatusDate ?? b.payment_status_date ?? existing?.payment_status_date ?? null;
    if ((paymentStatusVal === 'Cleared' || paymentStatusVal === 'Bounced') && !paymentStatusDateVal) {
      return res.status(400).json({
        success: false,
        message: `Payment status '${paymentStatusVal}' chunne par Payment Date darj karna zaroori hai (Payment Date is required).`
      });
    }

    if (missing.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Validation Error: Please fill required fields: ${missing.join(", ")}`,
        missingFields: missing
      });
    }

    // Format and normalize values
    const formNoVal = b.formNo ?? b.form_no ?? existing?.form_no ?? null;
    const formDateVal = b.formDate ?? b.form_date ?? existing?.form_date ?? null;
    const branchCodeVal = b.branchCode ?? b.branch_code ?? existing?.branch_code ?? null;
    const branchNameVal = b.branchName ?? b.branch_name ?? existing?.branch_name ?? null;
    const investorEnrollmentIdVal = b.investorId ?? b.investor_enrollment_id ?? existing?.investor_enrollment_id ?? null;
    const projectNameVal = b.projectName ?? b.project_name ?? existing?.project_name ?? null;

    const invFirstNameVal = normalizeHumanName(b.invFirstName ?? b.inv_first_name ?? existing?.inv_first_name);
    const invMiddleNameVal = (b.invMiddleName || existing?.inv_middle_name) ? normalizeHumanName(b.invMiddleName || existing?.inv_middle_name) : null;
    const invSurnameVal = normalizeHumanName(b.invSurname ?? b.inv_surname ?? existing?.inv_surname);
    const fhFirstNameVal = normalizeHumanName(b.fhFirstName ?? b.fh_first_name ?? existing?.fh_first_name);
    const fhMiddleNameVal = (b.fhMiddleName || existing?.fh_middle_name) ? normalizeHumanName(b.fhMiddleName || existing?.fh_middle_name) : null;
    const fhSurnameVal = normalizeHumanName(b.fhSurname ?? b.fh_surname ?? existing?.fh_surname);

    const dobVal = b.dob ?? b.date_of_birth ?? existing?.dob ?? null;
    const ageVal = b.age ? Number(b.age) : (existing?.age ?? null);
    const genderVal = b.gender ?? existing?.gender ?? 'M';
    const religionVal = b.religion ?? existing?.religion ?? null;
    const occupationVal = b.occupation ?? existing?.occupation ?? null;
    const occupationOtherVal = b.occupationOther ?? b.occupation_other ?? existing?.occupation_other ?? null;
    const addressVal = b.address ?? existing?.address ?? null;
    const cityVal = b.city ?? existing?.city ?? null;
    const stateVal = b.state ?? existing?.state ?? null;
    const pinCodeVal = b.pinCode ?? b.pin_code ?? existing?.pin_code ?? null;

    const corrAddressVal = b.corrAddress ?? b.corr_address ?? existing?.corr_address ?? addressVal;
    const corrCityVal = b.corrCity ?? b.corr_city ?? existing?.corr_city ?? cityVal;
    const corrStateVal = b.corrState ?? b.corr_state ?? existing?.corr_state ?? stateVal;
    const corrPinCodeVal = b.corrPinCode ?? b.corr_pin_code ?? existing?.corr_pin_code ?? pinCodeVal;

    const mobileVal = b.mobile ?? b.mobile_no ?? b.mobile_number ?? existing?.mobile ?? null;
    const altTelVal = b.altTel ?? b.alt_tel ?? existing?.alt_tel ?? null;
    const emailVal = b.email ?? existing?.email ?? null;
    const panVal = b.pan ? String(b.pan).toUpperCase() : (existing?.pan ?? null);
    const aadharVal = b.aadhar ?? b.aadhaar_number ?? existing?.aadhar ?? null;

    const amountVal = b.amount !== undefined ? Number(b.amount) : (existing?.amount ?? null);
    const amountWordsVal = b.amountWords ?? b.amount_words ?? existing?.amount_words ?? null;
    const paymentModeVal = b.paymentMode ?? b.payment_mode ?? existing?.payment_mode ?? null;
    const txnNoVal = b.txnNo ?? b.txn_no ?? existing?.txn_no ?? null;
    const txnDateVal = b.txnDate ?? b.txn_date ?? existing?.txn_date ?? null;
    const bankBranchVal = b.bankBranch ?? b.bank_branch ?? existing?.bank_branch ?? null;
    const ifscCodeVal = b.ifscCode ? String(b.ifscCode).toUpperCase() : (existing?.ifsc_code ?? null);
    const accountNumberVal = b.accountNumber ?? b.account_number ?? existing?.account_number ?? null;

    const nomineesVal = b.nominees ? (typeof b.nominees === 'string' ? b.nominees : JSON.stringify(b.nominees)) : (existing?.nominees ? (typeof existing.nominees === 'string' ? existing.nominees : JSON.stringify(existing.nominees)) : null);
    const declDateVal = b.declDate ?? b.decl_date ?? existing?.decl_date ?? null;
    const declPlaceVal = b.declPlace ?? b.decl_place ?? existing?.decl_place ?? null;
    const declSignatureNameVal = b.declSignatureName ?? b.decl_signature_name ?? existing?.decl_signature_name ?? null;
    const firstApplicantNameVal = b.firstApplicantName ?? b.first_applicant_name ?? existing?.first_applicant_name ?? null;
    const jointApplicantNameVal = b.jointApplicantName ?? b.joint_applicant_name ?? existing?.joint_applicant_name ?? null;

    const verifiedByVal = b.verifiedBy ?? b.verified_by ?? existing?.verified_by ?? null;
    const authorizedSignatoryVal = b.authorizedSignatory ?? b.authorized_signatory ?? existing?.authorized_signatory ?? null;
    const updatedByUserId = req.admin?.admin_id || req.admin?.id || 1;

    let targetEnrollmentId = existing?.id;
    let targetInvestorId = existing?.investor_id || (numId > 0 ? numId : null);

    // If no existing enrollment row, insert one!
    if (!existing) {
      const [newRow] = await sql`
        INSERT INTO investor_enrollments (
          investor_id, form_no, form_date, branch_code, branch_name, investor_enrollment_id, project_name,
          inv_first_name, inv_middle_name, inv_surname, fh_first_name, fh_middle_name, fh_surname,
          dob, age, gender, religion, occupation, occupation_other, address, city, state, pin_code,
          corr_address, corr_city, corr_state, corr_pin_code,
          mobile, alt_tel, email, pan, aadhar, amount, amount_words, payment_mode, txn_no, txn_date, bank_branch, ifsc_code, account_number,
          nominees, decl_date, decl_place, decl_signature_name, first_applicant_name, joint_applicant_name,
          app_status, rejection_reason, verified_by, payment_status, payment_status_date, authorized_signatory,
          photo_url, signature_first_url, signature_joint_url, is_final_submitted, updated_by_user_id
        ) VALUES (
          ${targetInvestorId}, ${formNoVal}, ${formDateVal}, ${branchCodeVal}, ${branchNameVal}, ${investorEnrollmentIdVal}, ${projectNameVal},
          ${invFirstNameVal}, ${invMiddleNameVal}, ${invSurnameVal}, ${fhFirstNameVal}, ${fhMiddleNameVal}, ${fhSurnameVal},
          ${dobVal}, ${ageVal}, ${genderVal}, ${religionVal}, ${occupationVal}, ${occupationOtherVal}, ${addressVal}, ${cityVal}, ${stateVal}, ${pinCodeVal},
          ${corrAddressVal}, ${corrCityVal}, ${corrStateVal}, ${corrPinCodeVal},
          ${mobileVal}, ${altTelVal}, ${emailVal}, ${panVal}, ${aadharVal}, ${amountVal}, ${amountWordsVal}, ${paymentModeVal}, ${txnNoVal}, ${txnDateVal}, ${bankBranchVal}, ${ifscCodeVal}, ${accountNumberVal},
          ${nomineesVal}, ${declDateVal}, ${declPlaceVal}, ${declSignatureNameVal}, ${firstApplicantNameVal}, ${jointApplicantNameVal},
          ${appStatusVal}, ${rejectionReasonVal}, ${verifiedByVal}, ${paymentStatusVal}, ${paymentStatusDateVal}, ${authorizedSignatoryVal},
          ${photoUrl}, ${sigFirstUrl}, ${sigJointUrl}, true, ${updatedByUserId}
        ) RETURNING id
      `;
      targetEnrollmentId = newRow?.id;
    } else {
      // If rejecting, set is_final_submitted = false so investor can edit
      const finalSubmitFlag = isRejecting ? false : existing.is_final_submitted;
      await sql`
        UPDATE investor_enrollments
        SET
          form_no = ${formNoVal}, form_date = ${formDateVal}, branch_code = ${branchCodeVal}, branch_name = ${branchNameVal}, investor_enrollment_id = ${investorEnrollmentIdVal}, project_name = ${projectNameVal},
          inv_first_name = ${invFirstNameVal}, inv_middle_name = ${invMiddleNameVal}, inv_surname = ${invSurnameVal}, fh_first_name = ${fhFirstNameVal}, fh_middle_name = ${fhMiddleNameVal}, fh_surname = ${fhSurnameVal},
          dob = ${dobVal}, age = ${ageVal}, gender = ${genderVal}, religion = ${religionVal}, occupation = ${occupationVal}, occupation_other = ${occupationOtherVal}, address = ${addressVal}, city = ${cityVal}, state = ${stateVal}, pin_code = ${pinCodeVal},
          corr_address = ${corrAddressVal}, corr_city = ${corrCityVal}, corr_state = ${corrStateVal}, corr_pin_code = ${corrPinCodeVal},
          mobile = ${mobileVal}, alt_tel = ${altTelVal}, email = ${emailVal}, pan = ${panVal}, aadhar = ${aadharVal}, amount = ${amountVal}, amount_words = ${amountWordsVal}, payment_mode = ${paymentModeVal}, txn_no = ${txnNoVal}, txn_date = ${txnDateVal}, bank_branch = ${bankBranchVal}, ifsc_code = ${ifscCodeVal}, account_number = ${accountNumberVal},
          nominees = ${nomineesVal}, decl_date = ${declDateVal}, decl_place = ${declPlaceVal}, decl_signature_name = ${declSignatureNameVal}, first_applicant_name = ${firstApplicantNameVal}, joint_applicant_name = ${jointApplicantNameVal},
          app_status = ${appStatusVal}, rejection_reason = ${rejectionReasonVal}, verified_by = ${verifiedByVal}, payment_status = ${paymentStatusVal}, payment_status_date = ${paymentStatusDateVal}, authorized_signatory = ${authorizedSignatoryVal},
          photo_url = COALESCE(${photoUrl}, photo_url), signature_first_url = COALESCE(${sigFirstUrl}, signature_first_url), signature_joint_url = COALESCE(${sigJointUrl}, signature_joint_url),
          is_final_submitted = ${finalSubmitFlag}, updated_by_user_id = ${updatedByUserId}, updated_at = NOW()
        WHERE id = ${existing.id}
      `;
    }

    // Auto-sync into investor_users (Rule 3G & 3H.7)
    // NEVER overwrite email or mobile_number (auth login credentials)!
    if (targetInvestorId) {
      const isApproved = String(appStatusVal).toLowerCase() === 'approved';
      const uEnrollmentStatus = isApproved ? 'Completed' : (isRejecting ? 'Rejected' : 'Pending');
      const fullName = [invFirstNameVal, invMiddleNameVal, invSurnameVal].filter(Boolean).join(" ");
      let firstNomineeName = null;
      if (b.nominees && Array.isArray(b.nominees) && b.nominees.length > 0 && b.nominees[0].name) {
        firstNomineeName = b.nominees[0].name;
      }

      await sql`
        UPDATE investor_users
        SET
          full_name = COALESCE(NULLIF(${fullName}, ''), full_name),
          father_husband_name = COALESCE(NULLIF(${[fhFirstNameVal, fhMiddleNameVal, fhSurnameVal].filter(Boolean).join(" ")}, ''), father_husband_name),
          date_of_birth = COALESCE(${dobVal ? new Date(dobVal) : null}, date_of_birth),
          gender = COALESCE(NULLIF(${genderVal}, ''), gender),
          alternate_mobile = COALESCE(NULLIF(${altTelVal}, ''), alternate_mobile),
          address = COALESCE(NULLIF(${addressVal}, ''), address),
          city = COALESCE(NULLIF(${cityVal}, ''), city),
          state = COALESCE(NULLIF(${stateVal}, ''), state),
          pincode = COALESCE(NULLIF(${pinCodeVal}, ''), pincode),
          pan_number = COALESCE(NULLIF(${panVal}, ''), pan_number),
          aadhaar_number = COALESCE(NULLIF(${aadharVal}, ''), aadhaar_number),
          bank_name = COALESCE(NULLIF(${bankBranchVal}, ''), bank_name),
          account_number = COALESCE(NULLIF(${accountNumberVal}, ''), account_number),
          ifsc_code = COALESCE(NULLIF(${ifscCodeVal}, ''), ifsc_code),
          nominee_name = COALESCE(NULLIF(${firstNomineeName}, ''), nominee_name),
          profile_picture_url = COALESCE(${photoUrl}, profile_picture_url),
          enrollment_status = ${uEnrollmentStatus},
          is_verified = CASE WHEN ${isApproved} THEN TRUE ELSE is_verified END,
          status = CASE WHEN ${isApproved} THEN 'active' ELSE (CASE WHEN ${isRejecting} THEN 'rejected' ELSE status END) END,
          updated_at = NOW()
        WHERE id = ${targetInvestorId}
      `;
    }

    const [updatedRow] = await sql`SELECT * FROM investor_enrollments WHERE id = ${targetEnrollmentId}`;
    if (updatedRow) {
      updatedRow.photo_url = formatStorageUrl(updatedRow.photo_url);
      updatedRow.signature_first_url = formatStorageUrl(updatedRow.signature_first_url);
      updatedRow.signature_joint_url = formatStorageUrl(updatedRow.signature_joint_url);
    }
    return ok(res, updatedRow, "Investor enrollment updated successfully.");
  } catch (e) {
    console.error("Update Enrollment Error:", e);
    return err(res, "Failed to update enrollment: " + e.message);
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
router.delete(["/admin/investor-enrollment/:id", "/admin/investor-enrollments/:id", "/admin/investor-users/:id", "/admin/investors-portal/:id"], authAdmin, async (req, res) => {
  try {
    const actor = {
      admin_id: req.admin?.admin_id || req.admin?.id || 1,
      full_name: req.admin?.full_name || req.admin?.username || "Admin"
    };
    const result = await deleteInvestorProfile(req.params.id, actor);
    return ok(res, result.data, result.message);
  } catch (e) {
    if (e.message === "Investor not found" || e.statusCode === 404) {
      return err(res, e.message, 404);
    }
    return err(res, "Failed to delete investor: " + e.message, e.statusCode || 500);
  }
});

export default router;
