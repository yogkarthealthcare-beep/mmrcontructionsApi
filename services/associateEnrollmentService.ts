import { z } from "zod";
import sql from "../db.js";
import { normalizeHumanName, isValidHumanName, calculateAge, isValidState } from "../utils/validationHelper.js";

// Helper functions for defense-in-depth sanitization
function cleanString(val: unknown): string | null {
  if (val === null || val === undefined) return null;
  const s = String(val).trim();
  return s === "" ? null : s;
}

function cleanUpper(val: unknown): string | null {
  if (val === null || val === undefined) return null;
  const s = String(val).trim().toUpperCase();
  return s === "" ? null : s;
}

function cleanDigits(val: unknown): string | null {
  if (val === null || val === undefined) return null;
  const s = String(val).replace(/[\s-]/g, "").trim();
  return s === "" ? null : s;
}

function cleanEmail(val: unknown): string | null {
  if (val === null || val === undefined) return null;
  const s = String(val).trim().toLowerCase();
  return s === "" ? null : s;
}

function normalizeDate(val: unknown): string | null {
  if (val === null || val === undefined) return null;
  const s = String(val).trim();
  if (!s) return null;
  // Match DD-MM-YYYY or DD/MM/YYYY
  const ddmmyyyy = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (ddmmyyyy) {
    const [, d, m, y] = ddmmyyyy;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  // Match ISO or YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    return s.substring(0, 10);
  }
  const parsed = new Date(s);
  if (!isNaN(parsed.getTime())) {
    return parsed.toISOString().split("T")[0];
  }
  return s;
}

// Validation schema for defense in depth
export const associateEnrollmentSchema = z.object({
  fullName: z.preprocess(
    (v) => cleanString(v) ?? "",
    z.string().min(1, "Full name is required")
      .refine(v => isValidHumanName(v), { message: "Full Name must contain only alphabets and spaces" })
      .transform(v => normalizeHumanName(v))
  ),
  dob: z.preprocess(
    (v) => normalizeDate(v) ?? cleanString(v) ?? "",
    z.string().min(1, "Date of birth is required")
      .refine(v => calculateAge(v) >= 18, { message: "Associate must be at least 18 years old" })
  ),
  gender: z.preprocess((v) => cleanString(v) ?? "", z.string().min(1, "Gender is required")),
  fatherName: z.preprocess(
    cleanString,
    z.string().optional().nullable()
      .refine(v => !v || isValidHumanName(v), { message: "Father's Name must contain only alphabets and spaces" })
      .transform(v => (v ? normalizeHumanName(v) : v))
  ),
  motherName: z.preprocess(
    cleanString,
    z.string().optional().nullable()
      .refine(v => !v || isValidHumanName(v), { message: "Mother's Name must contain only alphabets and spaces" })
      .transform(v => (v ? normalizeHumanName(v) : v))
  ),
  spouseName: z.preprocess(
    cleanString,
    z.string().optional().nullable()
      .refine(v => !v || isValidHumanName(v), { message: "Spouse's Name must contain only alphabets and spaces" })
      .transform(v => (v ? normalizeHumanName(v) : v))
  ),
  contact1: z.preprocess((v) => cleanDigits(v) ?? "", z.string().min(10, "Contact number 1 must be at least 10 digits").max(15, "Contact number cannot exceed 15 digits")),
  contact2: z.preprocess(cleanDigits, z.string().optional().nullable()),
  nationality: z.preprocess((v) => cleanString(v) ?? "Indian", z.string().default("Indian")),
  residentialStatus: z.preprocess(cleanString, z.string().optional().nullable()),
  panNo: z.preprocess((v) => cleanUpper(v) ?? "", z.string().regex(/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/, "Invalid PAN format (e.g. ABCDE1234F)")),
  aadharNo: z.preprocess((v) => cleanDigits(v) ?? "", z.string().regex(/^[0-9]{12}$/, "Aadhar number must be exactly 12 digits")),
  email: z.preprocess(cleanEmail, z.string().email("Invalid email format").optional().nullable()),
  occupation: z.preprocess(cleanString, z.string().optional().nullable()),
  annualIncome: z.preprocess(cleanString, z.string().optional().nullable()),
  education: z.preprocess(cleanString, z.string().optional().nullable()),
  category: z.preprocess(cleanString, z.string().optional().nullable()),
  religion: z.preprocess(cleanString, z.string().optional().nullable()),
  signDate: z.preprocess((v) => normalizeDate(v) || new Date().toISOString().split("T")[0], z.string().optional().nullable()),
  termsAccepted: z.preprocess(
    (val) => val === "true" || val === true || val === "1" || val === 1 || val === "on",
    z.boolean().refine((val) => val === true, "All terms must be accepted")
  ),
  
  // Address Details
  permAddress: z.preprocess(cleanString, z.string().optional().nullable()),
  permCity: z.preprocess(cleanString, z.string().optional().nullable()),
  permState: z.preprocess(
    cleanString,
    z.string().optional().nullable()
      .refine(v => !v || isValidState(v), { message: "Selected permanent state is not valid" })
  ),
  permCountry: z.preprocess((v) => cleanString(v) ?? "India", z.string().default("India")),
  permPin: z.preprocess(cleanString, z.string().optional().nullable()),
  localAddress: z.preprocess(cleanString, z.string().optional().nullable()),
  localCity: z.preprocess(cleanString, z.string().optional().nullable()),
  localState: z.preprocess(cleanString, z.string().optional().nullable()),
  localCountry: z.preprocess((v) => cleanString(v) ?? "India", z.string().default("India")),
  localPin: z.preprocess(cleanString, z.string().optional().nullable()),

  // Bank Details
  bankName: z.preprocess(cleanString, z.string().optional().nullable()),
  accHolder: z.preprocess(cleanString, z.string().optional().nullable()),
  accNo: z.preprocess(cleanString, z.string().optional().nullable()),
  ifsc: z.preprocess(cleanUpper, z.string().optional().nullable()),
  micr: z.preprocess(cleanString, z.string().optional().nullable()),
  branchName: z.preprocess(cleanString, z.string().optional().nullable()),
  branchCode: z.preprocess(cleanString, z.string().optional().nullable()),
  swift: z.preprocess(cleanUpper, z.string().optional().nullable()),
  branchCountry: z.preprocess((v) => cleanString(v) ?? "India", z.string().default("India")),

  // Nominee Details
  nomineeName: z.preprocess(
    cleanString,
    z.string().optional().nullable()
      .refine(v => !v || isValidHumanName(v), { message: "Nominee Name must contain only alphabets and spaces" })
      .transform(v => (v ? normalizeHumanName(v) : v))
  ),
  nomineeDob: z.preprocess(normalizeDate, z.string().optional().nullable()),
  nomineeGender: z.preprocess(cleanString, z.string().optional().nullable()),
  nomineeNationality: z.preprocess((v) => cleanString(v) ?? "Indian", z.string().default("Indian")),
  nomineeResStatus: z.preprocess(cleanString, z.string().optional().nullable()),
  nomineeRelationship: z.preprocess(cleanString, z.string().optional().nullable()),
  nomineePanName: z.preprocess(cleanString, z.string().optional().nullable()),
  nomineePanNo: z.preprocess(cleanUpper, z.string().optional().nullable()),
  nomineeAadharName: z.preprocess(cleanString, z.string().optional().nullable()),
  nomineeAadharNo: z.preprocess(cleanDigits, z.string().optional().nullable()),
  nomineeAddress: z.preprocess(cleanString, z.string().optional().nullable()),

  // Sponsor Details
  sponsorName: z.preprocess(cleanString, z.string().optional().nullable()),
  sponsorCode: z.preprocess(cleanString, z.string().optional().nullable()),
  sponsorContact: z.preprocess(cleanDigits, z.string().optional().nullable()),

  // Submission Status Flags
  isFinalSubmitted: z.preprocess((val) => val === "true" || val === true || val === "1" || val === 1, z.boolean().optional().nullable()),
  is_final_submitted: z.preprocess((val) => val === "true" || val === true || val === "1" || val === 1, z.boolean().optional().nullable())
});

export type AssociateEnrollmentInput = z.infer<typeof associateEnrollmentSchema>;

interface ServiceResult {
  associateId: string;
}

/**
 * Register or update an associate enrollment and related details in a single database transaction.
 */
// Auto-ensure signature columns and user link columns exist
(async () => {
  try {
    await sql`ALTER TABLE associate_enrollment ADD COLUMN IF NOT EXISTS user_id integer`;
    await sql`ALTER TABLE associate_enrollment ADD COLUMN IF NOT EXISTS member_id text`;
    await sql`ALTER TABLE associate_enrollment ADD COLUMN IF NOT EXISTS signature_path text`;
    await sql`ALTER TABLE associate_sponsor ADD COLUMN IF NOT EXISTS signature_path text`;
  } catch (e) {
    // silently catch if table not yet initialized
  }
})();

export async function registerAssociateEnrollment(
  data: AssociateEnrollmentInput,
  applicantPhotoPath: string | null,
  nomineePhotoPath: string | null,
  userId: any = null,
  applicantSignaturePath: string | null = null,
  sponsorSignaturePath: string | null = null
): Promise<ServiceResult> {
  const year = new Date().getFullYear();
  let generatedId = "";

  const panStr = String(data.panNo || '').trim().toUpperCase();
  const aadharStr = String(data.aadharNo || '').replace(/[\s-]/g, '').trim();
  const contactStr = String(data.contact1 || '').replace(/[\s-]/g, '').trim();
  const emailStr = data.email ? String(data.email).trim().toLowerCase() : null;
  const dobStr = normalizeDate(data.dob) || data.dob;
  const signDateStr = normalizeDate(data.signDate) || new Date().toISOString().split('T')[0];
  const nomineeDobStr = normalizeDate(data.nomineeDob);

  // Perform inside transaction so that failure in any step rolls back everything
  await sql.begin(async (tx: any) => {
    let userRow: any = null;
    if (userId) {
      const [u] = await tx`SELECT user_id, member_id, mobile_no, email, pan_number, aadhar_number FROM users WHERE user_id = ${userId}`;
      userRow = u;
    }

    // 1. Check if an enrollment record already exists for this user or credentials
    const [existing] = await tx`
      SELECT id, is_final_submitted, applicant_photo_path, signature_path 
      FROM associate_enrollment 
      WHERE (${Boolean(userRow?.user_id)} AND user_id = ${userRow?.user_id || 0})
         OR (${Boolean(userRow?.member_id)} AND (id = ${userRow?.member_id || ''} OR member_id = ${userRow?.member_id || ''}))
         OR (
           UPPER(pan_no) = ${panStr}
           OR aadhar_no = ${aadharStr}
           OR (${contactStr !== ''} AND contact_no_1 = ${contactStr})
           OR (${emailStr !== null} AND LOWER(email) = ${emailStr || ''})
         )
      ORDER BY (user_id = ${userRow?.user_id || 0}) DESC, created_at DESC
      LIMIT 1
    `;

    if (existing) {
      if (existing.is_final_submitted) {
        const lockErr: any = new Error("Enrollment is permanently finalized and cannot be modified.");
        lockErr.statusCode = 403;
        throw lockErr;
      }
      generatedId = existing.id;
      const finalApplicantPhoto = applicantPhotoPath || existing.applicant_photo_path || null;
      const finalApplicantSign = applicantSignaturePath || existing.signature_path || null;

      // Update master record
      await tx`
        UPDATE associate_enrollment SET
          user_id = COALESCE(user_id, ${userRow?.user_id || null}),
          member_id = COALESCE(member_id, ${userRow?.member_id || null}),
          full_name = ${data.fullName},
          dob = ${dobStr},
          gender = ${data.gender},
          father_name = ${data.fatherName || null},
          mother_name = ${data.motherName || null},
          spouse_name = ${data.spouseName || null},
          contact_no_1 = ${contactStr},
          contact_no_2 = ${data.contact2 || null},
          nationality = ${data.nationality || 'Indian'},
          residential_status = ${data.residentialStatus || null},
          pan_no = ${panStr},
          aadhar_no = ${aadharStr},
          email = ${emailStr},
          occupation = ${data.occupation || null},
          annual_income = ${data.annualIncome || null},
          education = ${data.education || null},
          category = ${data.category || null},
          religion = ${data.religion || null},
          is_final_submitted = COALESCE(${data.isFinalSubmitted !== undefined ? Boolean(data.isFinalSubmitted) : (data.is_final_submitted !== undefined ? Boolean(data.is_final_submitted) : null)}, is_final_submitted, FALSE),
          applicant_photo_path = COALESCE(${finalApplicantPhoto}, applicant_photo_path),
          signature_path = COALESCE(${finalApplicantSign}, signature_path),
          sign_date = ${signDateStr || null},
          terms_accepted = ${Boolean(data.termsAccepted)},
          terms_accepted_at = NOW(),
          updated_at = NOW()
        WHERE id = ${generatedId}
      `;

      // Refresh child tables
      await tx`DELETE FROM associate_address WHERE associate_id = ${generatedId}`;
      await tx`DELETE FROM associate_bank_details WHERE associate_id = ${generatedId}`;
      await tx`DELETE FROM associate_nominee WHERE associate_id = ${generatedId}`;
      await tx`DELETE FROM associate_sponsor WHERE associate_id = ${generatedId}`;
    } else {
      // 1. Generate unique chronological Associate ID
      // Format: MMR-ASC-YYYY-XXXX (where XXXX is a sequential 4-digit number starting at 0001)
      const [maxResult] = await tx`
        SELECT COALESCE(MAX(CAST(SUBSTRING(id FROM '[0-9]+$') AS INTEGER)), 0) as max_num
        FROM associate_enrollment 
        WHERE id LIKE ${`MMR-ASC-${year}-%`}
      `;
      const count = Number(maxResult?.max_num || 0) + 1;
      generatedId = `MMR-ASC-${year}-${String(count).padStart(4, "0")}`;

      const isFinal = Boolean(data.isFinalSubmitted || data.is_final_submitted || false);
      // 2. Insert master: associate_enrollment
      await tx`
        INSERT INTO associate_enrollment (
          id, user_id, member_id, full_name, dob, gender, father_name, mother_name, spouse_name,
          contact_no_1, contact_no_2, nationality, residential_status,
          pan_no, aadhar_no, email, occupation, annual_income, education,
          category, religion, is_final_submitted, applicant_photo_path, signature_path, sign_date,
          terms_accepted, terms_accepted_at, status
        ) VALUES (
          ${generatedId}, ${userRow?.user_id || null}, ${userRow?.member_id || null}, ${data.fullName}, ${dobStr}, ${data.gender}, ${data.fatherName || null}, ${data.motherName || null}, ${data.spouseName || null},
          ${contactStr}, ${data.contact2 || null}, ${data.nationality || 'Indian'}, ${data.residentialStatus || null},
          ${panStr}, ${aadharStr}, ${emailStr}, ${data.occupation || null}, ${data.annualIncome || null}, ${data.education || null},
          ${data.category || null}, ${data.religion || null}, ${isFinal}, ${applicantPhotoPath || null}, ${applicantSignaturePath || null}, ${signDateStr || null},
          ${Boolean(data.termsAccepted)}, NOW(), 'pending'
        )
      `;
    }

    // 3. Insert address: permanent & local
    if (data.permAddress) {
      await tx`
        INSERT INTO associate_address (
          associate_id, address_type, local_address, city, state, country, pin_code
        ) VALUES (
          ${generatedId}, 'permanent', ${data.permAddress}, ${data.permCity || null}, ${data.permState || null}, ${data.permCountry || 'India'}, ${data.permPin || null}
        )
      `;
    }

    if (data.localAddress) {
      await tx`
        INSERT INTO associate_address (
          associate_id, address_type, local_address, city, state, country, pin_code
        ) VALUES (
          ${generatedId}, 'local', ${data.localAddress}, ${data.localCity || null}, ${data.localState || null}, ${data.localCountry || 'India'}, ${data.localPin || null}
        )
      `;
    }

    // 4. Insert bank details
    if (data.bankName || data.accNo || data.ifsc) {
      await tx`
        INSERT INTO associate_bank_details (
          associate_id, bank_name, account_holder_name, account_no, ifsc_code,
          micr_code, branch_name, branch_code, swift_code, branch_country
        ) VALUES (
          ${generatedId}, ${data.bankName || null}, ${data.accHolder || null}, ${data.accNo || null}, ${data.ifsc || null},
          ${data.micr || null}, ${data.branchName || null}, ${data.branchCode || null}, ${data.swift || null}, ${data.branchCountry || 'India'}
        )
      `;
    }

    // 5. Insert nominee details
    if (data.nomineeName) {
      await tx`
        INSERT INTO associate_nominee (
          associate_id, nominee_name, dob, gender, nationality, residential_status,
          relationship, pan_name, pan_no, aadhar_name, aadhar_no, address, photo_path
        ) VALUES (
          ${generatedId}, ${data.nomineeName}, ${nomineeDobStr || null}, ${data.nomineeGender || null},
          ${data.nomineeNationality || 'Indian'}, ${data.nomineeResStatus || null}, ${data.nomineeRelationship || null},
          ${data.nomineePanName || null}, ${data.nomineePanNo || null}, ${data.nomineeAadharName || null},
          ${data.nomineeAadharNo || null}, ${data.nomineeAddress || null}, ${nomineePhotoPath || null}
        )
      `;
    }

    // 6. Insert sponsor details
    if (data.sponsorName || data.sponsorCode) {
      await tx`
        INSERT INTO associate_sponsor (
          associate_id, sponsor_name, sponsor_code, sponsor_contact, signature_path
        ) VALUES (
          ${generatedId}, ${data.sponsorName || null}, ${data.sponsorCode || null}, ${data.sponsorContact || null}, ${sponsorSignaturePath || null}
        )
      `;
    }

    // 7. Sync profile in users table
    try {
      const uidNum = Number(userId) || 0;
      await tx`
        UPDATE users SET
          enrollment_status = COALESCE(enrollment_status, 'Pending'),
          pan_number = COALESCE(NULLIF(${panStr}, ''), pan_number),
          aadhar_number = COALESCE(NULLIF(${aadharStr}, ''), aadhar_number),
          updated_at = NOW()
        WHERE (${uidNum > 0} AND user_id = ${uidNum})
           OR (${contactStr !== ''} AND mobile_no = ${contactStr})
           OR (${emailStr !== null} AND LOWER(email) = ${emailStr || ''})
      `;
    } catch (uErr: any) {
      console.warn("[AssociateEnrollment] User profile update skipped:", uErr.message);
    }
  });

  return { associateId: generatedId };
}
