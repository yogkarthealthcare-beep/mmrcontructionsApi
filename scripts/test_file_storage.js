import "../config/loadEnv.js";
import fileStorageService, {
  getStorageRoot,
  saveFileToVPS,
  deleteFileFromStorage,
  generateFilename,
  isCloudinaryUrl,
  isVpsStorageUrl,
  sanitizeName,
} from "../services/fileStorage.service.js";
import fs from "fs";
import path from "path";

async function runStorageArchitectureTests() {
  console.log("================================================================================");
  console.log("             TESTING NEW VPS FILE STORAGE ARCHITECTURE                          ");
  console.log("================================================================================");

  // Test 1: Storage Root Initialization
  const rootDir = getStorageRoot();
  console.log(`[Test 1] Storage Root Path: ${rootDir}`);
  if (!rootDir) throw new Error("Storage root initialization failed!");
  console.log("  -> Storage Root OK ✅");

  // Test 2: Filename Generation & Sanitization
  const filename = generateFilename({
    entityType: "Investor Profile",
    entityId: "INV-1001/../hacker",
    name: "Rahul Sharma & Family!",
    extension: "jpg",
  });
  console.log(`[Test 2] Generated Filename: ${filename}`);
  if (filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
    throw new Error("Filename sanitization failed to block path traversal!");
  }
  console.log("  -> Filename Sanitization & Path Traversal Guard OK ✅");

  // Test 3: Save Sample Image to VPS Storage (Module: Investors)
  const dummyBuffer = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64"
  ); // 1x1 PNG pixel

  const savedImage = await saveFileToVPS(dummyBuffer, {
    module: "investor",
    entityId: "INV-1001",
    entityType: "Investor",
    originalName: "profile_photo.png",
  });
  console.log(`[Test 3] Saved Image URL: ${savedImage.url}`);
  console.log(`         Full File Path: ${savedImage.fullPath}`);

  if (!fs.existsSync(savedImage.fullPath)) {
    throw new Error("Saved file does not physically exist on VPS filesystem!");
  }
  console.log("  -> VPS File Save & Folder Creation OK ✅");

  // Test 4: Cloudinary vs VPS URL Detection
  const cloudinaryUrl = "https://res.cloudinary.com/mmrconstructions/image/upload/v12345/demo.jpg";
  const vpsUrl = savedImage.url;

  console.log(`[Test 4] Is Cloudinary URL? ${cloudinaryUrl} -> ${isCloudinaryUrl(cloudinaryUrl)}`);
  console.log(`         Is VPS URL? ${vpsUrl} -> ${isVpsStorageUrl(vpsUrl)}`);

  if (!isCloudinaryUrl(cloudinaryUrl) || !isVpsStorageUrl(vpsUrl)) {
    throw new Error("URL Detection logic failed!");
  }
  console.log("  -> Cloudinary / VPS Storage Detection OK ✅");

  // Test 5: Safe Deletion & Path Traversal Block
  const maliciousUrl = "/uploads/../../etc/passwd";
  const isMaliciousDeleted = await deleteFileFromStorage(maliciousUrl);
  if (isMaliciousDeleted) {
    throw new Error("Path traversal deletion vulnerability detected!");
  }
  console.log("  -> Path Traversal Protection during file deletion OK ✅");

  // Delete test created file safely
  const isDeleted = await deleteFileFromStorage(savedImage.url);
  console.log(`[Test 5] Test File Deletion Result: ${isDeleted}`);
  if (fs.existsSync(savedImage.fullPath)) {
    throw new Error("File was not deleted from VPS filesystem!");
  }
  console.log("  -> VPS File Deletion OK ✅");

  console.log("================================================================================");
  console.log("🎉 ALL VPS FILE STORAGE TESTS PASSED SUCCESSFULLY!                             ");
  console.log("================================================================================");
}

runStorageArchitectureTests().catch((err) => {
  console.error("Test Error:", err);
  process.exit(1);
});
