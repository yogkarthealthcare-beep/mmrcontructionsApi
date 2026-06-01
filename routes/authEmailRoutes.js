import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import sql from '../db.js';
import { sendEmail, otpEmailHtml } from '../emailService.js';

const router = express.Router();

const ok = (res, data, msg = 'Success', status = 200) =>
  res.status(status).json({ success: true, message: msg, data });

const err = (res, msg = 'Server error', status = 500) =>
  res.status(status).json({ success: false, message: msg });

const genOTP = () => String(Math.floor(100000 + Math.random() * 900000));
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const isMobile = (v) => /^[6-9]\d{9}$/.test(v);
const normalizeEmail = (email) => String(email || '').toLowerCase().trim();

let pendingTableReady = false;

async function ensurePendingRegistrationTable() {
  if (pendingTableReady) return;

  await sql`
    CREATE TABLE IF NOT EXISTS pending_registrations (
      email TEXT PRIMARY KEY,
      mobile_no TEXT NOT NULL,
      user_type TEXT NOT NULL,
      full_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      sponsor_user_id INTEGER,
      sponsor_invite_code TEXT,
      otp_code TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;

  pendingTableReady = true;
}

async function canResend(email) {
  await ensurePendingRegistrationTable();

  const [last] = await sql`
    SELECT updated_at FROM pending_registrations
    WHERE email = ${normalizeEmail(email)}`;

  if (!last) return true;
  return (Date.now() - new Date(last.updated_at).getTime()) > 60_000;
}

async function validateSignupInput(body) {
  const userType = body.user_type || 'Customer';
  const email = normalizeEmail(body.email);
  const mobileNo = body.mobile_no;
  const fullName = body.full_name?.trim();

  if (!fullName) return { error: 'Full name is required' };
  if (!email || !isEmail(email)) return { error: 'Valid email address is required' };
  if (!mobileNo || !isMobile(mobileNo)) {
    return { error: 'Valid 10-digit mobile number is required' };
  }
  if (!body.password || body.password.length < 6) {
    return { error: 'Password must be at least 6 characters' };
  }
  if (!['Customer', 'Associate'].includes(userType)) {
    return { error: 'user_type must be Customer or Associate' };
  }

  const [dupEmail] = await sql`SELECT user_id FROM users WHERE email = ${email}`;
  if (dupEmail) return { error: 'Email already registered', status: 409 };

  const [dupMobile] = await sql`SELECT user_id FROM users WHERE mobile_no = ${mobileNo}`;
  if (dupMobile) return { error: 'Mobile number already registered', status: 409 };

  let sponsorUserId = null;
  if (body.sponsor_invite_code) {
    const [sponsor] = await sql`
      SELECT user_id FROM users
      WHERE invitation_code = ${body.sponsor_invite_code}
        AND account_status = 'Active'`;
    if (!sponsor) return { error: 'Invalid sponsor invitation code', status: 400 };
    sponsorUserId = sponsor.user_id;
  }

  return {
    value: {
      userType,
      email,
      mobileNo,
      fullName,
      password: body.password,
      sponsorUserId,
      sponsorInviteCode: body.sponsor_invite_code || null,
    },
  };
}

router.post('/register-quick', async (req, res) => {
  try {
    const validation = await validateSignupInput(req.body);
    if (validation.error) return err(res, validation.error, validation.status || 400);

    await ensurePendingRegistrationTable();

    const {
      userType,
      email,
      mobileNo,
      fullName,
      password,
      sponsorUserId,
      sponsorInviteCode,
    } = validation.value;

    const otp = genOTP();
    const expires = new Date(Date.now() + 10 * 60 * 1000);
    const passwordHash = await bcrypt.hash(password, 12);

    await sql`
      DELETE FROM pending_registrations
      WHERE email = ${email} OR mobile_no = ${mobileNo}`;

    await sql`
      INSERT INTO pending_registrations (
        email, mobile_no, user_type, full_name, password_hash,
        sponsor_user_id, sponsor_invite_code, otp_code, expires_at
      ) VALUES (
        ${email}, ${mobileNo}, ${userType}, ${fullName}, ${passwordHash},
        ${sponsorUserId}, ${sponsorInviteCode}, ${otp}, ${expires}
      )`;

    await sendEmail(email, 'Verify your MMR account', otpEmailHtml(otp, 'Verification'));

    return ok(
      res,
      { email, user_type: userType },
      'OTP sent to your email. Verify OTP to complete registration.',
    );
  } catch (e) {
    console.error('[register-quick]', e);
    return err(res, e.message);
  }
});

router.post('/send-email-otp', async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    if (!email || !isEmail(email)) return err(res, 'Valid email required', 400);

    await ensurePendingRegistrationTable();

    const [pending] = await sql`
      SELECT email FROM pending_registrations
      WHERE email = ${email}`;
    if (!pending) return err(res, 'Start registration before requesting OTP', 404);

    if (!(await canResend(email))) {
      return err(res, 'Please wait 60 seconds before requesting a new OTP', 429);
    }

    const otp = genOTP();
    const expires = new Date(Date.now() + 10 * 60 * 1000);

    await sql`
      UPDATE pending_registrations
      SET otp_code = ${otp}, attempts = 0, expires_at = ${expires}, updated_at = NOW()
      WHERE email = ${email}`;

    await sendEmail(email, 'Verify your MMR account', otpEmailHtml(otp, 'Verification'));

    return ok(res, { email }, 'OTP sent to email');
  } catch (e) {
    console.error('[send-email-otp]', e);
    return err(res, e.message);
  }
});

router.post('/verify-email-otp', async (req, res) => {
  try {
    await ensurePendingRegistrationTable();

    const email = normalizeEmail(req.body.email);
    const otp = String(req.body.otp || '').trim();
    if (!email || !otp) return err(res, 'email and otp are required', 400);

    const [pending] = await sql`
      SELECT * FROM pending_registrations
      WHERE email = ${email}`;

    if (!pending) return err(res, 'No pending registration found. Please sign up again.', 400);
    if (pending.attempts >= 5) {
      await sql`DELETE FROM pending_registrations WHERE email = ${email}`;
      return err(res, 'Too many OTP attempts. Please sign up again.', 429);
    }
    if (new Date() > new Date(pending.expires_at)) {
      await sql`DELETE FROM pending_registrations WHERE email = ${email}`;
      return err(res, 'OTP expired. Please sign up again.', 400);
    }
    if (pending.otp_code !== otp) {
      await sql`
        UPDATE pending_registrations
        SET attempts = attempts + 1, updated_at = NOW()
        WHERE email = ${email}`;
      return err(res, 'Invalid OTP. Please check and try again.', 400);
    }

    const [dupEmail] = await sql`SELECT user_id FROM users WHERE email = ${email}`;
    if (dupEmail) {
      await sql`DELETE FROM pending_registrations WHERE email = ${email}`;
      return err(res, 'Email already registered', 409);
    }

    const [dupMobile] = await sql`
      SELECT user_id FROM users WHERE mobile_no = ${pending.mobile_no}`;
    if (dupMobile) {
      await sql`DELETE FROM pending_registrations WHERE email = ${email}`;
      return err(res, 'Mobile number already registered', 409);
    }

    const [newUser] = await sql`
      INSERT INTO users (
        user_type, full_name, mobile_no, email,
        password_hash, sponsor_user_id,
        account_status, email_verified, email_verified_at
      ) VALUES (
        ${pending.user_type}, ${pending.full_name}, ${pending.mobile_no}, ${pending.email},
        ${pending.password_hash}, ${pending.sponsor_user_id},
        'Pending', TRUE, NOW()
      )
      RETURNING user_id, full_name, email, user_type, member_id, invitation_code`;

    await sql`DELETE FROM pending_registrations WHERE email = ${email}`;

    await sql`
      INSERT INTO audit_log
        (actor_type, actor_id, actor_name, module, action, target_table, target_record_id)
      VALUES
        ('User', ${newUser.user_id}, ${newUser.full_name},
         'Auth', 'RegisteredAfterEmailOtp', 'users', ${newUser.user_id})`;

    const payload = {
      user_id: newUser.user_id,
      user_type: newUser.user_type,
      member_id: newUser.member_id,
      email: newUser.email,
    };
    const token = jwt.sign(payload, process.env.JWT_SECRET, {
      expiresIn: process.env.JWT_EXPIRES_IN || '7d',
    });
    const refreshToken = jwt.sign(payload, process.env.JWT_REFRESH_SECRET, {
      expiresIn: '30d',
    });

    return ok(res, {
      token,
      refresh_token: refreshToken,
      user: {
        user_id: newUser.user_id,
        full_name: newUser.full_name,
        user_type: newUser.user_type,
        member_id: newUser.member_id,
        invitation_code: newUser.invitation_code,
      },
      redirect: newUser.user_type === 'Associate' ? '/associate/dashboard' : '/user/dashboard',
    }, 'Email verified. Registration completed and is pending admin approval.');
  } catch (e) {
    console.error('[verify-email-otp]', e);
    return err(res, e.message);
  }
});

router.post('/resend-email-otp', async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    if (!email || !isEmail(email)) return err(res, 'Valid email required', 400);

    await ensurePendingRegistrationTable();

    const [pending] = await sql`
      SELECT email FROM pending_registrations
      WHERE email = ${email}`;
    if (!pending) return err(res, 'No pending registration found. Please sign up again.', 404);

    if (!(await canResend(email))) {
      return err(res, 'Please wait 60 seconds before requesting a new OTP', 429);
    }

    const otp = genOTP();
    const expires = new Date(Date.now() + 10 * 60 * 1000);

    await sql`
      UPDATE pending_registrations
      SET otp_code = ${otp}, attempts = 0, expires_at = ${expires}, updated_at = NOW()
      WHERE email = ${email}`;

    await sendEmail(email, 'Your MMR verification OTP', otpEmailHtml(otp, 'Verification'));

    return ok(res, { email }, 'OTP resent to email');
  } catch (e) {
    console.error('[resend-email-otp]', e);
    return err(res, e.message);
  }
});

export default router;
