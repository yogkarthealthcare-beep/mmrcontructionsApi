import "../config/loadEnv.js";
import fileStorageService, {
  getStorageRoot,
  saveFileToVPS,
  deleteFileFromStorage,
  generateSeoFilename,
  toSeoSlug,
  isCloudinaryUrl,
  isVpsStorageUrl,
  resolveModuleDirectory,
} from "../services/fileStorage.service.js";
import fs from "fs";
import path from "path";

async function runStorageArchitectureTests() {
  console.log("================================================================================");
  console.log("    TESTING VPS STORAGE ARCHITECTURE & SEO-FRIENDLY FILE NAMING                 ");
  console.log("================================================================================");

  // Test 1: SEO Slug Generator
  const rawSiteName = "MMR Green Valley - Phase 1 (Main Site)!";
  const slug = toSeoSlug(rawSiteName);
  console.log(`[Test 1] Raw Name: "${rawSiteName}" -> SEO Slug: "${slug}"`);
  if (slug !== "mmr-green-valley-phase-1-main-site") {
    throw new Error("SEO Slug generation failed!");
  }
  console.log("  -> SEO Slug Generator OK ✅");

  // Test 2: SEO Filename Generation
  const seoFilename = generateSeoFilename({
    brand: "MMR-Constructions",
    entityName: "Green Valley Phase 1",
    entityId: "SITE-101",
    purpose: "site-map",
    originalName: "IMG_0029.JPG",
    extension: "jpg",
  });
  console.log(`[Test 2] Generated SEO Filename: ${seoFilename}`);
  if (!seoFilename.startsWith("mmr-constructions-green-valley-phase-1-site-101-site-map")) {
    throw new Error("SEO Filename formatting failed!");
  }
  console.log("  -> SEO Filename Generation OK ✅");

  // Test 3: Project-Wise Directory Resolution
  const projectDir = resolveModuleDirectory("site", { entityId: "101", entityName: "Green Valley Phase 1", subCategory: "site-map" });
  console.log(`[Test 3] Project Directory Path: ${projectDir}`);
  if (projectDir.replace(/\\/g, "/") !== "projects/green-valley-phase-1/site-map") {
    throw new Error("Project-wise directory resolution failed!");
  }
  console.log("  -> Project/Site Directory Resolution OK ✅");

  // Test 4: Save Sample File with SEO Name
  const dummyBuffer = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64"
  ); // 1x1 PNG pixel

  const savedImage = await saveFileToVPS(dummyBuffer, {
    module: "site",
    entityId: "101",
    siteName: "Green Valley Phase 1",
    entityType: "SiteMap",
    originalName: "site_map.png",
    subCategory: "site-map",
  });
  console.log(`[Test 4] Saved Image URL: ${savedImage.url}`);
  console.log(`         Full File Path: ${savedImage.fullPath}`);

  if (!fs.existsSync(savedImage.fullPath)) {
    throw new Error("Saved file does not physically exist on VPS filesystem!");
  }
  console.log("  -> VPS File Save & Folder Creation OK ✅");

  // Test 5: Cloudinary vs VPS URL Detection
  const cloudinaryUrl = "https://res.cloudinary.com/mmrconstructions/image/upload/v12345/demo.jpg";
  const vpsUrl = savedImage.url;

  console.log(`[Test 5] Is Cloudinary URL? ${cloudinaryUrl} -> ${isCloudinaryUrl(cloudinaryUrl)}`);
  console.log(`         Is VPS URL? ${vpsUrl} -> ${isVpsStorageUrl(vpsUrl)}`);

  if (!isCloudinaryUrl(cloudinaryUrl) || !isVpsStorageUrl(vpsUrl)) {
    throw new Error("URL Detection logic failed!");
  }
  console.log("  -> Cloudinary / VPS Storage Detection OK ✅");

  // Test 6: Path Traversal Protection during Deletion
  const maliciousUrl = "/uploads/../../etc/passwd";
  const isMaliciousDeleted = await deleteFileFromStorage(maliciousUrl);
  if (isMaliciousDeleted) {
    throw new Error("Path traversal deletion vulnerability detected!");
  }
  console.log("  -> Path Traversal Protection during file deletion OK ✅");

  // Test 7: VPS File Deletion
  const isDeleted = await deleteFileFromStorage(savedImage.url);
  console.log(`[Test 7] Test File Deletion Result: ${isDeleted}`);
  if (fs.existsSync(savedImage.fullPath)) {
    throw new Error("File was not deleted from VPS filesystem!");
  }
  console.log("  -> VPS File Deletion OK ✅");

  console.log("================================================================================");
  console.log("🎉 ALL VPS STORAGE & SEO FILENAME TESTS PASSED SUCCESSFULLY!                    ");
  console.log("================================================================================");
}

runStorageArchitectureTests().catch((err) => {
  console.error("Test Error:", err);
  process.exit(1);
});
