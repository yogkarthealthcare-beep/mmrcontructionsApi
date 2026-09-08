import { ZodError } from "zod";
import { saveFileToVPS } from "../services/fileStorage.service.js";
import { associateEnrollmentSchema, registerAssociateEnrollment } from "../services/associateEnrollmentService.js";
/**
 * Controller to handle POST /api/associate-enrollment
 */
export async function createAssociateEnrollment(req, res) {
    try {
        const userId = req.user?.user_id || "guest";
        const files = req.files;
        // 1. Validate the form body using Zod schema
        const validatedData = associateEnrollmentSchema.parse(req.body);
        // 2. Upload photos via saveFileToVPS if provided
        let applicantPhotoUrl = null;
        let nomineePhotoUrl = null;
        const applicantFile = files?.["applicantPhoto"]?.[0];
        if (applicantFile) {
            const uploadResult = await saveFileToVPS(applicantFile.buffer, {
                originalName: applicantFile.originalname,
                module: "associate",
                entityId: userId.toString(),
                subCategory: "enrollments"
            });
            applicantPhotoUrl = uploadResult.url;
        }
        const nomineeFile = files?.["nomineePhoto"]?.[0];
        if (nomineeFile) {
            const uploadResult = await saveFileToVPS(nomineeFile.buffer, {
                originalName: nomineeFile.originalname,
                module: "associate",
                entityId: userId.toString(),
                subCategory: "enrollments"
            });
            nomineePhotoUrl = uploadResult.url;
        }
        // 3. Register associate via the service layer
        const result = await registerAssociateEnrollment(validatedData, applicantPhotoUrl, nomineePhotoUrl);
        return res.status(200).json({
            success: true,
            message: "Associate enrollment submitted successfully.",
            data: {
                associateId: result.associateId
            }
        });
    }
    catch (error) {
        console.error("[AssociateEnrollmentController Error]:", error);
        // Zod validation errors
        if (error instanceof ZodError) {
            const formatErrors = error.issues.map((err) => ({
                field: err.path.join("."),
                message: err.message
            }));
            return res.status(400).json({
                success: false,
                message: "Validation failed.",
                errors: formatErrors
            });
        }
        // Database unique constraints (PAN or Aadhar duplicated)
        if (error.code === "23505") {
            let msg = "A record with this PAN or Aadhar number already exists.";
            if (error.detail?.includes("pan_no")) {
                msg = "This PAN number has already been registered.";
            }
            else if (error.detail?.includes("aadhar_no")) {
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
export async function printAssociateEnrollment(req, res) {
    try {
        const id = String(req.params.id);
        // 1. Generate the PDF
        const pdfBuffer = await generateAssociatePdf(id);
        // 2. Query associate row to get the ID and sign_date for naming
        const [associate] = await sql `SELECT id, sign_date FROM associate_enrollment WHERE id = ${id}`;
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
        await sql `
      UPDATE associate_enrollment 
      SET print_pdf_path = ${relativePath} 
      WHERE id = ${id}
    `;
        // 5. Send PDF down as attachment
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
        res.end(pdfBuffer);
    }
    catch (error) {
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
export async function getMyAssociateEnrollment(req, res) {
    try {
        const userId = req.user?.user_id;
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
                (${user.pan_number || null} IS NOT NULL AND UPPER(e.pan_no) = UPPER(${user.pan_number}))
                OR (${user.aadhar_number || null} IS NOT NULL AND e.aadhar_no = ${user.aadhar_number})
                OR (${user.mobile_no || null} IS NOT NULL AND e.contact_no_1 = ${user.mobile_no})
                OR (${user.email || null} IS NOT NULL AND LOWER(e.email) = LOWER(${user.email}))
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
    } catch (error) {
        console.error("[getMyAssociateEnrollment Error]:", error);
        return res.status(500).json({ success: false, message: error.message });
    }
}
