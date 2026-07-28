import express from 'express';
import sql from '../db.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const app = express();
app.use(express.json());

const ok = (res, data, msg = "Success", status = 200) => res.status(status).json({ success: true, message: msg, data });
const err = (res, msg = "Server error", status = 500) => res.status(status).json({ success: false, message: msg });

app.post("/api/auth/login", async (req, res) => {
  try {
    const { mobile_no, email, identifier, password, otp_code } = req.body;
    const loginId = String(identifier || email || mobile_no || "").trim().toLowerCase();
    const loginEmail = loginId.includes("@") ? loginId : null;
    const loginMobile = loginId.replace(/\D/g, "");
    const cleanMobile = loginMobile.length >= 10 ? loginMobile.slice(-10) : (loginMobile || null);

    if (!loginEmail && !cleanMobile) {
      return err(res, "Email or phone number required", 400);
    }

    let [user] = loginEmail
      ? await sql`
          SELECT user_id, full_name, email, mobile_no, user_type, account_status,
                 member_id, invitation_code, password_hash, email_verified, is_otp_verified
          FROM users
          WHERE LOWER(email) = ${loginEmail}`
      : await sql`
          SELECT user_id, full_name, email, mobile_no, user_type, account_status,
                 member_id, invitation_code, password_hash, email_verified, is_otp_verified
          FROM users
          WHERE RIGHT(regexp_replace(mobile_no, '\\D', '', 'g'), 10) = ${cleanMobile}`;

    if (!user) {
      const [investor] = loginEmail
        ? await sql`SELECT id, full_name, email, mobile_number, password_hash, status, is_verified FROM investor_users WHERE LOWER(email) = ${loginEmail} AND deleted_at IS NULL LIMIT 1`
        : await sql`SELECT id, full_name, email, mobile_number, password_hash, status, is_verified FROM investor_users WHERE RIGHT(regexp_replace(mobile_number, '\\D', '', 'g'), 10) = ${cleanMobile} AND deleted_at IS NULL LIMIT 1`;

      if (investor) {
        if (!investor.is_verified || investor.status === "pending_verification") {
          return err(res, "Please verify your email address before login.", 403);
        }
        if (investor.status === "inactive" || investor.status === "rejected") {
          return err(res, `Account is currently ${investor.status}. Contact support.`, 403);
        }
        if (password) {
          const valid = await bcrypt.compare(password, investor.password_hash);
          if (!valid) return err(res, "Invalid credentials", 401);
        } else {
          return err(res, "Password required for investor login.", 400);
        }

        const payload = {
          id: investor.id,
          user_id: investor.id,
          user_type: "Investor",
          role: "Investor",
          email: investor.email,
          full_name: investor.full_name,
        };

        const jwtSecret = process.env.JWT_SECRET || "mmr_constructions_jwt_secret_2026_key";
        const jwtRefreshSecret = process.env.JWT_REFRESH_SECRET || jwtSecret;
        const token = jwt.sign(payload, jwtSecret, { expiresIn: process.env.JWT_EXPIRES_IN || "7d" });
        const refreshToken = jwt.sign(payload, jwtRefreshSecret, { expiresIn: "30d" });

        return ok(res, {
          token,
          refresh_token: refreshToken,
          user: {
            id: investor.id,
            user_id: investor.id,
            full_name: investor.full_name,
            user_type: "Investor",
            email: investor.email,
            mobile_no: investor.mobile_number,
            account_status: investor.status,
            email_verified: Boolean(investor.is_verified)
          }
        }, "Investor login successful");
      }

      return err(res, "User not found", 404);
    }
  } catch (e) {
    console.error("CATCH ERROR:", e);
    return err(res, e.stack || e.message, 500);
  }
});

const server = app.listen(5099, async () => {
  try {
    const res = await fetch("http://localhost:5099/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "vikkirock8008@gmail.com", password: "TestPass123!" })
    });
    const json = await res.json();
    console.log("RESPONSE FROM LOCAL TEST SERVER:", json);
  } catch (e) {
    console.error(e);
  } finally {
    server.close();
    process.exit(0);
  }
});
