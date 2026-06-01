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

const sanitizeBody = (body = {}) => {
  const sanitized = { ...body };
  for (const key of Object.keys(sanitized)) {
    if (/password|token|secret|key/i.test(key)) {
      sanitized[key] = '[REDACTED]';
    }
  }
  return sanitized;
};

const describeFiles = (files) => {
  if (!files) return { files_present: false };

  return Object.entries(files).reduce((acc, [field, value]) => {
    const list = Array.isArray(value) ? value : [value];
    acc[field] = list.map((file) => ({
      originalname: file.originalname,
      mimetype: file.mimetype,
      size: file.size,
    }));
    return acc;
  }, {});
};

const logRegistrationError = (label, error) => {
  console.error(label, {
    message: error?.message,
    code: error?.code,
    detail: error?.detail,
    constraint: error?.constraint,
    table: error?.table,
    column: error?.column,
    stack: error?.stack,
    details: error,
  });
};

let pendingTableReady = false;

async function ensurePendingRegistrationTable() {
  if (pendingTableReady) return;

  console.log('[Associate Registration] Checking pending_registrations table...');
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
  console.log('[Associate Registration] pending_registrations table ready');
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
  const validationErrors = [];

  console.log('[Associate Registration] Validating signup input...', {
    user_type: userType,
    email,
    mobile_no: mobileNo,
    full_name_present: Boolean(fullName),
    sponsor_invite_code_present: Boolean(body.sponsor_invite_code),
  });

  if (!fullName) validationErrors.push('Full name is required');
  if (!email || !isEmail(email)) validationErrors.push('Valid email address is required');
  if (!mobileNo || !isMobile(mobileNo)) {
    validationErrors.push('Valid 10-digit mobile number is required');
  }
  if (!body.password || body.password.length < 6) {
    validationErrors.push('Password must be at least 6 characters');
  }
  if (!['Customer', 'Associate'].includes(userType)) {
    validationErrors.push('user_type must be Customer or Associate');
  }

  if (validationErrors.length) {
    console.error('[Associate Registration] Validation Failed:', validationErrors);
    return { error: validationErrors[0], status: 400, validationErrors };
  }

  console.log('[Associate Registration] Checking duplicate email...');
  const [dupEmail] = await sql`SELECT user_id FROM users WHERE email = ${email}`;
  if (dupEmail) {
    console.error('[Associate Registration] Duplicate email found:', { email, user_id: dupEmail.user_id });
    return { error: 'Email already registered', status: 409 };
  }

  console.log('[Associate Registration] Checking duplicate mobile...');
  const [dupMobile] = await sql`SELECT user_id FROM users WHERE mobile_no = ${mobileNo}`;
  if (dupMobile) {
    console.error('[Associate Registration] Duplicate mobile found:', { mobile_no: mobileNo, user_id: dupMobile.user_id });
    return { error: 'Mobile number already registered', status: 409 };
  }

  let sponsorUserId = null;
  if (body.sponsor_invite_code) {
    console.log('[Associate Registration] Validating sponsor invite code...');
    const [sponsor] = await sql`
      SELECT user_id FROM users
      WHERE invitation_code = ${body.sponsor_invite_code}
        AND account_status = 'Active'`;
    if (!sponsor) {
      console.error('[Associate Registration] Invalid sponsor invitation code:', {
        sponsor_invite_code: body.sponsor_invite_code,
      });
      return { error: 'Invalid sponsor invitation code', status: 400 };
    }
    sponsorUserId = sponsor.user_id;
    console.log('[Associate Registration] Sponsor found:', { sponsor_user_id: sponsorUserId });
  }

  console.log('[Associate Registration] Validation Passed');

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
  const requestId = `reg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    console.log(`[Associate Registration:${requestId}] Request received`);
    console.log(`[Associate Registration:${requestId}] Request Body:`, sanitizeBody(req.body));
    console.log(`[Associate Registration:${requestId}] Authenticated User:`, req.user || null);
    console.log(`[Associate Registration:${requestId}] Files Received:`, describeFiles(req.files));
    console.log(`[Associate Registration:${requestId}] Database connection check...`);
    await sql`SELECT 1`;
    console.log(`[Associate Registration:${requestId}] Database connection OK`);

    const validation = await validateSignupInput(req.body);
    if (validation.error) {
      console.error(`[Associate Registration:${requestId}] Validation Failed:`, {
        message: validation.error,
        validationErrors: validation.validationErrors,
        status: validation.status || 400,
      });
      return err(res, validation.error, validation.status || 400);
    }

    await ensurePendingRegistrationTable();
    console.log(`[Associate Registration:${requestId}] Pending registration table ensured`);

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
    console.log(`[Associate Registration:${requestId}] Hashing password...`);
    const passwordHash = await bcrypt.hash(password, 12);
    console.log(`[Associate Registration:${requestId}] Password hashed`);

    console.log(`[Associate Registration:${requestId}] Removing old pending registration records...`);
    await sql`
      DELETE FROM pending_registrations
      WHERE email = ${email} OR mobile_no = ${mobileNo}`;
    console.log(`[Associate Registration:${requestId}] Old pending registration cleanup complete`);

    console.log(`[Associate Registration:${requestId}] Creating Associate Record...`, {
      user_type: userType,
      email,
      mobile_no: mobileNo,
      sponsor_user_id: sponsorUserId,
      expires_at: expires,
    });
    await sql`
      INSERT INTO pending_registrations (
        email, mobile_no, user_type, full_name, password_hash,
        sponsor_user_id, sponsor_invite_code, otp_code, expires_at
      ) VALUES (
        ${email}, ${mobileNo}, ${userType}, ${fullName}, ${passwordHash},
        ${sponsorUserId}, ${sponsorInviteCode}, ${otp}, ${expires}
      )`;
    console.log(`[Associate Registration:${requestId}] Associate pending record created`);

    console.log(`[Associate Registration:${requestId}] Sending OTP email...`, { email });
    await sendEmail(email, 'Verify your MMR account', otpEmailHtml(otp, 'Verification'));
    console.log(`[Associate Registration:${requestId}] OTP email sent`);

    const responseData = { email, user_type: userType };
    console.log(`[Associate Registration:${requestId}] Registration Successful`, responseData);
    return ok(
      res,
      responseData,
      'OTP sent to your email. Verify OTP to complete registration.',
    );
  } catch (e) {
    logRegistrationError(`[Associate Registration:${requestId}] Associate Registration Error`, e);

    if (e?.code === '23505') {
      return err(res, 'Duplicate registration record found', 409);
    }
    if (/cloudinary/i.test(e?.message || '')) {
      return err(res, 'Cloudinary upload failed', 500);
    }
    if (/send|smtp|email|mail/i.test(e?.message || '')) {
      return err(res, `Email delivery failed: ${e.message}`, 500);
    }
    if (e?.code || e?.constraint || e?.table) {
      return err(res, `Database insert failed: ${e.message}`, 500);
    }

    return err(res, e.message || 'Associate registration failed');
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
