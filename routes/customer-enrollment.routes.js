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
    await sql`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`;
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
    return err(res, "Customer enrollment module is unavailable right now.");
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
// Accepts public submission or authenticated customer submission. (Using authUser if we assume customer needs to be logged in to access panel)
router.post("/customer-enrollment", authUser, async (req, res) => {
  try {
    const user_id = req.user.id; // From JWT
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
    });

    return ok(res, { id: newSubmissionId, applicationNo: appNo }, "Enrollment submitted successfully.");
  } catch (e) {
    console.error("Customer Enrollment Error:", e);
    return err(res, "Failed to submit enrollment form.");
  }
});

// GET /api/customer-enrollment/me (Get for logged-in user)
router.get("/customer-enrollment/me", authUser, async (req, res) => {
  try {
    const user_id = req.user.id;
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

// GET /api/customer-enrollment (Admin - List)
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
    const [row] = await sql`SELECT * FROM customer_enrollment_submissions WHERE id = ${id}`;
    if (!row) return err(res, "Enrollment not found.", 404);
    row.nominees = await sql`SELECT * FROM customer_nominees WHERE submission_id = ${id}`;
    return ok(res, row);
  } catch (e) {
    console.error("GET /api/customer-enrollment/:id error:", e);
    return err(res, "Failed to fetch enrollment: " + e.message);
  }
});

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

export default router;
