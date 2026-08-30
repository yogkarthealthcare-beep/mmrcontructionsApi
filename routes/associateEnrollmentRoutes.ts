import express from "express";
import multer from "multer";
import { userAuth } from "../middleware/auth.middleware.js";
import { createAssociateEnrollment, printAssociateEnrollment } from "../controllers/associateEnrollmentController.js";

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
router.post(
  "/associate-enrollment",
  userAuth,
  upload.fields([
    { name: "applicantPhoto", maxCount: 1 },
    { name: "nomineePhoto", maxCount: 1 }
  ]),
  createAssociateEnrollment
);

// GET /api/associate-enrollment/:id/print
router.get(
  "/associate-enrollment/:id/print",
  userAuth,
  printAssociateEnrollment
);

export default router;
