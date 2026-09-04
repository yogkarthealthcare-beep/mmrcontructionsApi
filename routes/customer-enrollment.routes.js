import express from "express";
import sql from "../db.js";
import { saveFileToVPS } from "../services/fileStorage.service.js";
import jwt from "jsonwebtoken";
import { generateCustomerPdf } from "../services/customerPdfService.js";

const router = express.Router();

// Helpers
const ok = (res, data, msg = "Success", status = 200) =>
  res.status(status).json({ success: true, message: msg, data });

const err = (res, msg = "Request failed", status = 400) =>
  res.status(status).json({ success: false, message: msg });

const isAdminPrincipal = (principal = {}) => {
  const adminRoles = new Set(["SuperAdmin", "FinanceManager", "SiteManager", "SupportStaff", "Admin", "admin", "super_admin"]);
  return Boolean(principal.admin_id || adminRoles.has(principal.role));
};

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
      return res.status(403).json({ success: false, message: "Access restricted to Admins only." });
    }
    next();
  } catch (e) {
    return res.status(401).json({ success: false, message: "Invalid admin session." });
  }
}

// User auth (for customer portal endpoints)
export function authUser(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ success: false, message: "No authentication token provided." });
  }
  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (e) {
    return res.status(401).json({ success: false, message: "Invalid or expired session token." });
  }
}

// Ensure schema
let schemaReady;
async function ensureSchema() {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    try {
      await sql`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`;
    } catch (e) {
      console.warn("[ensureSchema] pgcrypto extension warning (ignoring):", e.message);
    }
    await sql`
      CREATE TABLE IF NOT EXISTS customer_enrollment_submissions (
          id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id                     INTEGER,
          form_date                   DATE,
          application_no              VARCHAR(50) UNIQUE,
          project_name                VARCHAR(150),
          property_type               VARCHAR(30),
          property_type_other         VARCHAR(100),
          plot_flat_no                VARCHAR(50),
          block_tower                 VARCHAR(50),
          size_area                   VARCHAR(50),
          rate_per_unit               NUMERIC(14,2),
          basic_sale_price            NUMERIC(14,2),
          plc_dev_charges             NUMERIC(14,2),
          total_property_value        NUMERIC(14,2),
          applicant_name              VARCHAR(150) NOT NULL,
          fh_name                     VARCHAR(150),
          date_of_birth               DATE,
          age                         SMALLINT,
          gender                      VARCHAR(10),
          marital_status              VARCHAR(10),
          nationality                 VARCHAR(20),
          nationality_other           VARCHAR(100),
          pan_no                      VARCHAR(10),
          aadhar_no                   VARCHAR(12),
          occupation                  VARCHAR(100),
          present_address             TEXT,
          present_city                VARCHAR(100),
          present_state_pin           VARCHAR(100),
          permanent_address           TEXT,
          permanent_city              VARCHAR(100),
          permanent_state_pin         VARCHAR(100),
          mobile_1                    VARCHAR(15) NOT NULL,
          mobile_2                    VARCHAR(15),
          email_1                     VARCHAR(150),
          photo_first_applicant_url   TEXT,
          co_applicant_name           VARCHAR(150),
          co_fh_name                  VARCHAR(150),
          co_relation                 VARCHAR(80),
          co_date_of_birth            DATE,
          co_age                      SMALLINT,
          co_gender                   VARCHAR(10),
          co_pan_no                   VARCHAR(10),
          co_aadhar_no                VARCHAR(12),
          co_present_address          TEXT,
          co_mobile                   VARCHAR(15),
          co_email                    VARCHAR(150),
          photo_co_applicant_url      TEXT,
          booking_amount              NUMERIC(14,2),
          booking_amount_words        TEXT,
          payment_mode                VARCHAR(20),
          txn_cheque_no               VARCHAR(50),
          txn_date                    DATE,
          drawn_bank_branch           VARCHAR(150),
          acc_holder_name             VARCHAR(150),
          acc_bank_branch             VARCHAR(150),
          acc_number                  VARCHAR(30),
          ifsc_code                   VARCHAR(15),
          associate_name              VARCHAR(150),
          associate_id                VARCHAR(50),
          associate_mobile            VARCHAR(15),
          associate_signature_name    VARCHAR(150),
          declaration_accepted        BOOLEAN NOT NULL DEFAULT FALSE,
          signature_sole_first_applicant_url TEXT,
          signature_co_applicant_url  TEXT,
          signature_authorized_signatory_url TEXT,
          terms_accepted              BOOLEAN NOT NULL DEFAULT FALSE,
          terms_accepted_at           TIMESTAMPTZ,
          application_status          VARCHAR(50) DEFAULT 'Pending',
          verified_by                 VARCHAR(150),
          payment_status              VARCHAR(15),
          payment_status_date         DATE,
          submitted_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
          created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS customer_nominees (
          id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          submission_id     UUID NOT NULL REFERENCES customer_enrollment_submissions(id) ON DELETE CASCADE,
          nominee_name      VARCHAR(150),
          relation          VARCHAR(80),
          age_dob           VARCHAR(50),
          aadhar_no         VARCHAR(12),
          created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;
    
    await sql`CREATE INDEX IF NOT EXISTS idx_ces_application_no ON customer_enrollment_submissions(application_no)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_ces_status ON customer_enrollment_submissions(application_status)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_ces_user ON customer_enrollment_submissions(user_id)`;

    try {
      await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS enrollment_status VARCHAR(20) DEFAULT 'Pending'`;
      await sql`ALTER TABLE investor_users ADD COLUMN IF NOT EXISTS enrollment_status VARCHAR(20) DEFAULT 'Pending'`;
      await sql`ALTER TABLE associate_enrollment ADD COLUMN IF NOT EXISTS user_id INTEGER`;
    } catch (colErr) {
      console.warn("[ensureSchema column warning]", colErr.message);
    }
  })().catch((error) => {
    schemaReady = null;
    throw error;
  });
  return schemaReady;
}

router.use(async (_req, res, next) => {
  try {
    await ensureSchema();
    next();
  } catch (error) {
    console.error("[Customer Enrollment Schema Error]", error);
    return err(res, "Customer enrollment module is unavailable right now. Schema Error: " + error.message);
  }
});

// Process base64 file
const processBase64 = async (dataUrl, filename, userId) => {
  if (!dataUrl) return null;
  const matches = dataUrl.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
  if (!matches || matches.length !== 3) return null;
  const buffer = Buffer.from(matches[2], 'base64');
  const result = await saveFileToVPS(buffer, {
    originalName: filename,
    module: "customer",
    entityId: userId || "guest",
    subCategory: "enrollments"
  });
  return result ? result.url : null;
};

// POST /api/customer-enrollment
// Accepts authenticated customer submission
router.post("/customer-enrollment", authUser, async (req, res) => {
  try {
    const user_id = req.user.user_id || req.user.id; // From JWT
    const b = req.body;

    if (!b.applicantName || !b.mobile1) {
      return err(res, "Applicant Name and Mobile No 1 are required.");
    }
    if (!b.termsAccepted) {
      return err(res, "Terms and conditions must be accepted.");
    }

    // Helper functions for safe type parsing
    const parseDate = (val) => {
      if (!val || val === "null" || val === "undefined" || String(val).trim() === "") return null;
      const d = new Date(val);
      return isNaN(d.getTime()) ? null : val;
    };

    const parseNum = (val) => {
      if (val === undefined || val === null || String(val).trim() === "") return null;
      const n = Number(String(val).replace(/,/g, ''));
      return isNaN(n) ? null : n;
    };

    const rateVal = parseNum(b.rate);
    const bookingAmountVal = parseNum(b.bookingAmount);
    const ageVal = b.age ? Number(b.age) || null : null;
    const coAgeVal = b.coAge ? Number(b.coAge) || null : null;

    const formDateVal = parseDate(b.formDate);
    const dobVal = parseDate(b.dob);
    const coDobVal = parseDate(b.coDob);
    const txnDateVal = parseDate(b.txnDate);

    // Process files
    const photoFirstUrl = await processBase64(b.photoFirstApplicant, `photo1_${Date.now()}.png`, user_id);
    const photoCoUrl = await processBase64(b.photoCoApplicant, `photo2_${Date.now()}.png`, user_id);
    const sigSoleUrl = await processBase64(b.signatureSoleFirstApplicant, `sigSole_${Date.now()}.png`, user_id);
    const sigCoUrl = await processBase64(b.signatureCoApplicant, `sigCo_${Date.now()}.png`, user_id);
    const sigAuthUrl = await processBase64(b.signatureAuthorizedSignatory, `sigAuth_${Date.now()}.png`, user_id);

    // Auto-gen application no
    const year = new Date().getFullYear();
    const countRes = await sql`SELECT COUNT(*)+1 as cnt FROM customer_enrollment_submissions`;
    const appNo = `MMR-CEF-${year}-${String(countRes[0].cnt).padStart(4, '0')}`;

    // Compute total property value safely
    const bsp = Number(b.bsp) || 0;
    const plc = Number(b.plcDev) || 0;
    const totalVal = bsp + plc;

    let newSubmissionId = null;

    await sql.begin(async (tx) => {
      const [newRow] = await tx`
        INSERT INTO customer_enrollment_submissions (
          user_id, form_date, application_no, project_name, property_type, property_type_other, plot_flat_no, block_tower, size_area, rate_per_unit, basic_sale_price, plc_dev_charges, total_property_value,
          applicant_name, fh_name, date_of_birth, age, gender, marital_status, nationality, nationality_other, pan_no, aadhar_no, occupation,
          present_address, present_city, present_state_pin, permanent_address, permanent_city, permanent_state_pin, mobile_1, mobile_2, email_1, photo_first_applicant_url,
          co_applicant_name, co_fh_name, co_relation, co_date_of_birth, co_age, co_gender, co_pan_no, co_aadhar_no, co_present_address, co_mobile, co_email, photo_co_applicant_url,
          booking_amount, booking_amount_words, payment_mode, txn_cheque_no, txn_date, drawn_bank_branch,
          acc_holder_name, acc_bank_branch, acc_number, ifsc_code,
          associate_name, associate_id, associate_mobile, associate_signature_name,
          declaration_accepted, signature_sole_first_applicant_url, signature_co_applicant_url, signature_authorized_signatory_url, terms_accepted, terms_accepted_at
        ) VALUES (
          ${user_id}, ${formDateVal}, ${b.applicationNo || appNo}, ${b.projectName || null}, ${b.propertyType || null}, ${b.propertyTypeOther || null}, ${b.plotFlatNo || null}, ${b.blockTower || null}, ${b.sizeArea || null}, ${rateVal}, ${bsp}, ${plc}, ${totalVal},
          ${b.applicantName}, ${b.fhName || null}, ${dobVal}, ${ageVal}, ${b.gender || null}, ${b.maritalStatus || null}, ${b.nationality || null}, ${b.nationalityOther || null}, ${b.pan || null}, ${b.aadhar || null}, ${b.occupation || null},
          ${b.presentAddress || null}, ${b.presentCity || null}, ${b.presentStatePin || null}, ${b.permanentAddress || null}, ${b.permanentCity || null}, ${b.permanentStatePin || null}, ${b.mobile1}, ${b.mobile2 || null}, ${b.email1 || null}, ${photoFirstUrl},
          ${b.coApplicantName || null}, ${b.coFhName || null}, ${b.coRelation || null}, ${coDobVal}, ${coAgeVal}, ${b.coGender || null}, ${b.coPan || null}, ${b.coAadhar || null}, ${b.coPresentAddress || null}, ${b.coMobile || null}, ${b.coEmail || null}, ${photoCoUrl},
          ${bookingAmountVal}, ${b.bookingAmountWords || null}, ${b.paymentMode || null}, ${b.txnNo || null}, ${txnDateVal}, ${b.drawnBankBranch || null},
          ${b.accHolderName || null}, ${b.accBankBranch || null}, ${b.accNumber || null}, ${b.ifscCode || null},
          ${b.associateName || null}, ${b.associateId || null}, ${b.associateMobile || null}, ${b.associateSignatureName || null},
          ${b.declarationAccepted || false}, ${sigSoleUrl}, ${sigCoUrl}, ${sigAuthUrl}, ${true}, NOW()
        ) RETURNING id
      `;

      newSubmissionId = newRow.id;

      // Insert Nominees
      if (b.nominees && Array.isArray(b.nominees)) {
        for (const nom of b.nominees) {
          if (nom.nomineeName) {
            await tx`
              INSERT INTO customer_nominees (submission_id, nominee_name, relation, age_dob, aadhar_no)
              VALUES (${newSubmissionId}, ${nom.nomineeName}, ${nom.nomineeRelation || null}, ${nom.nomineeAgeDob || null}, ${nom.nomineeAadhar || null})
            `;
          }
        }
      }

      // Update user's enrollment_status to Completed
      if (user_id) {
        await tx`UPDATE users SET enrollment_status = 'Completed' WHERE user_id = ${user_id}`;
      }
    });

    return ok(res, { id: newSubmissionId, applicationNo: appNo }, "Enrollment submitted successfully.");
  } catch (e) {
    console.error("Customer Enrollment Error:", e);
    return err(res, "Failed to submit enrollment form. Details: " + e.message);
  }
});

// GET /api/customer-enrollment/me (Get for logged-in user)
router.get("/customer-enrollment/me", authUser, async (req, res) => {
  try {
    const user_id = req.user.user_id || req.user.id;
    const rows = await sql`SELECT * FROM customer_enrollment_submissions WHERE user_id = ${user_id} ORDER BY created_at DESC`;
    for (let r of rows) {
      r.nominees = await sql`SELECT * FROM customer_nominees WHERE submission_id = ${r.id}`;
    }
    return ok(res, rows);
  } catch (e) {
    console.error("GET /api/customer-enrollment/me error:", e);
    return err(res, "Failed to fetch your enrollments: " + e.message);
  }
});

// GET /api/customer-enrollment/:id/print
router.get("/customer-enrollment/:id/print", async (req, res) => {
  try {
    const id = String(req.params.id);
    const pdfBuffer = await generateCustomerPdf(id);

    const [submission] = await sql`SELECT application_no, form_date FROM customer_enrollment_submissions WHERE id = ${id}`;
    if (!submission) {
      return err(res, "Submission not found.", 404);
    }

    const dateStr = submission.form_date 
      ? new Date(submission.form_date).toISOString().split('T')[0] 
      : new Date().toISOString().split('T')[0];
    const fileName = `MMR-Customer-${submission.application_no}-${dateStr}.pdf`;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.end(pdfBuffer);
  } catch (error) {
    console.error("GET /api/customer-enrollment/:id/print error:", error);
    return err(res, error.message || "Failed to generate PDF.");
  }
});

// GET /api/admin/customer-enrollments (Admin - List all customers with enrollment status & search)
router.get("/admin/customer-enrollments", authAdmin, async (req, res) => {
  try {
    const search = String(req.query.search || "").trim();
    let rows;
    if (search) {
      const s = `%${search}%`;
      rows = await sql`
        SELECT 
          u.user_id,
          u.full_name,
          u.email,
          u.mobile_no,
          u.member_id,
          u.user_type,
          u.registered_at,
          sp.member_id as sponsor_id,
          sp.full_name as sponsor_name,
          ces.id as submission_id,
          ces.application_no,
          ces.application_status,
          ces.project_name,
          ces.submitted_at,
          CASE WHEN ces.id IS NOT NULL THEN 'Completed' ELSE COALESCE(u.enrollment_status, 'Pending') END as enrollment_status
        FROM users u
        LEFT JOIN users sp ON u.sponsor_user_id = sp.user_id
        LEFT JOIN customer_enrollment_submissions ces ON u.user_id = ces.user_id
        WHERE u.user_type = 'Customer'
          AND (
            u.full_name ILIKE ${s}
            OR u.mobile_no ILIKE ${s}
            OR u.email ILIKE ${s}
            OR u.member_id ILIKE ${s}
            OR sp.member_id ILIKE ${s}
            OR ces.application_no ILIKE ${s}
          )
        ORDER BY u.registered_at DESC
      `;
    } else {
      rows = await sql`
        SELECT 
          u.user_id,
          u.full_name,
          u.email,
          u.mobile_no,
          u.member_id,
          u.user_type,
          u.registered_at,
          sp.member_id as sponsor_id,
          sp.full_name as sponsor_name,
          ces.id as submission_id,
          ces.application_no,
          ces.application_status,
          ces.project_name,
          ces.submitted_at,
          CASE WHEN ces.id IS NOT NULL THEN 'Completed' ELSE COALESCE(u.enrollment_status, 'Pending') END as enrollment_status
        FROM users u
        LEFT JOIN users sp ON u.sponsor_user_id = sp.user_id
        LEFT JOIN customer_enrollment_submissions ces ON u.user_id = ces.user_id
        WHERE u.user_type = 'Customer'
        ORDER BY u.registered_at DESC
      `;
    }
    return ok(res, rows);
  } catch (e) {
    console.error("GET /api/admin/customer-enrollments error:", e);
    return err(res, "Failed to fetch customer enrollments: " + e.message);
  }
});

// GET /api/customer-enrollment (Admin - List submissions)
router.get("/customer-enrollment", authAdmin, async (req, res) => {
  try {
    const rows = await sql`SELECT * FROM customer_enrollment_submissions ORDER BY created_at DESC`;
    return ok(res, rows);
  } catch (e) {
    console.error("GET /api/customer-enrollment error:", e);
    return err(res, "Failed to fetch enrollments: " + e.message);
  }
});

// GET /api/customer-enrollment/:id (Admin - Detail)
router.get("/customer-enrollment/:id", authAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    // Check if id is UUID (submission id) or numeric (user_id)
    let row;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      const [resRow] = await sql`SELECT * FROM customer_enrollment_submissions WHERE id = ${id}`;
      row = resRow;
    } else {
      const [resRow] = await sql`SELECT * FROM customer_enrollment_submissions WHERE user_id = ${Number(id)} ORDER BY created_at DESC LIMIT 1`;
      row = resRow;
    }

    if (!row) {
      // If no submission exists yet, return user profile info so Admin can view/create
      const [user] = await sql`
        SELECT u.user_id, u.full_name, u.email, u.mobile_no, u.member_id, u.date_of_birth, u.gender, u.father_name, u.mother_name, u.pan_number, u.aadhar_number,
               sp.member_id as sponsor_id, sp.full_name as sponsor_name
        FROM users u
        LEFT JOIN users sp ON u.sponsor_user_id = sp.user_id
        WHERE u.user_id = ${Number(id) || 0}
      `;
      if (user) {
        return ok(res, {
          user_id: user.user_id,
          applicant_name: user.full_name,
          mobile_1: user.mobile_no,
          email_1: user.email,
          pan_no: user.pan_number,
          aadhar_no: user.aadhar_number,
          date_of_birth: user.date_of_birth,
          gender: user.gender,
          fh_name: user.father_name,
          associate_id: user.sponsor_id,
          associate_name: user.sponsor_name,
          nominees: [],
          is_new: true
        });
      }
      return err(res, "Enrollment not found.", 404);
    }

    row.nominees = await sql`SELECT * FROM customer_nominees WHERE submission_id = ${row.id}`;
    return ok(res, row);
  } catch (e) {
    console.error("GET /api/customer-enrollment/:id error:", e);
    return err(res, "Failed to fetch enrollment: " + e.message);
  }
});

// PUT /api/customer-enrollment/:id and /api/admin/customer-enrollments/:id (Admin - Full Update)
const handleAdminCustomerUpdate = async (req, res) => {
  try {
    const { id } = req.params;
    const b = req.body;

    const parseDate = (val) => {
      if (!val || val === "null" || val === "undefined" || String(val).trim() === "") return null;
      const d = new Date(val);
      return isNaN(d.getTime()) ? null : val;
    };

    const parseNum = (val) => {
      if (val === undefined || val === null || String(val).trim() === "") return null;
      const n = Number(String(val).replace(/,/g, ''));
      return isNaN(n) ? null : n;
    };

    const rateVal = parseNum(b.rate || b.rate_per_unit);
    const bsp = parseNum(b.bsp || b.basic_sale_price) || 0;
    const plc = parseNum(b.plcDev || b.plc_dev_charges) || 0;
    const totalVal = bsp + plc;
    const bookingAmountVal = parseNum(b.bookingAmount || b.booking_amount);
    const ageVal = b.age ? Number(b.age) || null : null;
    const coAgeVal = b.coAge || b.co_age ? Number(b.coAge || b.co_age) || null : null;

    let targetSubmissionId = id;

    // Check if target is UUID or user_id
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
    let existing;
    if (isUuid) {
      const [resRow] = await sql`SELECT * FROM customer_enrollment_submissions WHERE id = ${id}`;
      existing = resRow;
    } else {
      const [resRow] = await sql`SELECT * FROM customer_enrollment_submissions WHERE user_id = ${Number(id)} ORDER BY created_at DESC LIMIT 1`;
      existing = resRow;
    }

    if (existing) {
      targetSubmissionId = existing.id;
      const [updated] = await sql`
        UPDATE customer_enrollment_submissions
        SET
          form_date = COALESCE(${parseDate(b.formDate || b.form_date)}, form_date),
          project_name = COALESCE(${b.projectName || b.project_name || null}, project_name),
          property_type = COALESCE(${b.propertyType || b.property_type || null}, property_type),
          property_type_other = ${b.propertyTypeOther ?? b.property_type_other ?? null},
          plot_flat_no = ${b.plotFlatNo ?? b.plot_flat_no ?? null},
          block_tower = ${b.blockTower ?? b.block_tower ?? null},
          size_area = ${b.sizeArea ?? b.size_area ?? null},
          rate_per_unit = COALESCE(${rateVal}, rate_per_unit),
          basic_sale_price = COALESCE(${bsp}, basic_sale_price),
          plc_dev_charges = COALESCE(${plc}, plc_dev_charges),
          total_property_value = COALESCE(${totalVal}, total_property_value),
          applicant_name = COALESCE(${b.applicantName || b.applicant_name || null}, applicant_name),
          fh_name = ${b.fhName ?? b.fh_name ?? null},
          date_of_birth = COALESCE(${parseDate(b.dob || b.date_of_birth)}, date_of_birth),
          age = COALESCE(${ageVal}, age),
          gender = ${b.gender ?? null},
          marital_status = ${b.maritalStatus ?? b.marital_status ?? null},
          nationality = COALESCE(${b.nationality || null}, nationality),
          nationality_other = ${b.nationalityOther ?? b.nationality_other ?? null},
          pan_no = ${b.pan ?? b.pan_no ?? null},
          aadhar_no = ${b.aadhar ?? b.aadhar_no ?? null},
          occupation = ${b.occupation ?? null},
          present_address = ${b.presentAddress ?? b.present_address ?? null},
          present_city = ${b.presentCity ?? b.present_city ?? null},
          present_state_pin = ${b.presentStatePin ?? b.present_state_pin ?? null},
          permanent_address = ${b.permanentAddress ?? b.permanent_address ?? null},
          permanent_city = ${b.permanentCity ?? b.permanent_city ?? null},
          permanent_state_pin = ${b.permanentStatePin ?? b.permanent_state_pin ?? null},
          mobile_1 = COALESCE(${b.mobile1 || b.mobile_1 || null}, mobile_1),
          mobile_2 = ${b.mobile2 ?? b.mobile_2 ?? null},
          email_1 = ${b.email1 ?? b.email_1 ?? null},
          co_applicant_name = ${b.coApplicantName ?? b.co_applicant_name ?? null},
          co_fh_name = ${b.coFhName ?? b.co_fh_name ?? null},
          co_relation = ${b.coRelation ?? b.co_relation ?? null},
          co_date_of_birth = ${parseDate(b.coDob || b.co_date_of_birth)},
          co_age = ${coAgeVal},
          co_gender = ${b.coGender ?? b.co_gender ?? null},
          co_pan_no = ${b.coPan ?? b.co_pan_no ?? null},
          co_aadhar_no = ${b.coAadhar ?? b.co_aadhar_no ?? null},
          co_present_address = ${b.coPresentAddress ?? b.co_present_address ?? null},
          co_mobile = ${b.coMobile ?? b.co_mobile ?? null},
          co_email = ${b.coEmail ?? b.co_email ?? null},
          booking_amount = COALESCE(${bookingAmountVal}, booking_amount),
          booking_amount_words = ${b.bookingAmountWords ?? b.booking_amount_words ?? null},
          payment_mode = ${b.paymentMode ?? b.payment_mode ?? null},
          txn_cheque_no = ${b.txnNo ?? b.txn_cheque_no ?? null},
          txn_date = ${parseDate(b.txnDate || b.txn_date)},
          drawn_bank_branch = ${b.drawnBankBranch ?? b.drawn_bank_branch ?? null},
          acc_holder_name = ${b.accHolderName ?? b.acc_holder_name ?? null},
          acc_bank_branch = ${b.accBankBranch ?? b.acc_bank_branch ?? null},
          acc_number = ${b.accNumber ?? b.acc_number ?? null},
          ifsc_code = ${b.ifscCode ?? b.ifsc_code ?? null},
          associate_name = ${b.associateName ?? b.associate_name ?? null},
          associate_id = ${b.associateId ?? b.associate_id ?? null},
          associate_mobile = ${b.associateMobile ?? b.associate_mobile ?? null},
          associate_signature_name = ${b.associateSignatureName ?? b.associate_signature_name ?? null},
          application_status = COALESCE(${b.applicationStatus || b.application_status || null}, application_status),
          verified_by = ${b.verifiedBy ?? b.verified_by ?? null},
          payment_status = ${b.paymentStatus ?? b.payment_status ?? null},
          payment_status_date = ${parseDate(b.paymentStatusDate || b.payment_status_date)},
          updated_at = NOW()
        WHERE id = ${targetSubmissionId}
        RETURNING *
      `;

      // Update nominees if provided
      if (b.nominees && Array.isArray(b.nominees)) {
        await sql`DELETE FROM customer_nominees WHERE submission_id = ${targetSubmissionId}`;
        for (const nom of b.nominees) {
          if (nom.nomineeName || nom.nominee_name) {
            await sql`
              INSERT INTO customer_nominees (submission_id, nominee_name, relation, age_dob, aadhar_no)
              VALUES (${targetSubmissionId}, ${nom.nomineeName || nom.nominee_name}, ${nom.nomineeRelation || nom.relation || null}, ${nom.nomineeAgeDob || nom.age_dob || null}, ${nom.nomineeAadhar || nom.aadhar_no || null})
            `;
          }
        }
      }

      // Also ensure user's enrollment_status is Completed
      if (existing.user_id) {
        await sql`UPDATE users SET enrollment_status = 'Completed' WHERE user_id = ${existing.user_id}`;
      }

      return ok(res, updated, "Customer enrollment updated successfully.");
    } else {
      return err(res, "Customer enrollment submission not found.", 404);
    }
  } catch (e) {
    console.error("PUT /api/customer-enrollment/:id error:", e);
    return err(res, "Failed to update customer enrollment: " + e.message);
  }
};

router.put("/customer-enrollment/:id", authAdmin, handleAdminCustomerUpdate);
router.put("/admin/customer-enrollments/:id", authAdmin, handleAdminCustomerUpdate);

// PATCH /api/customer-enrollment/:id/office-use (Admin - Update)
router.patch("/customer-enrollment/:id/office-use", authAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { applicationStatus, verifiedBy, paymentStatus, paymentStatusDate } = req.body;
    
    const [updated] = await sql`
      UPDATE customer_enrollment_submissions
      SET application_status = COALESCE(${applicationStatus || null}, application_status),
          verified_by = COALESCE(${verifiedBy || null}, verified_by),
          payment_status = COALESCE(${paymentStatus || null}, payment_status),
          payment_status_date = COALESCE(${paymentStatusDate || null}, payment_status_date),
          updated_at = NOW()
      WHERE id = ${id}
      RETURNING *
    `;
    
    if (!updated) return err(res, "Enrollment not found.", 404);
    return ok(res, updated, "Office use details updated.");
  } catch (e) {
    console.error("PATCH /api/customer-enrollment/:id/office-use error:", e);
    return err(res, "Failed to update enrollment: " + e.message);
  }
});

router.get("/customer-enrollment/debug-db", async (req, res) => {
  try {
    const tableExists = await sql`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'customer_enrollment_submissions'
      );
    `;
    
    let columns = [];
    if (tableExists[0].exists) {
      columns = await sql`
        SELECT column_name, data_type, character_maximum_length 
        FROM information_schema.columns 
        WHERE table_name = 'customer_enrollment_submissions';
      `;
    }
    
    return res.json({ 
      success: true, 
      tableExists: tableExists[0].exists, 
      columns 
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message, stack: e.stack });
  }
});

export default router;
