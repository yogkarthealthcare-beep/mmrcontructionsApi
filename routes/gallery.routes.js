import express from "express";
import jwt from "jsonwebtoken";
import multer from "multer";
import path from "path";
import sql from "../db.js";
import { saveFileToVPS, deleteFileFromStorage } from "../services/fileStorage.service.js";

const router = express.Router();

// 100MB limit for videos, memory storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
});

const ok = (res, data, message = "Success", status = 200) =>
  res.status(status).json({ success: true, message, data });
const fail = (res, message, status = 500) =>
  res.status(status).json({ success: false, message });

function adminAuth(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return fail(res, "Admin authentication required", 401);
  try {
    req.admin = jwt.verify(
      token,
      process.env.JWT_ADMIN_SECRET || process.env.JWT_SECRET
    );
    return next();
  } catch {
    return fail(res, "Invalid or expired admin token", 401);
  }
}

/**
 * YouTube extraction and validation helper
 * Validates domain is youtube.com, youtu.be, or youtube-nocookie.com
 * Supports watch?v=, youtu.be/, /shorts/, /embed/
 */
export function extractYouTubeId(urlStr = "") {
  if (!urlStr || typeof urlStr !== "string") return null;
  const trimmed = urlStr.trim();

  let parsed;
  try {
    parsed = new URL(trimmed.startsWith("http") ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }

  const hostname = parsed.hostname.toLowerCase();
  const validHost =
    hostname === "youtube.com" ||
    hostname === "www.youtube.com" ||
    hostname === "m.youtube.com" ||
    hostname === "youtu.be" ||
    hostname === "youtube-nocookie.com" ||
    hostname === "www.youtube-nocookie.com";

  if (!validHost) return null;

  // 1. youtu.be/<id>
  if (hostname === "youtu.be") {
    const id = parsed.pathname.slice(1).split("/")[0].split("?")[0];
    return /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
  }

  // 2. /shorts/<id>
  if (parsed.pathname.includes("/shorts/")) {
    const parts = parsed.pathname.split("/shorts/");
    if (parts[1]) {
      const id = parts[1].split("/")[0].split("?")[0];
      return /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
    }
  }

  // 3. /embed/<id>
  if (parsed.pathname.includes("/embed/")) {
    const parts = parsed.pathname.split("/embed/");
    if (parts[1]) {
      const id = parts[1].split("/")[0].split("?")[0];
      return /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
    }
  }

  // 4. watch?v=<id>
  const v = parsed.searchParams.get("v");
  if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) {
    return v;
  }

  return null;
}

/**
 * Ensure table schema exists on server startup
 */
export async function ensureGalleryItemsTable() {
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS gallery_items (
        id SERIAL PRIMARY KEY,
        type VARCHAR(20) NOT NULL,
        title VARCHAR(255),
        url TEXT NOT NULL,
        storage_path TEXT,
        thumbnail_url TEXT,
        thumbnail_storage_path TEXT,
        youtube_id VARCHAR(50),
        show_in_advertisement BOOLEAN DEFAULT FALSE,
        is_active BOOLEAN DEFAULT TRUE,
        sort_order INT DEFAULT 0,
        start_date TIMESTAMP WITH TIME ZONE NULL,
        end_date TIMESTAMP WITH TIME ZONE NULL,
        cta_link TEXT NULL,
        cta_label VARCHAR(100) NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `;

    // Self-healing check for newly added columns if table previously existed
    await sql`
      ALTER TABLE gallery_items 
      ADD COLUMN IF NOT EXISTS start_date TIMESTAMP WITH TIME ZONE NULL,
      ADD COLUMN IF NOT EXISTS end_date TIMESTAMP WITH TIME ZONE NULL,
      ADD COLUMN IF NOT EXISTS cta_link TEXT NULL,
      ADD COLUMN IF NOT EXISTS cta_label VARCHAR(100) NULL;
    `;

    // Create helpful performance indexes
    await sql`CREATE INDEX IF NOT EXISTS idx_gallery_items_type ON gallery_items (type);`;
    await sql`CREATE INDEX IF NOT EXISTS idx_gallery_items_active ON gallery_items (is_active);`;
    await sql`CREATE INDEX IF NOT EXISTS idx_gallery_items_ad ON gallery_items (show_in_advertisement);`;
    await sql`CREATE INDEX IF NOT EXISTS idx_gallery_items_sort ON gallery_items (sort_order ASC, created_at DESC);`;

    console.log("[Gallery] Database schema for gallery_items verified and ready.");
  } catch (err) {
    console.error("[Gallery] Error ensuring gallery_items schema:", err.message);
  }
}

/**
 * Helper to safely check if a storage path is referenced by any other record before deleting
 */
async function canSafelyDeleteStoragePath(storagePath, excludeId = null) {
  if (!storagePath) return false;
  try {
    const rows = await sql`
      SELECT id FROM gallery_items 
      WHERE (storage_path = ${storagePath} OR thumbnail_storage_path = ${storagePath})
      ${excludeId ? sql`AND id != ${excludeId}` : sql``}
      LIMIT 1
    `;
    return rows.length === 0;
  } catch (err) {
    console.warn("[Gallery] Storage path usage check error:", err.message);
    return false; // Safely avoid deleting if check fails
  }
}

// ─────────────────────────────────────────────────────────────
// PUBLIC ENDPOINTS
// ─────────────────────────────────────────────────────────────

/**
 * GET /gallery
 * Public gallery items (images, youtube, video)
 */
router.get("/gallery", async (req, res) => {
  try {
    const type = req.query.type?.toString().toLowerCase();
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 12));
    const offset = (page - 1) * limit;

    let items;
    let totalCount;

    if (type && ["image", "youtube", "video"].includes(type)) {
      items = await sql`
        SELECT * FROM gallery_items
        WHERE is_active = TRUE AND type = ${type}
        ORDER BY sort_order ASC, created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
      const [countRow] = await sql`
        SELECT COUNT(*)::int AS count FROM gallery_items
        WHERE is_active = TRUE AND type = ${type}
      `;
      totalCount = countRow?.count || 0;
    } else {
      items = await sql`
        SELECT * FROM gallery_items
        WHERE is_active = TRUE
        ORDER BY sort_order ASC, created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
      const [countRow] = await sql`
        SELECT COUNT(*)::int AS count FROM gallery_items
        WHERE is_active = TRUE
      `;
      totalCount = countRow?.count || 0;
    }

    return ok(res, {
      items,
      pagination: {
        page,
        limit,
        total: totalCount,
        totalPages: Math.ceil(totalCount / limit) || 1,
        hasMore: offset + items.length < totalCount,
      },
    });
  } catch (err) {
    console.error("[Gallery] Error fetching public gallery:", err);
    return fail(res, "Failed to load gallery items.");
  }
});

/**
 * GET /gallery/advertisements
 * Public active advertisement items for home page banner slider
 */
router.get("/gallery/advertisements", async (req, res) => {
  try {
    const items = await sql`
      SELECT * FROM gallery_items
      WHERE is_active = TRUE 
        AND show_in_advertisement = TRUE
        AND (start_date IS NULL OR start_date <= NOW())
        AND (end_date IS NULL OR end_date >= NOW())
      ORDER BY sort_order ASC, created_at DESC
      LIMIT 10
    `;
    return ok(res, items);
  } catch (err) {
    console.error("[Gallery] Error fetching advertisements:", err);
    return fail(res, "Failed to load active advertisements.");
  }
});

// ─────────────────────────────────────────────────────────────
// ADMIN ENDPOINTS
// ─────────────────────────────────────────────────────────────

/**
 * GET /admin/gallery
 * Admin list with filters
 */
router.get("/admin/gallery", adminAuth, async (req, res) => {
  try {
    const type = req.query.type?.toString().toLowerCase();
    const search = req.query.q?.toString().trim();
    const adsOnly = req.query.adsOnly === "true";

    let items;
    if (adsOnly) {
      items = await sql`
        SELECT * FROM gallery_items
        WHERE show_in_advertisement = TRUE
        ${type && ["image", "youtube", "video"].includes(type) ? sql`AND type = ${type}` : sql``}
        ${search ? sql`AND (title ILIKE ${'%' + search + '%'} OR url ILIKE ${'%' + search + '%'})` : sql``}
        ORDER BY sort_order ASC, created_at DESC
      `;
    } else {
      items = await sql`
        SELECT * FROM gallery_items
        WHERE 1 = 1
        ${type && ["image", "youtube", "video"].includes(type) ? sql`AND type = ${type}` : sql``}
        ${search ? sql`AND (title ILIKE ${'%' + search + '%'} OR url ILIKE ${'%' + search + '%'})` : sql``}
        ORDER BY sort_order ASC, created_at DESC
      `;
    }

    return ok(res, items);
  } catch (err) {
    console.error("[Gallery] Error fetching admin gallery:", err);
    return fail(res, "Failed to load admin gallery list.");
  }
});

/**
 * GET /admin/gallery/:id
 */
router.get("/admin/gallery/:id", adminAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return fail(res, "Invalid gallery ID", 400);

    const [item] = await sql`SELECT * FROM gallery_items WHERE id = ${id}`;
    if (!item) return fail(res, "Gallery item not found", 404);

    return ok(res, item);
  } catch (err) {
    console.error("[Gallery] Error fetching item:", err);
    return fail(res, "Failed to load gallery item.");
  }
});

/**
 * POST /admin/gallery
 * Create Image / YouTube / Video item
 */
router.post(
  "/admin/gallery",
  adminAuth,
  upload.fields([
    { name: "file", maxCount: 1 },
    { name: "thumbnail", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const type = String(req.body.type || "").trim().toLowerCase();
      const title = String(req.body.title || "").trim();
      const showInAdvertisement = req.body.showInAdvertisement === "true" || req.body.showInAdvertisement === true;
      const isActive = req.body.isActive === undefined ? true : (req.body.isActive === "true" || req.body.isActive === true);
      const sortOrder = parseInt(req.body.sortOrder) || 0;
      const startDate = req.body.startDate ? new Date(req.body.startDate) : null;
      const endDate = req.body.endDate ? new Date(req.body.endDate) : null;
      const ctaLink = req.body.ctaLink ? String(req.body.ctaLink).trim() : null;
      const ctaLabel = req.body.ctaLabel ? String(req.body.ctaLabel).trim() : null;

      if (!["image", "youtube", "video"].includes(type)) {
        return fail(res, "Type must be 'image', 'youtube', or 'video'", 400);
      }

      let url = "";
      let storagePath = null;
      let thumbnailUrl = null;
      let thumbnailStoragePath = null;
      let youtubeId = null;

      // Handle Image
      if (type === "image") {
        const file = req.files?.file?.[0];
        if (!file) {
          return fail(res, "Image file is required", 400);
        }

        const allowedExts = [".jpg", ".jpeg", ".png", ".webp"];
        const ext = path.extname(file.originalname).toLowerCase();
        if (!allowedExts.includes(ext)) {
          return fail(res, "Only JPG, PNG, and WEBP image files are allowed", 400);
        }

        if (file.size > 5 * 1024 * 1024) {
          return fail(res, "Image file size exceeds the 5 MB limit", 400);
        }

        const saved = await saveFileToVPS(file.buffer, {
          module: "gallery",
          subCategory: "images",
          entityName: title || "image",
          purpose: "gallery-image",
          originalName: file.originalname,
        });

        url = saved.url;
        storagePath = saved.relativePath;
        thumbnailUrl = saved.url;
        thumbnailStoragePath = saved.relativePath;
      }

      // Handle YouTube
      else if (type === "youtube") {
        const inputUrl = String(req.body.url || "").trim();
        youtubeId = extractYouTubeId(inputUrl);

        if (!youtubeId) {
          return fail(
            res,
            "Invalid YouTube link. Please provide a valid URL from youtube.com, youtu.be, or youtube-nocookie.com.",
            400
          );
        }

        url = `https://www.youtube.com/watch?v=${youtubeId}`;
        thumbnailUrl = `https://img.youtube.com/vi/${youtubeId}/hqdefault.jpg`;
      }

      // Handle Video
      else if (type === "video") {
        const file = req.files?.file?.[0];
        if (!file) {
          return fail(res, "Video file is required", 400);
        }

        if (!title) {
          return fail(res, "Title is required for video items", 400);
        }

        const allowedExts = [".mp4", ".webm"];
        const ext = path.extname(file.originalname).toLowerCase();
        if (!allowedExts.includes(ext)) {
          return fail(res, "Only MP4 and WEBM video files are allowed", 400);
        }

        if (file.size > 100 * 1024 * 1024) {
          return fail(res, "Video file size exceeds the 100 MB limit", 400);
        }

        const savedVideo = await saveFileToVPS(file.buffer, {
          module: "gallery",
          subCategory: "videos",
          entityName: title,
          purpose: "gallery-video",
          originalName: file.originalname,
        });

        url = savedVideo.url;
        storagePath = savedVideo.relativePath;

        // Optional thumbnail file for video
        const thumbFile = req.files?.thumbnail?.[0];
        if (thumbFile) {
          const thumbExt = path.extname(thumbFile.originalname).toLowerCase();
          if (![".jpg", ".jpeg", ".png", ".webp"].includes(thumbExt)) {
            return fail(res, "Thumbnail must be a JPG, PNG, or WEBP image", 400);
          }
          if (thumbFile.size > 5 * 1024 * 1024) {
            return fail(res, "Thumbnail file size exceeds the 5 MB limit", 400);
          }

          const savedThumb = await saveFileToVPS(thumbFile.buffer, {
            module: "gallery",
            subCategory: "thumbnails",
            entityName: `${title}-thumb`,
            purpose: "video-thumbnail",
            originalName: thumbFile.originalname,
          });

          thumbnailUrl = savedThumb.url;
          thumbnailStoragePath = savedThumb.relativePath;
        }
      }

      const [newItem] = await sql`
        INSERT INTO gallery_items (
          type, title, url, storage_path, thumbnail_url, thumbnail_storage_path,
          youtube_id, show_in_advertisement, is_active, sort_order,
          start_date, end_date, cta_link, cta_label
        ) VALUES (
          ${type}, ${title || null}, ${url}, ${storagePath}, ${thumbnailUrl}, ${thumbnailStoragePath},
          ${youtubeId}, ${showInAdvertisement}, ${isActive}, ${sortOrder},
          ${startDate}, ${endDate}, ${ctaLink}, ${ctaLabel}
        )
        RETURNING *
      `;

      return ok(res, newItem, "Gallery item created successfully", 201);
    } catch (err) {
      console.error("[Gallery] Error creating item:", err);
      return fail(res, err.message || "Failed to create gallery item.");
    }
  }
);

/**
 * PUT /admin/gallery/:id
 * Update item with SAFE file replacement
 */
router.put(
  "/admin/gallery/:id",
  adminAuth,
  upload.fields([
    { name: "file", maxCount: 1 },
    { name: "thumbnail", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (!id) return fail(res, "Invalid gallery ID", 400);

      const [existing] = await sql`SELECT * FROM gallery_items WHERE id = ${id}`;
      if (!existing) return fail(res, "Gallery item not found", 404);

      const newType = req.body.type ? String(req.body.type).trim().toLowerCase() : existing.type;
      const newTitle = req.body.title !== undefined ? String(req.body.title).trim() : existing.title;
      const showInAdvertisement =
        req.body.showInAdvertisement !== undefined
          ? req.body.showInAdvertisement === "true" || req.body.showInAdvertisement === true
          : existing.show_in_advertisement;
      const isActive =
        req.body.isActive !== undefined
          ? req.body.isActive === "true" || req.body.isActive === true
          : existing.is_active;
      const sortOrder =
        req.body.sortOrder !== undefined ? parseInt(req.body.sortOrder) || 0 : existing.sort_order;
      const startDate =
        req.body.startDate !== undefined
          ? req.body.startDate ? new Date(req.body.startDate) : null
          : existing.start_date;
      const endDate =
        req.body.endDate !== undefined
          ? req.body.endDate ? new Date(req.body.endDate) : null
          : existing.end_date;
      const ctaLink =
        req.body.ctaLink !== undefined ? (req.body.ctaLink ? String(req.body.ctaLink).trim() : null) : existing.cta_link;
      const ctaLabel =
        req.body.ctaLabel !== undefined ? (req.body.ctaLabel ? String(req.body.ctaLabel).trim() : null) : existing.cta_label;

      let updatedUrl = existing.url;
      let updatedStoragePath = existing.storage_path;
      let updatedThumbnailUrl = existing.thumbnail_url;
      let updatedThumbnailStoragePath = existing.thumbnail_storage_path;
      let updatedYoutubeId = existing.youtube_id;

      // Track files to delete ONLY after database update succeeds
      const oldFilesToCleanup = [];

      // If replacing or handling YouTube
      if (newType === "youtube") {
        if (req.body.url) {
          const yId = extractYouTubeId(req.body.url);
          if (!yId) {
            return fail(res, "Invalid YouTube link provided", 400);
          }
          updatedYoutubeId = yId;
          updatedUrl = `https://www.youtube.com/watch?v=${yId}`;
          updatedThumbnailUrl = `https://img.youtube.com/vi/${yId}/hqdefault.jpg`;
        }

        // If switching from image/video to youtube, queue old files for cleanup
        if (existing.storage_path) {
          oldFilesToCleanup.push(existing.storage_path);
          updatedStoragePath = null;
        }
        if (existing.thumbnail_storage_path) {
          oldFilesToCleanup.push(existing.thumbnail_storage_path);
          updatedThumbnailStoragePath = null;
        }
      }

      // If replacing file with a new file
      const file = req.files?.file?.[0];
      if (file) {
        if (newType === "image") {
          const ext = path.extname(file.originalname).toLowerCase();
          if (![".jpg", ".jpeg", ".png", ".webp"].includes(ext)) {
            return fail(res, "Only JPG, PNG, and WEBP image files are allowed", 400);
          }
          if (file.size > 5 * 1024 * 1024) {
            return fail(res, "Image file size exceeds the 5 MB limit", 400);
          }

          // Step 1: Upload new file first
          const saved = await saveFileToVPS(file.buffer, {
            module: "gallery",
            subCategory: "images",
            entityName: newTitle || "image",
            purpose: "gallery-image",
            originalName: file.originalname,
          });

          // Queue old files for deletion after DB save
          if (existing.storage_path && existing.storage_path !== saved.relativePath) {
            oldFilesToCleanup.push(existing.storage_path);
          }
          if (existing.thumbnail_storage_path && existing.thumbnail_storage_path !== saved.relativePath) {
            oldFilesToCleanup.push(existing.thumbnail_storage_path);
          }

          updatedUrl = saved.url;
          updatedStoragePath = saved.relativePath;
          updatedThumbnailUrl = saved.url;
          updatedThumbnailStoragePath = saved.relativePath;
          updatedYoutubeId = null;
        } else if (newType === "video") {
          const ext = path.extname(file.originalname).toLowerCase();
          if (![".mp4", ".webm"].includes(ext)) {
            return fail(res, "Only MP4 and WEBM video files are allowed", 400);
          }
          if (file.size > 100 * 1024 * 1024) {
            return fail(res, "Video file size exceeds the 100 MB limit", 400);
          }

          // Step 1: Upload new file first
          const saved = await saveFileToVPS(file.buffer, {
            module: "gallery",
            subCategory: "videos",
            entityName: newTitle || "video",
            purpose: "gallery-video",
            originalName: file.originalname,
          });

          if (existing.storage_path && existing.storage_path !== saved.relativePath) {
            oldFilesToCleanup.push(existing.storage_path);
          }

          updatedUrl = saved.url;
          updatedStoragePath = saved.relativePath;
          updatedYoutubeId = null;
        }
      }

      // Handle optional new thumbnail file
      const thumbFile = req.files?.thumbnail?.[0];
      if (thumbFile) {
        const thumbExt = path.extname(thumbFile.originalname).toLowerCase();
        if (![".jpg", ".jpeg", ".png", ".webp"].includes(thumbExt)) {
          return fail(res, "Thumbnail must be a JPG, PNG, or WEBP image", 400);
        }
        if (thumbFile.size > 5 * 1024 * 1024) {
          return fail(res, "Thumbnail file size exceeds the 5 MB limit", 400);
        }

        const savedThumb = await saveFileToVPS(thumbFile.buffer, {
          module: "gallery",
          subCategory: "thumbnails",
          entityName: `${newTitle || "thumb"}-thumb`,
          purpose: "video-thumbnail",
          originalName: thumbFile.originalname,
        });

        if (existing.thumbnail_storage_path && existing.thumbnail_storage_path !== savedThumb.relativePath) {
          oldFilesToCleanup.push(existing.thumbnail_storage_path);
        }

        updatedThumbnailUrl = savedThumb.url;
        updatedThumbnailStoragePath = savedThumb.relativePath;
      }

      // Step 2: Update database record
      const [updatedItem] = await sql`
        UPDATE gallery_items SET
          type = ${newType},
          title = ${newTitle || null},
          url = ${updatedUrl},
          storage_path = ${updatedStoragePath},
          thumbnail_url = ${updatedThumbnailUrl},
          thumbnail_storage_path = ${updatedThumbnailStoragePath},
          youtube_id = ${updatedYoutubeId},
          show_in_advertisement = ${showInAdvertisement},
          is_active = ${isActive},
          sort_order = ${sortOrder},
          start_date = ${startDate},
          end_date = ${endDate},
          cta_link = ${ctaLink},
          cta_label = ${ctaLabel},
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ${id}
        RETURNING *
      `;

      // Step 3: Only AFTER database update succeeds, delete old files from storage
      for (const oldPath of oldFilesToCleanup) {
        if (oldPath && oldPath !== updatedStoragePath && oldPath !== updatedThumbnailStoragePath) {
          const safeToDelete = await canSafelyDeleteStoragePath(oldPath, id);
          if (safeToDelete) {
            await deleteFileFromStorage(oldPath);
          } else {
            console.log(`[Gallery] Retaining storage file as another item uses it: ${oldPath}`);
          }
        }
      }

      return ok(res, updatedItem, "Gallery item updated successfully");
    } catch (err) {
      console.error("[Gallery] Error updating item:", err);
      return fail(res, err.message || "Failed to update gallery item.");
    }
  }
);

/**
 * DELETE /admin/gallery/:id
 * Remove DB record AND delete associated files from storage (with safety check)
 */
router.delete("/admin/gallery/:id", adminAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return fail(res, "Invalid gallery ID", 400);

    const [item] = await sql`SELECT * FROM gallery_items WHERE id = ${id}`;
    if (!item) return fail(res, "Gallery item not found", 404);

    // 1. Delete DB record first
    await sql`DELETE FROM gallery_items WHERE id = ${id}`;

    // 2. Remove storage files if no other record uses them
    const filesToDelete = [item.storage_path, item.thumbnail_storage_path].filter(Boolean);
    const deletionErrors = [];

    for (const filePath of filesToDelete) {
      try {
        const safeToDelete = await canSafelyDeleteStoragePath(filePath);
        if (safeToDelete) {
          const deleted = await deleteFileFromStorage(filePath);
          if (!deleted) {
            console.warn(`[Gallery] Could not unlink file: ${filePath}`);
          }
        }
      } catch (fileErr) {
        deletionErrors.push(fileErr.message);
      }
    }

    if (deletionErrors.length > 0) {
      return ok(
        res,
        { id, cleanupWarnings: deletionErrors },
        "Gallery record deleted, but storage cleanup reported warnings."
      );
    }

    return ok(res, { id }, "Gallery item and associated files deleted successfully.");
  } catch (err) {
    console.error("[Gallery] Error deleting item:", err);
    return fail(res, "Failed to delete gallery item.");
  }
});

/**
 * PATCH /admin/gallery/:id/advertisement
 * Toggle or update advertisement configuration
 */
router.patch("/admin/gallery/:id/advertisement", adminAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return fail(res, "Invalid gallery ID", 400);

    const [existing] = await sql`SELECT * FROM gallery_items WHERE id = ${id}`;
    if (!existing) return fail(res, "Gallery item not found", 404);

    const showInAdvertisement =
      req.body.showInAdvertisement !== undefined
        ? req.body.showInAdvertisement === "true" || req.body.showInAdvertisement === true
        : existing.show_in_advertisement;
    const sortOrder =
      req.body.sortOrder !== undefined ? parseInt(req.body.sortOrder) || 0 : existing.sort_order;
    const isActive =
      req.body.isActive !== undefined
        ? req.body.isActive === "true" || req.body.isActive === true
        : existing.is_active;
    const startDate =
      req.body.startDate !== undefined
        ? req.body.startDate ? new Date(req.body.startDate) : null
        : existing.start_date;
    const endDate =
      req.body.endDate !== undefined
        ? req.body.endDate ? new Date(req.body.endDate) : null
        : existing.end_date;
    const ctaLink =
      req.body.ctaLink !== undefined ? (req.body.ctaLink ? String(req.body.ctaLink).trim() : null) : existing.cta_link;
    const ctaLabel =
      req.body.ctaLabel !== undefined ? (req.body.ctaLabel ? String(req.body.ctaLabel).trim() : null) : existing.cta_label;

    const [updated] = await sql`
      UPDATE gallery_items SET
        show_in_advertisement = ${showInAdvertisement},
        sort_order = ${sortOrder},
        is_active = ${isActive},
        start_date = ${startDate},
        end_date = ${endDate},
        cta_link = ${ctaLink},
        cta_label = ${ctaLabel},
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ${id}
      RETURNING *
    `;

    return ok(res, updated, "Advertisement settings updated.");
  } catch (err) {
    console.error("[Gallery] Error updating advertisement status:", err);
    return fail(res, "Failed to update advertisement setting.");
  }
});

/**
 * PATCH /admin/gallery/reorder-ads
 * Reorder ads batch
 */
router.patch("/admin/gallery/reorder-ads", adminAuth, async (req, res) => {
  try {
    const orders = req.body.orders; // Array of { id: number, sortOrder: number }
    if (!Array.isArray(orders) || orders.length === 0) {
      return fail(res, "Orders array is required", 400);
    }

    for (const item of orders) {
      if (item.id && typeof item.sortOrder === "number") {
        await sql`
          UPDATE gallery_items
          SET sort_order = ${item.sortOrder}, updated_at = CURRENT_TIMESTAMP
          WHERE id = ${item.id}
        `;
      }
    }

    return ok(res, null, "Advertisement order updated successfully.");
  } catch (err) {
    console.error("[Gallery] Error reordering ads:", err);
    return fail(res, "Failed to reorder advertisements.");
  }
});

export default router;

