import { Request, Response } from "express";
import { ZodError } from "zod";
import { saveFileToVPS } from "../services/fileStorage.service.js";
import { associateEnrollmentSchema, registerAssociateEnrollment } from "../services/associateEnrollmentService.js";
import { deleteAssociateProfile } from "../services/profileCleanupService.js";

/**
 * Controller to handle POST /api/associate-enrollment
 */
export async function createAssociateEnrollment(req: Request, res: Response): Promise<Response> {
  try {
    const userId = (req as any).user?.user_id || (req as any).user?.userId || (req as any).user?.id || null;
    const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;

    // 1. Validate the form body using Zod schema
    const validatedData = associateEnrollmentSchema.parse(req.body);

    // 2. Upload photos and signatures via saveFileToVPS if provided
    let applicantPhotoUrl: string | null = null;
    let nomineePhotoUrl: string | null = null;
    let applicantSignatureUrl: string | null = null;
    let sponsorSignatureUrl: string | null = null;

    const applicantFile = files?.["applicantPhoto"]?.[0];
    if (applicantFile) {
      const uploadResult = await saveFileToVPS(applicantFile.buffer, {
        originalName: applicantFile.originalname,
        module: "associate",
        entityId: (userId || "guest").toString(),
        subCategory: "enrollments"
      });
      applicantPhotoUrl = uploadResult.url;
    }

    const nomineeFile = files?.["nomineePhoto"]?.[0];
    if (nomineeFile) {
      const uploadResult = await saveFileToVPS(nomineeFile.buffer, {
        originalName: nomineeFile.originalname,
        module: "associate",
        entityId: (userId || "guest").toString(),
        subCategory: "enrollments"
      });
      nomineePhotoUrl = uploadResult.url;
    }

    const applicantSignFile = files?.["applicantSignature"]?.[0] || files?.["signature"]?.[0];
    if (applicantSignFile) {
      const uploadResult = await saveFileToVPS(applicantSignFile.buffer, {
        originalName: applicantSignFile.originalname,
        module: "associate",
        entityId: (userId || "guest").toString(),
        subCategory: "signatures"
      });
      applicantSignatureUrl = uploadResult.url;
    }

    const sponsorSignFile = files?.["sponsorSignature"]?.[0];
    if (sponsorSignFile) {
      const uploadResult = await saveFileToVPS(sponsorSignFile.buffer, {
        originalName: sponsorSignFile.originalname,
        module: "associate",
        entityId: (userId || "guest").toString(),
        subCategory: "signatures"
      });
      sponsorSignatureUrl = uploadResult.url;
    }

    // 3. Register associate via the service layer
    const result = await registerAssociateEnrollment(
      validatedData,
      applicantPhotoUrl,
      nomineePhotoUrl,
      userId,
      applicantSignatureUrl,
      sponsorSignatureUrl
    );

    return res.status(200).json({
      success: true,
      message: "Associate enrollment submitted successfully.",
      data: {
        associateId: result.associateId
      }
    });

  } catch (error: any) {
    console.error("[AssociateEnrollmentController Error]:", error);

    if (error.statusCode === 403 || error.status === 403) {
      return res.status(403).json({
        success: false,
        message: error.message || "Enrollment is permanently finalized and cannot be modified."
      });
    }

    // Zod validation errors
    if (error instanceof ZodError) {
      const formatErrors = error.issues.map((err: any) => ({
        field: err.path.join("."),
        message: err.message
      }));
      const detailedMsg = formatErrors.map((e: any) => `${e.field ? e.field + ': ' : ''}${e.message}`).join(', ');
      return res.status(400).json({
        success: false,
        message: detailedMsg ? `Validation failed: ${detailedMsg}` : "Validation failed.",
        errors: formatErrors
      });
    }

    // Database unique constraints (PAN or Aadhar duplicated)
    if (error.code === "23505") {
      let msg = "A record with this PAN or Aadhar number already exists.";
      if (error.detail?.includes("pan_no")) {
        msg = "This PAN number has already been registered.";
      } else if (error.detail?.includes("aadhar_no")) {
        msg = "This Aadhar number has already been registered.";
      }
      return res.status(400).json({
        success: false,
        message: msg
      });
    }

    // General server error
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to submit associate enrollment form."
    });
  }
}

import { generateAssociatePdf } from "../services/associatePdfService.js";
import sql from "../db.js";
import fs from "fs";
import path from "path";

/**
 * Controller to handle GET /api/associate-enrollment/:id/print
 */
export async function printAssociateEnrollment(req: Request, res: Response): Promise<void> {
  try {
    const id = String(req.params.id);

    // 1. Generate the PDF
    const pdfBuffer = await generateAssociatePdf(id);

    // 2. Query associate row to get the ID and sign_date for naming
    const [associate] = await sql`SELECT id, sign_date FROM associate_enrollment WHERE id = ${id}`;
    if (!associate) {
      res.status(404).json({ success: false, message: "Associate not found." });
      return;
    }

    const dateStr = associate.sign_date 
      ? new Date(associate.sign_date).toISOString().split('T')[0] 
      : new Date().toISOString().split('T')[0];
    const fileName = `MMR-Associate-${associate.id}-${dateStr}.pdf`;

    // 3. Save to disk inside uploads/associate/enrollments/pdfs/
    const dirPath = path.join(process.cwd(), "uploads", "associate", "enrollments", "pdfs");
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
    const filePath = path.join(dirPath, fileName);
    fs.writeFileSync(filePath, pdfBuffer);

    // 4. Update the DB table column print_pdf_path
    const relativePath = `/uploads/associate/enrollments/pdfs/${fileName}`;
    await sql`
      UPDATE associate_enrollment 
      SET print_pdf_path = ${relativePath} 
      WHERE id = ${id}
    `;

    // 5. Send PDF down as attachment
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.end(pdfBuffer);

  } catch (error: any) {
    console.error("[AssociateEnrollmentController Print Error]:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Failed to generate Associate enrollment PDF."
    });
  }
}

/**
 * Controller to handle GET /api/associate-enrollment/me
 */
export async function getMyAssociateEnrollment(req: Request, res: Response): Promise<Response> {
  try {
    const userId = (req as any).user?.user_id || (req as any).user?.id || (req as any).user?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const [user] = await sql`
      SELECT u.user_id, u.member_id, u.email, u.mobile_no, u.pan_number, u.aadhar_number, u.full_name,
             u.date_of_birth, u.gender, u.father_name, u.mother_name, u.spouse_name,
             COALESCE(sp.member_id, sp.invitation_code, 'MMR0001') AS sponsor_code,
             COALESCE(sp.full_name, 'Suraj Kumar Verma') AS sponsor_name,
             COALESCE(sp.mobile_no, '7071951011') AS sponsor_contact
      FROM users u
      LEFT JOIN users sp ON u.sponsor_user_id = sp.user_id
      WHERE u.user_id = ${userId}
    `;

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const panVal = user.pan_number ? String(user.pan_number).trim().toUpperCase() : null;
    const aadharVal = user.aadhar_number ? String(user.aadhar_number).trim() : null;
    const mobileVal = user.mobile_no ? String(user.mobile_no).trim() : null;
    const emailVal = user.email ? String(user.email).trim().toLowerCase() : null;
    const memberIdVal = user.member_id ? String(user.member_id).trim() : null;

    const [enrollment] = await sql`
      SELECT e.*,
             pa.local_address AS perm_address_line1, pa.city AS perm_city, pa.state AS perm_state, pa.country AS perm_country, pa.pin_code AS perm_pincode,
             la.local_address AS local_address_line1, la.city AS local_city, la.state AS local_state, la.country AS local_country, la.pin_code AS local_pincode,
             b.bank_name, b.account_holder_name, b.account_no AS account_number, b.ifsc_code, b.micr_code, b.branch_name, b.branch_code, b.swift_code, b.branch_country,
             n.nominee_name, n.dob AS nominee_dob, n.gender AS nominee_gender, n.nationality AS nominee_nationality, n.residential_status AS nominee_res_status,
             n.relationship AS nominee_relationship, n.pan_name AS nominee_pan_name, n.pan_no AS nominee_pan_no, n.aadhar_name AS nominee_aadhar_name,
             n.aadhar_no AS nominee_aadhar_no, n.address AS nominee_address, n.photo_path AS nominee_photo_url,
             asp.sponsor_name, asp.sponsor_code, asp.sponsor_contact, asp.signature_path AS sponsor_signature_path
      FROM associate_enrollment e
      LEFT JOIN associate_address pa      ON e.id = pa.associate_id AND pa.address_type = 'permanent'
      LEFT JOIN associate_address la      ON e.id = la.associate_id AND la.address_type = 'local'
      LEFT JOIN associate_bank_details b  ON e.id = b.associate_id
      LEFT JOIN associate_nominee n       ON e.id = n.associate_id
      LEFT JOIN associate_sponsor asp     ON e.id = asp.associate_id
      WHERE (
        (${userId !== null && userId !== undefined} AND e.user_id = ${userId})
        OR (${memberIdVal !== null} AND (e.id = ${memberIdVal || ''} OR e.member_id = ${memberIdVal || ''}))
        OR (
          (${panVal !== null && panVal !== ''} AND UPPER(e.pan_no) = ${panVal || ''})
          OR (${aadharVal !== null && aadharVal !== ''} AND e.aadhar_no = ${aadharVal || ''})
          OR (${mobileVal !== null && mobileVal !== ''} AND e.contact_no_1 = ${mobileVal || ''})
          OR (${emailVal !== null && emailVal !== ''} AND LOWER(e.email) = ${emailVal || ''})
        )
      )
      ORDER BY (e.user_id = ${userId}) DESC, e.created_at DESC
      LIMIT 1
    `;

    if (!enrollment) {
      return res.status(200).json({
        success: true,
        data: {
          is_new: true,
          full_name: user.full_name || '',
          contact_primary: user.mobile_no || '',
          contact_1: user.mobile_no || '',
          contact_no_1: user.mobile_no || '',
          contact1: user.mobile_no || '',
          mobile_no: user.mobile_no || '',
          email: user.email || '',
          pan_number: user.pan_number || '',
          pan_no: user.pan_number || '',
          aadhar_number: user.aadhar_number || '',
          aadhar_no: user.aadhar_number || '',
          dob: user.date_of_birth || null,
          gender: user.gender || '',
          father_name: user.father_name || '',
          mother_name: user.mother_name || '',
          spouse_name: user.spouse_name || '',
          sponsor_name: user.sponsor_name || 'Suraj Kumar Verma',
          sponsor_code: user.sponsor_code || 'MMR0001',
          sponsor_contact: user.sponsor_contact || '7071951011'
        }
      });
    }

    const primaryContact = enrollment.contact_no_1 || user.mobile_no || '';

    return res.status(200).json({
      success: true,
      data: {
        associate_id: enrollment.id,
        associateId: enrollment.id,
        full_name: enrollment.full_name || user.full_name || '',
        dob: enrollment.dob || user.date_of_birth || null,
        gender: enrollment.gender || user.gender || '',
        father_name: enrollment.father_name || user.father_name || '',
        mother_name: enrollment.mother_name || user.mother_name || '',
        spouse_name: enrollment.spouse_name || user.spouse_name || '',
        contact_primary: primaryContact,
        contact_1: primaryContact,
        contact_no_1: primaryContact,
        contact1: primaryContact,
        mobile_no: primaryContact,
        contact_secondary: enrollment.contact_no_2 || '',
        contact_2: enrollment.contact_no_2 || '',
        contact2: enrollment.contact_no_2 || '',
        nationality: enrollment.nationality || 'Indian',
        residential_status: enrollment.residential_status || 'Resident Individual',
        pan_number: enrollment.pan_no || user.pan_number || '',
        pan_no: enrollment.pan_no || user.pan_number || '',
        aadhar_number: enrollment.aadhar_no || user.aadhar_number || '',
        aadhar_no: enrollment.aadhar_no || user.aadhar_number || '',
        email: enrollment.email || user.email || '',
        occupation: enrollment.occupation,
        annual_income: enrollment.annual_income,
        education: enrollment.education,
        category: enrollment.category,
        religion: enrollment.religion,
        applicant_photo_url: enrollment.applicant_photo_path,
        signature_url: enrollment.signature_path,
        applicant_signature_url: enrollment.signature_path,
        sign_date: enrollment.sign_date,
        status: enrollment.status,
        is_final_submitted: Boolean(enrollment.is_final_submitted),
        isFinalSubmitted: Boolean(enrollment.is_final_submitted),
        print_pdf_path: enrollment.print_pdf_path,
        perm_address_line1: enrollment.perm_address_line1,
        perm_city: enrollment.perm_city,
        perm_state: enrollment.perm_state,
        perm_country: enrollment.perm_country,
        perm_pincode: enrollment.perm_pincode,
        local_address_line1: enrollment.local_address_line1,
        local_city: enrollment.local_city,
        local_state: enrollment.local_state,
        local_country: enrollment.local_country,
        local_pincode: enrollment.local_pincode,
        bank_name: enrollment.bank_name,
        account_holder_name: enrollment.account_holder_name,
        account_number: enrollment.account_number,
        ifsc_code: enrollment.ifsc_code,
        micr_code: enrollment.micr_code,
        branch_name: enrollment.branch_name,
        branch_code: enrollment.branch_code,
        swift_code: enrollment.swift_code,
        branch_country: enrollment.branch_country,
        nominee_name: enrollment.nominee_name,
        nominee_dob: enrollment.nominee_dob,
        nominee_gender: enrollment.nominee_gender,
        nominee_nationality: enrollment.nominee_nationality,
        nominee_res_status: enrollment.nominee_res_status,
        nominee_relationship: enrollment.nominee_relationship,
        nominee_pan_name: enrollment.nominee_pan_name,
        nominee_pan_no: enrollment.nominee_pan_no,
        nominee_aadhar_name: enrollment.nominee_aadhar_name,
        nominee_aadhar_no: enrollment.nominee_aadhar_no,
        nominee_address: enrollment.nominee_address,
        nominee_photo_url: enrollment.nominee_photo_url,
        sponsor_name: enrollment.sponsor_name || user.sponsor_name || 'Suraj Kumar Verma',
        sponsor_code: enrollment.sponsor_code || user.sponsor_code || 'MMR0001',
        sponsor_contact: enrollment.sponsor_contact || user.sponsor_contact || '7071951011',
        sponsor_signature_url: enrollment.sponsor_signature_path
      }
    });
  } catch (error: any) {
    console.error("[getMyAssociateEnrollment Error]:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
}

/**
 * Controller to handle GET /api/admin/associate-enrollments
 */
export async function getAdminAssociateEnrollments(req: Request, res: Response): Promise<Response> {
  try {
    const search = String(req.query.search || "").trim();
    const status = String(req.query.status || "").trim();

    let rows;
    if (search) {
      const s = `%${search}%`;
      rows = await sql`
        SELECT 
          u.user_id,
          COALESCE(e.full_name, u.full_name) AS full_name,
          COALESCE(e.email, u.email) AS email,
          COALESCE(e.contact_no_1, u.mobile_no) AS mobile_no,
          COALESCE(e.contact_no_1, u.mobile_no) AS contact_1,
          u.member_id,
          COALESCE(e.id, u.member_id) AS associate_id,
          COALESCE(e.id, u.user_id::text) AS id,
          COALESCE(asp.sponsor_code, sp.member_id) AS sponsor_id,
          COALESCE(asp.sponsor_code, sp.member_id) AS sponsor_code,
          COALESCE(asp.sponsor_name, sp.full_name) AS sponsor_name,
          COALESCE(asp.sponsor_contact, sp.mobile_no) AS sponsor_contact,
          COALESCE(e.category, 'General') AS category,
          COALESCE(pa.state, 'Uttar Pradesh') AS perm_state,
          COALESCE(pa.city, 'Kanpur') AS perm_city,
          COALESCE(pa.state, 'Uttar Pradesh') AS state,
          COALESCE(pa.city, 'Kanpur') AS city,
          COALESCE(e.applicant_photo_path, u.profile_image, '') AS applicant_photo_url,
          COALESCE(e.applicant_photo_path, u.profile_image, '') AS profile_image,
          COALESCE(nom.photo_path, '') AS nominee_photo_url,
          COALESCE(e.created_at, u.registered_at) AS created_at,
          e.sign_date,
          COALESCE(e.status, u.enrollment_status, 'Pending') AS app_status,
          COALESCE(
            CASE 
              WHEN LOWER(COALESCE(e.status, '')) IN ('approved', 'completed') THEN 'Completed'
              WHEN LOWER(COALESCE(e.status, '')) IN ('rejected') THEN 'Rejected'
              WHEN LOWER(COALESCE(e.status, '')) IN ('pending', 'under_review', 'submitted') THEN 'Pending'
              ELSE NULL
            END,
            CASE 
              WHEN LOWER(COALESCE(u.enrollment_status, '')) IN ('approved', 'completed') THEN 'Completed'
              WHEN LOWER(COALESCE(u.enrollment_status, '')) IN ('rejected') THEN 'Rejected'
              ELSE 'Pending'
            END
          ) AS enrollment_status
        FROM users u
        LEFT JOIN users sp ON u.sponsor_user_id = sp.user_id
        LEFT JOIN associate_enrollment e ON (
          (u.pan_number IS NOT NULL AND UPPER(e.pan_no) = UPPER(u.pan_number))
          OR (u.aadhar_number IS NOT NULL AND e.aadhar_no = u.aadhar_number)
          OR (u.mobile_no IS NOT NULL AND e.contact_no_1 = u.mobile_no)
          OR (u.email IS NOT NULL AND LOWER(e.email) = LOWER(u.email))
          OR e.id = u.member_id
          OR e.user_id = u.user_id
        )
        LEFT JOIN associate_address pa ON e.id = pa.associate_id AND pa.address_type = 'permanent'
        LEFT JOIN associate_sponsor asp ON e.id = asp.associate_id
        LEFT JOIN associate_nominee nom ON e.id = nom.associate_id
        WHERE u.user_type::text = 'Associate'
          AND (
            u.full_name ILIKE ${s}
            OR u.mobile_no ILIKE ${s}
            OR u.email ILIKE ${s}
            OR u.member_id ILIKE ${s}
            OR e.id ILIKE ${s}
            OR e.full_name ILIKE ${s}
            OR e.pan_no ILIKE ${s}
            OR e.aadhar_no ILIKE ${s}
            OR sp.member_id ILIKE ${s}
            OR asp.sponsor_code ILIKE ${s}
            OR asp.sponsor_name ILIKE ${s}
          )
        ORDER BY COALESCE(e.created_at, u.registered_at) DESC
      `;
    } else {
      rows = await sql`
        SELECT 
          u.user_id,
          COALESCE(e.full_name, u.full_name) AS full_name,
          COALESCE(e.email, u.email) AS email,
          COALESCE(e.contact_no_1, u.mobile_no) AS mobile_no,
          COALESCE(e.contact_no_1, u.mobile_no) AS contact_1,
          u.member_id,
          COALESCE(e.id, u.member_id) AS associate_id,
          COALESCE(e.id, u.user_id::text) AS id,
          COALESCE(asp.sponsor_code, sp.member_id) AS sponsor_id,
          COALESCE(asp.sponsor_code, sp.member_id) AS sponsor_code,
          COALESCE(asp.sponsor_name, sp.full_name) AS sponsor_name,
          COALESCE(asp.sponsor_contact, sp.mobile_no) AS sponsor_contact,
          COALESCE(e.category, 'General') AS category,
          COALESCE(pa.state, 'Uttar Pradesh') AS perm_state,
          COALESCE(pa.city, 'Kanpur') AS perm_city,
          COALESCE(pa.state, 'Uttar Pradesh') AS state,
          COALESCE(pa.city, 'Kanpur') AS city,
          COALESCE(e.applicant_photo_path, u.profile_image, '') AS applicant_photo_url,
          COALESCE(e.applicant_photo_path, u.profile_image, '') AS profile_image,
          COALESCE(nom.photo_path, '') AS nominee_photo_url,
          COALESCE(e.created_at, u.registered_at) AS created_at,
          e.sign_date,
          COALESCE(e.status, u.enrollment_status, 'Pending') AS app_status,
          COALESCE(
            CASE 
              WHEN LOWER(COALESCE(e.status, '')) IN ('approved', 'completed') THEN 'Completed'
              WHEN LOWER(COALESCE(e.status, '')) IN ('rejected') THEN 'Rejected'
              WHEN LOWER(COALESCE(e.status, '')) IN ('pending', 'under_review', 'submitted') THEN 'Pending'
              ELSE NULL
            END,
            CASE 
              WHEN LOWER(COALESCE(u.enrollment_status, '')) IN ('approved', 'completed') THEN 'Completed'
              WHEN LOWER(COALESCE(u.enrollment_status, '')) IN ('rejected') THEN 'Rejected'
              ELSE 'Pending'
            END
          ) AS enrollment_status
        FROM users u
        LEFT JOIN users sp ON u.sponsor_user_id = sp.user_id
        LEFT JOIN associate_enrollment e ON (
          (u.pan_number IS NOT NULL AND UPPER(e.pan_no) = UPPER(u.pan_number))
          OR (u.aadhar_number IS NOT NULL AND e.aadhar_no = u.aadhar_number)
          OR (u.mobile_no IS NOT NULL AND e.contact_no_1 = u.mobile_no)
          OR (u.email IS NOT NULL AND LOWER(e.email) = LOWER(u.email))
          OR e.id = u.member_id
          OR e.user_id = u.user_id
        )
        LEFT JOIN associate_address pa ON e.id = pa.associate_id AND pa.address_type = 'permanent'
        LEFT JOIN associate_sponsor asp ON e.id = asp.associate_id
        LEFT JOIN associate_nominee nom ON e.id = nom.associate_id
        WHERE u.user_type::text = 'Associate'
        ORDER BY COALESCE(e.created_at, u.registered_at) DESC
      `;
    }

    if (status) {
      rows = rows.filter((r: any) => (r.enrollment_status || '').toLowerCase() === status.toLowerCase());
    }

    return res.status(200).json({ success: true, data: rows });
  } catch (error: any) {
    console.error("[getAdminAssociateEnrollments Error]:", error);
    return res.status(500).json({ success: false, message: error.message || "Failed to fetch associate enrollments." });
  }
}

/**
 * Controller to handle GET /api/admin/associate-enrollments/:id
 */
export async function getAdminAssociateEnrollmentById(req: Request, res: Response): Promise<Response> {
  try {
    const rawId = String(req.params.id || "").trim();
    const numId = Number(rawId);

    // 1. Check users table first or in parallel for address, bank, nominee fallback
    const [user] = await sql`
      SELECT u.*,
             sp.member_id as sp_member_id, sp.full_name as sp_name, sp.mobile_no as sp_mobile,
             pa.address_line1 as u_address, pa.city as u_city, pa.state as u_state, pa.pin_code as u_pincode,
             bk.bank_name as u_bank_name, bk.account_holder_name as u_acc_holder, bk.account_number as u_acc_no, bk.ifsc_code as u_ifsc_code, bk.branch_name as u_branch_name,
             nom.nominee_name as u_nom_name, nom.relationship as u_nom_rel
      FROM users u
      LEFT JOIN users sp               ON u.sponsor_user_id = sp.user_id
      LEFT JOIN user_addresses pa      ON u.user_id = pa.user_id AND pa.address_type = 'Permanent'
      LEFT JOIN user_bank_details bk   ON u.user_id = bk.user_id
      LEFT JOIN user_nominees nom      ON u.user_id = nom.user_id
      WHERE u.user_id = ${numId || 0}
         OR u.member_id = ${rawId}
         OR (u.pan_number IS NOT NULL AND UPPER(u.pan_number) = UPPER(${rawId}))
         OR (u.mobile_no IS NOT NULL AND RIGHT(regexp_replace(u.mobile_no, '\\D', '', 'g'), 10) = RIGHT(regexp_replace(${rawId}, '\\D', '', 'g'), 10))
      LIMIT 1
    `;

    // 2. Check associate_enrollment table
    let [enrollment] = await sql`
      SELECT e.*,
             pa.local_address AS perm_address_line1, pa.city AS perm_city, pa.state AS perm_state, pa.country AS perm_country, pa.pin_code AS perm_pincode,
             la.local_address AS local_address_line1, la.city AS local_city, la.state AS local_state, la.country AS local_country, la.pin_code AS local_pincode,
             b.bank_name, b.account_holder_name, b.account_no AS account_number, b.ifsc_code, b.micr_code, b.branch_name, b.branch_code, b.swift_code, b.branch_country,
             n.nominee_name, n.dob AS nominee_dob, n.gender AS nominee_gender, n.nationality AS nominee_nationality, n.residential_status AS nominee_res_status,
             n.relationship AS nominee_relationship, n.pan_name AS nominee_pan_name, n.pan_no AS nominee_pan_no, n.aadhar_name AS nominee_aadhar_name,
             n.aadhar_no AS nominee_aadhar_no, n.address AS nominee_address, n.photo_path AS nominee_photo_url,
             sp.sponsor_name, sp.sponsor_code, sp.sponsor_contact, sp.signature_path AS sponsor_signature_path
      FROM associate_enrollment e
      LEFT JOIN associate_address pa      ON e.id = pa.associate_id AND pa.address_type = 'permanent'
      LEFT JOIN associate_address la      ON e.id = la.associate_id AND la.address_type = 'local'
      LEFT JOIN associate_bank_details b  ON e.id = b.associate_id
      LEFT JOIN associate_nominee n       ON e.id = n.associate_id
      LEFT JOIN associate_sponsor sp      ON e.id = sp.associate_id
      WHERE e.id = ${rawId}
         OR (${Boolean(user)} AND (e.id = ${user?.member_id || ''} OR e.user_id = ${user?.user_id || 0}))
         OR e.pan_no = ${rawId}
         OR e.aadhar_no = ${rawId}
         OR e.contact_no_1 = ${rawId}
      LIMIT 1
    `;

    if (!enrollment && user) {
      const uPermAddress = user.u_address || '';
      const uPermState = user.u_state || 'Uttar Pradesh';
      const uPermCity = user.u_city || 'Kanpur';
      const uPermPin = user.u_pincode || '';

      return res.status(200).json({
        success: true,
        data: {
          user_id: user.user_id,
          associate_id: user.member_id || `MMR-ASC-${String(user.user_id).padStart(4, '0')}`,
          associateId: user.member_id || `MMR-ASC-${String(user.user_id).padStart(4, '0')}`,
          id: user.member_id || user.user_id,
          full_name: user.full_name,
          dob: user.date_of_birth,
          gender: user.gender || 'Male',
          father_name: user.father_name || '',
          mother_name: user.mother_name || '',
          spouse_name: '',
          contact_primary: user.mobile_no,
          contact_1: user.mobile_no,
          contact_no_1: user.mobile_no,
          contact1: user.mobile_no,
          mobile_no: user.mobile_no,
          contact_secondary: '',
          contact_2: '',
          pan_no: user.pan_number || '',
          pan_number: user.pan_number || '',
          aadhar_no: user.aadhar_number || '',
          aadhar_number: user.aadhar_number || '',
          email: user.email || '',
          category: 'General',
          education: 'Intermediate (12th / 10+2)',
          occupation: 'Self Employed',
          annual_income: '₹5,00,000 - ₹10,00,000',
          religion: 'Hindu',
          residential_status: 'Resident Individual',
          perm_address: uPermAddress,
          perm_address_line1: uPermAddress,
          perm_city: uPermCity,
          perm_state: uPermState,
          perm_pincode: uPermPin,
          local_address: uPermAddress,
          local_address_line1: uPermAddress,
          local_city: uPermCity,
          local_state: uPermState,
          local_pincode: uPermPin,
          bank_name: user.u_bank_name || '',
          acc_holder: user.u_acc_holder || user.full_name,
          account_holder_name: user.u_acc_holder || user.full_name,
          acc_no: user.u_acc_no || '',
          account_number: user.u_acc_no || '',
          ifsc: user.u_ifsc_code || '',
          ifsc_code: user.u_ifsc_code || '',
          branch_name: user.u_branch_name || '',
          nominee_name: user.u_nom_name || '',
          nominee_relationship: user.u_nom_rel || '',
          sponsor_name: user.sp_name || '',
          sponsor_code: user.sp_member_id || '',
          sponsor_contact: user.sp_mobile || '',
          applicant_photo_url: user.profile_image || '',
          profile_image: user.profile_image || '',
          nominee_photo_url: '',
          enrollment_status: user.enrollment_status === 'Approved' ? 'Completed' : (user.enrollment_status || 'Pending'),
          status: user.enrollment_status === 'Approved' ? 'approved' : 'pending'
        }
      });
    }

    if (!enrollment) {
      return res.status(404).json({ success: false, message: "Associate enrollment not found." });
    }

    // Merge missing fields from user profile if enrollment row has empty addresses or bank
    const permAddr = enrollment.perm_address_line1 || user?.u_address || '';
    const permCity = enrollment.perm_city || user?.u_city || 'Kanpur';
    const permState = enrollment.perm_state || user?.u_state || 'Uttar Pradesh';
    const permPin = enrollment.perm_pincode || user?.u_pincode || '';
    const localAddr = enrollment.local_address_line1 || permAddr;
    const localCity = enrollment.local_city || permCity;
    const localState = enrollment.local_state || permState;
    const localPin = enrollment.local_pincode || permPin;
    const bankName = enrollment.bank_name || user?.u_bank_name || '';
    const accHolder = enrollment.account_holder_name || user?.u_acc_holder || enrollment.full_name || user?.full_name || '';
    const accNo = enrollment.account_number || user?.u_acc_no || '';
    const ifscCode = enrollment.ifsc_code || user?.u_ifsc_code || '';
    const branchName = enrollment.branch_name || user?.u_branch_name || '';
    const nomName = enrollment.nominee_name || user?.u_nom_name || '';
    const nomRel = enrollment.nominee_relationship || user?.u_nom_rel || '';
    const spName = enrollment.sponsor_name || user?.sp_name || '';
    const spCode = enrollment.sponsor_code || user?.sp_member_id || '';
    const spContact = enrollment.sponsor_contact || user?.sp_mobile || '';

    const isAppr = String(enrollment.status || '').toLowerCase() === 'approved' || String(enrollment.status || '').toLowerCase() === 'completed' || user?.enrollment_status === 'Approved';

    return res.status(200).json({
      success: true,
      data: {
        associate_id: enrollment.id,
        associateId: enrollment.id,
        id: enrollment.id,
        full_name: enrollment.full_name || user?.full_name || '',
        dob: enrollment.dob || user?.date_of_birth || null,
        gender: enrollment.gender || user?.gender || 'Male',
        father_name: enrollment.father_name || user?.father_name || '',
        mother_name: enrollment.mother_name || user?.mother_name || '',
        spouse_name: enrollment.spouse_name || '',
        contact_primary: enrollment.contact_no_1 || user?.mobile_no || '',
        contact_1: enrollment.contact_no_1 || user?.mobile_no || '',
        contact_no_1: enrollment.contact_no_1 || user?.mobile_no || '',
        contact1: enrollment.contact_no_1 || user?.mobile_no || '',
        mobile_no: enrollment.contact_no_1 || user?.mobile_no || '',
        contact_secondary: enrollment.contact_no_2 || '',
        contact_no_2: enrollment.contact_no_2 || '',
        contact_2: enrollment.contact_no_2 || '',
        contact2: enrollment.contact_no_2 || '',
        nationality: enrollment.nationality || 'Indian',
        residential_status: enrollment.residential_status || 'Resident Individual',
        pan_number: enrollment.pan_no || user?.pan_number || '',
        pan_no: enrollment.pan_no || user?.pan_number || '',
        aadhar_number: enrollment.aadhar_no || user?.aadhar_number || '',
        aadhar_no: enrollment.aadhar_no || user?.aadhar_number || '',
        email: enrollment.email || user?.email || '',
        occupation: enrollment.occupation || 'Self Employed',
        annual_income: enrollment.annual_income || '₹5,00,000 - ₹10,00,000',
        education: enrollment.education || 'Intermediate (12th / 10+2)',
        category: enrollment.category || 'General',
        religion: enrollment.religion || 'Hindu',
        applicant_photo_url: enrollment.applicant_photo_path || user?.profile_image || '',
        profile_image: enrollment.applicant_photo_path || user?.profile_image || '',
        signature_url: enrollment.signature_path,
        applicant_signature_url: enrollment.signature_path,
        sign_date: enrollment.sign_date,
        status: isAppr ? 'approved' : (enrollment.status || 'pending'),
        enrollment_status: isAppr ? 'Completed' : (enrollment.status === 'rejected' ? 'Rejected' : 'Pending'),
        print_pdf_path: enrollment.print_pdf_path,
        perm_address: permAddr,
        perm_address_line1: permAddr,
        perm_city: permCity,
        perm_state: permState,
        perm_country: enrollment.perm_country || 'India',
        perm_pincode: permPin,
        local_address: localAddr,
        local_address_line1: localAddr,
        local_city: localCity,
        local_state: localState,
        local_country: enrollment.local_country || 'India',
        local_pincode: localPin,
        bank_name: bankName,
        acc_holder: accHolder,
        account_holder_name: accHolder,
        acc_no: accNo,
        account_number: accNo,
        ifsc: ifscCode,
        ifsc_code: ifscCode,
        micr: enrollment.micr_code || '',
        micr_code: enrollment.micr_code || '',
        branch_name: branchName,
        branch_code: enrollment.branch_code || '',
        swift_code: enrollment.swift_code || '',
        branch_country: enrollment.branch_country || 'India',
        nominee_name: nomName,
        nominee_dob: enrollment.nominee_dob,
        nominee_gender: enrollment.nominee_gender || 'Male',
        nominee_nationality: enrollment.nominee_nationality || 'Indian',
        nominee_res_status: enrollment.nominee_res_status || 'Resident Individual',
        nominee_relationship: nomRel || 'Nominee',
        nominee_pan_name: enrollment.nominee_pan_name,
        nominee_pan_no: enrollment.nominee_pan_no,
        nominee_aadhar_name: enrollment.nominee_aadhar_name,
        nominee_aadhar_no: enrollment.nominee_aadhar_no,
        nominee_address: enrollment.nominee_address || '',
        nominee_photo_url: enrollment.nominee_photo_url || '',
        sponsor_name: spName,
        sponsor_code: spCode,
        sponsor_contact: spContact,
        sponsor_signature_url: enrollment.sponsor_signature_path
      }
    });
  } catch (error: any) {
    console.error("[getAdminAssociateEnrollmentById Error]:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
}

/**
 * Controller to handle PUT /api/admin/associate-enrollments/:id
 */
export async function updateAdminAssociateEnrollment(req: Request, res: Response): Promise<Response> {
  try {
    const rawId = String(req.params.id || "").trim();
    const b = req.body || {};
    const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;

    // 1. Find user if matching
    const [matchedUser] = await sql`
      SELECT * FROM users 
      WHERE user_id = ${Number(rawId) || 0}
         OR member_id = ${rawId}
         OR (pan_number IS NOT NULL AND UPPER(pan_number) = UPPER(${b.pan_no || b.pan_number || ''}))
         OR (mobile_no IS NOT NULL AND mobile_no = ${b.contact_1 || b.mobile_no || b.contact_primary || ''})
      LIMIT 1
    `;

    // 2. Find existing associate_enrollment row
    const [existing] = await sql`
      SELECT * FROM associate_enrollment 
      WHERE id = ${rawId}
         OR (${Boolean(matchedUser)} AND (
             id = ${matchedUser?.member_id || ''}
             OR user_id = ${matchedUser?.user_id || 0}
             OR (pan_no IS NOT NULL AND UPPER(pan_no) = UPPER(${matchedUser?.pan_number || ''}))
             OR (contact_no_1 IS NOT NULL AND contact_no_1 = ${matchedUser?.mobile_no || ''})
         ))
      LIMIT 1
    `;

    const targetId = existing ? existing.id : (matchedUser?.member_id || (rawId.startsWith('MMR-ASC-') ? rawId : `MMR-ASC-${String(matchedUser?.user_id || 1).padStart(4, '0')}`));
    const targetUserId = matchedUser ? matchedUser.user_id : (Number(rawId) || null);

    // 3. Process uploaded files if any
    let applicantPhotoUrl: string | null = null;
    const applicantFile = files?.["applicantPhoto"]?.[0];
    if (applicantFile) {
      const uploadResult = await saveFileToVPS(applicantFile.buffer, {
        originalName: applicantFile.originalname,
        module: "associate",
        entityId: (targetUserId || targetId || "admin").toString(),
        subCategory: "enrollments"
      });
      applicantPhotoUrl = uploadResult.url;
    } else if (b.applicant_photo_url || b.applicant_photo_path) {
      applicantPhotoUrl = b.applicant_photo_url || b.applicant_photo_path;
    }

    let nomineePhotoUrl: string | null = null;
    const nomineeFile = files?.["nomineePhoto"]?.[0];
    if (nomineeFile) {
      const uploadResult = await saveFileToVPS(nomineeFile.buffer, {
        originalName: nomineeFile.originalname,
        module: "associate",
        entityId: (targetUserId || targetId || "admin").toString(),
        subCategory: "enrollments"
      });
      nomineePhotoUrl = uploadResult.url;
    } else if (b.nominee_photo_url || b.nominee_photo_path) {
      nomineePhotoUrl = b.nominee_photo_url || b.nominee_photo_path;
    }

    let applicantSignUrl: string | null = null;
    const applicantSignFile = files?.["applicantSignature"]?.[0] || files?.["signature"]?.[0];
    if (applicantSignFile) {
      const uploadResult = await saveFileToVPS(applicantSignFile.buffer, {
        originalName: applicantSignFile.originalname,
        module: "associate",
        entityId: (targetUserId || targetId || "admin").toString(),
        subCategory: "signatures"
      });
      applicantSignUrl = uploadResult.url;
    } else if (b.signature_url || b.applicant_signature_url) {
      applicantSignUrl = b.signature_url || b.applicant_signature_url;
    }

    let sponsorSignUrl: string | null = null;
    const sponsorSignFile = files?.["sponsorSignature"]?.[0];
    if (sponsorSignFile) {
      const uploadResult = await saveFileToVPS(sponsorSignFile.buffer, {
        originalName: sponsorSignFile.originalname,
        module: "associate",
        entityId: (targetUserId || targetId || "admin").toString(),
        subCategory: "signatures"
      });
      sponsorSignUrl = uploadResult.url;
    } else if (b.sponsor_signature_url) {
      sponsorSignUrl = b.sponsor_signature_url;
    }

    const newStatus = b.status || b.app_status || (b.enrollment_status === 'Completed' ? 'approved' : (b.enrollment_status === 'Rejected' ? 'rejected' : 'pending'));
    const isApproving = newStatus === 'approved' || b.enrollment_status === 'Completed' || b.status === 'Completed' || b.status === 'approved';
    const enrollStatus = isApproving ? 'Completed' : (newStatus === 'rejected' || b.enrollment_status === 'Rejected' ? 'Rejected' : 'Pending');
    const userEnrollStatus = isApproving ? 'Approved' : (newStatus === 'rejected' ? 'Rejected' : 'Pending');

    const fullName = b.full_name || b.fullName || matchedUser?.full_name || existing?.full_name || 'Associate';
    const dob = b.dob || matchedUser?.date_of_birth || existing?.dob || null;
    const gender = b.gender || matchedUser?.gender || existing?.gender || 'Male';
    const fatherName = b.father_name || b.fatherName || matchedUser?.father_name || existing?.father_name || null;
    const motherName = b.mother_name || b.motherName || matchedUser?.mother_name || existing?.mother_name || null;
    const spouseName = b.spouse_name || b.spouseName || existing?.spouse_name || null;
    const contact1 = b.contact_primary || b.contact_1 || b.contact1 || b.contact_no_1 || b.mobile_no || matchedUser?.mobile_no || existing?.contact_no_1 || '';
    const contact2 = b.contact_secondary || b.contact_2 || b.contact2 || b.contact_no_2 || existing?.contact_no_2 || null;
    const nationality = b.nationality || existing?.nationality || 'Indian';
    const residentialStatus = b.residential_status || b.residentialStatus || existing?.residential_status || 'Resident Individual';
    const panNo = (b.pan_number || b.pan_no || b.panNo || matchedUser?.pan_number || existing?.pan_no || '') ? String(b.pan_number || b.pan_no || b.panNo || matchedUser?.pan_number || existing?.pan_no).trim().toUpperCase() : null;
    const aadharNo = (b.aadhar_number || b.aadhar_no || b.aadharNo || matchedUser?.aadhar_number || existing?.aadhar_no || '') ? String(b.aadhar_number || b.aadhar_no || b.aadharNo || matchedUser?.aadhar_number || existing?.aadhar_no).replace(/\s+/g, '').trim() : null;
    const email = b.email || matchedUser?.email || existing?.email || null;
    const occupation = b.occupation || existing?.occupation || 'Self Employed';
    const annualIncome = b.annual_income || b.annualIncome || existing?.annual_income || '₹5,00,000 - ₹10,00,000';
    const education = b.education || existing?.education || 'Intermediate (12th / 10+2)';
    const category = b.category || existing?.category || 'General';
    const religion = b.religion || existing?.religion || 'Hindu';
    const signDate = b.sign_date || b.signDate || existing?.sign_date || new Date().toISOString().split('T')[0];

    // Address fields
    const permLine = b.perm_address_line1 || b.perm_address || b.permAddress || '';
    const permCity = b.perm_city || b.permCity || 'Kanpur';
    const permState = b.perm_state || b.permState || 'Uttar Pradesh';
    const permCountry = b.perm_country || b.permCountry || 'India';
    const permPin = b.perm_pincode || b.permPin || b.perm_pin || '';

    const localLine = b.local_address_line1 || b.local_address || b.localAddress || permLine;
    const localCity = b.local_city || b.localCity || permCity;
    const localState = b.local_state || b.localState || permState;
    const localCountry = b.local_country || b.localCountry || permCountry;
    const localPin = b.local_pincode || b.localPin || b.local_pin || permPin;

    // Bank fields
    const bankName = b.bank_name || b.bankName || '';
    const accHolder = b.account_holder_name || b.accHolder || b.acc_holder || fullName;
    const accNo = b.account_number || b.accNo || b.acc_no || '';
    const ifsc = b.ifsc_code || b.ifsc || '';
    const micr = b.micr_code || b.micr || null;
    const branchName = b.branch_name || b.branchName || null;
    const branchCode = b.branch_code || b.branchCode || null;
    const swift = b.swift_code || b.swift || null;
    const branchCountry = b.branch_country || b.branchCountry || 'India';

    // Nominee fields
    const nomineeName = b.nominee_name || b.nomineeName || null;
    const nomineeDob = b.nominee_dob || b.nomineeDob || null;
    const nomineeGender = b.nominee_gender || b.nomineeGender || 'Male';
    const nomineeRel = b.nominee_relationship || b.nomineeRelationship || 'Nominee';
    const nomineePan = (b.nominee_pan_no || b.nomineePanNo || '') ? String(b.nominee_pan_no || b.nomineePanNo).trim().toUpperCase() : null;
    const nomineeAadhar = (b.nominee_aadhar_no || b.nomineeAadharNo || '') ? String(b.nominee_aadhar_no || b.nomineeAadharNo).replace(/\s+/g, '').trim() : null;
    const nomineeAddress = b.nominee_address || b.nomineeAddress || null;
    const nomineeResStatus = b.nominee_res_status || b.nomineeResStatus || 'Resident Individual';

    // Sponsor fields
    const sponsorName = b.sponsor_name || b.sponsorName || null;
    const sponsorCode = b.sponsor_code || b.sponsorCode || null;
    const sponsorContact = b.sponsor_contact || b.sponsorContact || null;

    await sql.begin(async (tx: any) => {
      if (existing) {
        await tx`
          UPDATE associate_enrollment SET
            full_name = ${fullName},
            dob = ${dob},
            gender = ${gender},
            father_name = ${fatherName},
            mother_name = ${motherName},
            spouse_name = ${spouseName},
            contact_no_1 = ${contact1},
            contact_no_2 = ${contact2},
            nationality = ${nationality},
            residential_status = ${residentialStatus},
            pan_no = ${panNo},
            aadhar_no = ${aadharNo},
            email = ${email},
            occupation = ${occupation},
            annual_income = ${annualIncome},
            education = ${education},
            category = ${category},
            religion = ${religion},
            applicant_photo_path = COALESCE(${applicantPhotoUrl}, applicant_photo_path),
            signature_path = COALESCE(${applicantSignUrl}, signature_path),
            sign_date = ${signDate},
            is_final_submitted = TRUE,
            status = ${isApproving ? 'approved' : newStatus}
          WHERE id = ${existing.id}
        `;
      } else {
        await tx`
          INSERT INTO associate_enrollment (
            id, user_id, member_id, full_name, dob, gender, father_name, mother_name, spouse_name,
            contact_no_1, contact_no_2, nationality, residential_status,
            pan_no, aadhar_no, email, occupation, annual_income, education,
            category, religion, is_final_submitted, applicant_photo_path, signature_path, sign_date, terms_accepted, terms_accepted_at, status
          ) VALUES (
            ${targetId}, ${targetUserId}, ${matchedUser?.member_id || targetId},
            ${fullName}, ${dob}, ${gender}, ${fatherName}, ${motherName}, ${spouseName},
            ${contact1}, ${contact2}, ${nationality}, ${residentialStatus},
            ${panNo}, ${aadharNo}, ${email}, ${occupation}, ${annualIncome}, ${education},
            ${category}, ${religion}, TRUE, ${applicantPhotoUrl}, ${applicantSignUrl}, ${signDate}, TRUE, NOW(), ${isApproving ? 'approved' : newStatus}
          )
        `;
      }

      // Permanent Address
      const [permAddrRow] = await tx`SELECT id FROM associate_address WHERE associate_id = ${targetId} AND address_type = 'permanent' LIMIT 1`;
      if (permAddrRow) {
        await tx`
          UPDATE associate_address SET
            local_address = ${permLine},
            city = ${permCity},
            state = ${permState},
            country = ${permCountry},
            pin_code = ${permPin}
          WHERE id = ${permAddrRow.id}
        `;
      } else if (permLine || permCity || permState) {
        await tx`
          INSERT INTO associate_address (associate_id, address_type, local_address, city, state, country, pin_code)
          VALUES (${targetId}, 'permanent', ${permLine}, ${permCity}, ${permState}, ${permCountry}, ${permPin})
        `;
      }

      // Local Address
      const [localAddrRow] = await tx`SELECT id FROM associate_address WHERE associate_id = ${targetId} AND address_type = 'local' LIMIT 1`;
      if (localAddrRow) {
        await tx`
          UPDATE associate_address SET
            local_address = ${localLine},
            city = ${localCity},
            state = ${localState},
            country = ${localCountry},
            pin_code = ${localPin}
          WHERE id = ${localAddrRow.id}
        `;
      } else if (localLine || localCity || localState) {
        await tx`
          INSERT INTO associate_address (associate_id, address_type, local_address, city, state, country, pin_code)
          VALUES (${targetId}, 'local', ${localLine}, ${localCity}, ${localState}, ${localCountry}, ${localPin})
        `;
      }

      // Bank Details
      const [bankRow] = await tx`SELECT id FROM associate_bank_details WHERE associate_id = ${targetId} LIMIT 1`;
      if (bankRow) {
        await tx`
          UPDATE associate_bank_details SET
            bank_name = ${bankName},
            account_holder_name = ${accHolder},
            account_no = ${accNo},
            ifsc_code = ${ifsc},
            micr_code = ${micr},
            branch_name = ${branchName},
            branch_code = ${branchCode},
            swift_code = ${swift},
            branch_country = ${branchCountry}
          WHERE id = ${bankRow.id}
        `;
      } else if (bankName || accNo || ifsc) {
        await tx`
          INSERT INTO associate_bank_details (associate_id, bank_name, account_holder_name, account_no, ifsc_code, micr_code, branch_name, branch_code, swift_code, branch_country)
          VALUES (${targetId}, ${bankName}, ${accHolder}, ${accNo}, ${ifsc}, ${micr}, ${branchName}, ${branchCode}, ${swift}, ${branchCountry})
        `;
      }

      // Nominee Details
      const [nomRow] = await tx`SELECT id FROM associate_nominee WHERE associate_id = ${targetId} LIMIT 1`;
      if (nomRow) {
        await tx`
          UPDATE associate_nominee SET
            nominee_name = ${nomineeName},
            dob = ${nomineeDob},
            gender = ${nomineeGender},
            residential_status = ${nomineeResStatus},
            relationship = ${nomineeRel},
            pan_no = ${nomineePan},
            aadhar_no = ${nomineeAadhar},
            address = ${nomineeAddress},
            photo_path = COALESCE(${nomineePhotoUrl}, photo_path)
          WHERE id = ${nomRow.id}
        `;
      } else if (nomineeName) {
        await tx`
          INSERT INTO associate_nominee (associate_id, nominee_name, dob, gender, nationality, residential_status, relationship, pan_name, pan_no, aadhar_name, aadhar_no, address, photo_path)
          VALUES (${targetId}, ${nomineeName}, ${nomineeDob}, ${nomineeGender}, 'Indian', ${nomineeResStatus}, ${nomineeRel}, NULL, ${nomineePan}, NULL, ${nomineeAadhar}, ${nomineeAddress}, ${nomineePhotoUrl})
        `;
      }

      // Sponsor Details
      const [spRow] = await tx`SELECT id FROM associate_sponsor WHERE associate_id = ${targetId} LIMIT 1`;
      if (spRow) {
        await tx`
          UPDATE associate_sponsor SET
            sponsor_name = ${sponsorName},
            sponsor_code = ${sponsorCode},
            sponsor_contact = ${sponsorContact},
            signature_path = COALESCE(${sponsorSignUrl}, signature_path)
          WHERE id = ${spRow.id}
        `;
      } else if (sponsorName || sponsorCode) {
        await tx`
          INSERT INTO associate_sponsor (associate_id, sponsor_name, sponsor_code, sponsor_contact, signature_path)
          VALUES (${targetId}, ${sponsorName || ''}, ${sponsorCode || ''}, ${sponsorContact}, ${sponsorSignUrl})
        `;
      }

      // Sync Users table
      if (targetUserId) {
        await tx`
          UPDATE users SET
            enrollment_status = ${userEnrollStatus},
            is_verified = ${isApproving ? true : (newStatus === 'approved' ? true : false)},
            is_active = ${isApproving ? true : (newStatus === 'rejected' ? false : matchedUser?.is_active ?? true)},
            account_status = ${isApproving ? 'Active' : (newStatus === 'rejected' ? 'Suspended' : (matchedUser?.account_status || 'Active'))},
            full_name = COALESCE(${fullName || null}, full_name),
            mobile_no = COALESCE(${contact1 || null}, mobile_no),
            email = COALESCE(${email || null}, email),
            pan_number = COALESCE(${panNo || null}, pan_number),
            aadhar_number = COALESCE(${aadharNo || null}, aadhar_number),
            father_name = COALESCE(${fatherName || null}, father_name),
            mother_name = COALESCE(${motherName || null}, mother_name),
            date_of_birth = COALESCE(${dob || null}, date_of_birth),
            gender = COALESCE(${gender || null}, gender),
            profile_image = COALESCE(${applicantPhotoUrl}, profile_image)
          WHERE user_id = ${targetUserId}
        `;

        // Sync user_addresses (Permanent)
        if (permLine || permCity || permState) {
          const [uAddrRow] = await tx`SELECT address_id FROM user_addresses WHERE user_id = ${targetUserId} AND address_type = 'Permanent' LIMIT 1`;
          if (uAddrRow) {
            await tx`
              UPDATE user_addresses SET
                address_line1 = ${permLine},
                city = ${permCity},
                state = ${permState},
                pin_code = ${permPin}
              WHERE address_id = ${uAddrRow.address_id}
            `;
          } else {
            await tx`
              INSERT INTO user_addresses (user_id, address_type, address_line1, city, state, pin_code)
              VALUES (${targetUserId}, 'Permanent', ${permLine}, ${permCity}, ${permState}, ${permPin})
            `;
          }
        }

        // Sync user_bank_details
        if (bankName || accNo || ifsc) {
          const [uBankRow] = await tx`SELECT bank_detail_id FROM user_bank_details WHERE user_id = ${targetUserId} LIMIT 1`;
          if (uBankRow) {
            await tx`
              UPDATE user_bank_details SET
                bank_name = ${bankName},
                account_holder_name = ${accHolder},
                account_number = ${accNo},
                ifsc_code = ${ifsc},
                branch_name = ${branchName}
              WHERE bank_detail_id = ${uBankRow.bank_detail_id}
            `;
          } else {
            await tx`
              INSERT INTO user_bank_details (user_id, bank_name, account_holder_name, account_number, ifsc_code, branch_name)
              VALUES (${targetUserId}, ${bankName}, ${accHolder}, ${accNo}, ${ifsc}, ${branchName})
            `;
          }
        }
      }
    });

    return res.status(200).json({
      success: true,
      message: isApproving ? "Associate enrollment approved successfully." : "Associate enrollment updated successfully.",
      data: { associate_id: targetId }
    });
  } catch (error: any) {
    console.error("[updateAdminAssociateEnrollment Error]:", error);
    return res.status(500).json({ success: false, message: error.message || "Failed to update associate enrollment." });
  }
}

/**
 * Controller to handle DELETE /api/admin/associate-enrollments/:id
 */
export async function deleteAdminAssociateEnrollment(req: Request, res: Response): Promise<Response> {
  try {
    const rawId = String(req.params.id || "").trim();
    const actor = {
      admin_id: (req as any).admin?.admin_id || (req as any).admin?.id || 1,
      full_name: (req as any).admin?.full_name || (req as any).admin?.username || "Admin"
    };
    const result = await deleteAssociateProfile(rawId, actor);
    return res.status(200).json({ success: true, message: result.message, data: result.data });
  } catch (error: any) {
    console.error("[deleteAdminAssociateEnrollment Error]:", error);
    if (error.message === "Associate not found" || error.statusCode === 404) {
      return res.status(404).json({ success: false, message: error.message });
    }
    return res.status(error.statusCode || 500).json({ success: false, message: error.message || "Failed to delete associate enrollment." });
  }
}

