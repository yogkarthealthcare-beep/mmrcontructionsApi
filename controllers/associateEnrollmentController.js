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
