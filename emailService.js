import nodemailer from 'nodemailer';
import sql from './db.js';

const mask = (value = '') => {
  if (!value) return '';
  if (value.length <= 8) return '***';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
};

async function getDbEmailConfig() {
  try {
    const rows = await sql`SELECT key, value FROM email_config`;
    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
  } catch {
    return {};
  }
}

async function getSmtpConfig() {
  const dbConfig = await getDbEmailConfig();

  return {
    provider: process.env.OTP_PROVIDER || dbConfig.active_provider || 'smtp',
    host: process.env.SMTP_HOST || dbConfig.smtp_host || 'smtp-relay.brevo.com',
    port: Number(process.env.SMTP_PORT || dbConfig.smtp_port || 587),
    user: process.env.SMTP_USER || dbConfig.smtp_user || dbConfig.gmail_email,
    pass: process.env.SMTP_PASSWORD || dbConfig.smtp_password || dbConfig.gmail_app_password,
    from:
      process.env.SMTP_FROM ||
      dbConfig.smtp_from ||
      `"${process.env.BREVO_SENDER_NAME || dbConfig.sender_name || 'MMR Constructions'}" <${process.env.BREVO_SENDER_EMAIL || dbConfig.sender_email || process.env.SMTP_USER || dbConfig.gmail_email}>`,
  };
}

function createSmtpTransport(config) {
  if (!config.user || !config.pass) {
    throw new Error('SMTP credentials are not configured. Set SMTP_USER and SMTP_PASSWORD.');
  }

  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === 465,
    auth: {
      user: config.user,
      pass: config.pass,
    },
  });
}

export async function verifyEmailTransport() {
  const config = await getSmtpConfig();
  const transporter = createSmtpTransport(config);
  await transporter.verify();
  return {
    provider: config.provider,
    host: config.host,
    port: config.port,
    user: mask(config.user),
    from: config.from,
  };
}

export async function sendEmail(to, subject, html) {
  const config = await getSmtpConfig();

  if (!['smtp', 'brevo-smtp', 'gmail'].includes(String(config.provider).toLowerCase())) {
    console.warn(`[Email] OTP_PROVIDER=${config.provider} is not supported here. Falling back to SMTP.`);
  }

  try {
    const transporter = createSmtpTransport(config);
    const result = await transporter.sendMail({
      from: config.from,
      to,
      subject,
      html,
    });

    console.log('[Email] Sent successfully', {
      provider: 'smtp',
      host: config.host,
      port: config.port,
      from: config.from,
      to,
      messageId: result.messageId,
      accepted: result.accepted,
      rejected: result.rejected,
    });

    return result;
  } catch (error) {
    console.error('[Email] Send failed', {
      provider: 'smtp',
      host: config.host,
      port: config.port,
      user: mask(config.user),
      from: config.from,
      to,
      subject,
      code: error.code,
      command: error.command,
      response: error.response,
      message: error.message,
    });
    throw error;
  }
}

export function otpEmailHtml(otp, purpose = 'Verification') {
  return `
  <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;background:#f9fafb;padding:32px 16px;">
    <div style="background:#fff;border-radius:16px;padding:40px 32px;box-shadow:0 2px 12px rgba(0,0,0,.08);">
      <div style="text-align:center;margin-bottom:28px;">
        <h2 style="color:#1a5c3a;font-size:22px;margin:0;">M.M.R. Constructions</h2>
        <p style="color:#6b7280;font-size:13px;margin-top:4px;">Email ${purpose}</p>
      </div>
      <p style="color:#374151;font-size:14px;margin-bottom:8px;">Your One-Time Password (OTP) is:</p>
      <div style="background:#eaf4ee;border:2px dashed #1a5c3a;border-radius:12px;padding:20px;text-align:center;margin:20px 0;">
        <span style="font-size:36px;font-weight:bold;letter-spacing:12px;color:#1a5c3a;">${otp}</span>
      </div>
      <p style="color:#6b7280;font-size:13px;line-height:1.6;">
        This OTP is valid for <strong>10 minutes</strong>. Do not share it with anyone.
      </p>
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;"/>
      <p style="color:#9ca3af;font-size:11px;text-align:center;margin:0;">
        M.M.R. Constructions &amp; Developers Pvt. Ltd. | Kanpur, UP
      </p>
    </div>
  </div>`;
}

export function passwordChangedEmailHtml(adminName) {
  return `
  <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;background:#f9fafb;padding:32px 16px;">
    <div style="background:#fff;border-radius:16px;padding:40px 32px;box-shadow:0 2px 12px rgba(0,0,0,.08);">
      <h2 style="color:#1a5c3a;text-align:center;">Password Changed Successfully</h2>
      <p style="color:#374151;font-size:14px;">Hi <strong>${adminName}</strong>,</p>
      <p style="color:#374151;font-size:14px;line-height:1.7;">
        Your admin account password has been changed successfully.
        If you did not make this change, please contact support immediately.
      </p>
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;"/>
      <p style="color:#9ca3af;font-size:11px;text-align:center;">M.M.R. Constructions &amp; Developers Pvt. Ltd.</p>
    </div>
  </div>`;
}

export function registrationWelcomeEmailHtml(fullName, userType) {
  const roleLabel = userType === 'Associate' ? 'Associate Partner' : 'Customer';
  return `
  <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;background:#f9fafb;padding:32px 16px;">
    <div style="background:#fff;border-radius:16px;padding:40px 32px;box-shadow:0 2px 12px rgba(0,0,0,.08);">
      <h2 style="color:#1a5c3a;font-size:22px;margin:0 0 8px;">Welcome to MMR!</h2>
      <p style="color:#6b7280;font-size:13px;margin-top:0;">${roleLabel}</p>
      <p style="color:#374151;font-size:14px;">Hi <strong>${fullName}</strong>,</p>
      <p style="color:#374151;font-size:14px;line-height:1.7;">
        Your account has been created and is pending admin approval.
      </p>
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;"/>
      <p style="color:#9ca3af;font-size:11px;text-align:center;margin:0;">
        M.M.R. Constructions &amp; Developers Pvt. Ltd. | Kanpur, UP
      </p>
    </div>
  </div>`;
}
