import fs from "fs";
import path from "path";
import { getStorageRoot } from "./fileStorage.service.js";

/**
 * Resolves an image/signature input into a Buffer or null.
 * Handles:
 * 1. Base64 data URLs (data:image/png;base64,...) and raw base64
 * 2. Objects containing { url, relativePath, fullPath }
 * 3. JSON strings serializing { url, relativePath, fullPath }
 * 4. Absolute filesystem paths (/var/www/mmrconstructions-storage/..., D:\...)
 * 5. Relative paths (uploads/..., investors/..., etc.)
 * 6. Storage root paths with multiple fallback search locations
 * 7. Remote HTTP/HTTPS URLs (fetches image data over network with timeout)
 */
export async function resolveImageBuffer(imageSource: any): Promise<Buffer | null> {
  if (!imageSource) return null;
  if (Buffer.isBuffer(imageSource)) return imageSource;

  let source = imageSource;
  // If it's an object from saveFileToVPS or similar
  if (typeof source === "object") {
    source = source.fullPath || source.relativePath || source.url || "";
  }
  if (typeof source !== "string") return null;

  let trimmed = source.trim();
  // Check if string is a JSON representation of an object
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsed = JSON.parse(trimmed);
      trimmed = (parsed.fullPath || parsed.relativePath || parsed.url || trimmed).trim();
    } catch {}
  }

  if (!trimmed) return null;

  // 1. Check for Base64 data URL
  if (trimmed.startsWith("data:") || trimmed.includes(";base64,")) {
    try {
      const base64Data = trimmed.replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, "").replace(/^data:[^;]+;base64,/, "");
      return Buffer.from(base64Data, "base64");
    } catch (e) {
      console.warn("[pdfImageHelper] Failed to decode base64 image:", e);
    }
  }

  // Raw base64 string check (long alphanumeric string)
  if (trimmed.length > 300 && /^[A-Za-z0-9+/=\r\n]+$/.test(trimmed)) {
    try {
      return Buffer.from(trimmed, "base64");
    } catch {}
  }

  // 2. Local Disk Lookup (Always check disk first even if it looks like an HTTP URL)
  try {
    const rootDir = getStorageRoot();
    const match = trimmed.match(/\/uploads\/(.+)$/);
    const relPath = match ? decodeURIComponent(match[1]) : trimmed.replace(/^\/?uploads\/?/, "");

    const candidatePaths = [
      trimmed,
      path.resolve(trimmed),
      path.resolve(rootDir, relPath),
      path.resolve(rootDir, trimmed),
      path.resolve(process.cwd(), "uploads", relPath),
      path.resolve(process.cwd(), "mmrconstructionsApi", "uploads", relPath),
      path.resolve(process.cwd(), trimmed),
      path.resolve("/var/www/mmrconstructions-storage", relPath),
      path.resolve("/var/www/mmrconstructions/uploads", relPath)
    ];

    for (const candidate of candidatePaths) {
      if (!candidate) continue;
      const variants = [
        candidate,
        candidate.replace(/\.(png|jpg|jpeg|webp)$/i, ".bin"),
        candidate + ".png",
        candidate + ".jpg"
      ];
      for (const p of variants) {
        if (fs.existsSync(p)) {
          const stats = fs.statSync(p);
          if (stats.isFile() && stats.size > 0) {
            return fs.readFileSync(p);
          }
        }
      }
    }
  } catch (e) {
    console.warn("[pdfImageHelper] File disk lookup error:", e);
  }

  // 3. Remote HTTP or HTTPS URL fetch fallback
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 7000);
      const res = await fetch(trimmed, { signal: controller.signal });
      clearTimeout(timeoutId);
      if (res.ok) {
        const arrayBuf = await res.arrayBuffer();
        return Buffer.from(arrayBuf);
      } else {
        console.warn(`[pdfImageHelper] HTTP fetch returned status ${res.status} for ${trimmed}`);
      }
    } catch (e) {
      console.warn(`[pdfImageHelper] HTTP fetch error for ${trimmed}:`, e);
    }
  }

  return null;
}

/**
 * Renders a photo slot in the PDF document from a resolved buffer or shows a placeholder.
 */
export function drawPhotoBoxWithBuffer(
  doc: any,
  label: string,
  x: number,
  y: number,
  buffer: Buffer | null,
  boxWidth: number = 80,
  boxHeight: number = 100
): void {
  doc.lineWidth(1).strokeColor("#64748b").rect(x, y, boxWidth, boxHeight).stroke();
  let loaded = false;
  if (buffer && buffer.length > 0) {
    try {
      doc.image(buffer, x + 2, y + 2, { fit: [boxWidth - 4, boxHeight - 4], align: "center", valign: "center" });
      loaded = true;
    } catch (e) {
      console.warn(`[pdfImageHelper] doc.image failed for ${label}:`, e);
    }
  }
  if (!loaded) {
    doc.fillColor("#64748b").fontSize(6.5).font("Helvetica-Bold");
    doc.text(`PHOTO\n(${label})`, x, y + (boxHeight / 2) - 8, { align: "center", width: boxWidth });
  }
}

/**
 * Renders a signature box in the PDF document from a resolved buffer or shows a placeholder.
 */
export function drawSignatureBoxWithBuffer(
  doc: any,
  label: string,
  x: number,
  y: number,
  buffer: Buffer | null,
  boxWidth: number = 160,
  boxHeight: number = 65
): void {
  doc.lineWidth(1).strokeColor("#64748b").rect(x, y, boxWidth, boxHeight).stroke();
  let loaded = false;
  if (buffer && buffer.length > 0) {
    try {
      doc.image(buffer, x + 4, y + 4, { fit: [boxWidth - 8, boxHeight - 8], align: "center", valign: "center" });
      loaded = true;
    } catch (e) {
      console.warn(`[pdfImageHelper] doc.image signature failed for ${label}:`, e);
    }
  }
  doc.fillColor("#64748b").fontSize(7).font("Helvetica-Bold");
  doc.text(label, x, y + boxHeight + 4, { align: "center", width: boxWidth });
}
