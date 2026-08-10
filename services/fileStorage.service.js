import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import crypto from "crypto";
import { v2 as cloudinary } from "cloudinary";

// Determine Storage Root Path cleanly with safe fallback for dev/testing
export function getStorageRoot() {
  const envRoot = process.env.FILE_STORAGE_ROOT?.trim();
  if (envRoot) {
    return path.resolve(envRoot);
  }

  // Production VPS preferred default path
  const vpsPreferred = "/var/www/mmrconstructions-storage";
  
  // On Linux/VPS check if /var/www is accessible or writable
  if (process.platform === "linux") {
    try {
      if (!fsSync.existsSync("/var/www")) {
        fsSync.mkdirSync("/var/www", { recursive: true });
      }
      return path.resolve(vpsPreferred);
    } catch {
      // Fallback if permission denied or non-root execution
    }
  }

  // Local development / fallback storage root inside current workspace directory
  return path.resolve(process.cwd(), "uploads");
}

// Module Folder Mapping
export const MODULE_FOLDERS = {
  investor: "investors",
  associate: "associates",
  customer: "customers",
  user: "users",
  profile: "users",
  site: "sites",
  plot: "plots",
  slider: "sliders",
  background: "sliders",
  proof: "proofs",
  payment: "proofs",
  company: "company",
  document: "documents",
  mobile_app: "mobile-app",
  other: "other",
};

// Ensure Storage Directory Exists (Race-condition safe)
export async function ensureDirExists(targetDir) {
  try {
    await fs.mkdir(targetDir, { recursive: true, mode: 0o755 });
  } catch (err) {
    if (err.code !== "EEXIST") {
      throw err;
    }
  }
}

// Sanitize name for filenames
export function sanitizeName(str = "unnamed") {
  return String(str)
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .substring(0, 50) || "unnamed";
}

// Format Server-side Unique Filename
export function generateFilename({ entityType = "File", entityId = "GEN", name = "upload", extension = "bin" }) {
  const dateStr = new Date().toISOString().replace(/[-T:.Z]/g, "").substring(0, 8); // YYYYMMDD
  const uniqueHash = crypto.randomBytes(3).toString("hex"); // 6 hex chars
  const cleanType = sanitizeName(entityType);
  const cleanId = sanitizeName(entityId);
  const cleanName = sanitizeName(name);
  const cleanExt = extension.replace(/^\.+/, "").toLowerCase() || "bin";

  return `MMR-Constructions_${cleanType}_${cleanId}_${cleanName}_${dateStr}_${uniqueHash}.${cleanExt}`;
}

// Detect image compression support via optional Sharp
let sharpModule = null;
try {
  sharpModule = (await import("sharp")).default;
} catch {
  // Sharp optional fallback
}

/**
 * Optimize image buffer if image format is JPEG/PNG/WebP
 */
export async function optimizeBuffer(buffer, ext) {
  const cleanExt = ext.toLowerCase().replace(".", "");
  if (!sharpModule || !["jpg", "jpeg", "png", "webp"].includes(cleanExt)) {
    return { buffer, format: cleanExt };
  }

  try {
    const sharpInstance = sharpModule(buffer);
    const metadata = await sharpInstance.metadata();

    // Auto-rotate based on EXIF
    sharpInstance.rotate();

    // Resize if ridiculously large (> 2500px)
    if (metadata.width && metadata.width > 2500) {
      sharpInstance.resize({ width: 2500, withoutEnlargement: true });
    }

    if (cleanExt === "png") {
      const optimized = await sharpInstance.png({ compressionLevel: 8, quality: 85 }).toBuffer();
      return { buffer: optimized, format: "png" };
    }

    if (cleanExt === "webp") {
      const optimized = await sharpInstance.webp({ quality: 82 }).toBuffer();
      return { buffer: optimized, format: "webp" };
    }

    // Default JPEG
    const optimized = await sharpInstance.jpeg({ quality: 82, mozjpeg: true }).toBuffer();
    return { buffer: optimized, format: "jpg" };
  } catch (err) {
    console.warn("[FileStorageService] Image optimization warning:", err.message);
    return { buffer, format: cleanExt };
  }
}

/**
 * Save file to VPS Storage
 * @param {Buffer} buffer - File buffer
 * @param {Object} options
 * @param {string} options.module - Module name (investor, site, plot, etc.)
 * @param {string} options.entityId - Entity or User ID (e.g. INV-1001, 25, etc.)
 * @param {string} options.entityType - Entity type descriptor (e.g. Investor, Site)
 * @param {string} options.originalName - Original uploaded filename
 * @param {string} [options.customName] - Optional custom file description
 * @returns {Promise<{ url: string, relativePath: string, fullPath: string, filename: string }>}
 */
export async function saveFileToVPS(buffer, options = {}) {
  const {
    module: modKey = "other",
    entityId = "common",
    entityType = "Doc",
    originalName = "file.bin",
    customName = "",
  } = options;

  const rootDir = getStorageRoot();
  const subFolder = MODULE_FOLDERS[modKey] || MODULE_FOLDERS.other;
  const entitySubDir = sanitizeName(entityId);

  // Storage directory: /var/www/mmrconstructions-storage/{subFolder}/{entitySubDir}
  const targetDir = path.join(rootDir, subFolder, entitySubDir);
  await ensureDirExists(targetDir);

  const rawExt = path.extname(originalName).replace(".", "") || "bin";
  const nameBase = customName || path.basename(originalName, path.extname(originalName));

  // Image optimization
  const { buffer: finalBuffer, format: finalExt } = await optimizeBuffer(buffer, rawExt);

  const filename = generateFilename({
    entityType,
    entityId,
    name: nameBase,
    extension: finalExt,
  });

  const fullPath = path.join(targetDir, filename);

  // Write file to disk
  await fs.writeFile(fullPath, finalBuffer);

  // Compute public relative URL & full URL
  const publicBase = (process.env.PUBLIC_API_URL || process.env.API_BASE_URL || "https://api.mmrconstructions.in").replace(/\/$/, "");
  const relativePath = `/uploads/${subFolder}/${entitySubDir}/${filename}`;
  const fullUrl = `${publicBase}${relativePath}`;

  return {
    url: fullUrl,
    relativePath,
    fullPath,
    filename,
    size: finalBuffer.length,
  };
}

/**
 * Helper to check if URL is a Cloudinary URL
 */
export function isCloudinaryUrl(url = "") {
  return typeof url === "string" && (url.includes("cloudinary.com") || url.includes("res.cloudinary.com"));
}

/**
 * Helper to check if URL is a VPS Storage URL
 */
export function isVpsStorageUrl(url = "") {
  return typeof url === "string" && (url.includes("/uploads/") || url.startsWith("/uploads"));
}

/**
 * Safely delete file (supports hybrid Cloudinary vs VPS Storage files)
 * @param {string} fileUrl - Stored file URL
 * @param {string} [publicId] - Optional Cloudinary public_id
 */
export async function deleteFileFromStorage(fileUrl = "", publicId = "") {
  if (!fileUrl && !publicId) return false;

  // 1. Existing Cloudinary file handling
  if (isCloudinaryUrl(fileUrl) || publicId) {
    if (publicId) {
      try {
        await cloudinary.uploader.destroy(publicId);
        return true;
      } catch (err) {
        console.warn("[FileStorageService] Cloudinary delete warning:", err.message);
      }
    }
    return false;
  }

  // 2. VPS Storage file handling
  if (isVpsStorageUrl(fileUrl)) {
    try {
      const rootDir = getStorageRoot();
      
      // Extract path after /uploads/
      const match = fileUrl.match(/\/uploads\/(.+)$/);
      if (!match) return false;

      const relPath = match[1];
      const targetFilePath = path.resolve(rootDir, relPath);

      // SECURITY GUARD: Ensure target path is strictly contained within FILE_STORAGE_ROOT
      if (!targetFilePath.startsWith(rootDir)) {
        console.error("[FileStorageService] Path traversal attempt blocked during file deletion:", targetFilePath);
        return false;
      }

      if (fsSync.existsSync(targetFilePath)) {
        await fs.unlink(targetFilePath);
        return true;
      }
    } catch (err) {
      console.warn("[FileStorageService] VPS file deletion warning:", err.message);
    }
  }

  return false;
}

export default {
  getStorageRoot,
  saveFileToVPS,
  deleteFileFromStorage,
  isCloudinaryUrl,
  isVpsStorageUrl,
  generateFilename,
  sanitizeName,
};
