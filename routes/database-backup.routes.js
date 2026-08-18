import express from "express";
import fs from "fs/promises";
import jwt from "jsonwebtoken";
import multer from "multer";
import path from "path";
import sql from "../db.js";
import {
  createBackup,
  deleteBackup,
  getBackupFile,
  getBackupSettings,
  getBackupStatus,
  listBackups,
  listRestoreHistory,
  listRestoreUploads,
  registerRestoreUpload,
  restoreUploadedBackup,
  restoreUploadMaxBytes,
  restoreUploadRoot,
  restoreBackup,
  updateBackupSettings,
} from "../services/databaseBackup.service.js";

const router = express.Router();

const ok = (res, data, msg = "Success", status = 200) =>
  res.status(status).json({ success: true, message: msg, data });

const err = (res, msg = "Server error", status = 500) =>
  res.status(status).json({ success: false, message: msg });

const authAdmin = (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) return err(res, "No admin token", 401);
  try {
    req.admin = jwt.verify(auth.split(" ")[1], process.env.JWT_ADMIN_SECRET || process.env.JWT_SECRET);
    return next();
  } catch {
    return err(res, "Invalid or expired admin token", 401);
  }
};

const requireSuperAdmin = (req, res, next) => {
  const role = req.admin?.role || 'Admin';
  if (role !== "SuperAdmin" && role !== "Admin") return err(res, "Only Admin/SuperAdmin can manage database backups.", 403);
  return next();
};

const restoreUpload = multer({
  storage: multer.diskStorage({
    destination: async (_req, _file, cb) => {
      try {
        await fs.mkdir(restoreUploadRoot(), { recursive: true, mode: 0o700 });
        cb(null, restoreUploadRoot());
      } catch (error) {
        cb(error);
      }
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || "").toLowerCase();
      const base = path.basename(file.originalname || "restore", ext).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "restore";
      cb(null, `${Date.now()}-${base}${ext}`);
    },
  }),
  limits: { fileSize: restoreUploadMaxBytes() },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    if ([".sql", ".backup", ".dump", ".tar"].includes(ext)) return cb(null, true);
    return cb(new Error("Unsupported restore file type. Upload .sql, .backup, .dump, or .tar files only."));
  },
});

const audit = async (req, action, newValue = null, targetRecordId = null) => {
  try {
    await sql`
      INSERT INTO audit_log (actor_type, actor_id, actor_name, module, action, target_table, target_record_id, new_value, ip_address)
      VALUES ('Admin', ${req.admin?.admin_id || null}, ${req.admin?.full_name || null},
              'DatabaseBackup', ${action}, 'database_backup_files', ${targetRecordId}, ${newValue ? JSON.stringify(newValue) : null}, ${req.ip || null})`;
  } catch (error) {
    console.error("[Database Backup Audit Error]", error.message);
  }
};

router.use("/admin/database-backup", authAdmin, requireSuperAdmin);

router.get("/admin/database-backup/status", async (_req, res) => {
  try {
    return ok(res, await getBackupStatus(), "Database backup status loaded.");
  } catch (error) {
    console.error("[Database Backup Status Error]", error);
    return err(res, error.message || "Failed to load database backup status.");
  }
});

router.get("/admin/database-backup/history", async (_req, res) => {
  try {
    return ok(res, await listBackups(), "Database backup history loaded.");
  } catch (error) {
    console.error("[Database Backup History Error]", error);
    return err(res, error.message || "Failed to load database backup history.");
  }
});

router.get("/admin/database-backup/restore-uploads", async (_req, res) => {
  try {
    return ok(res, await listRestoreUploads(), "Restore upload files loaded.");
  } catch (error) {
    console.error("[Database Restore Upload List Error]", error);
    return err(res, error.message || "Failed to load restore upload files.");
  }
});

router.get("/admin/database-backup/restore-history", async (_req, res) => {
  try {
    return ok(res, await listRestoreHistory(), "Restore history loaded.");
  } catch (error) {
    console.error("[Database Restore History Error]", error);
    return err(res, error.message || "Failed to load restore history.");
  }
});

router.get("/admin/database-backup/settings", async (_req, res) => {
  try {
    return ok(res, await getBackupSettings(), "Database backup settings loaded.");
  } catch (error) {
    console.error("[Database Backup Settings Error]", error);
    return err(res, error.message || "Failed to load database backup settings.");
  }
});

router.put("/admin/database-backup/settings", async (req, res) => {
  try {
    const settings = await updateBackupSettings(req.body || {}, req.admin?.admin_id || null);
    await audit(req, "UpdateBackupSettings", settings, 1);
    return ok(res, settings, "Automatic backup settings saved.");
  } catch (error) {
    console.error("[Database Backup Settings Save Error]", error);
    return err(res, error.message || "Failed to save automatic backup settings.");
  }
});

router.post("/admin/database-backup/create", async (req, res) => {
  try {
    const backup = await createBackup(req.admin?.admin_id || null);
    await audit(req, "CreateBackup", backup, backup.id);
    return ok(res, backup, "Database backup created successfully.", 201);
  } catch (error) {
    console.error("[Database Backup Create Error]", error);
    await audit(req, "CreateBackupFailed", { error: error.message });
    return err(res, error.message || "Failed to create database backup.");
  }
});

router.post("/admin/database-backup/create-download", async (req, res) => {
  try {
    const created = await createBackup(req.admin?.admin_id || null);
    await audit(req, "CreateBackup", created, created.id);
    const backup = await getBackupFile(created.file_name);
    await audit(req, "DownloadBackup", backup.backup, backup.backup.id);
    res.setHeader("Content-Type", "application/sql");
    res.setHeader("Content-Disposition", `attachment; filename="${backup.fileName}"`);
    res.setHeader("X-Backup-File-Name", backup.fileName);
    return res.sendFile(backup.filePath);
  } catch (error) {
    console.error("[Database Backup Create Download Error]", error);
    await audit(req, "CreateBackupFailed", { error: error.message });
    return err(res, error.message || "Failed to create and download database backup.");
  }
});

router.post("/admin/database-backup/restore-upload", restoreUpload.single("backup_file"), async (req, res) => {
  try {
    const upload = await registerRestoreUpload(req.file, req.admin?.admin_id || null);
    await audit(req, "UploadRestoreBackup", upload, upload.id);
    return ok(res, upload, "Restore backup file uploaded and validated.", 201);
  } catch (error) {
    if (req.file?.path) await fs.unlink(req.file.path).catch(() => {});
    console.error("[Database Restore Upload Error]", error);
    await audit(req, "UploadRestoreBackupFailed", { error: error.message });
    return err(res, error.message || "Failed to upload restore backup file.", 400);
  }
});

router.post("/admin/database-backup/restore-upload/:uploadId", async (req, res) => {
  try {
    const confirmText = String(req.body?.confirm || "");
    if (confirmText !== "RESTORE") {
      return err(res, "Restore confirmation is required.", 400);
    }
    const mode = req.body?.mode === "without_drop" ? "without_drop" : "replace";
    const restore = await restoreUploadedBackup(req.params.uploadId, {
      mode,
      adminId: req.admin?.admin_id || null,
      adminName: req.admin?.full_name || null,
    });
    await audit(req, mode === "replace" ? "ReplaceDatabaseFromUpload" : "RestoreDatabaseWithoutDropping", restore, restore.id);
    return ok(res, restore, "Database restore completed successfully.");
  } catch (error) {
    console.error("[Database Restore Upload Execute Error]", error);
    await audit(req, "RestoreUploadedBackupFailed", { uploadId: req.params.uploadId, error: error.message });
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to restore uploaded backup.",
      data: error.restore || null,
    });
  }
});

router.get("/admin/database-backup/download/:fileName", async (req, res) => {
  try {
    const backup = await getBackupFile(req.params.fileName);
    await audit(req, "DownloadBackup", backup.backup, backup.backup.id);
    res.setHeader("Content-Type", "application/sql");
    res.setHeader("Content-Disposition", `attachment; filename="${backup.fileName}"`);
    return res.sendFile(backup.filePath);
  } catch (error) {
    console.error("[Database Backup Download Error]", error);
    return err(res, error.message || "Failed to download database backup.", 404);
  }
});

router.delete("/admin/database-backup/:fileName", async (req, res) => {
  try {
    const backup = await deleteBackup(req.params.fileName, req.admin?.admin_id || null);
    await audit(req, "DeleteBackup", backup, backup.id);
    return ok(res, backup, "Database backup deleted successfully.");
  } catch (error) {
    console.error("[Database Backup Delete Error]", error);
    return err(res, error.message || "Failed to delete database backup.");
  }
});

router.post("/admin/database-backup/restore/:fileName", async (req, res) => {
  try {
    const confirmText = String(req.body?.confirm || "");
    if (confirmText !== "RESTORE") {
      return err(res, "Restore confirmation is required.", 400);
    }
    const backup = await restoreBackup(req.params.fileName, req.admin?.admin_id || null);
    await audit(req, "RestoreBackup", backup, backup.id);
    return ok(res, backup, "Database backup restored successfully.");
  } catch (error) {
    console.error("[Database Backup Restore Error]", error);
    await audit(req, "RestoreBackupFailed", { fileName: req.params.fileName, error: error.message });
    return err(res, error.message || "Failed to restore database backup.");
  }
});

router.use((error, req, res, _next) => {
  if (error instanceof multer.MulterError) {
    const message = error.code === "LIMIT_FILE_SIZE"
      ? `Restore file exceeds the maximum upload size of ${Math.round(restoreUploadMaxBytes() / 1024 / 1024)} MB.`
      : error.message;
    return err(res, message, 400);
  }
  if (/Unsupported restore file type/i.test(error.message || "")) {
    return err(res, error.message, 400);
  }
  return err(res, error.message || "Database backup request failed.", 500);
});

export default router;
