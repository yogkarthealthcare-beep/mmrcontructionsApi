import { Request, Response } from "express";
import { ZodError } from "zod";
import { saveFileToVPS } from "../services/fileStorage.service.js";
import { associateEnrollmentSchema, registerAssociateEnrollment } from "../services/associateEnrollmentService.js";

/**
 * Controller to handle POST /api/associate-enrollment
 */
export async function createAssociateEnrollment(req: Request, res: Response): Promise<Response> {
  try {
    const userId = (req as any).user?.user_id || (req as any).user?.userId || (req as any).user?.id || null;
    const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;

    // 1. Validate the form body using Zod schema
    const validatedData = associateEnrollmentSchema.parse(req.body);

    // 2. Upload photos via saveFileToVPS if provided
    let applicantPhotoUrl: string | null = null;
    let nomineePhotoUrl: string | null = null;

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

    // 3. Register associate via the service layer
    const result = await registerAssociateEnrollment(
      validatedData,
      applicantPhotoUrl,
      nomineePhotoUrl,
      userId
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
      SELECT u.user_id, u.email, u.mobile_no, u.pan_number, u.aadhar_number, u.full_name
      FROM users u
      WHERE u.user_id = ${userId}
    `;

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const panVal = user.pan_number ? String(user.pan_number).trim().toUpperCase() : null;
    const aadharVal = user.aadhar_number ? String(user.aadhar_number).trim() : null;
    const mobileVal = user.mobile_no ? String(user.mobile_no).trim() : null;
    const emailVal = user.email ? String(user.email).trim().toLowerCase() : null;

    const [enrollment] = await sql`
      SELECT e.*,
             pa.local_address AS perm_address_line1, pa.city AS perm_city, pa.state AS perm_state, pa.country AS perm_country, pa.pin_code AS perm_pincode,
             la.local_address AS local_address_line1, la.city AS local_city, la.state AS local_state, la.country AS local_country, la.pin_code AS local_pincode,
             b.bank_name, b.account_holder_name, b.account_no AS account_number, b.ifsc_code, b.micr_code, b.branch_name, b.branch_code, b.swift_code, b.branch_country,
             n.nominee_name, n.dob AS nominee_dob, n.gender AS nominee_gender, n.nationality AS nominee_nationality, n.residential_status AS nominee_res_status,
             n.relationship AS nominee_relationship, n.pan_name AS nominee_pan_name, n.pan_no AS nominee_pan_no, n.aadhar_name AS nominee_aadhar_name,
             n.aadhar_no AS nominee_aadhar_no, n.address AS nominee_address, n.photo_path AS nominee_photo_url,
             sp.sponsor_name, sp.sponsor_code, sp.sponsor_contact
      FROM associate_enrollment e
      LEFT JOIN associate_address pa      ON e.id = pa.associate_id AND pa.address_type = 'permanent'
      LEFT JOIN associate_address la      ON e.id = la.associate_id AND la.address_type = 'local'
      LEFT JOIN associate_bank_details b  ON e.id = b.associate_id
      LEFT JOIN associate_nominee n       ON e.id = n.associate_id
      LEFT JOIN associate_sponsor sp      ON e.id = sp.associate_id
      WHERE (
        (${panVal !== null} AND UPPER(e.pan_no) = ${panVal || ''})
        OR (${aadharVal !== null} AND e.aadhar_no = ${aadharVal || ''})
        OR (${mobileVal !== null} AND e.contact_no_1 = ${mobileVal || ''})
        OR (${emailVal !== null} AND LOWER(e.email) = ${emailVal || ''})
      )
      ORDER BY e.created_at DESC
      LIMIT 1
    `;

    if (!enrollment) {
      return res.status(200).json({ success: true, data: null });
    }

    return res.status(200).json({
      success: true,
      data: {
        associate_id: enrollment.id,
        associateId: enrollment.id,
        full_name: enrollment.full_name,
        dob: enrollment.dob,
        gender: enrollment.gender,
        father_name: enrollment.father_name,
        mother_name: enrollment.mother_name,
        spouse_name: enrollment.spouse_name,
        contact_primary: enrollment.contact_no_1,
        contact_secondary: enrollment.contact_no_2,
        nationality: enrollment.nationality,
        residential_status: enrollment.residential_status,
        pan_number: enrollment.pan_no,
        aadhar_number: enrollment.aadhar_no,
        email: enrollment.email,
        occupation: enrollment.occupation,
        annual_income: enrollment.annual_income,
        education: enrollment.education,
        category: enrollment.category,
        religion: enrollment.religion,
        applicant_photo_url: enrollment.applicant_photo_path,
        sign_date: enrollment.sign_date,
        status: enrollment.status,
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
        sponsor_name: enrollment.sponsor_name,
        sponsor_code: enrollment.sponsor_code,
        sponsor_contact: enrollment.sponsor_contact
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
          COALESCE(e.created_at, u.registered_at) AS created_at,
          e.sign_date,
          COALESCE(e.status, 'Pending') AS app_status,
          CASE WHEN e.id IS NOT NULL THEN 'Completed' ELSE COALESCE(u.enrollment_status, 'Pending') END AS enrollment_status
        FROM users u
        LEFT JOIN users sp ON u.sponsor_user_id = sp.user_id
        LEFT JOIN associate_enrollment e ON (
          (u.pan_number IS NOT NULL AND UPPER(e.pan_no) = UPPER(u.pan_number))
          OR (u.aadhar_number IS NOT NULL AND e.aadhar_no = u.aadhar_number)
          OR (u.mobile_no IS NOT NULL AND e.contact_no_1 = u.mobile_no)
          OR (u.email IS NOT NULL AND LOWER(e.email) = LOWER(u.email))
          OR e.id = u.member_id
        )
        LEFT JOIN associate_address pa ON e.id = pa.associate_id AND pa.address_type = 'permanent'
        LEFT JOIN associate_sponsor asp ON e.id = asp.associate_id
        WHERE u.user_type = 'Associate'
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
          COALESCE(e.created_at, u.registered_at) AS created_at,
          e.sign_date,
          COALESCE(e.status, 'Pending') AS app_status,
          CASE WHEN e.id IS NOT NULL THEN 'Completed' ELSE COALESCE(u.enrollment_status, 'Pending') END AS enrollment_status
        FROM users u
        LEFT JOIN users sp ON u.sponsor_user_id = sp.user_id
        LEFT JOIN associate_enrollment e ON (
          (u.pan_number IS NOT NULL AND UPPER(e.pan_no) = UPPER(u.pan_number))
          OR (u.aadhar_number IS NOT NULL AND e.aadhar_no = u.aadhar_number)
          OR (u.mobile_no IS NOT NULL AND e.contact_no_1 = u.mobile_no)
          OR (u.email IS NOT NULL AND LOWER(e.email) = LOWER(u.email))
          OR e.id = u.member_id
        )
        LEFT JOIN associate_address pa ON e.id = pa.associate_id AND pa.address_type = 'permanent'
        LEFT JOIN associate_sponsor asp ON e.id = asp.associate_id
        WHERE u.user_type = 'Associate'
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

    let [enrollment] = await sql`
      SELECT e.*,
             pa.local_address AS perm_address_line1, pa.city AS perm_city, pa.state AS perm_state, pa.country AS perm_country, pa.pin_code AS perm_pincode,
             la.local_address AS local_address_line1, la.city AS local_city, la.state AS local_state, la.country AS local_country, la.pin_code AS local_pincode,
             b.bank_name, b.account_holder_name, b.account_no AS account_number, b.ifsc_code, b.micr_code, b.branch_name, b.branch_code, b.swift_code, b.branch_country,
             n.nominee_name, n.dob AS nominee_dob, n.gender AS nominee_gender, n.nationality AS nominee_nationality, n.residential_status AS nominee_res_status,
             n.relationship AS nominee_relationship, n.pan_name AS nominee_pan_name, n.pan_no AS nominee_pan_no, n.aadhar_name AS nominee_aadhar_name,
             n.aadhar_no AS nominee_aadhar_no, n.address AS nominee_address, n.photo_path AS nominee_photo_url,
             sp.sponsor_name, sp.sponsor_code, sp.sponsor_contact
      FROM associate_enrollment e
      LEFT JOIN associate_address pa      ON e.id = pa.associate_id AND pa.address_type = 'permanent'
      LEFT JOIN associate_address la      ON e.id = la.associate_id AND la.address_type = 'local'
      LEFT JOIN associate_bank_details b  ON e.id = b.associate_id
      LEFT JOIN associate_nominee n       ON e.id = n.associate_id
      LEFT JOIN associate_sponsor sp      ON e.id = sp.associate_id
      WHERE e.id = ${rawId}
         OR e.pan_no = ${rawId}
         OR e.aadhar_no = ${rawId}
         OR e.contact_no_1 = ${rawId}
      LIMIT 1
    `;

    if (!enrollment && !isNaN(numId) && numId > 0) {
      const [user] = await sql`
        SELECT u.user_id, u.full_name, u.email, u.mobile_no, u.member_id, u.date_of_birth, u.gender, u.father_name, u.mother_name, u.pan_number, u.aadhar_number,
               sp.member_id as sponsor_id, sp.full_name as sponsor_name, sp.mobile_no as sponsor_contact
        FROM users u
        LEFT JOIN users sp ON u.sponsor_user_id = sp.user_id
        WHERE u.user_id = ${numId}
      `;
      if (user) {
        return res.status(200).json({
          success: true,
          data: {
            user_id: user.user_id,
            associate_id: user.member_id || `ASC-${user.user_id}`,
            full_name: user.full_name,
            dob: user.date_of_birth,
            gender: user.gender,
            father_name: user.father_name,
            mother_name: user.mother_name,
            contact_primary: user.mobile_no,
            contact_1: user.mobile_no,
            contact_no_1: user.mobile_no,
            pan_no: user.pan_number,
            pan_number: user.pan_number,
            aadhar_no: user.aadhar_number,
            aadhar_number: user.aadhar_number,
            email: user.email,
            sponsor_name: user.sponsor_name,
            sponsor_code: user.sponsor_id,
            sponsor_contact: user.sponsor_contact,
            enrollment_status: 'Pending'
          }
        });
      }
    }

    if (!enrollment) {
      return res.status(404).json({ success: false, message: "Associate enrollment not found." });
    }

    return res.status(200).json({
      success: true,
      data: {
        associate_id: enrollment.id,
        associateId: enrollment.id,
        id: enrollment.id,
        full_name: enrollment.full_name,
        dob: enrollment.dob,
        gender: enrollment.gender,
        father_name: enrollment.father_name,
        mother_name: enrollment.mother_name,
        spouse_name: enrollment.spouse_name,
        contact_primary: enrollment.contact_no_1,
        contact_1: enrollment.contact_no_1,
        contact_no_1: enrollment.contact_no_1,
        contact_secondary: enrollment.contact_no_2,
        contact_no_2: enrollment.contact_no_2,
        nationality: enrollment.nationality,
        residential_status: enrollment.residential_status,
        pan_number: enrollment.pan_no,
        pan_no: enrollment.pan_no,
        aadhar_number: enrollment.aadhar_no,
        aadhar_no: enrollment.aadhar_no,
        email: enrollment.email,
        occupation: enrollment.occupation,
        annual_income: enrollment.annual_income,
        education: enrollment.education,
        category: enrollment.category,
        religion: enrollment.religion,
        applicant_photo_url: enrollment.applicant_photo_path,
        sign_date: enrollment.sign_date,
        status: enrollment.status,
        enrollment_status: 'Completed',
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
        sponsor_name: enrollment.sponsor_name,
        sponsor_code: enrollment.sponsor_code,
        sponsor_contact: enrollment.sponsor_contact
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

    let targetId = rawId;
    const [existing] = await sql`SELECT * FROM associate_enrollment WHERE id = ${rawId}`;

    if (existing) {
      await sql.begin(async (tx: any) => {
        await tx`
          UPDATE associate_enrollment SET
            full_name = COALESCE(${b.full_name || b.fullName}, full_name),
            dob = COALESCE(${b.dob}, dob),
            gender = COALESCE(${b.gender}, gender),
            father_name = ${b.father_name || b.fatherName || existing.father_name},
            mother_name = ${b.mother_name || b.motherName || existing.mother_name},
            spouse_name = ${b.spouse_name || b.spouseName || existing.spouse_name},
            contact_no_1 = COALESCE(${b.contact_primary || b.contact_1 || b.contact1 || b.contact_no_1}, contact_no_1),
            contact_no_2 = ${b.contact_secondary || b.contact_2 || b.contact2 || b.contact_no_2 || existing.contact_no_2},
            nationality = COALESCE(${b.nationality}, nationality),
            residential_status = ${b.residential_status || b.residentialStatus || existing.residential_status},
            pan_no = COALESCE(${b.pan_number || b.pan_no || b.panNo}, pan_no),
            aadhar_no = COALESCE(${b.aadhar_number || b.aadhar_no || b.aadharNo}, aadhar_no),
            email = ${b.email || existing.email},
            occupation = ${b.occupation || existing.occupation},
            annual_income = ${b.annual_income || b.annualIncome || existing.annual_income},
            education = ${b.education || existing.education},
            category = ${b.category || existing.category},
            religion = ${b.religion || existing.religion},
            sign_date = COALESCE(${b.sign_date || b.signDate}, sign_date),
            status = COALESCE(${b.status || b.app_status}, status)
          WHERE id = ${rawId}
        `;

        const [permAddr] = await tx`SELECT id FROM associate_address WHERE associate_id = ${rawId} AND address_type = 'permanent'`;
        if (permAddr) {
          await tx`
            UPDATE associate_address SET
              local_address = COALESCE(${b.perm_address_line1 || b.permAddress}, local_address),
              city = COALESCE(${b.perm_city || b.permCity}, city),
              state = COALESCE(${b.perm_state || b.permState}, state),
              country = COALESCE(${b.perm_country || b.permCountry}, country),
              pin_code = COALESCE(${b.perm_pincode || b.permPin}, pin_code)
            WHERE id = ${permAddr.id}
          `;
        } else if (b.perm_address_line1 || b.permAddress || b.perm_city || b.perm_state) {
          await tx`
            INSERT INTO associate_address (associate_id, address_type, local_address, city, state, country, pin_code)
            VALUES (${rawId}, 'permanent', ${b.perm_address_line1 || b.permAddress || ''}, ${b.perm_city || b.permCity || ''}, ${b.perm_state || b.permState || ''}, ${b.perm_country || b.permCountry || 'India'}, ${b.perm_pincode || b.permPin || ''})
          `;
        }

        const [bank] = await tx`SELECT id FROM associate_bank_details WHERE associate_id = ${rawId}`;
        if (bank) {
          await tx`
            UPDATE associate_bank_details SET
              bank_name = COALESCE(${b.bank_name || b.bankName}, bank_name),
              account_holder_name = COALESCE(${b.account_holder_name || b.accHolder}, account_holder_name),
              account_no = COALESCE(${b.account_number || b.accNo}, account_no),
              ifsc_code = COALESCE(${b.ifsc_code || b.ifsc}, ifsc_code),
              micr_code = ${b.micr_code || b.micr || bank.micr_code},
              branch_name = COALESCE(${b.branch_name || b.branchName}, branch_name),
              branch_code = COALESCE(${b.branch_code || b.branchCode}, branch_code),
              swift_code = ${b.swift_code || b.swift || bank.swift_code},
              branch_country = COALESCE(${b.branch_country || b.branchCountry}, branch_country)
            WHERE id = ${bank.id}
          `;
        } else if (b.bank_name || b.bankName || b.account_number || b.accNo || b.ifsc_code || b.ifsc) {
          await tx`
            INSERT INTO associate_bank_details (associate_id, bank_name, account_holder_name, account_no, ifsc_code, micr_code, branch_name, branch_code, swift_code, branch_country)
            VALUES (${rawId}, ${b.bank_name || b.bankName || ''}, ${b.account_holder_name || b.accHolder || ''}, ${b.account_number || b.accNo || ''}, ${b.ifsc_code || b.ifsc || ''}, ${b.micr_code || b.micr || null}, ${b.branch_name || b.branchName || null}, ${b.branch_code || b.branchCode || null}, ${b.swift_code || b.swift || null}, ${b.branch_country || b.branchCountry || 'India'})
          `;
        }

        const [nominee] = await tx`SELECT id FROM associate_nominee WHERE associate_id = ${rawId}`;
        if (nominee) {
          await tx`
            UPDATE associate_nominee SET
              nominee_name = COALESCE(${b.nominee_name || b.nomineeName}, nominee_name),
              dob = ${b.nominee_dob || b.nomineeDob || nominee.dob},
              gender = COALESCE(${b.nominee_gender || b.nomineeGender}, gender),
              relationship = COALESCE(${b.nominee_relationship || b.nomineeRelationship}, relationship),
              pan_no = ${b.nominee_pan_no || b.nomineePanNo || nominee.pan_no},
              aadhar_no = ${b.nominee_aadhar_no || b.nomineeAadharNo || nominee.aadhar_no},
              address = ${b.nominee_address || b.nomineeAddress || nominee.address}
            WHERE id = ${nominee.id}
          `;
        } else if (b.nominee_name || b.nomineeName) {
          await tx`
            INSERT INTO associate_nominee (associate_id, nominee_name, dob, gender, nationality, residential_status, relationship, pan_name, pan_no, aadhar_name, aadhar_no, address)
            VALUES (${rawId}, ${b.nominee_name || b.nomineeName}, ${b.nominee_dob || b.nomineeDob || null}, ${b.nominee_gender || b.nomineeGender || 'Male'}, ${b.nominee_nationality || 'Indian'}, ${b.nominee_res_status || 'Resident'}, ${b.nominee_relationship || 'Nominee'}, ${b.nominee_pan_name || null}, ${b.nominee_pan_no || null}, ${b.nominee_aadhar_name || null}, ${b.nominee_aadhar_no || null}, ${b.nominee_address || null})
          `;
        }

        const [sponsor] = await tx`SELECT id FROM associate_sponsor WHERE associate_id = ${rawId}`;
        if (sponsor) {
          await tx`
            UPDATE associate_sponsor SET
              sponsor_name = COALESCE(${b.sponsor_name || b.sponsorName}, sponsor_name),
              sponsor_code = COALESCE(${b.sponsor_code || b.sponsorCode}, sponsor_code),
              sponsor_contact = ${b.sponsor_contact || b.sponsorContact || sponsor.sponsor_contact}
            WHERE id = ${sponsor.id}
          `;
        } else if (b.sponsor_name || b.sponsor_code) {
          await tx`
            INSERT INTO associate_sponsor (associate_id, sponsor_name, sponsor_code, sponsor_contact)
            VALUES (${rawId}, ${b.sponsor_name || b.sponsorName || ''}, ${b.sponsor_code || b.sponsorCode || ''}, ${b.sponsor_contact || b.sponsorContact || null})
          `;
        }
      });
    } else {
      const year = new Date().getFullYear();
      let generatedId = "";
      await sql.begin(async (tx: any) => {
        const [countResult] = await tx`SELECT COUNT(*)::integer as cnt FROM associate_enrollment WHERE id LIKE ${`MMR-ASC-${year}-%`}`;
        const count = (countResult?.cnt || 0) + 1;
        generatedId = `MMR-ASC-${year}-${String(count).padStart(4, "0")}`;

        await tx`
          INSERT INTO associate_enrollment (
            id, full_name, dob, gender, father_name, mother_name, spouse_name,
            contact_no_1, contact_no_2, nationality, residential_status,
            pan_no, aadhar_no, email, occupation, annual_income, education,
            category, religion, applicant_photo_path, sign_date,
            terms_accepted, terms_accepted_at, status
          ) VALUES (
            ${generatedId}, ${b.full_name || b.fullName || 'Associate'}, ${b.dob || '1990-01-01'}, ${b.gender || 'Male'}, ${b.father_name || b.fatherName || null}, ${b.mother_name || b.motherName || null}, ${b.spouse_name || b.spouseName || null},
            ${b.contact_primary || b.contact_1 || b.contact1 || b.contact_no_1 || '0000000000'}, ${b.contact_secondary || b.contact_2 || b.contact2 || b.contact_no_2 || null}, ${b.nationality || 'Indian'}, ${b.residential_status || b.residentialStatus || null},
            ${(b.pan_number || b.pan_no || b.panNo || 'PAN0000000').toUpperCase()}, ${b.aadhar_number || b.aadhar_no || b.aadharNo || '000000000000'}, ${b.email || null}, ${b.occupation || null}, ${b.annual_income || b.annualIncome || null}, ${b.education || null},
            ${b.category || null}, ${b.religion || null}, ${b.applicant_photo_url || null}, ${b.sign_date || b.signDate || null},
            true, NOW(), 'Completed'
          )
        `;

        if (b.perm_address_line1 || b.permAddress) {
          await tx`
            INSERT INTO associate_address (associate_id, address_type, local_address, city, state, country, pin_code)
            VALUES (${generatedId}, 'permanent', ${b.perm_address_line1 || b.permAddress || ''}, ${b.perm_city || b.permCity || ''}, ${b.perm_state || b.permState || ''}, ${b.perm_country || b.permCountry || 'India'}, ${b.perm_pincode || b.permPin || ''})
          `;
        }

        if (b.bank_name || b.bankName) {
          await tx`
            INSERT INTO associate_bank_details (associate_id, bank_name, account_holder_name, account_no, ifsc_code, micr_code, branch_name, branch_code, swift_code, branch_country)
            VALUES (${generatedId}, ${b.bank_name || b.bankName || ''}, ${b.account_holder_name || b.accHolder || ''}, ${b.account_number || b.accNo || ''}, ${b.ifsc_code || b.ifsc || ''}, ${b.micr_code || b.micr || null}, ${b.branch_name || b.branchName || null}, ${b.branch_code || b.branchCode || null}, ${b.swift_code || b.swift || null}, ${b.branch_country || b.branchCountry || 'India'})
          `;
        }

        if (b.nominee_name || b.nomineeName) {
          await tx`
            INSERT INTO associate_nominee (associate_id, nominee_name, dob, gender, nationality, residential_status, relationship, pan_name, pan_no, aadhar_name, aadhar_no, address)
            VALUES (${generatedId}, ${b.nominee_name || b.nomineeName}, ${b.nominee_dob || b.nomineeDob || null}, ${b.nominee_gender || b.nomineeGender || 'Male'}, ${b.nominee_nationality || 'Indian'}, ${b.nominee_res_status || 'Resident'}, ${b.nominee_relationship || 'Nominee'}, ${b.nominee_pan_name || null}, ${b.nominee_pan_no || null}, ${b.nominee_aadhar_name || null}, ${b.nominee_aadhar_no || null}, ${b.nominee_address || null})
          `;
        }

        if (b.sponsor_name || b.sponsor_code) {
          await tx`
            INSERT INTO associate_sponsor (associate_id, sponsor_name, sponsor_code, sponsor_contact)
            VALUES (${generatedId}, ${b.sponsor_name || b.sponsorName || ''}, ${b.sponsor_code || b.sponsorCode || ''}, ${b.sponsor_contact || b.sponsorContact || null})
          `;
        }

        targetId = generatedId;
      });
    }

    const pan = b.pan_number || b.pan_no || b.panNo;
    const aadhar = b.aadhar_number || b.aadhar_no || b.aadharNo;
    const phone = b.contact_primary || b.contact_1 || b.contact_no_1;
    if (pan || aadhar || phone) {
      await sql`
        UPDATE users SET enrollment_status = 'Completed'
        WHERE (pan_number IS NOT NULL AND UPPER(pan_number) = UPPER(${pan || ''}))
           OR (aadhar_number IS NOT NULL AND aadhar_number = ${aadhar || ''})
           OR (mobile_no IS NOT NULL AND mobile_no = ${phone || ''})
      `;
    }

    return res.status(200).json({
      success: true,
      message: "Associate enrollment updated successfully.",
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
    await sql.begin(async (tx: any) => {
      await tx`DELETE FROM associate_address WHERE associate_id = ${rawId}`;
      await tx`DELETE FROM associate_bank_details WHERE associate_id = ${rawId}`;
      await tx`DELETE FROM associate_nominee WHERE associate_id = ${rawId}`;
      await tx`DELETE FROM associate_sponsor WHERE associate_id = ${rawId}`;
      await tx`DELETE FROM associate_enrollment WHERE id = ${rawId}`;
    });
    return res.status(200).json({ success: true, message: "Associate enrollment deleted successfully." });
  } catch (error: any) {
    console.error("[deleteAdminAssociateEnrollment Error]:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
}

