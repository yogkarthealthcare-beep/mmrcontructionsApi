import express from "express";
import jwt from "jsonwebtoken";
import multer from "multer";
import path from "path";
import sql from "../db.js";
import { saveFileToVPS } from "../services/fileStorage.service.js";

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB
  fileFilter: (_req, file, cb) => {
    const allowed = /jpeg|jpg|png|webp|svg/;
    const ext = path.extname(file.originalname || "").toLowerCase();
    if (allowed.test(ext)) {
      cb(null, true);
    } else {
      cb(new Error("Only JPG, JPEG, PNG, WEBP, and SVG image files are allowed."));
    }
  },
});

const ok = (res, data, message = "Success", status = 200) =>
  res.status(status).json({ success: true, message, data });
const fail = (res, message, status = 500) =>
  res.status(status).json({ success: false, message });

function adminAuth(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return fail(res, "Admin login required", 401);
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

export async function ensureSiteGalleryTable() {
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS site_gallery (
        id SERIAL PRIMARY KEY,
        category VARCHAR(100) NOT NULL DEFAULT 'Plot',
        site_name VARCHAR(255) NOT NULL,
        site_address TEXT NOT NULL,
        site_image TEXT NOT NULL,
        display_order INT DEFAULT 0,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `;

    // Seed initial 5 project sites if table is empty
    const [countRow] = await sql`SELECT COUNT(*)::int AS count FROM site_gallery`;
    if (!countRow || countRow.count === 0) {
      const initialSites = [
        {
          category: "Plot",
          site_name: "AIMA Site",
          site_address: "Dhodi Ghaat Road, Rooma, Kanpur",
          site_image: "https://images.unsplash.com/photo-1500382017468-9049fed747ef?w=600&q=75",
          display_order: 1,
        },
        {
          category: "Plot",
          site_name: "Tribhuwan Khera",
          site_address: "Near Jajmau, NH-27, Unnao",
          site_image: "https://images.unsplash.com/photo-1464082354059-27db6ce50048?w=600&q=75",
          display_order: 2,
        },
        {
          category: "Plot",
          site_name: "Gadan Khera",
          site_address: "Unnao",
          site_image: "https://images.unsplash.com/photo-1545324418-cc1a3fa10c00?w=600&q=75",
          display_order: 3,
        },
        {
          category: "Plot",
          site_name: "Ajgain Site",
          site_address: "Ajgain, Near Highway",
          site_image: "https://images.unsplash.com/photo-1613082410785-22292e8426e0?w=600&q=75",
          display_order: 4,
        },
        {
          category: "Plot",
          site_name: "Lucknow Site",
          site_address: "Near Amousi Airport, Lucknow",
          site_image: "https://images.unsplash.com/photo-1486325212027-8081e485255e?w=600&q=75",
          display_order: 5,
        },
      ];

      for (const s of initialSites) {
        await sql`
          INSERT INTO site_gallery (category, site_name, site_address, site_image, display_order, is_active)
          VALUES (${s.category}, ${s.site_name}, ${s.site_address}, ${s.site_image}, ${s.display_order}, true)
        `;
      }
      console.log("[Site Gallery] Seeded initial 5 project sites successfully.");
    }
  } catch (err) {
    console.error("[Site Gallery] Error ensuring table schema:", err);
  }
}

// ── PUBLIC ENDPOINT: Get Active Site Gallery ──────────────────────
router.get("/site-gallery", async (req, res) => {
  try {
    await ensureSiteGalleryTable();
    const category = req.query.category ? String(req.query.category).trim() : null;

    let rows;
    if (category && category.toLowerCase() !== "all") {
      rows = await sql`
        SELECT id, category, site_name, site_address, site_image, display_order, created_at, updated_at
        FROM site_gallery
        WHERE is_active = true AND LOWER(category) = LOWER(${category})
        ORDER BY display_order ASC, id ASC
      `;
    } else {
      rows = await sql`
        SELECT id, category, site_name, site_address, site_image, display_order, created_at, updated_at
        FROM site_gallery
        WHERE is_active = true
        ORDER BY display_order ASC, id ASC
      `;
    }

    return ok(res, rows);
  } catch (error) {
    console.error("[Site Gallery Public GET Error]", error);
    return fail(res, error.message || "Failed to fetch site gallery");
  }
});

// ── ADMIN ENDPOINT: List All Sites (with filter) ───────────────────
router.get("/admin/site-gallery", adminAuth, async (req, res) => {
  try {
    await ensureSiteGalleryTable();
    const category = req.query.category ? String(req.query.category).trim() : null;

    let rows;
    if (category && category.toLowerCase() !== "all") {
      rows = await sql`
        SELECT * FROM site_gallery
        WHERE LOWER(category) = LOWER(${category})
        ORDER BY display_order ASC, id ASC
      `;
    } else {
      rows = await sql`
        SELECT * FROM site_gallery
        ORDER BY display_order ASC, id ASC
      `;
    }

    return ok(res, rows);
  } catch (error) {
    console.error("[Site Gallery Admin List Error]", error);
    return fail(res, error.message || "Failed to fetch site gallery list");
  }
});

// ── ADMIN ENDPOINT: Get Single Site ──────────────────────────────
router.get("/admin/site-gallery/:id", adminAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (isNaN(id)) return fail(res, "Invalid site ID", 400);

    const [site] = await sql`SELECT * FROM site_gallery WHERE id = ${id}`;
    if (!site) return fail(res, "Site not found", 404);

    return ok(res, site);
  } catch (error) {
    console.error("[Site Gallery Admin Detail Error]", error);
    return fail(res, error.message || "Failed to fetch site details");
  }
});

// ── ADMIN ENDPOINT: Create New Site ──────────────────────────────
router.post(
  "/admin/site-gallery",
  adminAuth,
  upload.single("site_image"),
  async (req, res) => {
    try {
      await ensureSiteGalleryTable();
      const siteName = String(req.body.site_name || "").trim();
      const siteAddress = String(req.body.site_address || "").trim();
      const category = String(req.body.category || "Plot").trim();
      const displayOrder = Number(req.body.display_order || 0);

      if (!siteName) return fail(res, "Site name is required", 400);
      if (!siteAddress) return fail(res, "Site address is required", 400);

      let imageUrl = String(req.body.site_image || "").trim();

      if (req.file) {
        const saved = await saveFileToVPS(req.file.buffer, {
          module: "site_gallery",
          entityId: siteName,
          entityType: "SiteGallery",
          originalName: req.file.originalname,
        });
        imageUrl = saved.url;
      }

      if (!imageUrl) {
        return fail(res, "Site image is required (upload a file or provide an image URL)", 400);
      }

      const [newSite] = await sql`
        INSERT INTO site_gallery (
          category,
          site_name,
          site_address,
          site_image,
          display_order,
          is_active
        ) VALUES (
          ${category || "Plot"},
          ${siteName},
          ${siteAddress},
          ${imageUrl},
          ${isNaN(displayOrder) ? 0 : displayOrder},
          true
        )
        RETURNING *
      `;

      return ok(res, newSite, "Project site added to gallery successfully.", 201);
    } catch (error) {
      console.error("[Site Gallery Admin Create Error]", error);
      return fail(res, error.message || "Failed to create site in gallery", 400);
    }
  }
);

// ── ADMIN ENDPOINT: Update Site ───────────────────────────────────
router.put(
  "/admin/site-gallery/:id",
  adminAuth,
  upload.single("site_image"),
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (isNaN(id)) return fail(res, "Invalid site ID", 400);

      const [existing] = await sql`SELECT * FROM site_gallery WHERE id = ${id}`;
      if (!existing) return fail(res, "Site not found", 404);

      const siteName = req.body.site_name !== undefined ? String(req.body.site_name).trim() : existing.site_name;
      const siteAddress = req.body.site_address !== undefined ? String(req.body.site_address).trim() : existing.site_address;
      const category = req.body.category !== undefined ? String(req.body.category).trim() : existing.category;
      const displayOrder = req.body.display_order !== undefined ? Number(req.body.display_order) : existing.display_order;
      const isActive = req.body.is_active !== undefined ? Boolean(req.body.is_active === true || req.body.is_active === "true") : existing.is_active;

      if (!siteName) return fail(res, "Site name cannot be empty", 400);
      if (!siteAddress) return fail(res, "Site address cannot be empty", 400);

      let imageUrl = existing.site_image;

      if (req.file) {
        const saved = await saveFileToVPS(req.file.buffer, {
          module: "site_gallery",
          entityId: siteName || String(id),
          entityType: "SiteGallery",
          originalName: req.file.originalname,
        });
        imageUrl = saved.url;
      } else if (req.body.site_image && String(req.body.site_image).trim()) {
        imageUrl = String(req.body.site_image).trim();
      }

      const [updated] = await sql`
        UPDATE site_gallery
        SET
          category = ${category || "Plot"},
          site_name = ${siteName},
          site_address = ${siteAddress},
          site_image = ${imageUrl},
          display_order = ${isNaN(displayOrder) ? 0 : displayOrder},
          is_active = ${isActive},
          updated_at = NOW()
        WHERE id = ${id}
        RETURNING *
      `;

      return ok(res, updated, "Project site updated successfully.");
    } catch (error) {
      console.error("[Site Gallery Admin Update Error]", error);
      return fail(res, error.message || "Failed to update project site", 400);
    }
  }
);

// ── ADMIN ENDPOINT: Delete Site ───────────────────────────────────
router.delete("/admin/site-gallery/:id", adminAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (isNaN(id)) return fail(res, "Invalid site ID", 400);

    const [deleted] = await sql`
      DELETE FROM site_gallery WHERE id = ${id}
      RETURNING id, site_name
    `;

    if (!deleted) return fail(res, "Site not found", 404);

    return ok(res, deleted, "Project site deleted from gallery successfully.");
  } catch (error) {
    console.error("[Site Gallery Admin Delete Error]", error);
    return fail(res, error.message || "Failed to delete project site");
  }
});

export default router;
