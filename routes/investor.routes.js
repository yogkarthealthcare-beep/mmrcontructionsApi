import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import sql from "../db.js";
import { sendEmail } from "../emailService.js";

const router = express.Router();

// ── Helpers ───────────────────────────────────────────────────
const ok = (res, data, msg = "Success", status = 200) =>
  res.status(status).json({ success: true, message: msg, data });

const err = (res, msg = "Server error", status = 500) =>
  res.status(status).json({ success: false, message: msg });

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
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
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
    try {
      req.admin = jwt.verify(token, process.env.JWT_SECRET);
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

// POST /api/investor/signup
router.post("/investor/signup", async (req, res) => {
  try {
    const {
      full_name,
      mobile_number,
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

    if (!full_name || !mobile_number || !email || !password) {
      return err(res, "Full Name, Mobile Number, Email, and Password are required.", 400);
    }

    const cleanEmail = String(email).trim().toLowerCase();
    const cleanMobile = String(mobile_number).trim();

    // Check existing email
    const [existing] = await sql`
      SELECT id FROM investor_users WHERE email = ${cleanEmail} OR mobile_number = ${cleanMobile} LIMIT 1
    `;
    if (existing) {
      return err(res, "An investor account with this Email or Mobile Number already exists.", 409);
    }

    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(password, salt);

    const [newInvestor] = await sql`
      INSERT INTO investor_users (
        full_name, mobile_number, email, password_hash,
        address, city, state, country, pincode,
        pan_number, aadhaar_number, bank_name, account_number, ifsc_code, nominee_name,
        status, is_verified
      ) VALUES (
        ${full_name.trim()}, ${cleanMobile}, ${cleanEmail}, ${password_hash},
        ${address || null}, ${city || null}, ${state || null}, ${country || 'India'}, ${pincode || null},
        ${pan_number ? pan_number.trim().toUpperCase() : null}, ${aadhaar_number || null},
        ${bank_name || null}, ${account_number || null}, ${ifsc_code ? ifsc_code.trim().toUpperCase() : null}, ${nominee_name || null},
        'pending', false
      )
      RETURNING id, full_name, email, mobile_number, status, is_verified, created_at
    `;

    return ok(res, newInvestor, "Investor registration submitted successfully! Pending approval.", 201);
  } catch (e) {
    console.error("Investor Signup Error:", e);
    return err(res, e.message || "Failed to process signup.");
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

    const token = jwt.sign(payload, process.env.JWT_SECRET, {
      expiresIn: process.env.JWT_EXPIRES_IN || "7d"
    });
    const refresh_token = jwt.sign(payload, process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET, {
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
        total_withdrawals: Number(user.total_withdrawals || 0)
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

    const [updated] = await sql`
      UPDATE investor_users
      SET full_name = COALESCE(${full_name}, full_name),
          mobile_number = COALESCE(${mobile_number}, mobile_number),
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
router.post("/investor/deposit", authInvestor, async (req, res) => {
  try {
    const { amount, payment_method, transaction_reference, payment_screenshot_url } = req.body;
    const numAmount = Number(amount);

    if (isNaN(numAmount) || numAmount <= 0) {
      return err(res, "Please enter a valid deposit amount greater than zero.", 400);
    }
    if (!payment_method || !transaction_reference) {
      return err(res, "Payment Method and Transaction Reference are required.", 400);
    }

    const investorId = req.investor.id;

    // Create Deposit request
    const [deposit] = await sql`
      INSERT INTO investor_deposits (
        investor_id, amount, payment_method, transaction_reference, payment_screenshot_url, status
      ) VALUES (
        ${investorId}, ${numAmount}, ${payment_method}, ${transaction_reference}, ${payment_screenshot_url || null}, 'pending'
      )
      RETURNING *
    `;

    // Create Transaction Record
    const txId = `DEP-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    await sql`
      INSERT INTO investor_transactions (
        investor_id, transaction_id, type, amount, status, payment_method, reference_number
      ) VALUES (
        ${investorId}, ${txId}, 'deposit', ${numAmount}, 'pending', ${payment_method}, ${transaction_reference}
      )
    `;

    return ok(res, deposit, "Deposit request submitted successfully! Awaiting admin approval.", 201);
  } catch (e) {
    console.error("Deposit Error:", e);
    return err(res, "Failed to submit deposit request.");
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

// GET /api/investor/payments
router.get("/investor/payments", authInvestor, async (req, res) => {
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
});

// ──────────────────────────────────────────────────────────────
//  ADMIN INVESTOR PORTAL APIs
// ──────────────────────────────────────────────────────────────

// GET /api/admin/investors-portal
router.get("/admin/investors-portal", authAdmin, async (req, res) => {
  try {
    const { search, status, page = 1, limit = 20 } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.max(1, Math.min(100, parseInt(limit, 10) || 20));
    const offset = (pageNum - 1) * limitNum;

    let query = sql`SELECT id, full_name, mobile_number, email, city, state, pan_number, bank_name, account_number, ifsc_code, available_balance, total_investment, total_deposits, total_withdrawals, status, is_verified, profile_picture_url, created_at FROM investor_users WHERE 1=1`;

    if (search) {
      const s = `%${search.trim()}%`;
      query = sql`${query} AND (full_name ILIKE ${s} OR email ILIKE ${s} OR mobile_number ILIKE ${s} OR pan_number ILIKE ${s})`;
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

    return ok(res, updated, `Investor account updated to ${updated.status}.`);
  } catch (e) {
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
      });
    }

    return ok(res, null, `Deposit request ${status} successfully.`);
  } catch (e) {
    console.error("Admin Deposit Status Error:", e);
    return err(res, "Failed to update deposit status.");
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

export default router;
