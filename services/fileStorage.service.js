import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import crypto from "crypto";
import { v2 as cloudinary } from "cloudinary";

/**
 * Determine Storage Root Path cleanly with safe fallback for dev/testing
 */
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

  // Local development / fallback storage root inside workspace directory
  return path.resolve(process.cwd(), "uploads");
}

/**
 * Convert string to safe SEO slug
 * Handles Hindi/Unicode, special characters, spaces, duplicate hyphens.
 */
export function toSeoSlug(str = "") {
  if (!str) return "";
  return String(str)
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // Remove accents
    .replace(/[^a-z0-9\u0900-\u097F_-]+/g, "-") // Allow alphanumeric & Hindi chars, convert rest to hyphen
    .replace(/-+/g, "-") // Collapse consecutive hyphens
    .replace(/^-+|-+$/g, "") // Trim leading/trailing hyphens
    .substring(0, 80);
}

/**
 * Ensure Storage Directory Exists (Race-condition safe)
 */
export async function ensureDirExists(targetDir) {
  try {
    await fs.mkdir(targetDir, { recursive: true, mode: 0o755 });
  } catch (err) {
    if (err.code !== "EEXIST") {
      throw err;
    }
  }
}

/**
 * Generate SEO-Friendly, Collision-Free Filename
 * Example: MMR-Constructions-green-valley-phase-1-site-map-a83f21.jpg
 */
export function generateSeoFilename({
  brand = "MMR-Constructions",
  entityName = "",
  entityId = "",
  purpose = "",
  originalName = "image.png",
  extension = "",
}) {
  const ext = extension || path.extname(originalName).replace(".", "").toLowerCase() || "png";
  const dateStr = new Date().toISOString().replace(/[-T:.Z]/g, "").substring(0, 8); // YYYYMMDD
  const uniqueHash = crypto.randomBytes(3).toString("hex"); // 6 hex chars

  const cleanBrand = toSeoSlug(brand) || "mmr-constructions";
  const cleanEntityName = toSeoSlug(entityName);
  const cleanEntityId = toSeoSlug(entityId);
  const cleanPurpose = toSeoSlug(purpose);
  const cleanOrigBase = toSeoSlug(path.basename(originalName, path.extname(originalName)));

  // Combine meaningful SEO parts
  const parts = [cleanBrand];

  if (cleanEntityName) parts.push(cleanEntityName);
  if (cleanEntityId && !cleanEntityName.includes(cleanEntityId)) parts.push(cleanEntityId);
  if (cleanPurpose && !cleanEntityName.includes(cleanPurpose)) parts.push(cleanPurpose);
  if (!cleanEntityName && !cleanPurpose && cleanOrigBase) parts.push(cleanOrigBase);

  parts.push(dateStr);
  parts.push(uniqueHash);

  const baseFilename = parts.join("-");
  return `${baseFilename}.${ext.toLowerCase()}`;
}

/**
 * Image compression / optimization module using Sharp
 */
let sharpModule = null;
try {
  sharpModule = (await import("sharp")).default;
} catch {
  // Sharp optional fallback
}

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

    // Resize if larger than 2500px width
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
 * Resolve Module & Subfolder Directory Structure
 */
export function resolveModuleDirectory(moduleKey = "other", options = {}) {
  const { entityId = "common", entityName = "", subCategory = "" } = options;
  const slugEntityName = toSeoSlug(entityName) || toSeoSlug(entityId) || "common";
  const cleanEntityId = toSeoSlug(entityId) || "common";

  switch (moduleKey.toLowerCase()) {
    case "site":
    case "project": {
      const cat = toSeoSlug(subCategory) || "images";
      return path.join("projects", slugEntityName, cat);
    }
    case "plot": {
      const siteSlug = toSeoSlug(options.siteName) || "project";
      return path.join("projects", siteSlug, "plots", cleanEntityId);
    }
    case "investor": {
      const cat = toSeoSlug(subCategory) || "profile";
      return path.join("investors", cleanEntityId, cat);
    }
    case "associate": {
      const cat = toSeoSlug(subCategory) || "profile";
      return path.join("associates", cleanEntityId, cat);
    }
    case "customer":
    case "user":
    case "profile": {
      const cat = toSeoSlug(subCategory) || "profile";
      return path.join("customers", cleanEntityId, cat);
    }
    case "slider":
    case "background":
    case "homepage": {
      const cat = toSeoSlug(subCategory) || "sliders";
      return path.join("homepage", cat);
    }
    case "proof":
    case "payment": {
      return path.join("payments", "proofs", cleanEntityId);
    }
    case "company": {
      const cat = toSeoSlug(subCategory) || "documents";
      return path.join("company", cat);
    }
    case "mobile_app": {
      const cat = toSeoSlug(subCategory) || "logo";
      return path.join("mobile-app", cat);
    }
    default: {
      return path.join("other", cleanEntityId);
    }
  }
}

/**
 * Server-Side Safe Audit Logging for File Operations
 */
export function logStorageOperation({ action, module, entityId, originalName, finalFilename, fullPath, size }) {
  console.log(`[VPS Storage] ${action || "Upload"} | Module: ${module} | ID: ${entityId} | File: ${finalFilename} | Size: ${Math.round(size / 1024)} KB | Path: ${fullPath}`);
}

/**
 * Save file to VPS Storage
 */
export async function saveFileToVPS(buffer, options = {}) {
  const {
    module: modKey = "other",
    entityId = "common",
    entityName = "",
    entityType = "Doc",
    purpose = "",
    originalName = "file.bin",
    subCategory = "",
    siteName = "",
  } = options;

  const rootDir = getStorageRoot();
  const relativeSubDir = resolveModuleDirectory(modKey, { entityId, entityName, subCategory, siteName });
  const targetDir = path.join(rootDir, relativeSubDir);

  await ensureDirExists(targetDir);

  const rawExt = path.extname(originalName).replace(".", "") || "bin";
  const { buffer: finalBuffer, format: finalExt } = await optimizeBuffer(buffer, rawExt);

  const filename = generateSeoFilename({
    brand: "MMR-Constructions",
    entityName: entityName || siteName || modKey,
    entityId: entityId !== "common" ? entityId : "",
    purpose: purpose || entityType,
    originalName,
    extension: finalExt,
  });

  const fullPath = path.join(targetDir, filename);

  // Write file to disk
  await fs.writeFile(fullPath, finalBuffer);

  // Log operation safely
  logStorageOperation({
    action: "FileSaved",
    module: modKey,
    entityId,
    originalName,
    finalFilename: filename,
    fullPath,
    size: finalBuffer.length,
  });

  const publicBase = (process.env.PUBLIC_API_URL || process.env.API_BASE_URL || "https://api.mmrconstructions.in").replace(/\/$/, "");
  const normalizedRelPath = relativeSubDir.replace(/\\/g, "/");
  const relativePath = `/uploads/${normalizedRelPath}/${filename}`;
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
 * Safely delete file from Storage (supports Cloudinary vs VPS Storage)
 */
export async function deleteFileFromStorage(fileUrl = "", publicId = "") {
  if (!fileUrl && !publicId) return false;

  // 1. Existing Cloudinary file handling
  if (isCloudinaryUrl(fileUrl) || publicId) {
    if (publicId) {
      try {
        await cloudinary.uploader.destroy(publicId);
        logStorageOperation({ action: "CloudinaryDestroyed", publicId });
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
        logStorageOperation({ action: "VPSFileUnlinked", fullPath: targetFilePath });
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
  toSeoSlug,
  generateSeoFilename,
  resolveModuleDirectory,
  saveFileToVPS,
  deleteFileFromStorage,
  isCloudinaryUrl,
  isVpsStorageUrl,
};
