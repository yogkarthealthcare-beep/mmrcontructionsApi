import { ZodError } from "zod";
import { saveFileToVPS } from "../services/fileStorage.service.js";
import { teamMemberSchema, getAssociatePrefill, createTeamMemberRecord, getTeamMembersByAssociate, getTeamMemberById, updateTeamMemberRecord, updateTeamMemberStatus, finalSubmitTeamMemberRecord } from "../services/teamMemberService.js";
import { generateTeamMemberPdf } from "../services/teamMemberPdfService.js";
/**
 * GET /api/associates/:associateId/prefill
 */
export async function getAssociatePrefillController(req, res) {
    try {
        const requestedAssociateId = Number(req.params.associateId);
        const authUser = req.user;
        const authUserId = authUser?.user_id || authUser?.id;
        if (!requestedAssociateId) {
            return res.status(400).json({
                success: false,
                message: "Valid Associate ID is required in URL path"
            });
        }
        // Ensure users can only prefill their own associate record unless admin
        if (!authUser?.is_admin && authUserId && Number(authUserId) !== requestedAssociateId) {
            return res.status(403).json({
                success: false,
                message: "You are not authorized to view details for this associate"
            });
        }
        const prefillData = await getAssociatePrefill(requestedAssociateId);
        return res.status(200).json({
            success: true,
            message: "Associate prefill data retrieved successfully",
            data: prefillData
        });
    }
    catch (error) {
        console.error("[TeamMemberController Prefill Error]:", error);
        return res.status(500).json({
            success: false,
            message: error.message || "Failed to load associate prefill data"
        });
    }
}
/**
 * GET /api/associates/:associateId/team-members
 */
export async function getAssociateTeamMembersController(req, res) {
    try {
        const associateId = Number(req.params.associateId);
        const authUser = req.user;
        const authUserId = authUser?.user_id || authUser?.id;
        if (!associateId) {
            return res.status(400).json({
                success: false,
                message: "Valid Associate ID is required"
            });
        }
        if (!authUser?.is_admin && authUserId && Number(authUserId) !== associateId) {
            return res.status(403).json({
                success: false,
                message: "You are not authorized to list team members for this associate"
            });
        }
        const { search, status, page, limit } = req.query;
        const result = await getTeamMembersByAssociate(associateId, {
            search: search ? String(search) : undefined,
            status: status ? String(status) : undefined,
            page: page ? Number(page) : 1,
            limit: limit ? Number(limit) : 20
        });
        return res.status(200).json({
            success: true,
            message: "Team members retrieved successfully",
            data: result.items,
            pagination: result.pagination
        });
    }
    catch (error) {
        console.error("[TeamMemberController List Error]:", error);
        return res.status(500).json({
            success: false,
            message: error.message || "Failed to list team members"
        });
    }
}
/**
 * GET /api/team-members/:id
 */
export async function getTeamMemberByIdController(req, res) {
    try {
        const id = String(req.params.id);
        const authUser = req.user;
        const authUserId = authUser?.user_id || authUser?.id;
        const isAdmin = Boolean(authUser?.is_admin || authUser?.role === "SuperAdmin" || authUser?.role === "Admin");
        const record = await getTeamMemberById(id, authUserId, isAdmin);
        if (!record) {
            return res.status(404).json({
                success: false,
                message: "Team member not found"
            });
        }
        return res.status(200).json({
            success: true,
            message: "Team member details retrieved successfully",
            data: record
        });
    }
    catch (error) {
        console.error("[TeamMemberController GetById Error]:", error);
        if (error.message?.includes("Unauthorized")) {
            return res.status(403).json({ success: false, message: error.message });
        }
        return res.status(500).json({
            success: false,
            message: error.message || "Failed to get team member details"
        });
    }
}
/**
 * POST /api/team-members
 */
export async function createTeamMemberController(req, res) {
    try {
        const authUser = req.user;
        const authUserId = authUser?.user_id || authUser?.id;
        // Body may come from JSON or multipart form
        const body = req.body || {};
        // Inject or verify associate_id from JWT if not present
        if (!body.associateId && authUserId) {
            body.associateId = authUserId;
        }
        if (!body.associateName && authUser?.full_name) {
            body.associateName = authUser.full_name;
        }
        // 1. Zod schema validation
        const validatedData = teamMemberSchema.parse(body);
        // Enforce associate isolation
        const isAdmin = Boolean(authUser?.is_admin ||
            authUser?.role === "SuperAdmin" ||
            authUser?.role === "Admin" ||
            authUser?.user_type === "Admin" ||
            authUser?.user_type === "SuperAdmin");
        if (!isAdmin && authUserId && Number(validatedData.associateId) !== Number(authUserId)) {
            return res.status(403).json({
                success: false,
                message: "Cannot enroll team members on behalf of another associate"
            });
        }
        // 2. Handle file uploads if multipart
        const files = req.files;
        let photoUrl = null;
        let applicantSigUrl = null;
        let associateSigUrl = null;
        const photoFile = files?.["photo"]?.[0] || files?.["photo_url"]?.[0];
        if (photoFile) {
            const upload = await saveFileToVPS(photoFile.buffer, {
                originalName: photoFile.originalname,
                module: "team-members",
                entityId: String(validatedData.associateId),
                subCategory: "photos"
            });
            photoUrl = upload.url;
        }
        const applicantSigFile = files?.["applicantSignatureFile"]?.[0] || files?.["applicantSignature"]?.[0];
        if (applicantSigFile) {
            const upload = await saveFileToVPS(applicantSigFile.buffer, {
                originalName: applicantSigFile.originalname,
                module: "team-members",
                entityId: String(validatedData.associateId),
                subCategory: "signatures"
            });
            applicantSigUrl = upload.url;
        }
        const associateSigFile = files?.["associateSignatureFile"]?.[0] || files?.["associateSignature"]?.[0];
        if (associateSigFile) {
            const upload = await saveFileToVPS(associateSigFile.buffer, {
                originalName: associateSigFile.originalname,
                module: "team-members",
                entityId: String(validatedData.associateId),
                subCategory: "signatures"
            });
            associateSigUrl = upload.url;
        }
        // 3. Register Record
        const result = await createTeamMemberRecord(validatedData, photoUrl, applicantSigUrl, associateSigUrl);
        return res.status(201).json({
            success: true,
            message: `Team member enrolled successfully with ID: ${result.team_member_uid}`,
            data: result
        });
    }
    catch (error) {
        console.error("[TeamMemberController Create Error]:", error);
        // Zod validation errors
        if (error instanceof ZodError) {
            const formattedErrors = error.issues.map((err) => ({
                field: err.path.join("."),
                message: err.message
            }));
            return res.status(400).json({
                success: false,
                message: formattedErrors[0]?.message || "Validation failed on submitted data.",
                errors: formattedErrors
            });
        }
        // Postgres unique constraint
        if (error.code === "23505") {
            let msg = "A team member with this Aadhar or PAN number is already registered.";
            if (error.detail?.includes("aadhar_no")) {
                msg = "A team member with this Aadhar Number has already been registered.";
            }
            else if (error.detail?.includes("slot_number") || error.constraint?.includes("uq_team_members_assoc_slot")) {
                msg = "This Associate has already reached the maximum limit of 10 direct Team Members.";
            }
            else if (error.detail?.includes("team_member_uid")) {
                msg = "UID generation collision. Please retry submission.";
            }
            return res.status(400).json({
                success: false,
                message: msg
            });
        }
        if (error.message?.includes("maximum limit of 10") || error.message?.includes("Associate with ID")) {
            return res.status(400).json({
                success: false,
                message: error.message
            });
        }
        return res.status(500).json({
            success: false,
            message: error.message || "Failed to create team member record"
        });
    }
}
/**
 * PUT /api/team-members/:id
 */
export async function updateTeamMemberController(req, res) {
    try {
        const id = String(req.params.id);
        const authUser = req.user;
        const authUserId = authUser?.user_id || authUser?.id;
        const isAdmin = Boolean(authUser?.is_admin || authUser?.role === "SuperAdmin" || authUser?.role === "Admin");
        const body = req.body || {};
        const files = req.files;
        let photoUrl = null;
        let applicantSigUrl = null;
        let associateSigUrl = null;
        const photoFile = files?.["photo"]?.[0] || files?.["photo_url"]?.[0];
        if (photoFile) {
            const upload = await saveFileToVPS(photoFile.buffer, {
                originalName: photoFile.originalname,
                module: "team-members",
                entityId: String(authUserId || "0"),
                subCategory: "photos"
            });
            photoUrl = upload.url;
        }
        const updated = await updateTeamMemberRecord(id, body, photoUrl, applicantSigUrl, associateSigUrl, authUserId, isAdmin);
        return res.status(200).json({
            success: true,
            message: "Team member record updated successfully",
            data: updated
        });
    }
    catch (error) {
        console.error("[TeamMemberController Update Error]:", error);
        const status = error.statusCode || (error.message?.includes("finalized") || error.message?.includes("Unauthorized") ? 403 : 400);
        return res.status(status).json({
            success: false,
            message: error.message || "Failed to update team member record"
        });
    }
}
/**
 * PATCH /api/team-members/:id/status
 */
export async function updateTeamMemberStatusController(req, res) {
    try {
        const id = String(req.params.id);
        const { status, authorizedSignatoryName } = req.body || {};
        if (!["pending", "approved", "rejected"].includes(status)) {
            return res.status(400).json({
                success: false,
                message: "Status must be 'pending', 'approved', or 'rejected'"
            });
        }
        const updated = await updateTeamMemberStatus(id, status, authorizedSignatoryName);
        return res.status(200).json({
            success: true,
            message: `Team member status successfully updated to '${status}'`,
            data: updated
        });
    }
    catch (error) {
        console.error("[TeamMemberController Status Error]:", error);
        return res.status(400).json({
            success: false,
            message: error.message || "Failed to update team member status"
        });
    }
}
/**
 * POST /api/team-members/:id/final-submit
 */
export async function finalSubmitTeamMemberController(req, res) {
    try {
        const id = String(req.params.id);
        const authUser = req.user;
        const authUserId = authUser?.user_id || authUser?.id;
        const isAdmin = Boolean(authUser?.is_admin ||
            authUser?.role === "SuperAdmin" ||
            authUser?.role === "Admin" ||
            authUser?.user_type === "Admin" ||
            authUser?.user_type === "SuperAdmin");
        const body = req.body || {};
        const declarationAccepted = (body.declarationAccepted === true ||
            body.declarationAccepted === 'true' ||
            body.termsAccepted === true ||
            body.termsAccepted === 'true');
        if (!declarationAccepted) {
            return res.status(400).json({
                success: false,
                message: "Declaration must be accepted to perform Final Submit."
            });
        }
        const result = await finalSubmitTeamMemberRecord(id, authUserId, isAdmin);
        return res.status(200).json({
            success: true,
            message: "Team member enrollment final submitted successfully",
            data: result
        });
    }
    catch (error) {
        console.error("[TeamMemberController FinalSubmit Error]:", error);
        const status = error.statusCode || (error.message?.includes("finalized") || error.message?.includes("Unauthorized") ? 403 : 400);
        return res.status(status).json({
            success: false,
            message: error.message || "Failed to final submit team member record"
        });
    }
}
/**
 * GET /api/team-members/:id/print
 */
export async function printTeamMemberController(req, res) {
    try {
        const id = String(req.params.id);
        const authUser = req.user;
        const authUserId = authUser?.user_id || authUser?.id;
        const isAdmin = Boolean(authUser?.is_admin ||
            authUser?.role === "SuperAdmin" ||
            authUser?.role === "Admin" ||
            authUser?.user_type === "Admin" ||
            authUser?.user_type === "SuperAdmin");
        const record = await getTeamMemberById(id, authUserId, isAdmin);
        if (!record) {
            return res.status(404).json({
                success: false,
                message: "Team member not found"
            });
        }
        // Strict ownership check: Admin, owner associate, or the team member themselves
        if (!isAdmin && authUserId) {
            const isNumeric = /^\d+$/.test(String(authUserId).trim());
            const authNumId = isNumeric ? Number(authUserId) : null;
            const authCodeStr = String(authUser?.member_id || (!isNumeric ? authUserId : "") || "").trim().toUpperCase();
            let isOwnerAssociate = false;
            let isSelfMember = false;
            if (authNumId !== null) {
                isOwnerAssociate = Number(record.associate_id) === authNumId;
                isSelfMember = record.user_id ? Number(record.user_id) === authNumId : false;
            }
            if (!isOwnerAssociate && !isSelfMember && authCodeStr) {
                if (record.team_member_uid && String(record.team_member_uid).trim().toUpperCase() === authCodeStr) {
                    isSelfMember = true;
                }
            }
            if (!isOwnerAssociate && !isSelfMember) {
                return res.status(403).json({
                    success: false,
                    message: "Forbidden: You are not authorized to print this team member enrollment record."
                });
            }
        }
        const pdfBuffer = await generateTeamMemberPdf(record.id);
        const dateStr = record.created_at
            ? new Date(record.created_at).toISOString().split('T')[0]
            : new Date().toISOString().split('T')[0];
        const fileName = `MMR-TeamMember-${record.team_member_uid || record.id}-${dateStr}.pdf`;
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
        return res.end(pdfBuffer);
    }
    catch (error) {
        console.error("[TeamMemberController Print Error]:", error);
        const status = error.statusCode || (error.message?.includes("Unauthorized") || error.message?.includes("Forbidden") ? 403 : 500);
        return res.status(status).json({
            success: false,
            message: error.message || "Failed to generate Team Member PDF"
        });
    }
}
