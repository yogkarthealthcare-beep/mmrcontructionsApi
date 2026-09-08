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
