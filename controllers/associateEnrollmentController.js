import { ZodError } from "zod";
import { saveFileToVPS } from "../services/fileStorage.service.js";
import { 
  associateEnrollmentSchema, 
  registerAssociateEnrollment,
  getAssociateEnrollmentByUserId,
  adminListAssociateEnrollments,
  adminGetAssociateEnrollmentById,
  adminUpdateAssociateEnrollment as serviceUpdateAssociateEnrollment
} from "../services/associateEnrollmentService.js";
import { generateAssociatePdf } from "../services/associatePdfService.js";
import sql from "../db.js";
import fs from "fs";
import path from "path";

/**
 * Controller to handle POST /api/associate-enrollment
 */
export async function createAssociateEnrollment(req, res) {
    try {
        const userId = req.user?.user_id || req.user?.id || null;
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
                entityId: userId ? userId.toString() : "guest",
                subCategory: "enrollments"
            });
            applicantPhotoUrl = uploadResult.url;
        }
        const nomineeFile = files?.["nomineePhoto"]?.[0];
        if (nomineeFile) {
            const uploadResult = await saveFileToVPS(nomineeFile.buffer, {
                originalName: nomineeFile.originalname,
                module: "associate",
                entityId: userId ? userId.toString() : "guest",
                subCategory: "enrollments"
            });
            nomineePhotoUrl = uploadResult.url;
        }
        // 3. Register associate via the service layer
        const result = await registerAssociateEnrollment(validatedData, applicantPhotoUrl, nomineePhotoUrl, userId);
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

/**
 * Controller to handle GET /api/associate-enrollment/me
 */
export async function getMyAssociateEnrollment(req, res) {
    try {
        const userId = req.user?.user_id || req.user?.id;
        const mobile = req.user?.mobile_no;
        const email = req.user?.email;

        const enrollment = await getAssociateEnrollmentByUserId(userId, mobile, email);
        if (!enrollment) {
            return res.status(200).json({
                success: true,
                message: "No enrollment found.",
                data: null
            });
        }
        return res.status(200).json({
            success: true,
            data: enrollment
        });
    } catch (error) {
        console.error("[getMyAssociateEnrollment Error]:", error);
        return res.status(500).json({
            success: false,
            message: error.message || "Failed to fetch associate enrollment."
        });
    }
}

/**
 * Controller to handle GET /api/admin/associate-enrollments
 */
export async function adminGetAssociateEnrollments(req, res) {
    try {
        const search = req.query.search || "";
        const rows = await adminListAssociateEnrollments(search);
        return res.status(200).json({
            success: true,
            data: rows
        });
    } catch (error) {
        console.error("[adminGetAssociateEnrollments Error]:", error);
        return res.status(500).json({
            success: false,
            message: error.message || "Failed to fetch associate enrollments."
        });
    }
}

/**
 * Controller to handle GET /api/admin/associate-enrollments/:id
 */
export async function adminGetAssociateEnrollment(req, res) {
    try {
        const { id } = req.params;
        const enrollment = await adminGetAssociateEnrollmentById(id);
        if (!enrollment) {
            return res.status(404).json({
                success: false,
                message: "Associate enrollment not found."
            });
        }
        return res.status(200).json({
            success: true,
            data: enrollment
        });
    } catch (error) {
        console.error("[adminGetAssociateEnrollment Error]:", error);
        return res.status(500).json({
            success: false,
            message: error.message || "Failed to fetch associate enrollment."
        });
    }
}

/**
 * Controller to handle PUT /api/admin/associate-enrollments/:id
 */
export async function adminUpdateAssociateEnrollment(req, res) {
    try {
        const { id } = req.params;
        const files = req.files;
        let applicantPhotoUrl = null;
        let nomineePhotoUrl = null;

        const applicantFile = files?.["applicantPhoto"]?.[0];
        if (applicantFile) {
            const uploadResult = await saveFileToVPS(applicantFile.buffer, {
                originalName: applicantFile.originalname,
                module: "associate",
                entityId: id,
                subCategory: "enrollments"
            });
            applicantPhotoUrl = uploadResult.url;
        }
        const nomineeFile = files?.["nomineePhoto"]?.[0];
        if (nomineeFile) {
            const uploadResult = await saveFileToVPS(nomineeFile.buffer, {
                originalName: nomineeFile.originalname,
                module: "associate",
                entityId: id,
                subCategory: "enrollments"
            });
            nomineePhotoUrl = uploadResult.url;
        }

        const updated = await serviceUpdateAssociateEnrollment(id, req.body, applicantPhotoUrl, nomineePhotoUrl);
        return res.status(200).json({
            success: true,
            message: "Associate enrollment updated successfully.",
            data: updated
        });
    } catch (error) {
        console.error("[adminUpdateAssociateEnrollment Error]:", error);
        return res.status(500).json({
            success: false,
            message: error.message || "Failed to update associate enrollment."
        });
    }
}

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
