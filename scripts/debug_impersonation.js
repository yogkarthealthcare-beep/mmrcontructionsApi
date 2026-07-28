import express from "express";
import jwt from "jsonwebtoken";
import sql from "../db.js";

const app = express();
app.use(express.json());

const ok = (res, data, msg = "Success", status = 200) => res.status(status).json({ success: true, message: msg, data });
const err = (res, msg = "Server error", status = 500) => res.status(status).json({ success: false, message: msg });

const adminJwtSecret = () => process.env.JWT_ADMIN_SECRET || process.env.JWT_SECRET || "mmr_constructions_jwt_secret_2026_key";

const verifyAdminToken = (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer "))
    return err(res, "No admin token", 401);
  try {
    req.admin = jwt.verify(auth.split(" ")[1], adminJwtSecret());
    next();
  } catch (e) {
    return err(res, "Invalid or expired admin token: " + e.message, 401);
  }
};

app.post("/api/admin/login-as-user", verifyAdminToken, async (req, res) => {
  try {
    const { user_id, user_type } = req.body;
    if (!user_id || !user_type) {
      return err(res, "user_id and user_type are required", 400);
    }

    const normalizedType = String(user_type).trim();
    const cleanUserId = Number(user_id);
    if (!cleanUserId || isNaN(cleanUserId)) {
      return err(res, "Valid user_id is required", 400);
    }

    let targetUser = null;
    let redirectUrl = "";
    let payload = {};

    if (["Customer", "Associate"].includes(normalizedType)) {
      const [user] = await sql`
        SELECT user_id, full_name, email, mobile_no, user_type, account_status, member_id, invitation_code
        FROM users
        WHERE user_id = ${cleanUserId}`;

      if (!user) {
        return err(res, "User account not found", 404);
      }

      if (user.account_status !== "Active") {
        return err(res, `Account cannot be accessed because status is '${user.account_status}'.`, 403);
      }

      targetUser = user;
      redirectUrl = user.user_type === "Associate" ? "/associate/dashboard" : "/user/dashboard";

      payload = {
        user_id: user.user_id,
        user_type: user.user_type,
        member_id: user.member_id,
        mobile_no: user.mobile_no,
        email: user.email,
        full_name: user.full_name,
        impersonated_by_admin_id: req.admin.admin_id
      };
    } else if (normalizedType === "Investor") {
      const [investor] = await sql`
        SELECT id, full_name, email, mobile_number, status, is_verified
        FROM investor_users
        WHERE id = ${cleanUserId} AND deleted_at IS NULL`;

      if (!investor) {
        return err(res, "Investor account not found", 404);
      }

      if (investor.status !== "active" || !investor.is_verified) {
        return err(res, `Investor account is not active or verified (status: ${investor.status}).`, 403);
      }

      targetUser = {
        user_id: investor.id,
        id: investor.id,
        full_name: investor.full_name,
        email: investor.email,
        mobile_no: investor.mobile_number,
        user_type: "Investor",
        account_status: investor.status
      };
      redirectUrl = "/investor/dashboard";

      payload = {
        id: investor.id,
        user_id: investor.id,
        user_type: "Investor",
        role: "Investor",
        email: investor.email,
        full_name: investor.full_name,
        impersonated_by_admin_id: req.admin.admin_id
      };
    } else {
      return err(res, "Invalid user_type. Expected 'Customer', 'Associate', or 'Investor'.", 400);
    }

    const jwtSecret = process.env.JWT_SECRET || "mmr_constructions_jwt_secret_2026_key";
    const jwtRefreshSecret = process.env.JWT_REFRESH_SECRET || jwtSecret;
    const token = jwt.sign(payload, jwtSecret, { expiresIn: "2h" });
    const refreshToken = jwt.sign(payload, jwtRefreshSecret, { expiresIn: "7d" });

    try {
      await sql`
        INSERT INTO audit_log (actor_type, actor_id, actor_name, module, action, target_table, target_record_id, new_value)
        VALUES ('Admin', ${req.admin.admin_id}, ${req.admin.full_name || 'Admin'},
                'AdminImpersonation', 'LoginAsUser',
                ${normalizedType === 'Investor' ? 'investor_users' : 'users'},
                ${cleanUserId},
                ${JSON.stringify({ target_user_type: normalizedType, target_name: targetUser.full_name, target_email: targetUser.email, ip: req.ip, user_agent: req.headers['user-agent'] })})`;
    } catch (auditErr) {
      console.warn("[Audit Log Warning]:", auditErr.message);
    }

    return ok(res, {
      token,
      refresh_token: refreshToken,
      user: targetUser,
      redirect_url: redirectUrl
    }, `Successfully generated login session for ${targetUser.full_name}`);
  } catch (e) {
    console.error("ENDPOINT ERROR:", e);
    return err(res, e.stack || e.message, 500);
  }
});

const server = app.listen(5098, async () => {
  try {
    const adminToken = jwt.sign({ admin_id: 1, email: "admin@mmrconstructions.in", full_name: "MMR Admin", role: "SuperAdmin" }, adminJwtSecret(), { expiresIn: "1h" });
    const res = await fetch("http://localhost:5098/api/admin/login-as-user", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${adminToken}` },
      body: JSON.stringify({ user_id: 7, user_type: "Customer" })
    });
    const json = await res.json();
    console.log("LOCAL DEBUG RESPONSE:", json);
  } catch (e) {
    console.error("FETCH ERROR:", e);
  } finally {
    server.close();
    process.exit(0);
  }
});
