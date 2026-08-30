import { z } from "zod";
import sql from "../db.js";

// Validation schema for defense in depth
export const associateEnrollmentSchema = z.object({
  fullName: z.string().min(1, "Full name is required"),
  dob: z.string().min(1, "Date of birth is required"),
  gender: z.string().min(1, "Gender is required"),
  fatherName: z.string().optional().nullable(),
  motherName: z.string().optional().nullable(),
  spouseName: z.string().optional().nullable(),
  contact1: z.string().min(10, "Contact number 1 must be at least 10 digits").max(15),
  contact2: z.string().optional().nullable(),
  nationality: z.string().default("Indian"),
  residentialStatus: z.string().optional().nullable(),
  panNo: z.string().regex(/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/, "Invalid PAN format"),
  aadharNo: z.string().regex(/^[0-9]{12}$/, "Aadhar number must be 12 digits"),
  email: z.string().email("Invalid email format").optional().nullable().or(z.literal("")),
  occupation: z.string().optional().nullable(),
  annualIncome: z.string().optional().nullable(),
  education: z.string().optional().nullable(),
  category: z.string().optional().nullable(),
  religion: z.string().optional().nullable(),
  signDate: z.string().optional().nullable(),
  termsAccepted: z.preprocess(
    (val) => val === "true" || val === true,
    z.boolean().refine((val) => val === true, "All terms must be accepted")
  ),
  
  // Address Details
  permAddress: z.string().optional().nullable(),
  permCity: z.string().optional().nullable(),
  permState: z.string().optional().nullable(),
  permCountry: z.string().default("India"),
  permPin: z.string().optional().nullable(),
  localAddress: z.string().optional().nullable(),
  localCity: z.string().optional().nullable(),
  localState: z.string().optional().nullable(),
  localCountry: z.string().default("India"),
  localPin: z.string().optional().nullable(),

  // Bank Details
  bankName: z.string().optional().nullable(),
  accHolder: z.string().optional().nullable(),
  accNo: z.string().optional().nullable(),
  ifsc: z.string().optional().nullable(),
  micr: z.string().optional().nullable(),
  branchName: z.string().optional().nullable(),
  branchCode: z.string().optional().nullable(),
  swift: z.string().optional().nullable(),
  branchCountry: z.string().default("India"),

  // Nominee Details
  nomineeName: z.string().optional().nullable(),
  nomineeDob: z.string().optional().nullable(),
  nomineeGender: z.string().optional().nullable(),
  nomineeNationality: z.string().default("Indian"),
  nomineeResStatus: z.string().optional().nullable(),
  nomineeRelationship: z.string().optional().nullable(),
  nomineePanName: z.string().optional().nullable(),
  nomineePanNo: z.string().optional().nullable(),
  nomineeAadharName: z.string().optional().nullable(),
  nomineeAadharNo: z.string().optional().nullable(),
  nomineeAddress: z.string().optional().nullable(),

  // Sponsor Details
  sponsorName: z.string().optional().nullable(),
  sponsorCode: z.string().optional().nullable(),
  sponsorContact: z.string().optional().nullable()
});

export type AssociateEnrollmentInput = z.infer<typeof associateEnrollmentSchema>;

interface ServiceResult {
  associateId: string;
}

/**
 * Register a new associate enrollment and related details in a single database transaction.
 */
export async function registerAssociateEnrollment(
  data: AssociateEnrollmentInput,
  applicantPhotoPath: string | null,
  nomineePhotoPath: string | null
): Promise<ServiceResult> {
  const year = new Date().getFullYear();
  let generatedId = "";

  // Perform inside transaction so that failure in any step rolls back everything
  await sql.begin(async (tx: any) => {
    // 1. Generate unique chronological Associate ID
    // Format: MMR-ASC-YYYY-XXXX (where XXXX is a sequential 4-digit number starting at 0001)
    const [countResult] = await tx`
      SELECT COUNT(*)::integer as cnt 
      FROM associate_enrollment 
      WHERE id LIKE ${`MMR-ASC-${year}-%`}
    `;
    const count = (countResult?.cnt || 0) + 1;
    generatedId = `MMR-ASC-${year}-${String(count).padStart(4, "0")}`;

    // 2. Insert master: associate_enrollment
    await tx`
      INSERT INTO associate_enrollment (
        id, full_name, dob, gender, father_name, mother_name, spouse_name,
        contact_no_1, contact_no_2, nationality, residential_status,
        pan_no, aadhar_no, email, occupation, annual_income, education,
        category, religion, applicant_photo_path, sign_date,
        terms_accepted, terms_accepted_at, status
      ) VALUES (
        ${generatedId}, ${data.fullName}, ${data.dob}, ${data.gender}, ${data.fatherName || null}, ${data.motherName || null}, ${data.spouseName || null},
        ${data.contact1}, ${data.contact2 || null}, ${data.nationality}, ${data.residentialStatus || null},
        ${data.panNo.toUpperCase()}, ${data.aadharNo}, ${data.email || null}, ${data.occupation || null}, ${data.annualIncome || null}, ${data.education || null},
        ${data.category || null}, ${data.religion || null}, ${applicantPhotoPath}, ${data.signDate || null},
        ${data.termsAccepted}, NOW(), 'pending'
      )
    `;

    // 3. Insert address: permanent & local
    if (data.permAddress) {
      await tx`
        INSERT INTO associate_address (
          associate_id, address_type, local_address, city, state, country, pin_code
        ) VALUES (
          ${generatedId}, 'permanent', ${data.permAddress}, ${data.permCity || null}, ${data.permState || null}, ${data.permCountry}, ${data.permPin || null}
        )
      `;
    }

    if (data.localAddress) {
      await tx`
        INSERT INTO associate_address (
          associate_id, address_type, local_address, city, state, country, pin_code
        ) VALUES (
          ${generatedId}, 'local', ${data.localAddress}, ${data.localCity || null}, ${data.localState || null}, ${data.localCountry}, ${data.localPin || null}
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
          ${data.micr || null}, ${data.branchName || null}, ${data.branchCode || null}, ${data.swift || null}, ${data.branchCountry}
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
          ${generatedId}, ${data.nomineeName}, ${data.nomineeDob || null}, ${data.nomineeGender || null},
          ${data.nomineeNationality}, ${data.nomineeResStatus || null}, ${data.nomineeRelationship || null},
          ${data.nomineePanName || null}, ${data.nomineePanNo || null}, ${data.nomineeAadharName || null},
          ${data.nomineeAadharNo || null}, ${data.nomineeAddress || null}, ${nomineePhotoPath}
        )
      `;
    }

    // 6. Insert sponsor details
    if (data.sponsorName || data.sponsorCode) {
      await tx`
        INSERT INTO associate_sponsor (
          associate_id, sponsor_name, sponsor_code, sponsor_contact
        ) VALUES (
          ${generatedId}, ${data.sponsorName || null}, ${data.sponsorCode || null}, ${data.sponsorContact || null}
        )
      `;
    }
  });

  return { associateId: generatedId };
}
