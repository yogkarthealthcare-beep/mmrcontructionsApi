import express from "express";
import cors from "cors";
import sql from "./db.js";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import multer from "multer";
import path from "path";
import { v2 as cloudinary } from "cloudinary";
import { Readable } from "stream";
import newRoutes from './routes/newRoutes.js';
import authEmailRoutes from './routes/authEmailRoutes.js';
import { sendEmail, otpEmailHtml, passwordChangedEmailHtml } from "./emailService.js";
dotenv.config();


const app = express();

const defaultAllowedOrigins = [
  "http://localhost:4200",
  "http://127.0.0.1:4200",
  "https://mmrconstructions.in",
  "https://www.mmrconstructions.in",
  "https://mmrconstructions-adeb0.web.app",
  "https://mmrconstructions-adeb0.firebaseapp.com",
];
const envAllowedOrigins = (process.env.FRONTEND_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const allowedOrigins = [...new Set([...defaultAllowedOrigins, ...envAllowedOrigins])];

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    console.warn(`[CORS] Blocked origin: ${origin}`);
    return callback(new Error(`CORS blocked for origin: ${origin}`));
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-API-Key"],
  optionsSuccessStatus: 204,
}));

app.use(express.json());
app.use('/api/auth', authEmailRoutes);
app.use('/api', newRoutes);
// ─── Cloudinary Config ────────────────────────────────────────
const envValue = (key) => (process.env[key] || "").trim();
cloudinary.config({
  cloud_name: envValue("CLOUDINARY_CLOUD_NAME"),
  api_key:    envValue("CLOUDINARY_API_KEY"),
  api_secret: envValue("CLOUDINARY_API_SECRET"),
});

// ─── Folder mapping per fieldname ─────────────────────────────
const CLOUDINARY_FOLDER = {
  profile_photo: "mmr/profiles",
  payment_proof: "mmr/proofs",
  pan_card:      "mmr/documents",
  aadhar_card:   "mmr/documents",
  property_image:"mmr/site-images",
  site_map:      "mmr/site-maps",
  document:      "mmr/documents",   // generic upload-doc
};

/**
 * Buffer ko Cloudinary par upload karo
 * @param {Buffer} buffer
 * @param {string} folder  - Cloudinary folder
 * @param {string} filename - original file name (extension ke liye)
 * @returns {Promise<{url: string, public_id: string}>}
 */
function uploadToCloudinary(buffer, folder, filename) {
  return new Promise((resolve, reject) => {
    const ext         = path.extname(filename).toLowerCase().replace(".", "");
    const isPdf       = ext === "pdf";
    const resourceType = isPdf ? "raw" : "image";
    const cloudinaryConfig = {
      cloudName: envValue("CLOUDINARY_CLOUD_NAME"),
      apiKey: envValue("CLOUDINARY_API_KEY"),
      apiSecret: envValue("CLOUDINARY_API_SECRET"),
    };

    if (!cloudinaryConfig.cloudName || !cloudinaryConfig.apiKey || !cloudinaryConfig.apiSecret) {
      return reject(new Error("Cloudinary configuration missing. Check CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET."));
    }

    const publicId = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
    const timestamp = Math.floor(Date.now() / 1000);
    const paramsToSign = {
      folder,
      public_id: publicId,
      timestamp,
      ...(isPdf ? { format: "pdf" } : {}),
    };
    const signature = cloudinary.utils.api_sign_request(paramsToSign, cloudinaryConfig.apiSecret);
    const uploadOptions = {
      folder,
      resource_type: resourceType,
      public_id: publicId,
      timestamp,
      ...(isPdf ? { format: "pdf" } : {}),
    };

    console.log("Params To Sign:", paramsToSign);
    console.log("Generated Signature:", signature);
    console.log("Upload Payload:", {
      ...uploadOptions,
      api_key: `${cloudinaryConfig.apiKey.slice(0, 4)}...${cloudinaryConfig.apiKey.slice(-4)}`,
      file_name: filename,
      file_size: buffer.length,
    });

    const stream = cloudinary.uploader.upload_stream(
      uploadOptions,
      (error, result) => {
        if (error) {
          console.error("[Cloudinary Upload Error]", {
            message: error.message,
            http_code: error.http_code,
            paramsToSign,
            generatedSignature: signature,
            uploadPayload: {
              ...uploadOptions,
              api_key: `${cloudinaryConfig.apiKey.slice(0, 4)}...${cloudinaryConfig.apiKey.slice(-4)}`,
              file_name: filename,
              file_size: buffer.length,
            },
          });

          if (/invalid signature/i.test(error.message || "")) {
            return reject(new Error("Cloudinary upload failed: invalid signature. Verify CLOUDINARY_API_SECRET in the deployed environment and ensure folder, public_id, and timestamp match the signed payload."));
          }
          if (/timestamp/i.test(error.message || "")) {
            return reject(new Error("Cloudinary upload failed: missing or invalid timestamp."));
          }
          return reject(new Error(error.message || "Cloudinary upload failed."));
        }
        resolve({ url: result.secure_url, public_id: result.public_id });
      }
    );

    Readable.from(buffer).pipe(stream);
  });
}

// ─── Multer — memory storage (disk nahi, seedha buffer mein) ──
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (req, file, cb) => {
    const isSiteImage = file.fieldname === "site_map" || file.fieldname === "property_image";
    const allowed = isSiteImage ? /jpeg|jpg|png/ : /jpeg|jpg|png|pdf/;
    allowed.test(path.extname(file.originalname).toLowerCase())
      ? cb(null, true)
      : cb(new Error(isSiteImage ? "Only JPG, JPEG, and PNG files are allowed." : "Only JPG, PNG, PDF allowed"));
  },
});

/* ==========================
   HELPERS
========================== */
const ok  = (res, data, msg = "Success", status = 200) =>
  res.status(status).json({ success: true,  message: msg, data });

const err = (res, msg = "Server error", status = 500) =>
  res.status(status).json({ success: false, message: msg });

const adminJwtSecret = () => process.env.JWT_ADMIN_SECRET || process.env.JWT_SECRET;
const parseBool = (value, fallback = false) => {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return ["true", "1", "yes", "on"].includes(String(value).toLowerCase());
};

// Generate 6-digit OTP
const genOTP = () => String(Math.floor(100000 + Math.random() * 900000));

// Generate member ID:  MMR-C-00001 / MMR-A-00001
const genMemberID = async (userType) => {
  const prefix = userType === "Customer" ? "MMR-C-" : "MMR-A-";
  const [row] = await sql`
    SELECT COALESCE(MAX(CAST(SUBSTRING(member_id FROM ${prefix.length + 1}) AS INT)), 0) + 1 AS seq
    FROM users WHERE member_id LIKE ${prefix + "%"}`;
  return prefix + String(row.seq).padStart(5, "0");
};

// Generate invite code for Associates
const genInviteCode = () =>
  "MMR" + Math.random().toString(36).substring(2, 8).toUpperCase();

/* ==========================
   SIMPLE API KEY AUTH  (existing)
========================== */
const apiAuth = (req, res, next) => {
  const apiKey = req.headers["x-api-key"];
  if (!apiKey || apiKey !== process.env.API_KEY)
    return res.status(401).json({ error: "Unauthorized" });
  next();
};

/* ==========================
   JWT MIDDLEWARE — USER
========================== */
const verifyUserToken = (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer "))
    return err(res, "No token provided", 401);
  try {
    req.user = jwt.verify(auth.split(" ")[1], process.env.JWT_SECRET);
    next();
  } catch {
    return err(res, "Invalid or expired token", 401);
  }
};

/* ==========================
   JWT MIDDLEWARE — ADMIN
========================== */
const verifyAdminToken = (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer "))
    return err(res, "No admin token", 401);
  try {
    req.admin = jwt.verify(auth.split(" ")[1], adminJwtSecret());
    next();
  } catch {
    return err(res, "Invalid or expired admin token", 401);
  }
};

// Role guard for admin
const role = (...allowed) => (req, res, next) => {
  if (!allowed.includes(req.admin?.role))
    return err(res, "Forbidden — insufficient role", 403);
  next();
};

const inquiryStatuses = ["New", "Contacted", "Follow Up", "Interested", "Converted", "Closed"];
let inquirySchemaReady;
const ensureInquirySchema = () => {
  if (!inquirySchemaReady) {
    inquirySchemaReady = (async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS inquiries (
          inquiry_id SERIAL PRIMARY KEY,
          full_name VARCHAR(150) NOT NULL,
          mobile_no VARCHAR(20) NOT NULL,
          email VARCHAR(150),
          site_name VARCHAR(180),
          plot_number VARCHAR(80),
          inquiry_message TEXT,
          inquiry_type VARCHAR(80) DEFAULT 'General Enquiry',
          source_page VARCHAR(180) DEFAULT 'Website',
          status VARCHAR(30) NOT NULL DEFAULT 'New',
          remarks TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`;
      await sql`ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS email VARCHAR(150)`;
      await sql`ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS site_name VARCHAR(180)`;
      await sql`ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS plot_number VARCHAR(80)`;
      await sql`ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS inquiry_message TEXT`;
      await sql`ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS inquiry_type VARCHAR(80) DEFAULT 'General Enquiry'`;
      await sql`ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS source_page VARCHAR(180) DEFAULT 'Website'`;
      await sql`ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS status VARCHAR(30) NOT NULL DEFAULT 'New'`;
      await sql`ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS remarks TEXT`;
      await sql`ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`;
      await sql`ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`;
      await sql`CREATE INDEX IF NOT EXISTS idx_inquiries_created_at ON inquiries (created_at DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS idx_inquiries_status ON inquiries (status)`;
    })();
  }
  return inquirySchemaReady;
};

/* ==========================
   ─────────────────────────
   EXISTING APIS (unchanged)
   ─────────────────────────
========================== */

// GET ALL USERS API
app.get("/api/users", async (req, res) => {
  try {
    const users = await sql`SELECT * FROM users`;
    res.json(users);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ALL USERS (NO AUTH)
app.get("/api/usersNew", async (req, res) => {
  try {
    const users = await sql`SELECT id, full_name, email FROM users`;
    res.json(users);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET DAYS (NO JWT)
app.get("/api/days", async (req, res) => {
  try {
    const days = [
      { id: 1, name: "Monday" },   { id: 2, name: "Tuesday" },
      { id: 3, name: "Wednesday" }, { id: 4, name: "Thursday" },
      { id: 5, name: "Friday" },   { id: 6, name: "Saturday" },
      { id: 7, name: "Sunday" },
    ];
    res.json(days);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET USER BY ID
app.get("/api/users/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const user = await sql`SELECT * FROM users WHERE id = ${id}`;
    res.json(user[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ==========================
   ─────────────────────────
   AUTH — USER
   POST /api/auth/send-otp
   POST /api/auth/register
   POST /api/auth/login
   POST /api/auth/refresh
   POST /api/auth/forgot-password
   POST /api/auth/reset-password
   ─────────────────────────
========================== */

// Send OTP (registration / login)
app.post("/api/auth/send-otp", async (req, res) => {
  try {
    const { mobile_no, purpose = "Login" } = req.body;
    if (!mobile_no) return err(res, "mobile_no required", 400);

    const otp  = genOTP();
    const exp  = new Date(Date.now() + 10 * 60 * 1000); // 10 min

    // Invalidate old OTPs
    await sql`
      UPDATE otp_log SET is_used = TRUE
      WHERE mobile = ${mobile_no} AND purpose = ${purpose} AND is_used = FALSE`;

    await sql`
      INSERT INTO otp_log (user_type, reference_id, mobile, otp_code, purpose, expires_at)
      VALUES ('User', 0, ${mobile_no}, ${otp}, ${purpose}, ${exp})`;

    // TODO: Integrate real SMS gateway (Fast2SMS / MSG91)
    console.log(`[OTP] ${mobile_no} → ${otp}`);

    return ok(res, { mobile_no }, "OTP sent successfully");
  } catch (e) {
    return err(res, e.message);
  }
});

// Register (multi-step — submit all at once after form)
app.post("/api/auth/register", upload.fields([
  { name: "pan_card",      maxCount: 1 },
  { name: "aadhar_card",   maxCount: 1 },
  { name: "profile_photo", maxCount: 1 },
]), async (req, res) => {
  try {
    const {
      user_type, full_name, date_of_birth, gender,
      father_name, mother_name, spouse_name,
      mobile_no, alternate_mobile, email,
      pan_number, aadhar_number, otp_code,
      password,                                   // ← FIX: password field add kiya
      // Address
      perm_address_line1, perm_city, perm_state, perm_pin,
      local_address_line1, local_city, local_pin,
      // Bank
      account_holder_name, account_number, ifsc_code, branch_name, bank_name,
      // Nominee
      nominee_name, nominee_dob, nominee_gender, nominee_pan,
      nominee_aadhar, nominee_relationship,
      // Associate
      sponsor_invite_code,
      // Declaration
      terms_accepted,
    } = req.body;

    // ── Validate required fields ──
    if (!user_type || !full_name || !mobile_no || !pan_number || !aadhar_number)
      return err(res, "Required fields missing", 400);

    if (!terms_accepted || terms_accepted !== "true")
      return err(res, "Terms & Conditions must be accepted", 400);

    // ── Verify OTP ──
    const [otpRow] = await sql`
      SELECT * FROM otp_log
      WHERE mobile = ${mobile_no} AND otp_code = ${otp_code}
        AND purpose = 'Registration' AND is_used = FALSE
        AND expires_at > NOW()
      ORDER BY otp_id DESC LIMIT 1`;

    if (!otpRow) return err(res, "Invalid or expired OTP", 400);

    // ── Duplicate checks ──
    const [dupMobile] = await sql`SELECT user_id FROM users WHERE mobile_no = ${mobile_no}`;
    if (dupMobile) return err(res, "Mobile number already registered", 409);

    const [dupPAN] = await sql`SELECT user_id FROM users WHERE pan_number = ${pan_number}`;
    if (dupPAN) return err(res, "PAN already registered", 409);

    const [dupAadhar] = await sql`SELECT user_id FROM users WHERE aadhar_number = ${aadhar_number}`;
    if (dupAadhar) return err(res, "Aadhar already registered", 409);

    // ── Find sponsor ──
    let sponsorUserId = null;
    if (sponsor_invite_code) {
      const [sponsor] = await sql`
        SELECT user_id FROM users WHERE invitation_code = ${sponsor_invite_code}
          AND account_status = 'Active'`;
      if (!sponsor) return err(res, "Invalid sponsor invitation code", 400);
      sponsorUserId = sponsor.user_id;
    }

    // ── Hash password if provided ──
    const passwordHash = password ? await bcrypt.hash(password, 12) : null;

    // ── Insert User ──
    const [newUser] = await sql`
      INSERT INTO users (
        user_type, full_name, date_of_birth, gender,
        father_name, mother_name, spouse_name,
        mobile_no, alternate_mobile, email,
        pan_number, aadhar_number, is_otp_verified,
        password_hash,
        sponsor_user_id, account_status
      ) VALUES (
        ${user_type}, ${full_name}, ${date_of_birth || null}, ${gender || null},
        ${father_name || null}, ${mother_name || null}, ${spouse_name || null},
        ${mobile_no}, ${alternate_mobile || null}, ${email || null},
        ${pan_number.toUpperCase()}, ${aadhar_number}, TRUE,
        ${passwordHash},
        ${sponsorUserId}, 'Pending'
      ) RETURNING user_id, full_name, mobile_no, user_type`;

    const userId = newUser.user_id;

    // ── Addresses ──
    if (perm_address_line1) {
      await sql`
        INSERT INTO user_addresses (user_id, address_type, address_line1, city, state, pin_code)
        VALUES (${userId}, 'Permanent', ${perm_address_line1}, ${perm_city || null},
                ${perm_state || null}, ${perm_pin || null})`;
    }
    if (local_address_line1) {
      await sql`
        INSERT INTO user_addresses (user_id, address_type, address_line1, city, pin_code)
        VALUES (${userId}, 'Local', ${local_address_line1}, ${local_city || null}, ${local_pin || null})`;
    }

    // ── Bank Details ──
    if (account_number && ifsc_code) {
      await sql`
        INSERT INTO user_bank_details
          (user_id, account_holder_name, account_number, ifsc_code, branch_name, bank_name)
        VALUES (${userId}, ${account_holder_name || full_name}, ${account_number},
                ${ifsc_code.toUpperCase()}, ${branch_name || null}, ${bank_name || null})`;
    }

    // ── Nominee ──
    if (nominee_name) {
      await sql`
        INSERT INTO user_nominees
          (user_id, nominee_name, date_of_birth, gender, pan_number, aadhar_number, relationship)
        VALUES (${userId}, ${nominee_name}, ${nominee_dob || null}, ${nominee_gender || null},
                ${nominee_pan || null}, ${nominee_aadhar || null}, ${nominee_relationship || null})`;
    }

    // ── Documents — Cloudinary upload ──
    const fileFields = [
      { field: "pan_card",      type: "PANCard"      },
      { field: "aadhar_card",   type: "AadharCard"   },
      { field: "profile_photo", type: "ProfilePhoto" },
    ];

    for (const { field, type } of fileFields) {
      const f = req.files?.[field]?.[0];
      if (!f) continue;
      const folder = CLOUDINARY_FOLDER[field] || "mmr/documents";
      const { url, public_id } = await uploadToCloudinary(f.buffer, folder, f.originalname);
      await sql`
        INSERT INTO user_documents (user_id, document_type, file_path, cloudinary_public_id)
        VALUES (${userId}, ${type}, ${url}, ${public_id})`;
    }

    // ── Mark OTP used ──
    await sql`UPDATE otp_log SET is_used = TRUE WHERE otp_id = ${otpRow.otp_id}`;

    // ── Audit ──
    await sql`
      INSERT INTO audit_log (actor_type, actor_id, actor_name, module, action, target_table, target_record_id)
      VALUES ('User', ${userId}, ${full_name}, 'Auth', 'Registered', 'users', ${userId})`;

    return ok(res, { user_id: userId, full_name, user_type: newUser.user_type },
      "Registration submitted. Pending admin approval.", 201);
  } catch (e) {
    return err(res, e.message);
  }
});


// Register Quick (Signup form se — sirf basic details, email OTP verify hoga)
app.post("/api/auth/register-quick", async (req, res) => {
  try {
    const { user_type, full_name, email, mobile_no, password, sponsor_invite_code } = req.body;

    if (!user_type || !full_name || !email || !mobile_no || !password)
      return err(res, "user_type, full_name, email, mobile_no, password required", 400);

    // Duplicate checks
    const [dupMobile] = await sql`SELECT user_id FROM users WHERE mobile_no = ${mobile_no}`;
    if (dupMobile) return err(res, "Mobile number already registered", 409);

    const [dupEmail] = await sql`SELECT user_id FROM users WHERE email = ${email}`;
    if (dupEmail) return err(res, "Email already registered", 409);

    // Find sponsor
    let sponsorUserId = null;
    if (sponsor_invite_code) {
      const [sponsor] = await sql`
        SELECT user_id FROM users WHERE invitation_code = ${sponsor_invite_code}
          AND account_status = 'Active'`;
      if (!sponsor) return err(res, "Invalid sponsor invitation code", 400);
      sponsorUserId = sponsor.user_id;
    }

    const passwordHash = await bcrypt.hash(password, 12);

    // Insert user with Pending status
    const [newUser] = await sql`
      INSERT INTO users (user_type, full_name, email, mobile_no, password_hash,
                         sponsor_user_id, account_status, is_otp_verified)
      VALUES (${user_type}, ${full_name.trim()}, ${email.toLowerCase().trim()},
              ${mobile_no}, ${passwordHash}, ${sponsorUserId}, 'Pending', FALSE)
      RETURNING user_id, full_name, email, user_type`;

    // Generate 6-digit email OTP aur email_otp_log mein store karo
    const otp = genOTP();
    const exp = new Date(Date.now() + 10 * 60 * 1000); // 10 min

    // otp_log table use kar raha hai (mobile field mein email store karo)
    await sql`
      INSERT INTO otp_log (user_type, reference_id, mobile, otp_code, purpose, expires_at)
      VALUES ('User', ${newUser.user_id}, ${email.toLowerCase().trim()}, ${otp}, 'EmailVerification', ${exp})`;

    // TODO: Real email gateway se OTP bhejo (Nodemailer / SendGrid)
    console.log(`[EMAIL OTP] ${email} -> ${otp}`);

    await sql`
      INSERT INTO audit_log (actor_type, actor_id, actor_name, module, action, target_table, target_record_id)
      VALUES ('User', ${newUser.user_id}, ${full_name}, 'Auth', 'QuickRegistered', 'users', ${newUser.user_id})`;

    return ok(res, { user_id: newUser.user_id, email: newUser.email },
      "Registration initiated. OTP sent to your email.", 201);
  } catch (e) {
    return err(res, e.message);
  }
});

// Verify Email OTP (signup ke baad)
app.post("/api/auth/verify-email-otp", async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) return err(res, "email and otp required", 400);

    const [otpRow] = await sql`
      SELECT * FROM otp_log
      WHERE mobile = ${email.toLowerCase().trim()} AND otp_code = ${otp}
        AND purpose = 'EmailVerification' AND is_used = FALSE AND expires_at > NOW()
      ORDER BY otp_id DESC LIMIT 1`;

    if (!otpRow) return err(res, "Invalid or expired OTP", 400);

    const [user] = await sql`
      SELECT user_id, full_name, mobile_no, user_type, account_status, member_id, invitation_code
      FROM users WHERE user_id = ${otpRow.reference_id}`;

    if (!user) return err(res, "User not found", 404);

    // Mark email verified
    await sql`UPDATE users SET is_otp_verified = TRUE, updated_at = NOW() WHERE user_id = ${user.user_id}`;
    await sql`UPDATE otp_log SET is_used = TRUE WHERE otp_id = ${otpRow.otp_id}`;

    // JWT token generate karo
    const payload = {
      user_id:   user.user_id,
      user_type: user.user_type,
      member_id: user.member_id,
      mobile_no: user.mobile_no,
    };
    const token        = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || "7d" });
    const refreshToken = jwt.sign(payload, process.env.JWT_REFRESH_SECRET, { expiresIn: "30d" });

    return ok(res, {
      token,
      refresh_token: refreshToken,
      user: { user_id: user.user_id, full_name: user.full_name,
              user_type: user.user_type, member_id: user.member_id,
              invitation_code: user.invitation_code },
    }, "Email verified successfully. Registration pending admin approval.");
  } catch (e) {
    return err(res, e.message);
  }
});

// Resend Email OTP
app.post("/api/auth/resend-email-otp", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return err(res, "email required", 400);

    const [user] = await sql`SELECT user_id FROM users WHERE email = ${email.toLowerCase().trim()}`;
    if (!user) return err(res, "Email not registered", 404);

    const otp = genOTP();
    const exp = new Date(Date.now() + 10 * 60 * 1000);

    await sql`
      UPDATE otp_log SET is_used = TRUE
      WHERE mobile = ${email.toLowerCase().trim()} AND purpose = 'EmailVerification' AND is_used = FALSE`;

    await sql`
      INSERT INTO otp_log (user_type, reference_id, mobile, otp_code, purpose, expires_at)
      VALUES ('User', ${user.user_id}, ${email.toLowerCase().trim()}, ${otp}, 'EmailVerification', ${exp})`;

    console.log(`[EMAIL OTP RESEND] ${email} -> ${otp}`);
    return ok(res, {}, "OTP resent to your email.");
  } catch (e) {
    return err(res, e.message);
  }
});

// Login
app.post("/api/auth/login", async (req, res) => {
  try {
    const { mobile_no, email, identifier, password, otp_code } = req.body;
    const loginId = String(identifier || email || mobile_no || "").trim();
    const loginEmail = loginId.includes("@") ? loginId.toLowerCase() : null;
    const loginMobile = loginEmail ? null : String(mobile_no || loginId).replace(/\D/g, "");

    if (!loginEmail && !loginMobile) {
      return err(res, "Email or phone number required", 400);
    }

    const [user] = loginEmail
      ? await sql`
          SELECT user_id, full_name, email, mobile_no, user_type, account_status,
                 member_id, invitation_code, password_hash
          FROM users
          WHERE email = ${loginEmail}`
      : await sql`
          SELECT user_id, full_name, email, mobile_no, user_type, account_status,
                 member_id, invitation_code, password_hash
          FROM users
          WHERE mobile_no = ${loginMobile}`;

    if (!user) return err(res, "User not found", 404);

    if (user.account_status === "Pending")
      return err(res, "Account pending admin approval", 403);
    if (user.account_status === "Rejected")
      return err(res, "Account rejected. Contact support.", 403);
    if (user.account_status === "Suspended" || user.account_status === "Blacklisted")
      return err(res, "Account suspended. Contact support.", 403);

    // OTP login
    if (otp_code) {
      if (!loginMobile) return err(res, "OTP login requires mobile number", 400);
      const [otpRow] = await sql`
        SELECT * FROM otp_log
        WHERE mobile = ${loginMobile} AND otp_code = ${otp_code}
          AND purpose = 'Login' AND is_used = FALSE AND expires_at > NOW()
        ORDER BY otp_id DESC LIMIT 1`;
      if (!otpRow) return err(res, "Invalid or expired OTP", 401);
      await sql`UPDATE otp_log SET is_used = TRUE WHERE otp_id = ${otpRow.otp_id}`;
    }
    // Password login
    else if (password) {
      if (!user.password_hash) return err(res, "No password set. Use OTP login.", 400);
      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) return err(res, "Invalid credentials", 401);
    } else {
      return err(res, "Provide password or otp_code", 400);
    }

    const payload = {
      user_id:    user.user_id,
      user_type:  user.user_type,
      member_id:  user.member_id,
      mobile_no:  user.mobile_no,
      email:      user.email,
    };

    const token        = jwt.sign(payload, process.env.JWT_SECRET,         { expiresIn: process.env.JWT_EXPIRES_IN || "7d" });
    const refreshToken = jwt.sign(payload, process.env.JWT_REFRESH_SECRET, { expiresIn: "30d" });

    return ok(res, {
      token, refresh_token: refreshToken,
      user: { user_id: user.user_id, full_name: user.full_name,
              user_type: user.user_type, member_id: user.member_id,
              invitation_code: user.invitation_code, email: user.email },
    }, "Login successful");
  } catch (e) {
    return err(res, e.message);
  }
});

// Refresh Token
app.post("/api/auth/refresh", async (req, res) => {
  try {
    const { refresh_token } = req.body;
    if (!refresh_token) return err(res, "refresh_token required", 400);
    const decoded = jwt.verify(refresh_token, process.env.JWT_REFRESH_SECRET);
    const token   = jwt.sign(
      { user_id: decoded.user_id, user_type: decoded.user_type,
        member_id: decoded.member_id, mobile_no: decoded.mobile_no },
      process.env.JWT_SECRET, { expiresIn: "7d" }
    );
    return ok(res, { token }, "Token refreshed");
  } catch {
    return err(res, "Invalid refresh token", 401);
  }
});

// Forgot Password — send OTP
app.post("/api/auth/forgot-password", async (req, res) => {
  try {
    const email = String(req.body.email || "").toLowerCase().trim();
    const mobileNo = String(req.body.mobile_no || "").replace(/\D/g, "");
    if (!email && !mobileNo) return err(res, "email required", 400);

    const [user] = email
      ? await sql`
          SELECT user_id, full_name, email, mobile_no
          FROM users
          WHERE LOWER(email) = ${email}`
      : await sql`
          SELECT user_id, full_name, email, mobile_no
          FROM users
          WHERE mobile_no = ${mobileNo}`;

    if (!user) return err(res, "Email not registered", 404);
    if (!user.email) return err(res, "Registered email not available for this account", 400);

    const resetEmail = String(user.email).toLowerCase().trim();
    const otp = genOTP();

    await sql`
      UPDATE otp_log SET is_used = TRUE
      WHERE mobile = ${resetEmail} AND purpose = 'ResetPassword' AND is_used = FALSE`;
    await sql`
      INSERT INTO otp_log (user_type, reference_id, mobile, otp_code, purpose, expires_at)
      VALUES ('User', ${user.user_id}, ${resetEmail}, ${otp}, 'ResetPassword',
              ${new Date(Date.now() + 10*60*1000)})`;

    await sendEmail(resetEmail, "MMR password reset OTP", otpEmailHtml(otp, "Password Reset"));
    return ok(res, { email: resetEmail }, "OTP sent to your registered email");
  } catch (e) {
    return err(res, e.message);
  }
});

app.post("/api/auth/reset-password", async (req, res) => {
  try {
    const email = String(req.body.email || "").toLowerCase().trim();
    const { otp_code, new_password } = req.body;
    if (!email || !otp_code || !new_password)
      return err(res, "email, otp_code, new_password required", 400);
    if (String(new_password).length < 8)
      return err(res, "New password minimum 8 characters required", 400);

    const [otpRow] = await sql`
      SELECT * FROM otp_log
      WHERE mobile = ${email} AND otp_code = ${otp_code}
        AND purpose = 'ResetPassword' AND is_used = FALSE AND expires_at > NOW()
      ORDER BY otp_id DESC LIMIT 1`;
    if (!otpRow) return err(res, "Invalid or expired OTP", 400);

    const hash = await bcrypt.hash(new_password, 12);
    await sql`UPDATE users SET password_hash = ${hash}, updated_at = NOW() WHERE user_id = ${otpRow.reference_id}`;
    await sql`UPDATE otp_log SET is_used = TRUE WHERE otp_id = ${otpRow.otp_id}`;

    return ok(res, {}, "Password reset successfully");
  } catch (e) {
    return err(res, e.message);
  }
});

app.post("/api/auth/change-password", verifyUserToken, async (req, res) => {
  try {
    const { current_password, new_password, confirm_password } = req.body;
    if (!current_password || !new_password || !confirm_password)
      return err(res, "current_password, new_password, confirm_password required", 400);
    if (new_password.length < 8)
      return err(res, "New password minimum 8 characters required", 400);
    if (new_password !== confirm_password)
      return err(res, "New password and confirm password do not match", 400);

    const [user] = await sql`
      SELECT user_id, full_name, email, password_hash
      FROM users
      WHERE user_id = ${req.user.user_id}`;

    if (!user) return err(res, "User not found", 404);
    if (!user.password_hash) return err(res, "No password set for this account", 400);

    const valid = await bcrypt.compare(current_password, user.password_hash);
    if (!valid) return err(res, "Current password is incorrect", 400);
    if (await bcrypt.compare(new_password, user.password_hash))
      return err(res, "New password must be different from current password", 400);

    const newHash = await bcrypt.hash(new_password, 12);
    await sql`UPDATE users SET password_hash = ${newHash}, updated_at = NOW() WHERE user_id = ${user.user_id}`;

    if (user.email) {
      try {
        await sendEmail(user.email, "MMR password changed", passwordChangedEmailHtml(user.full_name || "User"));
      } catch (mailError) {
        console.warn("[user-change-password] Confirmation email failed:", mailError.message);
      }
    }

    return ok(res, {}, "Password changed successfully");
  } catch (e) {
    return err(res, e.message);
  }
});
/* ==========================
   ─────────────────────────
   AUTH — ADMIN
   POST /api/admin/auth/login
   POST /api/admin/auth/refresh
   ─────────────────────────
========================== */

app.post("/api/admin/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return err(res, "email & password required", 400);

    const [admin] = await sql`
      SELECT a.admin_id, a.full_name, a.email, a.password_hash,
             a.is_active, a.is_locked, a.failed_login_attempts,
             r.role_name AS role
      FROM admin_users a
      JOIN admin_roles r ON a.role_id = r.role_id
      WHERE a.email = ${email}`;

    if (!admin)      return err(res, "Invalid credentials", 401);
    if (!admin.is_active) return err(res, "Account deactivated", 403);
    if (admin.is_locked)  return err(res, "Account locked after 5 failed attempts. Contact Super Admin.", 403);

    const valid = await bcrypt.compare(password, admin.password_hash);

    if (!valid) {
      const attempts = admin.failed_login_attempts + 1;
      await sql`
        UPDATE admin_users SET
          failed_login_attempts = ${attempts},
          is_locked = ${attempts >= 5}
        WHERE admin_id = ${admin.admin_id}`;
      return err(res, `Invalid credentials. ${5 - attempts} attempts remaining.`, 401);
    }

    // Reset failed attempts, set last login
    await sql`
      UPDATE admin_users SET failed_login_attempts = 0, last_login_at = NOW()
      WHERE admin_id = ${admin.admin_id}`;

    const payload = { admin_id: admin.admin_id, email: admin.email,
                      full_name: admin.full_name, role: admin.role };

    const token        = jwt.sign(payload, adminJwtSecret(),               { expiresIn: "8h" });
    const refreshToken = jwt.sign(payload, process.env.JWT_REFRESH_SECRET, { expiresIn: "1d" });

    // Log session
    await sql`
      INSERT INTO admin_sessions (admin_id, session_token, ip_address)
      VALUES (${admin.admin_id}, ${token}, ${req.ip})`;

    await sql`
      INSERT INTO audit_log (actor_type, actor_id, actor_name, module, action, ip_address)
      VALUES ('Admin', ${admin.admin_id}, ${admin.full_name}, 'Auth', 'AdminLogin', ${req.ip})`;

    return ok(res, { token, refresh_token: refreshToken,
      admin: { admin_id: admin.admin_id, full_name: admin.full_name,
               email: admin.email, role: admin.role }
    }, "Admin login successful");
  } catch (e) {
    return err(res, e.message);
  }
});

app.post("/api/admin/auth/refresh", async (req, res) => {
  try {
    const { refresh_token } = req.body;
    if (!refresh_token) return err(res, "refresh_token required", 400);
    const decoded = jwt.verify(refresh_token, process.env.JWT_REFRESH_SECRET);
    const token   = jwt.sign(
      { admin_id: decoded.admin_id, email: decoded.email,
        full_name: decoded.full_name, role: decoded.role },
      adminJwtSecret(), { expiresIn: "8h" }
    );
    return ok(res, { token }, "Token refreshed");
  } catch {
    return err(res, "Invalid refresh token", 401);
  }
});

/* ==========================
   ─────────────────────────
   USER PROFILE  (JWT protected)
   GET  /api/profile
   PUT  /api/profile
   GET  /api/profile/documents
   POST /api/profile/upload-doc
   ─────────────────────────
========================== */

app.get("/api/profile", verifyUserToken, async (req, res) => {
  try {
    const [user] = await sql`
      SELECT u.user_id, u.member_id, u.user_type, u.full_name, u.date_of_birth,
             u.gender, u.father_name, u.mother_name, u.spouse_name,
             u.mobile_no, u.alternate_mobile, u.email,
             u.pan_number, u.aadhar_number, u.account_status,
             u.invitation_code, u.registered_at,
             sp.full_name AS sponsor_name, sp.member_id AS sponsor_id,
             pa.city, pa.state, pa.pin_code,
             b.bank_name, b.account_number, b.ifsc_code,
             n.nominee_name, n.relationship AS nominee_relationship
      FROM users u
      LEFT JOIN users sp               ON u.sponsor_user_id = sp.user_id
      LEFT JOIN user_addresses pa      ON u.user_id = pa.user_id AND pa.address_type = 'Permanent'
      LEFT JOIN user_bank_details b    ON u.user_id = b.user_id
      LEFT JOIN user_nominees n        ON u.user_id = n.user_id
      WHERE u.user_id = ${req.user.user_id}`;

    if (!user) return err(res, "User not found", 404);
    return ok(res, user);
  } catch (e) {
    return err(res, e.message);
  }
});

app.put("/api/profile", verifyUserToken, async (req, res) => {
  try {
    const { alternate_mobile, email, spouse_name,
            account_holder_name, bank_name, branch_name,
            nominee_name, nominee_relationship } = req.body;
    const uid = req.user.user_id;

    await sql`
      UPDATE users SET
        alternate_mobile = COALESCE(${alternate_mobile || null}, alternate_mobile),
        email            = COALESCE(${email || null}, email),
        spouse_name      = COALESCE(${spouse_name || null}, spouse_name),
        updated_at       = NOW()
      WHERE user_id = ${uid}`;

    if (bank_name || account_holder_name || branch_name) {
      await sql`
        UPDATE user_bank_details SET
          bank_name           = COALESCE(${bank_name || null}, bank_name),
          account_holder_name = COALESCE(${account_holder_name || null}, account_holder_name),
          branch_name         = COALESCE(${branch_name || null}, branch_name),
          updated_at          = NOW()
        WHERE user_id = ${uid}`;
    }
    if (nominee_name || nominee_relationship) {
      await sql`
        UPDATE user_nominees SET
          nominee_name = COALESCE(${nominee_name || null}, nominee_name),
          relationship = COALESCE(${nominee_relationship || null}, relationship),
          updated_at   = NOW()
        WHERE user_id = ${uid}`;
    }
    return ok(res, {}, "Profile updated");
  } catch (e) {
    return err(res, e.message);
  }
});

app.get("/api/profile/documents", verifyUserToken, async (req, res) => {
  try {
    const docs = await sql`
      SELECT document_id, document_type, uploaded_at, is_verified, rejection_note
      FROM user_documents WHERE user_id = ${req.user.user_id} AND is_active = TRUE`;
    return ok(res, docs);
  } catch (e) {
    return err(res, e.message);
  }
});

app.post("/api/profile/upload-doc",
  verifyUserToken,
  upload.single("document"),
  async (req, res) => {
    try {
      const { document_type } = req.body;
      if (!req.file) return err(res, "No file uploaded", 400);
      if (!["PANCard","AadharCard","ProfilePhoto","Other"].includes(document_type))
        return err(res, "Invalid document_type", 400);

      // Cloudinary par upload karo
      const folder = CLOUDINARY_FOLDER.document;
      const { url, public_id } = await uploadToCloudinary(
        req.file.buffer, folder, req.file.originalname
      );

      // Purana doc deactivate karo
      await sql`
        UPDATE user_documents SET is_active = FALSE
        WHERE user_id = ${req.user.user_id} AND document_type = ${document_type}`;

      const [doc] = await sql`
        INSERT INTO user_documents (user_id, document_type, file_path, cloudinary_public_id, file_name, file_size_kb)
        VALUES (${req.user.user_id}, ${document_type}, ${url},
                ${public_id}, ${req.file.originalname}, ${Math.round(req.file.size / 1024)})
        RETURNING document_id`;

      return ok(res, { document_id: doc.document_id, url }, "Document uploaded", 201);
    } catch (e) {
      return err(res, e.message);
    }
  }
);

/* ==========================
   ─────────────────────────
   SITES & PLOTS  (public)
   GET /api/sites
   GET /api/sites/:id
   GET /api/sites/:id/plots
   GET /api/plots/:id
   ─────────────────────────
========================== */

app.get("/api/sites", async (req, res) => {
  try {
    const sites = await sql`
      SELECT s.site_id, s.site_name, s.city, s.state, s.full_address,
             s.description, s.starting_price, s.total_area, s.highlights,
             s.property_image_url, s.map_image_url, s.display_on_home_page,
             s.site_status, s.has_govt_approval,
             COUNT(p.plot_id)                                              AS total_plots,
             COUNT(p.plot_id) FILTER (WHERE p.plot_status = 'Vacant')     AS vacant,
             COUNT(p.plot_id) FILTER (WHERE p.plot_status = 'InProcess')  AS in_process,
             COUNT(p.plot_id) FILTER (WHERE p.plot_status = 'Booked')     AS booked,
             COUNT(p.plot_id) FILTER (WHERE p.plot_status = 'Sold')       AS sold
      FROM sites s
      LEFT JOIN plots p ON s.site_id = p.site_id AND p.is_active = TRUE
      WHERE s.site_status = 'Active'
      GROUP BY s.site_id ORDER BY s.site_id`;
    return ok(res, sites);
  } catch (e) {
    return err(res, e.message);
  }
});

app.get("/api/sites/home", async (req, res) => {
  try {
    const sites = await sql`
      SELECT s.site_id, s.site_name, s.city, s.state, s.full_address,
             s.description, s.starting_price, s.total_area, s.highlights,
             s.property_image_url, s.map_image_url, s.display_on_home_page,
             s.site_status, s.has_govt_approval,
             COUNT(p.plot_id)                                             AS total_plots,
             COUNT(p.plot_id) FILTER (WHERE p.plot_status = 'Vacant')    AS vacant,
             COUNT(p.plot_id) FILTER (WHERE p.plot_status = 'InProcess') AS in_process,
             COUNT(p.plot_id) FILTER (WHERE p.plot_status = 'Booked')    AS booked,
             COUNT(p.plot_id) FILTER (WHERE p.plot_status = 'Sold')      AS sold
      FROM sites s
      LEFT JOIN plots p ON s.site_id = p.site_id AND p.is_active = TRUE
      WHERE s.site_status = 'Active' AND COALESCE(s.display_on_home_page, TRUE) = TRUE
      GROUP BY s.site_id ORDER BY s.site_id`;
    return ok(res, sites);
  } catch (e) {
    return err(res, e.message);
  }
});

app.get("/api/sites/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const [site] = await sql`SELECT * FROM sites WHERE site_id = ${id}`;
    if (!site) return err(res, "Site not found", 404);

    const landmarks = await sql`
      SELECT * FROM site_landmarks WHERE site_id = ${id} ORDER BY sort_order`;
    const photos = await sql`
      SELECT photo_id, file_path, caption, sort_order, is_cover_photo
      FROM site_photos WHERE site_id = ${id} AND is_active = TRUE ORDER BY sort_order`;

    return ok(res, { ...site, landmarks, photos });
  } catch (e) {
    return err(res, e.message);
  }
});

app.get("/api/sites/:id/map", async (req, res) => {
  try {
    const { id } = req.params;
    const [site] = await sql`
      SELECT site_id, site_name, city, state, full_address, description,
             starting_price, total_area, highlights, property_image_url,
             map_image_url, site_status, total_plots, display_on_home_page
      FROM sites
      WHERE site_id = ${id}`;
    if (!site) return err(res, "Site not found", 404);

    const plots = await sql`
      SELECT plot_id, plot_number, plot_area, plot_category,
             base_price, down_payment, monthly_emi, emi_tenure_months,
             file_charge, plot_status, coordinates_x, coordinates_y
      FROM plots
      WHERE site_id = ${id} AND is_active = TRUE
      ORDER BY plot_number`;

    return ok(res, { site, plots });
  } catch (e) {
    return err(res, e.message);
  }
});

app.get("/api/sites/:id/plots", async (req, res) => {
  try {
    const { id } = req.params;
    const { status, category } = req.query;

    let plots = await sql`
      SELECT plot_id, plot_number, plot_area, plot_category,
             base_price, down_payment, monthly_emi, emi_tenure_months,
             file_charge, plot_status, coordinates_x, coordinates_y
      FROM plots
      WHERE site_id = ${id} AND is_active = TRUE
        AND (${status   || null} IS NULL OR plot_status   = ${status})
        AND (${category || null} IS NULL OR plot_category = ${category})
      ORDER BY plot_number`;

    return ok(res, plots);
  } catch (e) {
    return err(res, e.message);
  }
});

app.get("/api/plots/:id", async (req, res) => {
  try {
    const [plot] = await sql`
      SELECT p.*, s.site_name, s.city, s.full_address
      FROM plots p JOIN sites s ON p.site_id = s.site_id
      WHERE p.plot_id = ${req.params.id}`;
    if (!plot) return err(res, "Plot not found", 404);
    return ok(res, plot);
  } catch (e) {
    return err(res, e.message);
  }
});

/* ==========================
   ─────────────────────────
   BOOKINGS  (JWT required)
   GET  /api/bookings          — my bookings
   POST /api/bookings          — create booking
   GET  /api/bookings/:id      — booking detail
   POST /api/bookings/:id/upload-proof
   ─────────────────────────
========================== */

app.get("/api/bookings", verifyUserToken, async (req, res) => {
  try {
    const bookings = await sql`
      SELECT b.booking_id, b.booking_serial, b.booking_date, b.booking_status,
             b.advance_amount, b.payment_type,
             p.plot_number, p.plot_area, p.plot_category,
             s.site_name, s.city
      FROM bookings b
      JOIN plots p ON b.plot_id = p.plot_id
      JOIN sites  s ON p.site_id  = s.site_id
      WHERE b.user_id = ${req.user.user_id}
      ORDER BY b.created_at DESC`;
    return ok(res, bookings);
  } catch (e) {
    return err(res, e.message);
  }
});

app.post("/api/bookings", verifyUserToken, async (req, res) => {
  try {
    const { plot_id, payment_type, advance_amount } = req.body;
    if (!plot_id || !payment_type || !advance_amount)
      return err(res, "plot_id, payment_type, advance_amount required", 400);

    // Check plot is vacant
    const [plot] = await sql`SELECT * FROM plots WHERE plot_id = ${plot_id}`;
    if (!plot) return err(res, "Plot not found", 404);
    if (plot.plot_status !== "Vacant")
      return err(res, "Plot is not available for booking", 409);

    // Generate serial
    const [seq] = await sql`
      SELECT COALESCE(MAX(CAST(SUBSTRING(booking_serial FROM 9) AS INT)),0)+1 AS n
      FROM bookings WHERE booking_serial LIKE 'BK-' || to_char(NOW(),'YYYY') || '-%'`;
    const serial = `BK-${new Date().getFullYear()}-${String(seq.n).padStart(5,"0")}`;

    const [booking] = await sql`
      INSERT INTO bookings (booking_serial, user_id, plot_id, payment_type, advance_amount)
      VALUES (${serial}, ${req.user.user_id}, ${plot_id}, ${payment_type}, ${advance_amount})
      RETURNING booking_id, booking_serial, booking_status`;

    // Mark plot InProcess
    await sql`UPDATE plots SET plot_status = 'InProcess', updated_at = NOW() WHERE plot_id = ${plot_id}`;
    await sql`
      INSERT INTO plot_status_history (plot_id, old_status, new_status, reason)
      VALUES (${plot_id}, 'Vacant', 'InProcess', 'Booking submitted by user')`;

    return ok(res, booking, "Booking submitted. Awaiting admin confirmation.", 201);
  } catch (e) {
    return err(res, e.message);
  }
});

app.get("/api/bookings/:id", verifyUserToken, async (req, res) => {
  try {
    const [booking] = await sql`
      SELECT b.*, p.plot_number, p.plot_area, p.plot_category,
             p.base_price, p.monthly_emi, p.emi_tenure_months,
             s.site_name, s.city, s.full_address
      FROM bookings b
      JOIN plots p ON b.plot_id = p.plot_id
      JOIN sites  s ON p.site_id = s.site_id
      WHERE b.booking_id = ${req.params.id} AND b.user_id = ${req.user.user_id}`;
    if (!booking) return err(res, "Booking not found", 404);
    return ok(res, booking);
  } catch (e) {
    return err(res, e.message);
  }
});

app.post("/api/bookings/:id/upload-proof",
  verifyUserToken,
  upload.single("payment_proof"),
  async (req, res) => {
    try {
      if (!req.file) return err(res, "No file uploaded", 400);
      const [booking] = await sql`
        SELECT booking_id FROM bookings
        WHERE booking_id = ${req.params.id} AND user_id = ${req.user.user_id}`;
      if (!booking) return err(res, "Booking not found", 404);

      // Cloudinary upload
      const { url, public_id } = await uploadToCloudinary(
        req.file.buffer, CLOUDINARY_FOLDER.payment_proof, req.file.originalname
      );

      await sql`
        INSERT INTO booking_payment_proofs (booking_id, file_path, cloudinary_public_id)
        VALUES (${booking.booking_id}, ${url}, ${public_id})`;

      await sql`
        UPDATE bookings SET booking_status = 'PaymentPending', updated_at = NOW()
        WHERE booking_id = ${booking.booking_id}`;

      return ok(res, { url }, "Payment proof uploaded");
    } catch (e) {
      return err(res, e.message);
    }
  }
);

/* ==========================
   ─────────────────────────
   EMI  (JWT required)
   GET  /api/emi               — all EMIs for my bookings
   GET  /api/emi/:bookingId    — EMI schedule for a booking
   POST /api/emi/:emiId/upload-proof
   GET  /api/emi/:emiId/voucher
   ─────────────────────────
========================== */

app.get("/api/emi", verifyUserToken, async (req, res) => {
  try {
    const emis = await sql`
      SELECT e.emi_id, e.installment_no, e.due_date, e.emi_amount,
             e.late_fee_amount, e.total_due, e.paid_amount, e.paid_date,
             e.emi_status, e.voucher_file_path,
             p.plot_number, s.site_name,
             CASE WHEN CURRENT_DATE > e.due_date AND e.emi_status = 'Pending'
                  THEN (CURRENT_DATE - e.due_date) ELSE 0 END AS overdue_days
      FROM emi_schedules e
      JOIN bookings b ON e.booking_id = b.booking_id
      JOIN plots    p ON b.plot_id = p.plot_id
      JOIN sites    s ON p.site_id = s.site_id
      WHERE e.user_id = ${req.user.user_id}
      ORDER BY e.due_date ASC`;
    return ok(res, emis);
  } catch (e) {
    return err(res, e.message);
  }
});

app.get("/api/emi/:bookingId", verifyUserToken, async (req, res) => {
  try {
    const emis = await sql`
      SELECT e.* FROM emi_schedules e
      JOIN bookings b ON e.booking_id = b.booking_id
      WHERE e.booking_id = ${req.params.bookingId} AND b.user_id = ${req.user.user_id}
      ORDER BY e.installment_no`;
    return ok(res, emis);
  } catch (e) {
    return err(res, e.message);
  }
});

app.post("/api/emi/:emiId/upload-proof",
  verifyUserToken,
  upload.single("payment_proof"),
  async (req, res) => {
    try {
      if (!req.file) return err(res, "No file uploaded", 400);
      const { payment_mode, reference_no } = req.body;

      const [emi] = await sql`
        SELECT e.emi_id FROM emi_schedules e
        JOIN bookings b ON e.booking_id = b.booking_id
        WHERE e.emi_id = ${req.params.emiId} AND b.user_id = ${req.user.user_id}`;
      if (!emi) return err(res, "EMI not found", 404);

      // Cloudinary upload
      const { url, public_id } = await uploadToCloudinary(
        req.file.buffer, CLOUDINARY_FOLDER.payment_proof, req.file.originalname
      );

      await sql`
        INSERT INTO emi_payment_proofs (emi_id, file_path, cloudinary_public_id, payment_mode, reference_no)
        VALUES (${emi.emi_id}, ${url}, ${public_id}, ${payment_mode || null}, ${reference_no || null})`;

      await sql`
        UPDATE emi_schedules SET emi_status = 'ProofSubmitted', updated_at = NOW()
        WHERE emi_id = ${emi.emi_id}`;

      return ok(res, { url }, "EMI proof submitted. Awaiting admin confirmation.");
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.get("/api/emi/:emiId/voucher", verifyUserToken, async (req, res) => {
  try {
    const [v] = await sql`
      SELECT pv.* FROM payment_vouchers pv
      WHERE pv.voucher_type = 'EMI' AND pv.reference_id = ${req.params.emiId}
        AND pv.user_id = ${req.user.user_id}`;
    if (!v) return err(res, "Voucher not found", 404);
    return ok(res, v);
  } catch (e) {
    return err(res, e.message);
  }
});

/* ==========================
   ─────────────────────────
   ASSOCIATE / MLM  (JWT required)
   GET /api/associate/dashboard
   GET /api/associate/network
   GET /api/associate/commissions
   GET /api/associate/invite-code
   ─────────────────────────
========================== */

app.get("/api/associate/dashboard", verifyUserToken, async (req, res) => {
  try {
    if (req.user.user_type !== "Associate")
      return err(res, "Associates only", 403);

    const [tracker] = await sql`
      SELECT * FROM associate_sales_tracker WHERE associate_user_id = ${req.user.user_id}`;

    const pendingComm = await sql`
      SELECT COALESCE(SUM(net_amount),0) AS pending
      FROM commission_transactions
      WHERE associate_user_id = ${req.user.user_id} AND commission_status = 'Pending'`;

    const [networkCount] = await sql`
      SELECT COUNT(*) AS count FROM mlm_network WHERE sponsor_user_id = ${req.user.user_id}`;

    const recentCommissions = await sql`
      SELECT commission_id, commission_type, net_amount, commission_month,
             commission_status, created_at
      FROM commission_transactions
      WHERE associate_user_id = ${req.user.user_id}
      ORDER BY created_at DESC LIMIT 5`;

    return ok(res, {
      tracker,
      pending_commission: pendingComm[0]?.pending || 0,
      direct_network_count: networkCount?.count || 0,
      recent_commissions: recentCommissions,
      // Milestone flags
      milestone_achieved: (tracker?.total_gaj_sold || 0) >= 2000,
      current_monthly_net: Math.floor((tracker?.total_gaj_sold || 0) / 100) * 600,
    });
  } catch (e) {
    return err(res, e.message);
  }
});

app.get("/api/associate/network", verifyUserToken, async (req, res) => {
  try {
    if (req.user.user_type !== "Associate")
      return err(res, "Associates only", 403);

    const network = await sql`
      SELECT u.user_id, u.member_id, u.full_name, u.mobile_no,
             u.account_status, u.registered_at,
             t.total_gaj_sold, t.total_commission_earned,
             m.level
      FROM mlm_network m
      JOIN users u ON m.associate_user_id = u.user_id
      LEFT JOIN associate_sales_tracker t ON u.user_id = t.associate_user_id
      WHERE m.sponsor_user_id = ${req.user.user_id}
      ORDER BY u.registered_at DESC`;

    return ok(res, network);
  } catch (e) {
    return err(res, e.message);
  }
});

app.get("/api/associate/commissions", verifyUserToken, async (req, res) => {
  try {
    if (req.user.user_type !== "Associate")
      return err(res, "Associates only", 403);

    const { status, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    const commissions = await sql`
      SELECT c.commission_id, c.commission_type, c.gaj_sold,
             c.gross_amount, c.deduction_amount, c.net_amount,
             c.commission_month, c.commission_status,
             c.paid_at, c.payment_reference, c.created_at,
             b.booking_serial, p.plot_number, s.site_name
      FROM commission_transactions c
      LEFT JOIN bookings b ON c.related_booking_id = b.booking_id
      LEFT JOIN plots    p ON b.plot_id = p.plot_id
      LEFT JOIN sites    s ON p.site_id = s.site_id
      WHERE c.associate_user_id = ${req.user.user_id}
        AND (${status || null} IS NULL OR c.commission_status = ${status})
      ORDER BY c.created_at DESC
      LIMIT ${limit} OFFSET ${offset}`;

    const [total] = await sql`
      SELECT COUNT(*) AS count FROM commission_transactions
      WHERE associate_user_id = ${req.user.user_id}
        AND (${status || null} IS NULL OR commission_status = ${status})`;

    return ok(res, { commissions, total: total.count, page: +page, limit: +limit });
  } catch (e) {
    return err(res, e.message);
  }
});

app.get("/api/associate/invite-code", verifyUserToken, async (req, res) => {
  try {
    if (req.user.user_type !== "Associate")
      return err(res, "Associates only", 403);
    const [user] = await sql`
      SELECT invitation_code, member_id FROM users WHERE user_id = ${req.user.user_id}`;
    return ok(res, { invitation_code: user.invitation_code, member_id: user.member_id });
  } catch (e) {
    return err(res, e.message);
  }
});

/* ==========================
   ─────────────────────────
   NOTIFICATIONS  (JWT required)
   GET   /api/notifications
   PATCH /api/notifications/:id/read
   PATCH /api/notifications/read-all
   ─────────────────────────
========================== */

app.get("/api/notifications", verifyUserToken, async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    const notifs = await sql`
      SELECT notif_id, title, message, channel, is_read, read_at, sent_at, delivery_status
      FROM notification_log
      WHERE user_id = ${req.user.user_id}
      ORDER BY sent_at DESC LIMIT ${limit} OFFSET ${offset}`;

    const [unread] = await sql`
      SELECT COUNT(*) AS count FROM notification_log
      WHERE user_id = ${req.user.user_id} AND is_read = FALSE`;

    return ok(res, { notifications: notifs, unread_count: unread.count });
  } catch (e) {
    return err(res, e.message);
  }
});

app.patch("/api/notifications/:id/read", verifyUserToken, async (req, res) => {
  try {
    await sql`
      UPDATE notification_log SET is_read = TRUE, read_at = NOW()
      WHERE notif_id = ${req.params.id} AND user_id = ${req.user.user_id}`;
    return ok(res, {}, "Marked as read");
  } catch (e) {
    return err(res, e.message);
  }
});

app.patch("/api/notifications/read-all", verifyUserToken, async (req, res) => {
  try {
    await sql`
      UPDATE notification_log SET is_read = TRUE, read_at = NOW()
      WHERE user_id = ${req.user.user_id} AND is_read = FALSE`;
    return ok(res, {}, "All notifications marked as read");
  } catch (e) {
    return err(res, e.message);
  }
});

/* ==========================
   ─────────────────────────
   BUYBACK  (JWT required)
   POST /api/buyback/apply
   GET  /api/buyback/status
   ─────────────────────────
========================== */

app.post("/api/buyback/apply", verifyUserToken, async (req, res) => {
  try {
    const { booking_id } = req.body;
    if (!booking_id) return err(res, "booking_id required", 400);

    const [booking] = await sql`
      SELECT b.booking_id, b.plot_id, b.booking_date, b.booking_status,
             p.base_price
      FROM bookings b JOIN plots p ON b.plot_id = p.plot_id
      WHERE b.booking_id = ${booking_id} AND b.user_id = ${req.user.user_id}
        AND b.booking_status = 'Confirmed'`;

    if (!booking) return err(res, "Valid confirmed booking not found", 404);

    // Check 2-year window
    const purchaseDate   = new Date(booking.booking_date);
    const twoYearCutoff  = new Date(purchaseDate);
    twoYearCutoff.setFullYear(twoYearCutoff.getFullYear() + 2);
    const eligible = new Date() <= twoYearCutoff;

    const [app_] = await sql`
      INSERT INTO buyback_applications
        (booking_id, user_id, plot_id, original_price, eligibility_check, purchase_date)
      VALUES (${booking.booking_id}, ${req.user.user_id}, ${booking.plot_id},
              ${booking.base_price}, ${eligible}, ${purchaseDate.toISOString().split("T")[0]})
      RETURNING buyback_id, buyback_amount, eligibility_check`;

    await sql`
      UPDATE bookings SET booking_status = 'BuybackApplied', updated_at = NOW()
      WHERE booking_id = ${booking_id}`;

    return ok(res, {
      buyback_id:        app_.buyback_id,
      buyback_amount:    app_.buyback_amount,
      eligible:          app_.eligibility_check,
    }, eligible
      ? "Buyback applied. Admin will process your request."
      : "Applied but 2-year window may have passed. Admin will verify.", 201);
  } catch (e) {
    return err(res, e.message);
  }
});

app.get("/api/buyback/status", verifyUserToken, async (req, res) => {
  try {
    const apps = await sql`
      SELECT ba.*, p.plot_number, s.site_name
      FROM buyback_applications ba
      JOIN plots p ON ba.plot_id = p.plot_id
      JOIN sites s ON p.site_id  = s.site_id
      WHERE ba.user_id = ${req.user.user_id}
      ORDER BY ba.applied_at DESC`;
    return ok(res, apps);
  } catch (e) {
    return err(res, e.message);
  }
});

/* ==========================
   ─────────────────────────
   ADMIN — USER MANAGEMENT
   GET  /api/admin/users/pending
   GET  /api/admin/users
   GET  /api/admin/users/:id
   POST /api/admin/users/:id/approve
   POST /api/admin/users/:id/reject
   POST /api/admin/users/:id/request-info
   POST /api/admin/users/:id/blacklist
   ─────────────────────────
========================== */

const adminUserSortMap = {
  name: "u.full_name",
  full_name: "u.full_name",
  email: "u.email",
  mobile_no: "u.mobile_no",
  status: "u.account_status",
  account_status: "u.account_status",
  date: "u.registered_at",
  registered_at: "u.registered_at",
  created_at: "u.registered_at",
  updated_at: "u.updated_at",
  user_type: "u.user_type",
  member_id: "u.member_id",
};

const adminUsersResponse = (res, rows, totalRecords, page, pageSize) => {
  const totalPages = Math.max(1, Math.ceil(totalRecords / pageSize));
  return res.json({
    success: true,
    data: rows,
    users: rows,
    total: totalRecords,
    totalRecords,
    currentPage: page,
    page,
    pageSize,
    limit: pageSize,
    totalPages,
  });
};

const getAdminUsersPage = async (query, defaults = {}) => {
  const page = Math.max(1, Number(query.page || defaults.page || 1));
  const pageSize = Math.min(100, Math.max(1, Number(query.pageSize || query.limit || defaults.pageSize || 20)));
  const offset = (page - 1) * pageSize;
  const sortBy = adminUserSortMap[query.sortBy || query.sort_by || defaults.sortBy || "registered_at"] || "u.registered_at";
  const sortDir = String(query.sortDir || query.sort_dir || defaults.sortDir || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
  const where = [];
  const params = [];

  const add = (condition, value) => {
    params.push(value);
    where.push(condition.replace("?", `$${params.length}`));
  };

  if (defaults.statuses?.length) {
    params.push(defaults.statuses);
    where.push(`u.account_status::text = ANY($${params.length})`);
  }

  if (query.status) add("u.account_status::text = ?", query.status);
  if (query.user_type) add("LOWER(u.user_type::text) = LOWER(?)", query.user_type);
  if (query.verification_status) add("COALESCE(u.email_verified, u.is_otp_verified, FALSE) = ?", query.verification_status === "verified");
  if (query.date_from) add("u.registered_at::date >= ?::date", query.date_from);
  if (query.date_to) add("u.registered_at::date <= ?::date", query.date_to);
  if (defaults.activeOnly) where.push("COALESCE(u.is_active, TRUE) = TRUE");

  if (query.search) {
    params.push(`%${String(query.search).trim()}%`);
    const idx = `$${params.length}`;
    where.push(`(
      u.full_name ILIKE ${idx}
      OR u.email ILIKE ${idx}
      OR u.mobile_no ILIKE ${idx}
      OR u.member_id ILIKE ${idx}
      OR u.invitation_code ILIKE ${idx}
      OR CAST(u.user_id AS TEXT) ILIKE ${idx}
    )`);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = await sql.unsafe(`
    SELECT u.user_id, u.member_id, u.user_type, u.full_name, u.mobile_no,
           u.email, u.account_status, u.registered_at, u.updated_at,
           pa.address_line1 AS address, pa.city, pa.state, pa.pin_code,
           u.invitation_code, sp.full_name AS sponsor_name,
           COALESCE(doc.doc_count, 0)::int AS doc_count
    FROM users u
    LEFT JOIN users sp ON u.sponsor_user_id = sp.user_id
    LEFT JOIN user_addresses pa ON pa.user_id = u.user_id AND pa.address_type = 'Permanent'
    LEFT JOIN (
      SELECT user_id, COUNT(*) AS doc_count
      FROM user_documents
      WHERE is_active = TRUE
      GROUP BY user_id
    ) doc ON doc.user_id = u.user_id
    ${whereSql}
    ORDER BY ${sortBy} ${sortDir}, u.user_id DESC
    LIMIT $${params.length + 1} OFFSET $${params.length + 2}
  `, [...params, pageSize, offset]);

  const [total] = await sql.unsafe(`
    SELECT COUNT(*)::int AS count
    FROM users u
    ${whereSql}
  `, params);

  return { rows, totalRecords: Number(total?.count || 0), page, pageSize };
};

const adminInquiriesResponse = (res, rows, totalRecords, page, pageSize, counts = []) => {
  const totalPages = Math.max(1, Math.ceil(totalRecords / pageSize));
  const statusCounts = inquiryStatuses.reduce((acc, status) => {
    acc[status] = 0;
    return acc;
  }, {});
  counts.forEach((row) => { statusCounts[row.status] = Number(row.count || 0); });
  return res.json({
    success: true,
    data: rows,
    inquiries: rows,
    total: totalRecords,
    totalRecords,
    currentPage: page,
    page,
    pageSize,
    limit: pageSize,
    totalPages,
    counts: statusCounts,
  });
};

const getAdminInquiriesPage = async (query) => {
  await ensureInquirySchema();
  const page = Math.max(1, Number(query.page || 1));
  const pageSize = Math.min(100, Math.max(1, Number(query.pageSize || query.limit || 20)));
  const offset = (page - 1) * pageSize;
  const sortMap = {
    created_at: "created_at",
    full_name: "full_name",
    mobile_no: "mobile_no",
    email: "email",
    status: "status",
    inquiry_type: "inquiry_type",
    site_name: "site_name",
  };
  const sortBy = sortMap[query.sortBy || query.sort_by || "created_at"] || "created_at";
  const sortDir = String(query.sortDir || query.sort_dir || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
  const where = [];
  const params = [];
  const add = (condition, value) => {
    params.push(value);
    where.push(condition.replace("?", `$${params.length}`));
  };

  if (query.status && query.status !== "all") add("status = ?", query.status);
  if (query.inquiry_type) add("inquiry_type = ?", query.inquiry_type);
  if (query.date_from) add("created_at::date >= ?::date", query.date_from);
  if (query.date_to) add("created_at::date <= ?::date", query.date_to);
  if (query.search) {
    params.push(`%${String(query.search).trim()}%`);
    const idx = `$${params.length}`;
    where.push(`(
      full_name ILIKE ${idx}
      OR mobile_no ILIKE ${idx}
      OR COALESCE(email, '') ILIKE ${idx}
      OR COALESCE(site_name, '') ILIKE ${idx}
      OR COALESCE(plot_number, '') ILIKE ${idx}
      OR COALESCE(inquiry_message, '') ILIKE ${idx}
      OR COALESCE(inquiry_type, '') ILIKE ${idx}
      OR CAST(inquiry_id AS TEXT) ILIKE ${idx}
    )`);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = await sql.unsafe(`
    SELECT inquiry_id, full_name, mobile_no, email, site_name, plot_number,
           inquiry_message, inquiry_type, source_page, status, remarks,
           created_at, updated_at
    FROM inquiries
    ${whereSql}
    ORDER BY ${sortBy} ${sortDir}, inquiry_id DESC
    LIMIT $${params.length + 1} OFFSET $${params.length + 2}
  `, [...params, pageSize, offset]);

  const [total] = await sql.unsafe(`SELECT COUNT(*)::int AS count FROM inquiries ${whereSql}`, params);
  const counts = await sql`SELECT status, COUNT(*)::int AS count FROM inquiries GROUP BY status`;
  return { rows, totalRecords: Number(total?.count || 0), page, pageSize, counts };
};

app.post("/api/inquiries", async (req, res) => {
  try {
    await ensureInquirySchema();
    console.log("[Inquiry Submit Request]", req.body);
    const fullName = String(req.body.full_name || req.body.name || "").trim();
    const mobileNo = String(req.body.mobile_no || req.body.mobile || "").replace(/\D/g, "").slice(0, 15);
    const email = String(req.body.email || "").trim().toLowerCase() || null;
    const siteName = String(req.body.site_name || req.body.property_name || req.body.interest || "").trim() || null;
    const plotNumber = String(req.body.plot_number || "").trim() || null;
    const message = String(req.body.inquiry_message || req.body.message || "").trim() || null;
    const inquiryType = String(req.body.inquiry_type || req.body.interest || "General Enquiry").trim() || "General Enquiry";
    const sourcePage = String(req.body.source_page || "Website").trim() || "Website";

    if (!fullName) return err(res, "Full name is required", 400);
    if (!mobileNo) return err(res, "Mobile number is required", 400);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return err(res, "Valid email is required", 400);

    const [created] = await sql`
      INSERT INTO inquiries (
        full_name, mobile_no, email, site_name, plot_number,
        inquiry_message, inquiry_type, source_page, status
      )
      VALUES (
        ${fullName}, ${mobileNo}, ${email}, ${siteName}, ${plotNumber},
        ${message}, ${inquiryType}, ${sourcePage}, 'New'
      )
      RETURNING inquiry_id, full_name, mobile_no, email, site_name, plot_number,
                inquiry_message, inquiry_type, source_page, status, remarks,
                created_at, updated_at`;

    console.log("[Inquiry Insert Result]", created);
    return ok(res, created, "Inquiry submitted successfully", 201);
  } catch (e) {
    console.error("[Inquiry Submit Error]", e);
    return err(res, e.message);
  }
});

app.get("/api/admin/inquiries",
  verifyAdminToken,
  role("SuperAdmin","SupportStaff","SiteManager"),
  async (req, res) => {
    try {
      const result = await getAdminInquiriesPage(req.query);
      console.log("[Admin Inquiry Fetch Response]", { total: result.totalRecords, page: result.page });
      return adminInquiriesResponse(res, result.rows, result.totalRecords, result.page, result.pageSize, result.counts);
    } catch (e) {
      console.error("[Admin Inquiry Fetch Error]", e);
      return err(res, e.message);
    }
  }
);

app.get("/api/admin/inquiries/:id",
  verifyAdminToken,
  role("SuperAdmin","SupportStaff","SiteManager"),
  async (req, res) => {
    try {
      await ensureInquirySchema();
      const [inquiry] = await sql`
        SELECT inquiry_id, full_name, mobile_no, email, site_name, plot_number,
               inquiry_message, inquiry_type, source_page, status, remarks,
               created_at, updated_at
        FROM inquiries
        WHERE inquiry_id = ${req.params.id}`;
      if (!inquiry) return err(res, "Inquiry not found", 404);
      return ok(res, inquiry);
    } catch (e) {
      console.error("[Admin Inquiry Detail Error]", e);
      return err(res, e.message);
    }
  }
);

app.put("/api/admin/inquiries/:id",
  verifyAdminToken,
  role("SuperAdmin","SupportStaff","SiteManager"),
  async (req, res) => {
    try {
      await ensureInquirySchema();
      const status = String(req.body.status || "").trim();
      const remarks = req.body.remarks == null ? null : String(req.body.remarks).trim();
      if (status && !inquiryStatuses.includes(status)) return err(res, "Invalid inquiry status", 400);

      const [updated] = await sql`
        UPDATE inquiries SET
          status = COALESCE(${status || null}, status),
          remarks = COALESCE(${remarks}, remarks),
          updated_at = NOW()
        WHERE inquiry_id = ${req.params.id}
        RETURNING inquiry_id, full_name, mobile_no, email, site_name, plot_number,
                  inquiry_message, inquiry_type, source_page, status, remarks,
                  created_at, updated_at`;
      if (!updated) return err(res, "Inquiry not found", 404);
      console.log("[Admin Inquiry Update]", updated);
      return ok(res, updated, "Inquiry updated successfully");
    } catch (e) {
      console.error("[Admin Inquiry Update Error]", e);
      return err(res, e.message);
    }
  }
);

app.delete("/api/admin/inquiries/:id",
  verifyAdminToken,
  role("SuperAdmin"),
  async (req, res) => {
    try {
      await ensureInquirySchema();
      const [deleted] = await sql`
        DELETE FROM inquiries
        WHERE inquiry_id = ${req.params.id}
        RETURNING inquiry_id`;
      if (!deleted) return err(res, "Inquiry not found", 404);
      console.log("[Admin Inquiry Delete]", deleted);
      return ok(res, deleted, "Inquiry deleted successfully");
    } catch (e) {
      console.error("[Admin Inquiry Delete Error]", e);
      return err(res, e.message);
    }
  }
);

app.get("/api/admin/users/pending",
  verifyAdminToken,
  role("SuperAdmin","SupportStaff"),
  async (req, res) => {
    try {
      const result = await getAdminUsersPage(req.query, {
        statuses: ["Pending", "InfoRequested", "InfoSubmitted"],
        sortBy: "registered_at",
        sortDir: "asc",
      });
      return adminUsersResponse(res, result.rows, result.totalRecords, result.page, result.pageSize);
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.get("/api/admin/users",
  verifyAdminToken,
  role("SuperAdmin","SupportStaff"),
  async (req, res) => {
    try {
      const result = await getAdminUsersPage(req.query);
      return adminUsersResponse(res, result.rows, result.totalRecords, result.page, result.pageSize);
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.get("/api/admin/customers",
  verifyAdminToken,
  role("SuperAdmin","SupportStaff"),
  async (req, res) => {
    try {
      const result = await getAdminUsersPage(
        { ...req.query, user_type: "Customer" },
        { sortBy: "registered_at", sortDir: "desc", activeOnly: true },
      );
      return adminUsersResponse(res, result.rows, result.totalRecords, result.page, result.pageSize);
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.post("/api/admin/customers",
  verifyAdminToken,
  role("SuperAdmin","SupportStaff"),
  async (req, res) => {
    try {
      const fullName = String(req.body.full_name || "").trim();
      const email = String(req.body.email || "").toLowerCase().trim();
      const mobileNo = String(req.body.mobile_no || req.body.phone || "").replace(/\D/g, "");
      const password = String(req.body.password || "");
      const confirmPassword = String(req.body.confirm_password || "");
      const accountStatus = String(req.body.account_status || req.body.status || "Active").trim();
      const address = String(req.body.address || "").trim();
      const city = String(req.body.city || "").trim();
      const state = String(req.body.state || "").trim();
      const pinCode = String(req.body.pin_code || req.body.pincode || "").trim();

      if (!fullName) return err(res, "Name is required", 400);
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return err(res, "Valid email is required", 400);
      if (!mobileNo) return err(res, "Phone number is required", 400);
      if (!password) return err(res, "Password is required", 400);
      if (password.length < 6) return err(res, "Password must be at least 6 characters", 400);
      if (password !== confirmPassword) return err(res, "Confirm password must match password", 400);
      if (!["Active", "Pending", "Suspended", "Blacklisted"].includes(accountStatus)) {
        return err(res, "Invalid status", 400);
      }

      const [dupEmail] = await sql`SELECT user_id FROM users WHERE LOWER(email) = ${email}`;
      if (dupEmail) return err(res, "Email already exists", 409);
      const [dupMobile] = await sql`SELECT user_id FROM users WHERE mobile_no = ${mobileNo}`;
      if (dupMobile) return err(res, "Phone number already exists", 409);

      const passwordHash = await bcrypt.hash(password, 12);
      const memberId = await genMemberID("Customer");

      const [customer] = await sql`
        INSERT INTO users (
          user_type, full_name, email, mobile_no, password_hash,
          member_id, account_status, is_otp_verified, email_verified,
          email_verified_at, is_active, is_verified, approved_by_admin_id, approved_at
        )
        VALUES (
          'Customer', ${fullName}, ${email}, ${mobileNo}, ${passwordHash},
          ${memberId}, ${accountStatus}, TRUE, TRUE,
          NOW(), TRUE, TRUE, ${req.admin.admin_id}, NOW()
        )
        RETURNING user_id, member_id, user_type, full_name, email, mobile_no,
                  account_status, registered_at, updated_at`;

      if (address || city || state || pinCode) {
        await sql`
          INSERT INTO user_addresses (user_id, address_type, address_line1, city, state, pin_code)
          VALUES (${customer.user_id}, 'Permanent', ${address || null}, ${city || null}, ${state || null}, ${pinCode || null})`;
      }

      await sql`
        INSERT INTO audit_log (actor_type, actor_id, actor_name, module, action, target_table, target_record_id, new_value)
        VALUES ('Admin', ${req.admin.admin_id}, ${req.admin.full_name},
                'CustomerManagement', 'Created', 'users', ${customer.user_id},
                ${JSON.stringify({ email, mobile_no: mobileNo, member_id: memberId, status: accountStatus })})`;

      return ok(res, customer, "Customer created successfully", 201);
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.put("/api/admin/customers/:id",
  verifyAdminToken,
  role("SuperAdmin","SupportStaff"),
  async (req, res) => {
    try {
      const uid = req.params.id;
      const fullName = String(req.body.full_name || "").trim();
      const email = String(req.body.email || "").toLowerCase().trim();
      const mobileNo = String(req.body.mobile_no || req.body.phone || "").replace(/\D/g, "");
      const accountStatus = String(req.body.account_status || req.body.status || "").trim();
      const address = String(req.body.address || "").trim();
      const city = String(req.body.city || "").trim();
      const state = String(req.body.state || "").trim();
      const pinCode = String(req.body.pin_code || req.body.pincode || "").trim();

      if (!fullName) return err(res, "Name is required", 400);
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return err(res, "Valid email is required", 400);
      if (!mobileNo) return err(res, "Phone number is required", 400);
      if (!["Active", "Pending", "Suspended", "Blacklisted"].includes(accountStatus)) {
        return err(res, "Invalid status", 400);
      }

      const [existing] = await sql`
        SELECT user_id FROM users
        WHERE user_id = ${uid} AND LOWER(user_type::text) = 'customer'`;
      if (!existing) return err(res, "Customer not found", 404);

      const [dupEmail] = await sql`SELECT user_id FROM users WHERE LOWER(email) = ${email} AND user_id <> ${uid}`;
      if (dupEmail) return err(res, "Email already exists", 409);
      const [dupMobile] = await sql`SELECT user_id FROM users WHERE mobile_no = ${mobileNo} AND user_id <> ${uid}`;
      if (dupMobile) return err(res, "Phone number already exists", 409);

      const [customer] = await sql`
        UPDATE users SET
          full_name = ${fullName},
          email = ${email},
          mobile_no = ${mobileNo},
          account_status = ${accountStatus},
          updated_at = NOW()
        WHERE user_id = ${uid} AND LOWER(user_type::text) = 'customer'
        RETURNING user_id, member_id, user_type, full_name, email, mobile_no,
                  account_status, registered_at, updated_at`;

      await sql`
        DELETE FROM user_addresses
        WHERE user_id = ${uid} AND address_type = 'Permanent'`;
      if (address || city || state || pinCode) {
        await sql`
          INSERT INTO user_addresses (user_id, address_type, address_line1, city, state, pin_code)
          VALUES (${uid}, 'Permanent', ${address || null}, ${city || null}, ${state || null}, ${pinCode || null})`;
      }

      await sql`
        INSERT INTO audit_log (actor_type, actor_id, actor_name, module, action, target_table, target_record_id, new_value)
        VALUES ('Admin', ${req.admin.admin_id}, ${req.admin.full_name},
                'CustomerManagement', 'Updated', 'users', ${uid},
                ${JSON.stringify({ email, mobile_no: mobileNo, status: accountStatus })})`;

      return ok(res, customer, "Customer updated successfully");
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.delete("/api/admin/customers/:id",
  verifyAdminToken,
  role("SuperAdmin"),
  async (req, res) => {
    try {
      const uid = req.params.id;
      const [customer] = await sql`
        UPDATE users SET account_status = 'Blacklisted', is_active = FALSE, updated_at = NOW()
        WHERE user_id = ${uid} AND LOWER(user_type::text) = 'customer'
        RETURNING user_id`;
      if (!customer) return err(res, "Customer not found", 404);

      await sql`
        INSERT INTO audit_log (actor_type, actor_id, actor_name, module, action, target_table, target_record_id)
        VALUES ('Admin', ${req.admin.admin_id}, ${req.admin.full_name},
                'CustomerManagement', 'Deleted', 'users', ${uid})`;

      return ok(res, {}, "Customer deleted successfully");
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.get("/api/admin/users/:id",
  verifyAdminToken,
  role("SuperAdmin","SupportStaff"),
  async (req, res) => {
    try {
      const uid = req.params.id;
      const [user] = await sql`SELECT * FROM users WHERE user_id = ${uid}`;
      if (!user) return err(res, "User not found", 404);

      const [address]  = await sql`SELECT * FROM user_addresses    WHERE user_id = ${uid} AND address_type = 'Permanent'`;
      const [bank]     = await sql`SELECT * FROM user_bank_details  WHERE user_id = ${uid}`;
      const [nominee]  = await sql`SELECT * FROM user_nominees      WHERE user_id = ${uid}`;
      const documents  = await sql`SELECT * FROM user_documents     WHERE user_id = ${uid} AND is_active = TRUE`;

      return ok(res, { ...user, address, bank, nominee, documents });
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.post("/api/admin/users/:id/approve",
  verifyAdminToken,
  role("SuperAdmin"),
  async (req, res) => {
    try {
      const uid   = req.params.id;
      const { verify_note } = req.body;
      const [user] = await sql`SELECT user_id, user_type, full_name, account_status FROM users WHERE user_id = ${uid}`;
      if (!user) return err(res, "User not found", 404);
      if (user.account_status === "Active") return err(res, "Already approved", 400);

      const memberId = await genMemberID(user.user_type);
      const invCode  = user.user_type === "Associate" ? genInviteCode() : null;

      await sql`
        UPDATE users SET
          account_status = 'Active', member_id = ${memberId},
          invitation_code = COALESCE(${invCode}, invitation_code),
          approved_by_admin_id = ${req.admin.admin_id}, approved_at = NOW(), updated_at = NOW()
        WHERE user_id = ${uid}`;

      // For associate: insert tracker + MLM node
      if (user.user_type === "Associate") {
        await sql`
          INSERT INTO associate_sales_tracker (associate_user_id)
          VALUES (${uid}) ON CONFLICT (associate_user_id) DO NOTHING`;

        const [sponsor] = await sql`SELECT sponsor_user_id FROM users WHERE user_id = ${uid}`;
        await sql`
          INSERT INTO mlm_network (associate_user_id, sponsor_user_id, level)
          VALUES (${uid}, ${sponsor?.sponsor_user_id || null},
                  CASE WHEN ${sponsor?.sponsor_user_id} IS NULL THEN 1
                       ELSE (SELECT COALESCE(level,0)+1 FROM mlm_network
                             WHERE associate_user_id = ${sponsor?.sponsor_user_id})
                  END) ON CONFLICT (associate_user_id) DO NOTHING`;
      }

      await sql`
        INSERT INTO audit_log (actor_type, actor_id, actor_name, module, action,
                               target_table, target_record_id, new_value)
        VALUES ('Admin', ${req.admin.admin_id}, ${req.admin.full_name},
                'UserApproval', 'Approved', 'users', ${uid},
                ${JSON.stringify({ member_id: memberId, note: verify_note || "" })})`;

      return ok(res, { member_id: memberId, invitation_code: invCode },
        `User approved. Member ID: ${memberId}`);
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.post("/api/admin/users/:id/reject",
  verifyAdminToken,
  role("SuperAdmin"),
  async (req, res) => {
    try {
      const uid = req.params.id;
      const { rejection_reason, rejection_custom } = req.body;
      if (!rejection_reason) return err(res, "rejection_reason required", 400);

      await sql`
        UPDATE users SET account_status = 'Rejected',
          rejection_reason = ${rejection_reason},
          rejection_custom = ${rejection_custom || null},
          updated_at = NOW()
        WHERE user_id = ${uid}`;

      await sql`
        INSERT INTO audit_log (actor_type, actor_id, actor_name, module, action,
                               target_table, target_record_id, new_value)
        VALUES ('Admin', ${req.admin.admin_id}, ${req.admin.full_name},
                'UserApproval', 'Rejected', 'users', ${uid},
                ${JSON.stringify({ reason: rejection_reason, custom: rejection_custom })})`;

      return ok(res, {}, "User rejected");
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.post("/api/admin/users/:id/request-info",
  verifyAdminToken,
  role("SuperAdmin"),
  async (req, res) => {
    try {
      const { message } = req.body;
      if (!message) return err(res, "message required", 400);
      await sql`
        UPDATE users SET account_status = 'InfoRequested',
          info_request_note = ${message}, updated_at = NOW()
        WHERE user_id = ${req.params.id}`;
      return ok(res, {}, "Info requested from user");
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.post("/api/admin/users/:id/blacklist",
  verifyAdminToken,
  role("SuperAdmin"),
  async (req, res) => {
    try {
      const { reason } = req.body;
      if (!reason) return err(res, "reason required", 400);
      await sql`UPDATE users SET account_status = 'Blacklisted', updated_at = NOW() WHERE user_id = ${req.params.id}`;
      await sql`
        INSERT INTO blacklist_registry (user_id, blacklisted_by_admin_id, blacklist_reason)
        VALUES (${req.params.id}, ${req.admin.admin_id}, ${reason})`;
      return ok(res, {}, "User blacklisted");
    } catch (e) {
      return err(res, e.message);
    }
  }
);

/* ==========================
   ─────────────────────────
   ADMIN — BOOKING & EMI
   GET  /api/admin/bookings
   POST /api/admin/bookings/:id/confirm
   POST /api/admin/bookings/:id/cancel
   GET  /api/admin/emi/overdue
   POST /api/admin/emi/:id/confirm
   ─────────────────────────
========================== */

app.get("/api/admin/bookings",
  verifyAdminToken,
  role("SuperAdmin","FinanceManager"),
  async (req, res) => {
    try {
      const { status, site_id, page = 1, limit = 20 } = req.query;
      const offset = (page - 1) * limit;

      const bookings = await sql`
        SELECT b.booking_id, b.booking_serial, b.booking_date, b.booking_status,
               b.advance_amount, b.payment_type,
               u.full_name AS customer_name, u.member_id, u.mobile_no,
               p.plot_number, p.plot_area, s.site_name, s.city
        FROM bookings b
        JOIN users u  ON b.user_id  = u.user_id
        JOIN plots p  ON b.plot_id  = p.plot_id
        JOIN sites s  ON p.site_id  = s.site_id
        WHERE (${status  || null} IS NULL OR b.booking_status = ${status})
          AND (${site_id || null} IS NULL OR s.site_id = ${site_id})
        ORDER BY b.created_at DESC
        LIMIT ${limit} OFFSET ${offset}`;

      return ok(res, bookings);
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.post("/api/admin/bookings/:id/confirm",
  verifyAdminToken,
  role("SuperAdmin","FinanceManager"),
  async (req, res) => {
    try {
      const bid = req.params.id;
      const [booking] = await sql`SELECT * FROM bookings WHERE booking_id = ${bid}`;
      if (!booking) return err(res, "Booking not found", 404);
      if (booking.booking_status === "Confirmed")
        return err(res, "Already confirmed", 400);

      // Generate 60 EMI rows
      const [plot] = await sql`SELECT monthly_emi, emi_tenure_months FROM plots WHERE plot_id = ${booking.plot_id}`;
      const start  = new Date(); start.setDate(1); start.setMonth(start.getMonth() + 1);

      for (let i = 1; i <= plot.emi_tenure_months; i++) {
        const due = new Date(start);
        due.setMonth(due.getMonth() + (i - 1));
        await sql`
          INSERT INTO emi_schedules (booking_id, user_id, installment_no, due_date, emi_amount)
          VALUES (${bid}, ${booking.user_id}, ${i}, ${due.toISOString().split("T")[0]}, ${plot.monthly_emi})
          ON CONFLICT (booking_id, installment_no) DO NOTHING`;
      }

      await sql`
        UPDATE bookings SET booking_status = 'Confirmed',
          confirmed_by_admin_id = ${req.admin.admin_id}, confirmed_at = NOW(), updated_at = NOW()
        WHERE booking_id = ${bid}`;

      await sql`UPDATE plots SET plot_status = 'Booked', updated_at = NOW() WHERE plot_id = ${booking.plot_id}`;

      await sql`
        INSERT INTO plot_status_history (plot_id, old_status, new_status, changed_by_admin_id, reason)
        VALUES (${booking.plot_id}, 'InProcess', 'Booked', ${req.admin.admin_id}, 'Booking Confirmed')`;

      await sql`
        INSERT INTO audit_log (actor_type, actor_id, actor_name, module, action, target_table, target_record_id)
        VALUES ('Admin', ${req.admin.admin_id}, ${req.admin.full_name},
                'BookingManagement', 'BookingConfirmed', 'bookings', ${bid})`;

      return ok(res, {}, `Booking confirmed. ${plot.emi_tenure_months} EMIs generated.`);
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.post("/api/admin/bookings/:id/cancel",
  verifyAdminToken,
  role("SuperAdmin","FinanceManager"),
  async (req, res) => {
    try {
      const { reason } = req.body;
      if (!reason) return err(res, "reason required", 400);

      const [booking] = await sql`SELECT plot_id FROM bookings WHERE booking_id = ${req.params.id}`;
      if (!booking) return err(res, "Booking not found", 404);

      await sql`
        UPDATE bookings SET booking_status = 'Cancelled',
          cancellation_reason = ${reason}, cancelled_by_admin_id = ${req.admin.admin_id},
          cancelled_at = NOW(), updated_at = NOW()
        WHERE booking_id = ${req.params.id}`;

      await sql`UPDATE plots SET plot_status = 'Vacant', updated_at = NOW() WHERE plot_id = ${booking.plot_id}`;

      return ok(res, {}, "Booking cancelled. Plot set to Vacant.");
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.get("/api/admin/emi/overdue",
  verifyAdminToken,
  role("SuperAdmin","FinanceManager"),
  async (req, res) => {
    try {
      // Auto-mark overdue
      await sql`
        UPDATE emi_schedules SET emi_status = 'Overdue', updated_at = NOW()
        WHERE emi_status = 'Pending' AND due_date < CURRENT_DATE`;

      const overdue = await sql`
        SELECT e.emi_id, e.installment_no, e.due_date, e.emi_amount,
               (CURRENT_DATE - e.due_date) AS overdue_days,
               ROUND(e.emi_amount * 0.05, 2) AS late_fee_due,
               u.full_name, u.member_id, u.mobile_no,
               p.plot_number, s.site_name
        FROM emi_schedules e
        JOIN users    u ON e.user_id   = u.user_id
        JOIN bookings b ON e.booking_id = b.booking_id
        JOIN plots    p ON b.plot_id   = p.plot_id
        JOIN sites    s ON p.site_id   = s.site_id
        WHERE e.emi_status = 'Overdue'
        ORDER BY e.due_date ASC`;

      return ok(res, overdue);
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.post("/api/admin/emi/:id/confirm",
  verifyAdminToken,
  role("SuperAdmin","FinanceManager"),
  async (req, res) => {
    try {
      const emiId = req.params.id;
      const { paid_amount } = req.body;
      if (!paid_amount) return err(res, "paid_amount required", 400);

      const [emi] = await sql`SELECT * FROM emi_schedules WHERE emi_id = ${emiId}`;
      if (!emi) return err(res, "EMI not found", 404);

      const lateFee = new Date() > new Date(emi.due_date)
        ? Math.round(emi.emi_amount * 0.05 * 100) / 100 : 0;

      // Voucher serial
      const [seq] = await sql`
        SELECT COALESCE(MAX(CAST(REPLACE(voucher_serial,'U-','') AS INT)),0)+1 AS n
        FROM payment_vouchers WHERE voucher_serial LIKE 'U-%'`;
      const vSerial = `U-${seq.n}`;

      await sql`
        UPDATE emi_schedules SET
          emi_status = 'Paid', paid_amount = ${paid_amount},
          paid_date  = CURRENT_DATE, late_fee_amount = ${lateFee},
          voucher_file_path = ${'vouchers/' + vSerial + '.pdf'},
          confirmed_by_admin_id = ${req.admin.admin_id}, confirmed_at = NOW(), updated_at = NOW()
        WHERE emi_id = ${emiId}`;

      await sql`
        INSERT INTO payment_vouchers (voucher_serial, voucher_type, reference_id, user_id, amount, generated_by_admin_id)
        VALUES (${vSerial}, 'EMI', ${emiId}, ${emi.user_id},
                ${parseFloat(paid_amount) + lateFee}, ${req.admin.admin_id})`;

      return ok(res, { voucher_serial: vSerial, late_fee: lateFee },
        "EMI payment confirmed. Voucher generated.");
    } catch (e) {
      return err(res, e.message);
    }
  }
);

/* ==========================
   ─────────────────────────
   ADMIN — SITES & PLOTS
   GET  /api/admin/sites
   POST /api/admin/sites
   PUT  /api/admin/sites/:id
   POST /api/admin/sites/:id/photo
   POST /api/admin/plots
   PUT  /api/admin/plots/:id/status
   ─────────────────────────
========================== */

app.get("/api/admin/sites",
  verifyAdminToken,
  role("SuperAdmin","SiteManager","SupportStaff"),
  async (req, res) => {
    try {
      const sites = await sql`
        SELECT s.site_id, s.site_name, s.city, s.state, s.full_address,
               s.description, s.starting_price, s.total_area, s.highlights,
               s.property_image_url, s.map_image_url, s.display_on_home_page,
               s.site_status, s.has_govt_approval,
               s.total_plots AS planned_total_plots, s.created_at, s.updated_at,
               COUNT(p.plot_id)::int AS total_plots,
               COUNT(p.plot_id) FILTER (WHERE p.plot_status = 'Vacant')::int AS vacant,
               COUNT(p.plot_id) FILTER (WHERE p.plot_status = 'InProcess')::int AS in_process,
               COUNT(p.plot_id) FILTER (WHERE p.plot_status = 'Booked')::int AS booked,
               COUNT(p.plot_id) FILTER (WHERE p.plot_status = 'Sold')::int AS sold
        FROM sites s
        LEFT JOIN plots p ON p.site_id = s.site_id AND p.is_active = TRUE
        GROUP BY s.site_id
        ORDER BY s.site_id`;
      return ok(res, sites);
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.post("/api/admin/sites",
  verifyAdminToken,
  role("SuperAdmin","SiteManager"),
  upload.fields([
    { name: "property_image", maxCount: 1 },
    { name: "site_map", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const {
        site_name, city, state, full_address, description, total_plots, site_status,
        starting_price, total_area, highlights, display_on_home_page,
      } = req.body;
      if (!site_name || !city) return err(res, "site_name, city required", 400);
      let propertyImageUrl = null;
      let propertyImagePublicId = null;
      let mapUrl = null;
      let mapPublicId = null;
      const propertyFile = req.files?.property_image?.[0];
      const mapFile = req.files?.site_map?.[0];
      if (propertyFile) {
        const uploaded = await uploadToCloudinary(propertyFile.buffer, CLOUDINARY_FOLDER.property_image, propertyFile.originalname);
        propertyImageUrl = uploaded.url;
        propertyImagePublicId = uploaded.public_id;
      }
      if (mapFile) {
        const uploaded = await uploadToCloudinary(mapFile.buffer, CLOUDINARY_FOLDER.site_map, mapFile.originalname);
        mapUrl = uploaded.url;
        mapPublicId = uploaded.public_id;
      }
      const [site] = await sql`
        INSERT INTO sites (
          site_name, city, state, full_address, description, total_plots,
          starting_price, total_area, highlights, property_image_url, property_image_public_id,
          display_on_home_page, site_status, map_image_url, map_public_id, created_by_admin_id
        )
        VALUES (
          ${site_name}, ${city}, ${state || "Uttar Pradesh"}, ${full_address || null},
          ${description || null}, ${Number(total_plots || 0)},
          ${starting_price ? Number(starting_price) : null}, ${total_area || null}, ${highlights || null},
          ${propertyImageUrl}, ${propertyImagePublicId}, ${parseBool(display_on_home_page, true)},
          ${site_status || "Active"}::site_status_enum, ${mapUrl}, ${mapPublicId}, ${req.admin.admin_id}
        )
        RETURNING site_id, site_name`;
      return ok(res, site, "Site created", 201);
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.put("/api/admin/sites/:id",
  verifyAdminToken,
  role("SuperAdmin","SiteManager"),
  upload.fields([
    { name: "property_image", maxCount: 1 },
    { name: "site_map", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const {
        site_name, city, state, full_address, description, total_plots, site_status, has_govt_approval,
        starting_price, total_area, highlights, display_on_home_page,
      } = req.body;
      let propertyImageUrl = null;
      let propertyImagePublicId = null;
      let mapUrl = null;
      let mapPublicId = null;
      const [oldSite] = await sql`
        SELECT map_public_id, property_image_public_id FROM sites WHERE site_id = ${req.params.id}`;
      const propertyFile = req.files?.property_image?.[0];
      const mapFile = req.files?.site_map?.[0];
      if (propertyFile) {
        const uploaded = await uploadToCloudinary(propertyFile.buffer, CLOUDINARY_FOLDER.property_image, propertyFile.originalname);
        propertyImageUrl = uploaded.url;
        propertyImagePublicId = uploaded.public_id;
        if (oldSite?.property_image_public_id) {
          cloudinary.uploader.destroy(oldSite.property_image_public_id).catch(() => {});
        }
      }
      if (mapFile) {
        const uploaded = await uploadToCloudinary(mapFile.buffer, CLOUDINARY_FOLDER.site_map, mapFile.originalname);
        mapUrl = uploaded.url;
        mapPublicId = uploaded.public_id;
        if (oldSite?.map_public_id) {
          cloudinary.uploader.destroy(oldSite.map_public_id).catch(() => {});
        }
      }
      await sql`
        UPDATE sites SET
          site_name        = COALESCE(${site_name        || null}, site_name),
          city             = COALESCE(${city             || null}, city),
          state            = COALESCE(${state            || null}, state),
          full_address     = COALESCE(${full_address     || null}, full_address),
          description      = COALESCE(${description      || null}, description),
          total_plots      = COALESCE(${total_plots ? Number(total_plots) : null}, total_plots),
          starting_price   = COALESCE(${starting_price ? Number(starting_price) : null}, starting_price),
          total_area       = COALESCE(${total_area       || null}, total_area),
          highlights       = COALESCE(${highlights       || null}, highlights),
          display_on_home_page = COALESCE(${display_on_home_page != null ? parseBool(display_on_home_page, true) : null}, display_on_home_page),
          site_status      = COALESCE(${site_status      || null}::site_status_enum, site_status),
          has_govt_approval= COALESCE(${has_govt_approval != null ? has_govt_approval : null}, has_govt_approval),
          property_image_url = COALESCE(${propertyImageUrl}, property_image_url),
          property_image_public_id = COALESCE(${propertyImagePublicId}, property_image_public_id),
          map_image_url    = COALESCE(${mapUrl}, map_image_url),
          map_public_id    = COALESCE(${mapPublicId}, map_public_id),
          updated_at       = NOW()
        WHERE site_id = ${req.params.id}`;
      return ok(res, {}, "Site updated");
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.delete("/api/admin/sites/:id",
  verifyAdminToken,
  role("SuperAdmin","SiteManager"),
  async (req, res) => {
    try {
      const siteId = req.params.id;
      const [usage] = await sql`
        SELECT
          COUNT(p.plot_id)::int AS plots,
          COUNT(b.booking_id)::int AS bookings
        FROM sites s
        LEFT JOIN plots p ON p.site_id = s.site_id AND p.is_active = TRUE
        LEFT JOIN bookings b ON b.plot_id = p.plot_id
        WHERE s.site_id = ${siteId}`;

      if (usage?.bookings > 0) {
        return err(res, "Site has linked bookings or sales. Marking inactive is safer than deleting.", 409);
      }
      if (usage?.plots > 0) {
        await sql`UPDATE plots SET is_active = FALSE, updated_at = NOW() WHERE site_id = ${siteId}`;
      }
      await sql`UPDATE sites SET site_status = 'Inactive', updated_at = NOW() WHERE site_id = ${siteId}`;
      return ok(res, {}, "Site deactivated safely");
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.post("/api/admin/sites/:id/map",
  verifyAdminToken,
  role("SuperAdmin","SiteManager"),
  upload.single("site_map"),
  async (req, res) => {
    try {
      if (!req.file) return err(res, "site_map image is required", 400);
      const [oldSite] = await sql`SELECT map_public_id FROM sites WHERE site_id = ${req.params.id}`;
      if (!oldSite) return err(res, "Site not found", 404);
      const uploaded = await uploadToCloudinary(req.file.buffer, CLOUDINARY_FOLDER.site_map, req.file.originalname);
      await sql`
        UPDATE sites SET map_image_url = ${uploaded.url}, map_public_id = ${uploaded.public_id}, updated_at = NOW()
        WHERE site_id = ${req.params.id}`;
      if (oldSite.map_public_id) cloudinary.uploader.destroy(oldSite.map_public_id).catch(() => {});
      return ok(res, { map_image_url: uploaded.url }, "Map uploaded successfully");
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.post("/api/admin/sites/:id/map-image",
  verifyAdminToken,
  role("SuperAdmin","SiteManager"),
  upload.single("site_map"),
  async (req, res) => {
    try {
      if (!req.file) return err(res, "site_map image is required", 400);
      const [oldSite] = await sql`SELECT map_public_id FROM sites WHERE site_id = ${req.params.id}`;
      if (!oldSite) return err(res, "Site not found", 404);
      const uploaded = await uploadToCloudinary(req.file.buffer, CLOUDINARY_FOLDER.site_map, req.file.originalname);
      await sql`
        UPDATE sites SET map_image_url = ${uploaded.url}, map_public_id = ${uploaded.public_id}, updated_at = NOW()
        WHERE site_id = ${req.params.id}`;
      if (oldSite.map_public_id) cloudinary.uploader.destroy(oldSite.map_public_id).catch(() => {});
      return ok(res, { map_image_url: uploaded.url }, "Map uploaded successfully");
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.post("/api/admin/sites/:id/property-image",
  verifyAdminToken,
  role("SuperAdmin","SiteManager"),
  upload.single("property_image"),
  async (req, res) => {
    try {
      if (!req.file) return err(res, "property_image is required", 400);
      const [oldSite] = await sql`SELECT property_image_public_id FROM sites WHERE site_id = ${req.params.id}`;
      if (!oldSite) return err(res, "Site not found", 404);
      const uploaded = await uploadToCloudinary(req.file.buffer, CLOUDINARY_FOLDER.property_image, req.file.originalname);
      await sql`
        UPDATE sites SET property_image_url = ${uploaded.url}, property_image_public_id = ${uploaded.public_id}, updated_at = NOW()
        WHERE site_id = ${req.params.id}`;
      if (oldSite.property_image_public_id) cloudinary.uploader.destroy(oldSite.property_image_public_id).catch(() => {});
      return ok(res, { property_image_url: uploaded.url }, "Property image uploaded successfully");
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.get("/api/admin/sites/:id/plots",
  verifyAdminToken,
  role("SuperAdmin","SiteManager","SupportStaff","FinanceManager"),
  async (req, res) => {
    try {
      const plots = await sql`
        SELECT
          p.plot_id, p.site_id, p.plot_number, p.plot_area, p.plot_category,
          p.base_price, p.down_payment, p.monthly_emi, p.emi_tenure_months,
          p.file_charge, p.plot_status, p.coordinates_x, p.coordinates_y,
          b.booking_id, b.booking_serial, b.booking_date, b.booking_status,
          b.advance_amount AS booking_amount, b.advance_amount AS down_payment_paid,
          b.payment_type,
          u.user_id AS customer_id, u.member_id AS customer_member_id,
          u.full_name AS customer_name, u.mobile_no AS customer_mobile, u.email AS customer_email,
          COALESCE(pay.total_emi_paid, 0)::numeric AS emi_paid_amount,
          COALESCE(pay.total_paid, COALESCE(b.advance_amount, 0))::numeric AS total_paid,
          GREATEST(COALESCE(p.base_price, 0) - COALESCE(pay.total_paid, COALESCE(b.advance_amount, 0)), 0)::numeric AS remaining_payment,
          COALESCE(pay.pending_emi_count, 0)::int AS pending_emi_count,
          COALESCE(pay.proof_submitted_count, 0)::int AS proof_submitted_count,
          CASE
            WHEN b.booking_id IS NULL THEN 'No booking'
            WHEN b.booking_status = 'Cancelled' THEN 'Cancelled'
            WHEN COALESCE(pay.proof_submitted_count, 0) > 0 THEN 'Proof submitted'
            WHEN COALESCE(pay.pending_emi_count, 0) > 0 THEN 'Payment pending'
            WHEN b.booking_status = 'Confirmed' THEN 'Confirmed'
            ELSE b.booking_status::text
          END AS payment_status
        FROM plots p
        LEFT JOIN LATERAL (
          SELECT *
          FROM bookings b
          WHERE b.plot_id = p.plot_id
          ORDER BY
            CASE WHEN b.booking_status = 'Cancelled' THEN 1 ELSE 0 END,
            b.created_at DESC
          LIMIT 1
        ) b ON TRUE
        LEFT JOIN users u ON u.user_id = b.user_id
        LEFT JOIN LATERAL (
          SELECT
            COALESCE(SUM(e.paid_amount) FILTER (WHERE e.emi_status = 'Paid'), 0) AS total_emi_paid,
            COALESCE(b.advance_amount, 0) + COALESCE(SUM(e.paid_amount) FILTER (WHERE e.emi_status = 'Paid'), 0) AS total_paid,
            COUNT(*) FILTER (WHERE e.emi_status = 'Pending') AS pending_emi_count,
            COUNT(*) FILTER (WHERE e.emi_status = 'ProofSubmitted') AS proof_submitted_count
          FROM emi_schedules e
          WHERE e.booking_id = b.booking_id
        ) pay ON TRUE
        WHERE p.site_id = ${req.params.id} AND p.is_active = TRUE
        ORDER BY p.plot_number`;

      return ok(res, plots);
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.post("/api/admin/sites/:id/plots",
  verifyAdminToken,
  role("SuperAdmin","SiteManager"),
  async (req, res) => {
    try {
      const { plot_number, plot_area, plot_category,
              base_price, down_payment, monthly_emi, emi_tenure_months,
              file_charge, plot_status, coordinates_x, coordinates_y } = req.body;
      if (!plot_number || !plot_area || !base_price)
        return err(res, "plot_number, plot_area, base_price required", 400);

      const [plot] = await sql`
        INSERT INTO plots (site_id, plot_number, plot_area, plot_category,
                           base_price, down_payment, monthly_emi, emi_tenure_months,
                           file_charge, plot_status, coordinates_x, coordinates_y,
                           created_by_admin_id)
        VALUES (${req.params.id}, ${plot_number}, ${plot_area},
                ${plot_category || (plot_area <= 50 ? "50gaj" : "100gaj")},
                ${base_price}, ${down_payment || 0}, ${monthly_emi || 0},
                ${emi_tenure_months || 60}, ${file_charge || 0},
                ${plot_status || "Vacant"}::plot_status_enum,
                ${coordinates_x || null}, ${coordinates_y || null}, ${req.admin.admin_id})
        RETURNING plot_id, plot_number, plot_status`;
      return ok(res, plot, "Plot created", 201);
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.post("/api/admin/plots",
  verifyAdminToken,
  role("SuperAdmin","SiteManager"),
  async (req, res) => {
    try {
      const { site_id, plot_number, plot_area, plot_category,
              base_price, down_payment, monthly_emi, emi_tenure_months,
              file_charge, plot_status, coordinates_x, coordinates_y } = req.body;
      if (!site_id || !plot_number || !plot_area || !base_price)
        return err(res, "site_id, plot_number, plot_area, base_price required", 400);

      const [plot] = await sql`
        INSERT INTO plots (site_id, plot_number, plot_area, plot_category,
                           base_price, down_payment, monthly_emi, emi_tenure_months,
                           file_charge, plot_status, coordinates_x, coordinates_y,
                           created_by_admin_id)
        VALUES (${site_id}, ${plot_number}, ${plot_area},
                ${plot_category || (plot_area <= 50 ? "50gaj" : "100gaj")},
                ${base_price}, ${down_payment || 0}, ${monthly_emi || 0},
                ${emi_tenure_months || 60}, ${file_charge || 0},
                ${plot_status || "Vacant"}::plot_status_enum,
                ${coordinates_x || null}, ${coordinates_y || null}, ${req.admin.admin_id})
        RETURNING plot_id, plot_number, plot_status`;
      return ok(res, plot, "Plot created", 201);
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.put("/api/admin/plots/:id",
  verifyAdminToken,
  role("SuperAdmin","SiteManager"),
  async (req, res) => {
    try {
      const { plot_number, plot_area, plot_category, base_price, down_payment,
              monthly_emi, emi_tenure_months, file_charge, plot_status,
              coordinates_x, coordinates_y } = req.body;

      const [plot] = await sql`
        UPDATE plots SET
          plot_number = COALESCE(${plot_number || null}, plot_number),
          plot_area = COALESCE(${plot_area ? Number(plot_area) : null}, plot_area),
          plot_category = COALESCE(${plot_category || null}::plot_category_enum, plot_category),
          base_price = COALESCE(${base_price ? Number(base_price) : null}, base_price),
          down_payment = COALESCE(${down_payment != null ? Number(down_payment) : null}, down_payment),
          monthly_emi = COALESCE(${monthly_emi != null ? Number(monthly_emi) : null}, monthly_emi),
          emi_tenure_months = COALESCE(${emi_tenure_months ? Number(emi_tenure_months) : null}, emi_tenure_months),
          file_charge = COALESCE(${file_charge != null ? Number(file_charge) : null}, file_charge),
          plot_status = COALESCE(${plot_status || null}::plot_status_enum, plot_status),
          coordinates_x = ${coordinates_x ?? null},
          coordinates_y = ${coordinates_y ?? null},
          updated_at = NOW()
        WHERE plot_id = ${req.params.id}
        RETURNING plot_id, plot_number, plot_status`;
      if (!plot) return err(res, "Plot not found", 404);
      return ok(res, plot, "Plot updated");
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.delete("/api/admin/plots/:id",
  verifyAdminToken,
  role("SuperAdmin","SiteManager"),
  async (req, res) => {
    try {
      const [booking] = await sql`SELECT booking_id FROM bookings WHERE plot_id = ${req.params.id} LIMIT 1`;
      if (booking) return err(res, "Plot has linked booking/payment records. Delete is blocked.", 409);
      const [plot] = await sql`
        UPDATE plots SET is_active = FALSE, updated_at = NOW()
        WHERE plot_id = ${req.params.id}
        RETURNING plot_id`;
      if (!plot) return err(res, "Plot not found", 404);
      return ok(res, {}, "Plot deleted safely");
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.put("/api/admin/plots/:id/status",
  verifyAdminToken,
  role("SuperAdmin","SiteManager"),
  async (req, res) => {
    try {
      const { new_status, reason } = req.body;
      if (!new_status) return err(res, "new_status required", 400);

      const [plot] = await sql`SELECT plot_status FROM plots WHERE plot_id = ${req.params.id}`;
      if (!plot) return err(res, "Plot not found", 404);

      await sql`UPDATE plots SET plot_status = ${new_status}::plot_status_enum, updated_at = NOW() WHERE plot_id = ${req.params.id}`;
      await sql`
        INSERT INTO plot_status_history (plot_id, old_status, new_status, changed_by_admin_id, reason)
        VALUES (${req.params.id}, ${plot.plot_status}::plot_status_enum,
                ${new_status}::plot_status_enum, ${req.admin.admin_id}, ${reason || null})`;

      return ok(res, {}, "Plot status updated");
    } catch (e) {
      return err(res, e.message);
    }
  }
);

/* ==========================
   ─────────────────────────
   ADMIN — COMMISSION
   GET  /api/admin/commissions/pending
   POST /api/admin/commissions/:id/approve
   ─────────────────────────
========================== */

app.get("/api/admin/commissions/pending",
  verifyAdminToken,
  role("SuperAdmin","FinanceManager"),
  async (req, res) => {
    try {
      const pending = await sql`
        SELECT c.commission_id, c.commission_type, c.gaj_sold,
               c.gross_amount, c.deduction_amount, c.net_amount,
               c.commission_month, c.created_at,
               u.full_name AS associate_name, u.member_id,
               b.booking_serial, p.plot_number, s.site_name
        FROM commission_transactions c
        JOIN users u ON c.associate_user_id = u.user_id
        LEFT JOIN bookings b ON c.related_booking_id = b.booking_id
        LEFT JOIN plots    p ON b.plot_id = p.plot_id
        LEFT JOIN sites    s ON p.site_id = s.site_id
        WHERE c.commission_status = 'Pending'
        ORDER BY c.created_at ASC`;
      return ok(res, pending);
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.post("/api/admin/commissions/:id/approve",
  verifyAdminToken,
  role("SuperAdmin","FinanceManager"),
  async (req, res) => {
    try {
      const { payment_reference } = req.body;
      await sql`
        UPDATE commission_transactions SET
          commission_status = 'Paid', approved_by_admin_id = ${req.admin.admin_id},
          approved_at = NOW(), paid_at = NOW(),
          payment_reference = ${payment_reference || null}
        WHERE commission_id = ${req.params.id}`;
      return ok(res, {}, "Commission approved and marked as paid");
    } catch (e) {
      return err(res, e.message);
    }
  }
);

/* ==========================
   ─────────────────────────
   ADMIN — NOTIFICATIONS
   POST /api/admin/notifications/send
   POST /api/admin/notifications/bulk
   ─────────────────────────
========================== */

app.post("/api/admin/notifications/send",
  verifyAdminToken,
  role("SuperAdmin","SupportStaff"),
  async (req, res) => {
    try {
      const { user_id, title, message, channel = "Push" } = req.body;
      if (!user_id || !message) return err(res, "user_id & message required", 400);

      await sql`
        INSERT INTO notification_log (user_id, sent_by_admin_id, channel, title, message)
        VALUES (${user_id}, ${req.admin.admin_id}, ${channel}, ${title || null}, ${message})`;
      return ok(res, {}, "Notification sent");
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.post("/api/admin/notifications/bulk",
  verifyAdminToken,
  role("SuperAdmin","SupportStaff"),
  async (req, res) => {
    try {
      const { target, title, message, channel = "All" } = req.body;
      // target: 'All' | 'Customer' | 'Associate'
      if (!message) return err(res, "message required", 400);

      const users = await sql`
        SELECT user_id FROM users
        WHERE account_status = 'Active'
          AND (${target || null} IS NULL OR ${target} = 'All' OR user_type = ${target})`;

      for (const u of users) {
        await sql`
          INSERT INTO notification_log (user_id, sent_by_admin_id, channel, title, message)
          VALUES (${u.user_id}, ${req.admin.admin_id}, ${channel}, ${title || null}, ${message})`;
      }
      return ok(res, { sent_to: users.length }, `Bulk notification sent to ${users.length} users`);
    } catch (e) {
      return err(res, e.message);
    }
  }
);

/* ==========================
   ─────────────────────────
   ADMIN — DASHBOARD STATS
   GET /api/admin/dashboard
   GET /api/admin/audit-log
   ─────────────────────────
========================== */

app.get("/api/admin/dashboard",
  verifyAdminToken,
  role("SuperAdmin","FinanceManager","SiteManager"),
  async (req, res) => {
    try {
      const [stats] = await sql`SELECT * FROM vw_admin_dashboard_stats`;
      const sites   = await sql`SELECT * FROM vw_site_plot_summary`;
      const recentBookings = await sql`
        SELECT b.booking_serial, b.booking_status, b.booking_date,
               u.full_name, p.plot_number, s.site_name
        FROM bookings b
        JOIN users u ON b.user_id = u.user_id
        JOIN plots p ON b.plot_id = p.plot_id
        JOIN sites s ON p.site_id = s.site_id
        ORDER BY b.created_at DESC LIMIT 5`;
      return ok(res, { stats, sites, recent_bookings: recentBookings });
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.get("/api/admin/audit-log",
  verifyAdminToken,
  role("SuperAdmin"),
  async (req, res) => {
    try {
      const { module, page = 1, limit = 30 } = req.query;
      const offset = (page - 1) * limit;
      const logs = await sql`
        SELECT * FROM audit_log
        WHERE (${module || null} IS NULL OR module = ${module})
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}`;
      return ok(res, logs);
    } catch (e) {
      return err(res, e.message);
    }
  }
);

/* ==========================
   HEALTH CHECK
========================== */
app.get("/health", async (req, res) => {
  try {
    await sql`SELECT 1`;
    res.json({ status: "ok", db: "connected", time: new Date().toISOString() });
  } catch (e) {
    res.status(503).json({ status: "error", db: "disconnected" });
  }
});

/* ==========================
   404 + Error Handler
========================== */
app.use((req, res) => res.status(404).json({ success: false, message: "Route not found" }));

app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError)
    return res.status(400).json({ success: false, message: error.message });
  console.error(error);
  res.status(500).json({ success: false, message: error.message || "Internal server error" });
});

const PORT = Number(process.env.PORT) || 5000;
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`[MMR API] Server running on port ${PORT}`);
});

server.on("error", (error) => {
  console.error("[MMR API] Server startup failed", {
    code: error.code,
    message: error.message,
  });
  process.exitCode = 1;
});

globalThis.__mmrApiServer = server;

