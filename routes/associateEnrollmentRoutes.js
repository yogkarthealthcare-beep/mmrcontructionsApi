import express from "express";
import multer from "multer";
import { userAuth, adminAuth } from "../middleware/auth.middleware.js";
import { 
  createAssociateEnrollment, 
  printAssociateEnrollment,
  getMyAssociateEnrollment,
  adminGetAssociateEnrollments,
  adminGetAssociateEnrollment,
  adminUpdateAssociateEnrollment
} from "../controllers/associateEnrollmentController.js";

const router = express.Router();
// Multer memory storage configuration for file processing
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 5 * 1024 * 1024 // 5 MB limit per photo
    }
});

// POST /api/associate-enrollment
// Authenticated route, handles multipart form uploads
router.post("/associate-enrollment", userAuth, upload.fields([
    { name: "applicantPhoto", maxCount: 1 },
    { name: "nomineePhoto", maxCount: 1 }
]), createAssociateEnrollment);

// GET /api/associate-enrollment/me (Get logged-in associate enrollment)
router.get("/associate-enrollment/me", userAuth, getMyAssociateEnrollment);

// GET /api/associate-enrollment/:id/print
router.get("/associate-enrollment/:id/print", userAuth, printAssociateEnrollment);

// ── Admin Endpoints ──
// GET /api/admin/associate-enrollments (Admin - List all associates with status & search)
router.get("/admin/associate-enrollments", adminAuth, adminGetAssociateEnrollments);

// GET /api/admin/associate-enrollments/:id (Admin - Detail)
router.get("/admin/associate-enrollments/:id", adminAuth, adminGetAssociateEnrollment);

// PUT /api/admin/associate-enrollments/:id (Admin - Full update)
router.put("/admin/associate-enrollments/:id", adminAuth, upload.fields([
    { name: "applicantPhoto", maxCount: 1 },
    { name: "nomineePhoto", maxCount: 1 }
]), adminUpdateAssociateEnrollment);

export default router;
