import express from "express";
import multer from "multer";
import { userAuth, adminAuth } from "../middleware/auth.middleware.js";
import { 
    createAssociateEnrollment, 
    printAssociateEnrollment, 
    getMyAssociateEnrollment,
    getAdminAssociateEnrollments,
    getAdminAssociateEnrollmentById,
    updateAdminAssociateEnrollment,
    deleteAdminAssociateEnrollment
} from "../controllers/associateEnrollmentController.js";

const router = express.Router();

// Multer memory storage configuration for file processing
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 5 * 1024 * 1024 // 5 MB limit per photo
    }
});

// Admin Routes for Associate Enrollments
router.get(["/admin/associate-enrollments", "/admin/associate-enrollment"], adminAuth, getAdminAssociateEnrollments);
router.get(["/admin/associate-enrollments/:id", "/admin/associate-enrollment/:id"], adminAuth, getAdminAssociateEnrollmentById);
router.put(["/admin/associate-enrollments/:id", "/admin/associate-enrollment/:id"], adminAuth, updateAdminAssociateEnrollment);
router.delete(["/admin/associate-enrollments/:id", "/admin/associate-enrollment/:id"], adminAuth, deleteAdminAssociateEnrollment);

// User Routes
router.get("/associate-enrollment/me", userAuth, getMyAssociateEnrollment);
router.post("/associate-enrollment", userAuth, upload.fields([
    { name: "applicantPhoto", maxCount: 1 },
    { name: "nomineePhoto", maxCount: 1 }
]), createAssociateEnrollment);
router.get("/associate-enrollment/:id/print", userAuth, printAssociateEnrollment);

export default router;

