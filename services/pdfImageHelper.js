import fs from "fs";
import path from "path";
import { getStorageRoot } from "./fileStorage.service.js";
/**
 * Resolves an image/signature input into a Buffer or null.
 * Handles:
 * 1. Base64 data URLs (data:image/png;base64,...) and raw base64
 * 2. Absolute filesystem paths (/var/www/mmrconstructions-storage/..., D:\...)
 * 3. Relative paths (uploads/..., associates/..., etc.)
 * 4. Storage root paths with multiple fallback search locations
 * 5. Remote HTTP/HTTPS URLs (fetches image data over network with timeout)
 */
export async function resolveImageBuffer(imageSource) {
    if (!imageSource)
        return null;
    if (Buffer.isBuffer(imageSource))
        return imageSource;
    if (typeof imageSource !== "string")
        return null;
    const trimmed = imageSource.trim();
    if (!trimmed)
        return null;
    // 1. Check for Base64 data URL
    if (trimmed.startsWith("data:") || trimmed.includes(";base64,")) {
        try {
            const base64Data = trimmed.replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, "").replace(/^data:[^;]+;base64,/, "");
            return Buffer.from(base64Data, "base64");
        }
        catch (e) {
            console.warn("[pdfImageHelper] Failed to decode base64 image:", e);
        }
    }
    // 2. If it is an HTTP or HTTPS URL
    if (/^https?:\/\//i.test(trimmed)) {
        // 2a. First, try to see if it maps to a local file on disk
        try {
            const rootDir = getStorageRoot();
            const match = trimmed.match(/\/uploads\/(.+)$/);
            if (match) {
                const relPath = decodeURIComponent(match[1]);
                const candidates = [
                    path.resolve(rootDir, relPath),
                    path.resolve(process.cwd(), "uploads", relPath),
                    path.resolve("/var/www/mmrconstructions-storage", relPath),
                    path.resolve("/var/www/mmrconstructions/uploads", relPath)
                ];
                for (const candidate of candidates) {
                    if (fs.existsSync(candidate)) {
                        return fs.readFileSync(candidate);
                    }
                }
            }
        }
        catch (e) {
            console.warn("[pdfImageHelper] Local disk check for URL failed:", e);
        }
        // 2b. If not on local disk, fetch via HTTP
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 6000);
            const res = await fetch(trimmed, { signal: controller.signal });
            clearTimeout(timeoutId);
            if (res.ok) {
                const arrayBuf = await res.arrayBuffer();
                return Buffer.from(arrayBuf);
            }
            else {
                console.warn(`[pdfImageHelper] HTTP fetch returned status ${res.status} for ${trimmed}`);
            }
        }
        catch (e) {
            console.warn(`[pdfImageHelper] HTTP fetch error for ${trimmed}:`, e);
        }
    }
    // 3. Filesystem Path checking
    try {
        const rootDir = getStorageRoot();
        const cleanPath = trimmed.replace(/^\/?uploads\/?/, "");
        const candidates = [
            trimmed,
            path.resolve(trimmed),
            path.resolve(rootDir, trimmed),
            path.resolve(rootDir, cleanPath),
            path.resolve(process.cwd(), "uploads", cleanPath),
            path.resolve(process.cwd(), trimmed),
            path.resolve("/var/www/mmrconstructions-storage", cleanPath),
            path.resolve("/var/www/mmrconstructions-storage", trimmed)
        ];
        for (const candidate of candidates) {
            if (candidate && fs.existsSync(candidate)) {
                const stats = fs.statSync(candidate);
                if (stats.isFile() && stats.size > 0) {
                    return fs.readFileSync(candidate);
                }
            }
        }
    }
    catch (e) {
        console.warn("[pdfImageHelper] File disk lookup error:", e);
    }
    return null;
}
/**
 * Renders a photo slot in the PDF document from a resolved buffer or shows a placeholder.
 */
export function drawPhotoBoxWithBuffer(doc, label, x, y, buffer, boxWidth = 80, boxHeight = 100) {
    doc.lineWidth(1).strokeColor("#64748b").rect(x, y, boxWidth, boxHeight).stroke();
    let loaded = false;
    if (buffer && buffer.length > 0) {
        try {
            doc.image(buffer, x + 2, y + 2, { fit: [boxWidth - 4, boxHeight - 4], align: "center", valign: "center" });
            loaded = true;
        }
        catch (e) {
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
export function drawSignatureBoxWithBuffer(doc, label, x, y, buffer, boxWidth = 160, boxHeight = 65) {
    doc.lineWidth(1).strokeColor("#64748b").rect(x, y, boxWidth, boxHeight).stroke();
    let loaded = false;
    if (buffer && buffer.length > 0) {
        try {
            doc.image(buffer, x + 4, y + 4, { fit: [boxWidth - 8, boxHeight - 8], align: "center", valign: "center" });
            loaded = true;
        }
        catch (e) {
            console.warn(`[pdfImageHelper] doc.image signature failed for ${label}:`, e);
        }
    }
    doc.fillColor("#64748b").fontSize(7).font("Helvetica-Bold");
    doc.text(label, x, y + boxHeight + 4, { align: "center", width: boxWidth });
}
