import express from "express";
import multer from "multer";
import { userAuth } from "../middleware/auth.middleware.js";
import { getAssociatePrefillController, getAssociateTeamMembersController, getTeamMemberByIdController, createTeamMemberController, updateTeamMemberController, updateTeamMemberStatusController } from "../controllers/teamMemberController.js";
const router = express.Router();
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 5 * 1024 * 1024 // 5MB per file
    },
    fileFilter: (_req, file, cb) => {
        if (file.mimetype.startsWith("image/")) {
            cb(null, true);
        }
        else {
            cb(new Error("Only image files (JPG, PNG, WEBP) are allowed"));
        }
    }
});
const uploadFields = upload.fields([
    { name: "photo", maxCount: 1 },
    { name: "photo_url", maxCount: 1 },
    { name: "applicantSignatureFile", maxCount: 1 },
    { name: "associateSignatureFile", maxCount: 1 }
]);
// 1. Prefill associate info
router.get("/associates/:associateId/prefill", userAuth, getAssociatePrefillController);
// 2. List team members scoped to an associate
router.get("/associates/:associateId/team-members", userAuth, getAssociateTeamMembersController);
// 3. Get single team member record
router.get("/team-members/:id", userAuth, getTeamMemberByIdController);
// 4. Create new team member
router.post("/team-members", userAuth, uploadFields, createTeamMemberController);
// 5. Update team member
router.put("/team-members/:id", userAuth, uploadFields, updateTeamMemberController);
// 6. Approve / reject team member status
router.patch("/team-members/:id/status", userAuth, updateTeamMemberStatusController);
export default router;
