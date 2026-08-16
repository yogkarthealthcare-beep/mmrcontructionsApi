import express from "express";
import "./config/loadEnv.js";
import cors from "cors";
import compression from "compression";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import sql, { getDatabaseConfig, supabaseSql } from "./db.js";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import multer from "multer";
import path from "path";
import fs from "fs/promises";
import crypto from "crypto";
import { fileURLToPath } from "url";
import xlsx from "xlsx";
import { v2 as cloudinary } from "cloudinary";
import { Readable } from "stream";
import newRoutes from './routes/newRoutes.js';
import authEmailRoutes from './routes/authEmailRoutes.js';
import paymentRoutes from './routes/payment.routes.js';
import walletRoutes from './routes/wallet.routes.js';
import bookingWorkflowRoutes from './routes/booking-workflow.routes.js';
import databaseBackupRoutes from './routes/database-backup.routes.js';
import whatsappRoutes, { whatsappEvents } from './routes/whatsapp.routes.js';
import investorRoutes from './routes/investor.routes.js';
import invoiceModuleRoutes from './routes/invoice-module.routes.js';
import fileStorageService, { saveFileToVPS, deleteFileFromStorage, getStorageRoot } from "./services/fileStorage.service.js";
import { startBackupScheduler } from "./services/databaseBackup.service.js";
import { sendEmail, otpEmailHtml, passwordChangedEmailHtml } from "./emailService.js";

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
const API_PROJECT_DIR = path.dirname(fileURLToPath(import.meta.url));
const isProduction = process.env.NODE_ENV === "production";

const defaultAllowedOrigins = [
  "http://localhost:4200",
  "http://127.0.0.1:4200",
  "https://mmrconstructions.in",
  "https://www.mmrconstructions.in",
  "https://api.mmrconstructions.in",
  "http://api.mmrconstructions.in",
  "https://mmrconstructions-adeb0.web.app",
  "https://mmrconstructions-adeb0.firebaseapp.com",
];
const envAllowedOrigins = (process.env.FRONTEND_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const allowedOrigins = [...new Set([...defaultAllowedOrigins, ...envAllowedOrigins])];

app.use(helmet({
  crossOriginResourcePolicy: false,
  contentSecurityPolicy: false,
}));
app.use(compression());

const containsSuspiciousMarkup = (value) =>
  typeof value === "string" && /<\s*script|javascript\s*:|on\w+\s*=|data\s*:\s*text\/html/i.test(value);

function rejectSuspiciousInput(req, res, next) {
  const stack = [req.body, req.query, req.params];
  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== "object") continue;
    for (const value of Object.values(current)) {
      if (containsSuspiciousMarkup(value)) {
        return res.status(400).json({ success: false, message: "Invalid input detected." });
      }
      if (value && typeof value === "object") stack.push(value);
    }
  }
  next();
}

const isAllowedOrigin = (origin) => {
  if (!origin) return true;
  if (allowedOrigins.includes(origin)) return true;
  if (/https?:\/\/(www\.|api\.)?mmrconstructions\.in$/i.test(origin)) return true;
  if (/https?:\/\/mmrconstructions-[a-z0-9]+\.(web\.app|firebaseapp\.com)$/i.test(origin)) return true;
  return false;
};

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Key, X-Requested-With, Accept");
  }

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  next();
});

app.use(cors({
  origin(origin, callback) {
    if (isAllowedOrigin(origin)) {
      return callback(null, true);
    }
    console.warn(`[CORS] Blocked origin: ${origin}`);
    return callback(null, true);
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-API-Key", "X-Requested-With", "Accept"],
  optionsSuccessStatus: 204,
}));




const rateLimitResponse = { success: false, message: "Too many requests. Please try again shortly." };
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5000,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: rateLimitResponse,
  skip: (req) => Boolean(req.headers.authorization),
});
const authLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 60,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: rateLimitResponse,
});
const publicFormLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 100,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: rateLimitResponse,
});
const uploadLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 150,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: rateLimitResponse,
});

app.use("/api", apiLimiter);
app.use("/api/auth", authLimiter);
app.use("/api/admin/auth", authLimiter);
app.use(["/api/book-plot/leads", "/api/inquiries"], publicFormLimiter);
app.use(["/api/profile/upload-doc"], uploadLimiter);

app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.set('Surrogate-Control', 'no-store');
  }
  next();
});

app.use(express.json({
  limit: "50mb",
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));
app.use(express.urlencoded({ extended: false, limit: "50mb" }));
app.use(["/api/book-plot/leads", "/api/inquiries"], rejectSuspiciousInput);
app.use("/uploads", (req, res) => {
  const rootDir = getStorageRoot();
  const safePath = path.normalize(req.path || "").replace(/^(\.\.[\/\\])+/, "").replace(/^\/+/, "");
  const targetPath = path.join(rootDir, safePath);

  if (!targetPath.startsWith(rootDir)) {
    return res.status(403).send("Forbidden");
  }

  res.sendFile(targetPath, (err) => {
    if (err && !res.headersSent) {
      res.status(404).send("File not found");
    }
  });
});

app.get("/api/health", (_req, res) => {
  return res.json({
    success: true,
    status: "healthy",
    service: "MMR Constructions API",
    timestamp: new Date().toISOString(),
    storage_root: getStorageRoot(),
  });
});

app.use('/api/auth', authEmailRoutes);
app.use('/api', newRoutes);
app.use('/api', paymentRoutes);
app.use('/api', walletRoutes);
app.use('/api', bookingWorkflowRoutes);
app.use('/api', databaseBackupRoutes);
app.use('/api', whatsappRoutes);
app.use('/api', investorRoutes);
app.use('/api', invoiceModuleRoutes);
// ─── Cloudinary Config ────────────────────────────────────────
const envValue = (key) => (process.env[key] || "").trim();
cloudinary.config({
  cloud_name: envValue("CLOUDINARY_CLOUD_NAME"),
  api_key:    envValue("CLOUDINARY_API_KEY"),
  api_secret: envValue("CLOUDINARY_API_SECRET"),
});

// ─── Folder mapping per fieldname ─────────────────────────────
const CLOUDINARY_FOLDER = {
  profile_photo: "mmr/profiles",
  payment_proof: "mmr/proofs",
  pan_card:      "mmr/documents",
  aadhar_card:   "mmr/documents",
  property_image:"mmr/site-images",
  site_map:      "mmr/site-maps",
  slider_image:  "mmr/home-sliders",
  book_plot_background: "mmr/book-plot-backgrounds",
  investor_profile: "mmr/investors",
  company_document: "mmr/company-documents",
  site_document: "mmr/site-documents",
  mobile_app_logo: "mmr/mobile-app",
  mobile_app_apk: "mmr/mobile-app/apk",
  document:      "mmr/documents",   // generic upload-doc
};

/**
 * Buffer ko Cloudinary par upload karo
 * @param {Buffer} buffer
 * @param {string} folder  - Cloudinary folder
 * @param {string} filename - original file name (extension ke liye)
 * @returns {Promise<{url: string, public_id: string}>}
 */
function uploadToCloudinary(buffer, folder, filename) {
  return new Promise((resolve, reject) => {
    const ext         = path.extname(filename).toLowerCase().replace(".", "");
    const isPdf       = ext === "pdf";
    const isApk       = ext === "apk";
    const isSiteMapPdf = isPdf && folder === CLOUDINARY_FOLDER.site_map;
    const resourceType = (isPdf && !isSiteMapPdf) || isApk ? "raw" : "image";
    const cloudinaryConfig = {
      cloudName: envValue("CLOUDINARY_CLOUD_NAME"),
      apiKey: envValue("CLOUDINARY_API_KEY"),
      apiSecret: envValue("CLOUDINARY_API_SECRET"),
    };

    if (!cloudinaryConfig.cloudName || !cloudinaryConfig.apiKey || !cloudinaryConfig.apiSecret) {
      return reject(new Error("Cloudinary configuration missing. Check CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET."));
    }

    const publicId = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
    const timestamp = Math.floor(Date.now() / 1000);
    const paramsToSign = {
      folder,
      public_id: publicId,
      timestamp,
      ...(isPdf ? { format: "pdf" } : {}),
    };
    const signature = cloudinary.utils.api_sign_request(paramsToSign, cloudinaryConfig.apiSecret);
    const uploadOptions = {
      folder,
      resource_type: resourceType,
      public_id: publicId,
      timestamp,
      ...(isPdf ? { format: "pdf" } : {}),
    };

    if (!isProduction) {
      console.log("[Cloudinary Upload]", {
        folder,
        resource_type: resourceType,
        file_name: filename,
        file_size: buffer.length,
      });
    }

    const stream = cloudinary.uploader.upload_stream(
      uploadOptions,
      (error, result) => {
        if (error) {
          console.error("[Cloudinary Upload Error]", {
            message: error.message,
            http_code: error.http_code,
            folder,
            resource_type: resourceType,
            file_name: filename,
            file_size: buffer.length,
          });

          if (/invalid signature/i.test(error.message || "")) {
            return reject(new Error("Image upload failed. Please try again."));
          }
          if (/timestamp/i.test(error.message || "")) {
            return reject(new Error("Image upload failed. Please try again."));
          }
          return reject(new Error("Image upload failed. Please try again."));
        }
        resolve({ url: result.secure_url, public_id: result.public_id });
      }
    );

    Readable.from(buffer).pipe(stream);
  });
}

// ─── Multer — memory storage (disk nahi, seedha buffer mein) ──
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB
  fileFilter: (req, file, cb) => {
    if (file.fieldname === "html_map") {
      const allowedHtml = path.extname(file.originalname || "").toLowerCase() === ".html";
      return allowedHtml ? cb(null, true) : cb(new Error("Only HTML files are allowed for plot map upload."));
    }
    const isSiteMap = file.fieldname === "site_map";
    const isSiteImage = ["site_map", "property_image", "slider_image"].includes(file.fieldname);
    const isCompanyDocument = file.fieldname === "company_document";
    const allowed = isSiteMap ? /jpeg|jpg|png|pdf|svg/ : isSiteImage ? /jpeg|jpg|png|webp/ : /jpeg|jpg|png|webp|pdf/;
    allowed.test(path.extname(file.originalname).toLowerCase())
      ? cb(null, true)
      : cb(new Error(
          isSiteMap
            ? "Only JPG, JPEG, PNG, PDF, and SVG files are allowed."
            : isSiteImage
            ? "Only JPG, JPEG, and PNG files are allowed."
            : isCompanyDocument
              ? "Only JPG, JPEG, PNG, WEBP, and PDF files are allowed."
              : "Only JPG, PNG, WEBP, and PDF files are allowed."
        ));
  },
});

const plotImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

const importUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 3 * 1024 * 1024, files: 1, fields: 10 },
  fileFilter: (_req, file, cb) => {
    const allowedExt = [".xlsx", ".csv"];
    const allowedMime = [
      "text/csv",
      "application/csv",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ];
    const ext = path.extname(file.originalname || "").toLowerCase();
    allowedExt.includes(ext) && (!file.mimetype || allowedMime.includes(file.mimetype))
      ? cb(null, true)
      : cb(new Error("Only .xlsx and .csv files are allowed."));
  },
});

const companyAssetUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedExt = [".jpg", ".jpeg", ".png", ".ico"];
    const allowedMime = ["image/jpeg", "image/png", "image/x-icon", "image/vnd.microsoft.icon"];
    const ext = path.extname(file.originalname || "").toLowerCase();
    allowedExt.includes(ext) && allowedMime.includes(file.mimetype)
      ? cb(null, true)
      : cb(new Error("Only JPG, JPEG, PNG, and ICO files are allowed."));
  },
});

const mobileAppLogoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowedExt = [".jpg", ".jpeg", ".png", ".svg", ".webp"];
    const allowedMime = ["image/jpeg", "image/png", "image/svg+xml", "image/webp"];
    const ext = path.extname(file.originalname || "").toLowerCase();
    allowedExt.includes(ext) && allowedMime.includes(file.mimetype)
      ? cb(null, true)
      : cb(new Error("Only PNG, SVG, JPG, JPEG, and WEBP app logos are allowed."));
  },
});

const mobileAppApkUpload = multer({
  storage: multer.diskStorage({
    destination: async (_req, _file, cb) => {
      try {
        const apkDir = mobileAppApkDir();
        await fs.mkdir(apkDir, { recursive: true });
        cb(null, apkDir);
      } catch (error) {
        cb(error);
      }
    },
    filename: (_req, file, cb) => {
      cb(null, `${Date.now()}-${safeApkFileName(file.originalname || "mmr-app.apk")}`);
    },
  }),
  limits: { fileSize: 120 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    const allowedMime = [
      "application/vnd.android.package-archive",
      "application/octet-stream",
      "application/x-zip-compressed",
      "application/zip",
    ];
    ext === ".apk" && (!file.mimetype || allowedMime.includes(file.mimetype))
      ? cb(null, true)
      : cb(new Error("Only Android .apk files are allowed."));
  },
});

const siteDocumentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowedExt = [".pdf", ".jpg", ".jpeg", ".png"];
    const allowedMime = ["application/pdf", "image/jpeg", "image/png"];
    const ext = path.extname(file.originalname || "").toLowerCase();
    allowedExt.includes(ext) && allowedMime.includes(file.mimetype)
      ? cb(null, true)
      : cb(new Error("Only PDF, JPG, JPEG, and PNG files are allowed."));
  },
});

/* ==========================
   HELPERS
========================== */
const ok  = (res, data, msg = "Success", status = 200) =>
  res.status(status).json({ success: true,  message: msg, data });

const INTERNAL_ERROR_PATTERN =
  /(postgres|database|sql|relation|column|constraint|cloudinary|syntax|enoent|econn|enotfound|connection string|api[_ -]?key)/i;
const publicErrorMessage = (msg, status = 400) => {
  const text = String(msg || "Request failed").trim();
  if (!text) return status >= 500 ? "Unable to process request right now." : "Invalid request.";
  if (status >= 500 && INTERNAL_ERROR_PATTERN.test(text)) {
    return "Unable to process request right now.";
  }
  return text.slice(0, 240);
};
const err = (res, msg = "Request failed", status = 400) =>
  res.status(status).json({ success: false, message: publicErrorMessage(msg, status) });

const adminJwtSecret = () => process.env.JWT_ADMIN_SECRET || process.env.JWT_SECRET || "mmr_constructions_jwt_secret_2026_key";
const parseBool = (value, fallback = false) => {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return ["true", "1", "yes", "on"].includes(String(value).toLowerCase());
};

let companyDocumentsSchemaPromise;
function ensureCompanyDocumentsSchema() {
  if (!companyDocumentsSchemaPromise) {
    companyDocumentsSchemaPromise = (async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS company_documents (
          id SERIAL PRIMARY KEY,
          document_name VARCHAR(180) NOT NULL,
          document_name_hi VARCHAR(180),
          document_description TEXT,
          document_description_hi TEXT,
          document_type VARCHAR(100),
          document_type_hi VARCHAR(100),
          file_url TEXT NOT NULL,
          file_public_id TEXT,
          file_data BYTEA,
          file_type VARCHAR(20) NOT NULL,
          mime_type VARCHAR(120),
          original_file_name VARCHAR(255),
          file_size_bytes BIGINT,
          display_order INTEGER NOT NULL DEFAULT 0,
          is_active BOOLEAN NOT NULL DEFAULT TRUE,
          created_by_admin_id INTEGER,
          updated_by_admin_id INTEGER,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`;
      await sql`
        CREATE INDEX IF NOT EXISTS idx_company_documents_active_order
        ON company_documents (is_active, display_order, id)`;
      await sql`ALTER TABLE company_documents ADD COLUMN IF NOT EXISTS file_data BYTEA`;
      await sql`ALTER TABLE company_documents ADD COLUMN IF NOT EXISTS document_name_hi VARCHAR(180)`;
      await sql`ALTER TABLE company_documents ADD COLUMN IF NOT EXISTS document_description_hi TEXT`;
      await sql`ALTER TABLE company_documents ADD COLUMN IF NOT EXISTS document_type_hi VARCHAR(100)`;
      await sql`ALTER TABLE company_documents ALTER COLUMN file_url DROP NOT NULL`;
    })().catch((error) => {
      companyDocumentsSchemaPromise = null;
      throw error;
    });
  }
  return companyDocumentsSchemaPromise;
}

const asNumberOrNull = (value) => {
  if (value === undefined || value === null || value === "") return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
};

let homeSlidersReady;
const ensureHomeSlidersSchema = () => {
  if (!homeSlidersReady) {
    homeSlidersReady = (async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS home_sliders (
          id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
          title TEXT NOT NULL,
          subtitle TEXT,
          description TEXT,
          image_url TEXT NOT NULL,
          image_public_id TEXT,
          button_text TEXT,
          button_link TEXT,
          button_icon TEXT,
          button2_text TEXT,
          button2_link TEXT,
          button2_icon TEXT,
          tag_text TEXT,
          tag_icon TEXT,
          thumbnail_url TEXT,
          thumbnail_title TEXT,
          thumbnail_subtitle TEXT,
          stats_json JSONB NOT NULL DEFAULT '[]'::jsonb,
          show_image BOOLEAN NOT NULL DEFAULT TRUE,
          show_tag BOOLEAN NOT NULL DEFAULT TRUE,
          show_title BOOLEAN NOT NULL DEFAULT TRUE,
          show_subtitle BOOLEAN NOT NULL DEFAULT TRUE,
          show_description BOOLEAN NOT NULL DEFAULT TRUE,
          show_button1 BOOLEAN NOT NULL DEFAULT TRUE,
          show_button2 BOOLEAN NOT NULL DEFAULT TRUE,
          show_stats BOOLEAN NOT NULL DEFAULT TRUE,
          show_thumbnail BOOLEAN NOT NULL DEFAULT TRUE,
          display_order INTEGER NOT NULL DEFAULT 0,
          is_active BOOLEAN NOT NULL DEFAULT TRUE,
          created_by_admin_id INTEGER,
          updated_by_admin_id INTEGER,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`;
      await sql`CREATE SEQUENCE IF NOT EXISTS home_sliders_id_seq`;
      await sql`ALTER TABLE home_sliders ALTER COLUMN id SET DEFAULT nextval('home_sliders_id_seq')`;
      await sql`ALTER TABLE home_sliders ADD COLUMN IF NOT EXISTS button_icon TEXT`;
      await sql`ALTER TABLE home_sliders ADD COLUMN IF NOT EXISTS button2_text TEXT`;
      await sql`ALTER TABLE home_sliders ADD COLUMN IF NOT EXISTS button2_link TEXT`;
      await sql`ALTER TABLE home_sliders ADD COLUMN IF NOT EXISTS button2_icon TEXT`;
      await sql`ALTER TABLE home_sliders ADD COLUMN IF NOT EXISTS tag_text TEXT`;
      await sql`ALTER TABLE home_sliders ADD COLUMN IF NOT EXISTS tag_icon TEXT`;
      await sql`ALTER TABLE home_sliders ADD COLUMN IF NOT EXISTS thumbnail_url TEXT`;
      await sql`ALTER TABLE home_sliders ADD COLUMN IF NOT EXISTS thumbnail_title TEXT`;
      await sql`ALTER TABLE home_sliders ADD COLUMN IF NOT EXISTS thumbnail_subtitle TEXT`;
      await sql`ALTER TABLE home_sliders ADD COLUMN IF NOT EXISTS stats_json JSONB NOT NULL DEFAULT '[]'::jsonb`;
      await sql`ALTER TABLE home_sliders ADD COLUMN IF NOT EXISTS show_image BOOLEAN NOT NULL DEFAULT TRUE`;
      await sql`ALTER TABLE home_sliders ADD COLUMN IF NOT EXISTS show_tag BOOLEAN NOT NULL DEFAULT TRUE`;
      await sql`ALTER TABLE home_sliders ADD COLUMN IF NOT EXISTS show_title BOOLEAN NOT NULL DEFAULT TRUE`;
      await sql`ALTER TABLE home_sliders ADD COLUMN IF NOT EXISTS show_subtitle BOOLEAN NOT NULL DEFAULT TRUE`;
      await sql`ALTER TABLE home_sliders ADD COLUMN IF NOT EXISTS show_description BOOLEAN NOT NULL DEFAULT TRUE`;
      await sql`ALTER TABLE home_sliders ADD COLUMN IF NOT EXISTS show_button1 BOOLEAN NOT NULL DEFAULT TRUE`;
      await sql`ALTER TABLE home_sliders ADD COLUMN IF NOT EXISTS show_button2 BOOLEAN NOT NULL DEFAULT TRUE`;
      await sql`ALTER TABLE home_sliders ADD COLUMN IF NOT EXISTS show_stats BOOLEAN NOT NULL DEFAULT TRUE`;
      await sql`ALTER TABLE home_sliders ADD COLUMN IF NOT EXISTS show_thumbnail BOOLEAN NOT NULL DEFAULT TRUE`;
      await sql`
        CREATE INDEX IF NOT EXISTS idx_home_sliders_active_order
        ON home_sliders (display_order ASC, id ASC)
        WHERE is_active = TRUE`;
    })();
  }
  return homeSlidersReady;
};

let homeExperienceReady;
const ensureHomeExperienceSchema = () => {
  if (!homeExperienceReady) {
    homeExperienceReady = (async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS home_page_settings (
          id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
          display_type VARCHAR(20) NOT NULL DEFAULT 'hero_slider'
            CHECK (display_type IN ('hero_slider')),
          show_hero_slider BOOLEAN NOT NULL DEFAULT TRUE,
          show_information_section BOOLEAN NOT NULL DEFAULT TRUE,
          section_visibility JSONB NOT NULL DEFAULT '{"investors":true,"sites":true,"why_choose":true,"emi_calculator":true,"buyback":true,"earn":true,"facilities":true,"cta":true,"contact":true}'::jsonb,
          is_active BOOLEAN NOT NULL DEFAULT TRUE,
          is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`;
      await sql`
        INSERT INTO home_page_settings (id)
        VALUES (1) ON CONFLICT (id) DO NOTHING`;
      await sql`ALTER TABLE home_page_settings ADD COLUMN IF NOT EXISTS show_hero_slider BOOLEAN NOT NULL DEFAULT TRUE`;
      await sql`ALTER TABLE home_page_settings ADD COLUMN IF NOT EXISTS section_visibility JSONB NOT NULL DEFAULT '{"investors":true,"sites":true,"why_choose":true,"emi_calculator":true,"buyback":true,"earn":true,"facilities":true,"cta":true,"contact":true}'::jsonb`;
      await sql`UPDATE home_page_settings SET display_type = 'hero_slider', show_hero_slider = TRUE, section_visibility = section_visibility - 'hero_book_now' - 'hero_site_slider' WHERE id = 1`;
      await sql`
        CREATE TABLE IF NOT EXISTS investors (
          id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
          name VARCHAR(160) NOT NULL,
          profile_image_url TEXT NOT NULL,
          profile_image_public_id TEXT,
          designation VARCHAR(160),
          short_description TEXT,
          display_order INTEGER NOT NULL DEFAULT 0,
          is_active BOOLEAN NOT NULL DEFAULT TRUE,
          is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`;
      await sql`CREATE SEQUENCE IF NOT EXISTS investors_id_seq`;
      await sql`ALTER TABLE investors ALTER COLUMN id SET DEFAULT nextval('investors_id_seq')`;
      await sql`ALTER SEQUENCE investors_id_seq OWNED BY investors.id`;
      await sql`CREATE INDEX IF NOT EXISTS idx_investors_public_order ON investors(display_order, created_at) WHERE is_active = TRUE AND is_deleted = FALSE`;
      await sql`
        CREATE TABLE IF NOT EXISTS book_plot_background_images (
          id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
          image_url TEXT NOT NULL,
          image_public_id TEXT,
          alt_text VARCHAR(180),
          display_order INTEGER NOT NULL DEFAULT 0,
          is_active BOOLEAN NOT NULL DEFAULT TRUE,
          is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`;
      await sql`
        CREATE INDEX IF NOT EXISTS idx_book_plot_background_active
        ON book_plot_background_images (display_order, id)
        WHERE is_active = TRUE AND is_deleted = FALSE`;
      await sql`
        CREATE TABLE IF NOT EXISTS book_plot_leads (
          id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
          inquiry_number VARCHAR(32) UNIQUE,
          full_name VARCHAR(160) NOT NULL,
          contact_number VARCHAR(15) NOT NULL,
          site_id INTEGER REFERENCES sites(site_id) ON DELETE SET NULL,
          custom_site_name VARCHAR(180),
          user_id INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
          status VARCHAR(20) NOT NULL DEFAULT 'New'
            CHECK (status IN ('New', 'Contacted', 'Follow Up', 'Converted', 'Closed')),
          is_active BOOLEAN NOT NULL DEFAULT TRUE,
          is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`;
      await sql`CREATE INDEX IF NOT EXISTS idx_book_plot_leads_created ON book_plot_leads (created_at DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS idx_book_plot_leads_status ON book_plot_leads (status, created_at DESC)`;
    })().catch((error) => {
      homeExperienceReady = null;
      throw error;
    });
  }
  return homeExperienceReady;
};

const publicApiCache = new Map();
const getCachedOrFetch = async (key, ttlMs, fetchFn) => {
  const now = Date.now();
  const cached = publicApiCache.get(key);
  if (cached && (now - cached.timestamp < ttlMs)) {
    return cached.data;
  }
  const data = await fetchFn();
  publicApiCache.set(key, { data, timestamp: now });
  return data;
};
const invalidateApiCache = (prefix = '') => {
  for (const key of publicApiCache.keys()) {
    if (!prefix || key.startsWith(prefix)) publicApiCache.delete(key);
  }
};

const optionalUserToken = async (req, _res, next) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return next();
  try {
    const decoded = jwt.verify(auth.slice(7), process.env.JWT_SECRET);
    const [user] = await sql`SELECT user_id FROM users WHERE user_id = ${decoded.user_id} AND is_active = TRUE`;
    if (user) req.user = { ...decoded, ...user };
  } catch { /* Invalid optional credentials are treated as a guest submission. */ }
  return next();
};

const normalizeSliderLink = (value) => {
  const link = String(value || "").trim();
  if (!link) return null;
  if (/^javascript:/i.test(link)) return null;
  return link;
};

const parseSliderStats = (value) => {
  if (!value) return [];
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, 3).map((item) => ({
      num: String(item?.num || "").trim(),
      lbl: String(item?.lbl || "").trim(),
    })).filter((item) => item.num || item.lbl);
  } catch {
    return [];
  }
};

const normalizeHeroFieldVisibility = (value) => {
  let source = value && typeof value === "object" ? value : {};
  if (typeof value === "string" && value.trim()) {
    try { source = JSON.parse(value); } catch { source = {}; }
  }
  return Object.fromEntries([
    "tagline", "director_name", "contact_number", "secondary_contact",
    "whatsapp_number", "form_title", "submit_button_text",
  ].map((key) => [key, parseBool(source[key], true)]));
};

const normalizeHeroSliderImages = (value, fallbackUrl = null, fallbackPublicId = null) => {
  const source = Array.isArray(value) ? value : [];
  const images = source
    .map((item) => ({
      url: String(item?.url || item?.image_url || "").trim(),
      public_id: String(item?.public_id || item?.image_public_id || "").trim() || null,
      name: String(item?.name || item?.original_name || "").trim() || null,
    }))
    .filter((item) => item.url);
  if (!images.length && fallbackUrl) {
    images.push({ url: fallbackUrl, public_id: fallbackPublicId || null, name: null });
  }
  return images;
};

const defaultCompanySettings = {
  company_name: "M.M.R. Constructions",
  company_logo_url: null,
  company_address: "Neel Kanth Market, Ramadevi, Kanpur, Uttar Pradesh",
  company_email: null,
  company_phone: "+91 70719 51011",
  company_whatsapp: "+91 70719 51011",
  company_website: "https://mmrconstructions.in",
  company_description: "Premium affordable plots in Kanpur, Unnao & Lucknow with buyback guarantee and 12-year commission program.",
  support_email: "support@mmrconstructions.com",
  support_phone: "+91 70719 51011",
  facebook_url: null,
  instagram_url: null,
  twitter_url: null,
  youtube_url: null,
  linkedin_url: null,
  favicon_url: null,
  gst_number: null,
  pan_number: null,
  copyright_text: "© 2024 M.M.R. Constructions & Developers Pvt. Ltd. All Rights Reserved.",
  is_active: true,
};

const companySettingsFields = Object.keys(defaultCompanySettings).filter((key) => key !== "is_active");

let companySettingsReady;
const ensureCompanySettingsSchema = () => {
  if (!companySettingsReady) {
    companySettingsReady = (async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS company_settings (
          id SERIAL PRIMARY KEY,
          company_name TEXT,
          company_logo_url TEXT,
          company_address TEXT,
          company_email TEXT,
          company_phone TEXT,
          company_whatsapp TEXT,
          company_website TEXT,
          company_description TEXT,
          support_email TEXT,
          support_phone TEXT,
          facebook_url TEXT,
          instagram_url TEXT,
          twitter_url TEXT,
          youtube_url TEXT,
          linkedin_url TEXT,
          favicon_url TEXT,
          gst_number TEXT,
          pan_number TEXT,
          copyright_text TEXT,
          is_active BOOLEAN NOT NULL DEFAULT TRUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`;
      const [existing] = await sql`SELECT id FROM company_settings WHERE is_active = TRUE ORDER BY id LIMIT 1`;
      if (!existing) {
        await sql`
          INSERT INTO company_settings (
            company_name, company_logo_url, company_address, company_email, company_phone,
            company_whatsapp, company_website, company_description, support_email, support_phone,
            facebook_url, instagram_url, twitter_url, youtube_url, linkedin_url, favicon_url,
            gst_number, pan_number, copyright_text, is_active
          ) VALUES (
            ${defaultCompanySettings.company_name}, ${defaultCompanySettings.company_logo_url},
            ${defaultCompanySettings.company_address}, ${defaultCompanySettings.company_email},
            ${defaultCompanySettings.company_phone}, ${defaultCompanySettings.company_whatsapp},
            ${defaultCompanySettings.company_website}, ${defaultCompanySettings.company_description},
            ${defaultCompanySettings.support_email}, ${defaultCompanySettings.support_phone},
            ${defaultCompanySettings.facebook_url}, ${defaultCompanySettings.instagram_url},
            ${defaultCompanySettings.twitter_url}, ${defaultCompanySettings.youtube_url},
            ${defaultCompanySettings.linkedin_url}, ${defaultCompanySettings.favicon_url},
            ${defaultCompanySettings.gst_number}, ${defaultCompanySettings.pan_number},
            ${defaultCompanySettings.copyright_text}, TRUE
          )`;
      }
    })();
  }
  return companySettingsReady;
};

const getCompanySettingsRow = async () => {
  await ensureCompanySettingsSchema();
  const [row] = await sql`SELECT * FROM company_settings WHERE is_active = TRUE ORDER BY id LIMIT 1`;
  return { ...defaultCompanySettings, ...(row || {}) };
};

const defaultBuybackTerms = {
  title: "बायबैक ऑफर एवं नियम व शर्तें",
  summary: "M.M.R. Constructions and Developers Pvt. Ltd. के प्लॉट बायबैक ऑफर, बुकिंग, रजिस्ट्री और भुगतान से संबंधित नियम ध्यानपूर्वक पढ़ें।",
  content: `बायबैक ऑफर की शर्तें

1. यदि ग्राहक 100 गज के प्लॉट की रजिस्ट्री 2 वर्ष के अंदर करवा लेता है और बाद में अपना प्लॉट पुनः कंपनी को बेचना चाहता है, तो कंपनी ग्राहक को उसके मूलधन के साथ ₹1,00,000 अतिरिक्त देगी।

2. यदि किसी प्लॉट उपभोक्ता (ग्राहक) के साथ ऐसी दुर्घटना हो जाती है, जिसके कारण वह किस्तें देने में असमर्थ हो जाए अथवा दुर्घटना में उसका निधन हो जाए, और ग्राहक ने कम से कम 18 महीने तक किस्तें जमा की हों, तो शेष किस्तें कंपनी माफ कर देगी। इसके बाद ग्राहक के नामित व्यक्ति/कानूनी वारिस को रजिस्ट्री, दाखिल-खारिज और कब्जा प्रदान किया जाएगा।

3. यदि कोई ग्राहक एकमुश्त भुगतान करके तुरंत रजिस्ट्री करवाता है, तो उसकी रजिस्ट्री का खर्च कंपनी वहन करेगी।

4. फाइनेंस सुविधा के लिए ₹499 फाइल चार्ज देय होगा।

नियम एवं शर्तें

1. प्लॉट की बुकिंग केवल कंपनी के अधिकृत कार्यालय में ही की जाएगी।

2. प्लॉट बुक करने के बाद बुकिंग राशि केवल उस स्थिति में वापस की जाएगी, जब ग्राहक किसी आकस्मिक दुर्घटना के कारण स्थायी रूप से दिव्यांग/विकलांग हो जाए। अन्य किसी स्थिति में बुकिंग राशि वापस नहीं होगी; ग्राहक को बुक किया गया प्लॉट ही प्रदान किया जाएगा।

3. 100 गज का प्लॉट बुक करने के लिए ₹1,00,000 डाउन पेमेंट (DP) देय होगा।

4. 50 गज का प्लॉट बुक करने के लिए ₹51,000 डाउन पेमेंट (DP) देय होगा।

5. किस्त का भुगतान विलंब से होने पर लागू विलंब शुल्क देय होगा।

6. पात्रता और संबंधित बैंक की स्वीकृति के अधीन बैंक फाइनेंस सुविधा उपलब्ध है।

महत्वपूर्ण सूचना: सभी लाभ और दावे ग्राहक के भुगतान रिकॉर्ड, बुकिंग दस्तावेज, पहचान, नामांकन तथा कंपनी के अभिलेखों के सत्यापन के अधीन होंगे। हस्ताक्षरित बुकिंग/विक्रय अनुबंध की शर्तें अंतिम और प्रभावी मानी जाएंगी।`,
};

let buybackTermsReady;
const ensureBuybackTermsSchema = () => {
  if (!buybackTermsReady) {
    buybackTermsReady = (async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS buyback_terms (
          id SERIAL PRIMARY KEY,
          title TEXT NOT NULL,
          summary TEXT,
          content TEXT NOT NULL,
          updated_by_admin_id INTEGER,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`;
      const [existing] = await sql`SELECT id FROM buyback_terms ORDER BY id LIMIT 1`;
      if (!existing) {
        await sql`
          INSERT INTO buyback_terms (title, summary, content)
          VALUES (
            ${defaultBuybackTerms.title},
            ${defaultBuybackTerms.summary},
            ${defaultBuybackTerms.content}
          )`;
      }
    })();
  }
  return buybackTermsReady;
};

const getBuybackTermsRow = async () => {
  await ensureBuybackTermsSchema();
  const [row] = await sql`
    SELECT id, title, summary, content, created_at, updated_at
    FROM buyback_terms
    ORDER BY id
    LIMIT 1`;
  return { ...defaultBuybackTerms, ...(row || {}) };
};

const normalizeCompanyPayload = (body = {}) => {
  const normalized = {};
  for (const field of companySettingsFields) {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      normalized[field] = body[field] === "" ? null : body[field];
    }
  }
  return normalized;
};

const defaultMobileAppSettings = {
  platform: "google_play",
  app_name: "MMR Constructions",
  app_logo_url: null,
  app_logo_public_id: null,
  play_store_url: null,
  package_name: null,
  current_version: null,
  latest_version: null,
  version_code: null,
  release_notes: null,
  download_mode: "apk",
  apk_url: null,
  apk_public_id: null,
  apk_file_name: null,
  apk_file_size_bytes: null,
  apk_uploaded_at: null,
  release_date: null,
  description: null,
  button_text: "Download App",
  badge_text: "Google Play",
  is_enabled: false,
  is_coming_soon: true,
  force_download: true,
  open_target: "_blank",
  display_order: 1,
};

let mobileAppSettingsReady;
const ensureMobileAppSettingsSchema = () => {
  if (!mobileAppSettingsReady) {
    mobileAppSettingsReady = (async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS mobile_app_settings (
          id SERIAL PRIMARY KEY,
          platform TEXT NOT NULL DEFAULT 'google_play',
          app_name TEXT NOT NULL DEFAULT 'MMR Constructions',
          app_logo_url TEXT,
          app_logo_public_id TEXT,
          play_store_url TEXT,
          package_name TEXT,
          current_version TEXT,
          latest_version TEXT,
          version_code TEXT,
          release_notes TEXT,
          download_mode TEXT NOT NULL DEFAULT 'apk',
          apk_url TEXT,
          apk_public_id TEXT,
          apk_file_name TEXT,
          apk_file_size_bytes BIGINT,
          apk_uploaded_at TIMESTAMPTZ,
          release_date DATE,
          description TEXT,
          button_text TEXT NOT NULL DEFAULT 'Download App',
          badge_text TEXT NOT NULL DEFAULT 'Google Play',
          is_enabled BOOLEAN NOT NULL DEFAULT FALSE,
          is_coming_soon BOOLEAN NOT NULL DEFAULT TRUE,
          force_download BOOLEAN NOT NULL DEFAULT TRUE,
          open_target TEXT NOT NULL DEFAULT '_blank',
          display_order INTEGER NOT NULL DEFAULT 1,
          updated_by_admin_id INTEGER,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`;
      await sql`ALTER TABLE mobile_app_settings ADD COLUMN IF NOT EXISTS platform TEXT NOT NULL DEFAULT 'google_play'`;
      await sql`ALTER TABLE mobile_app_settings ADD COLUMN IF NOT EXISTS app_logo_public_id TEXT`;
      await sql`ALTER TABLE mobile_app_settings ADD COLUMN IF NOT EXISTS current_version TEXT`;
      await sql`ALTER TABLE mobile_app_settings ADD COLUMN IF NOT EXISTS latest_version TEXT`;
      await sql`ALTER TABLE mobile_app_settings ADD COLUMN IF NOT EXISTS version_code TEXT`;
      await sql`ALTER TABLE mobile_app_settings ADD COLUMN IF NOT EXISTS release_notes TEXT`;
      await sql`ALTER TABLE mobile_app_settings ADD COLUMN IF NOT EXISTS download_mode TEXT NOT NULL DEFAULT 'apk'`;
      await sql`ALTER TABLE mobile_app_settings ADD COLUMN IF NOT EXISTS apk_url TEXT`;
      await sql`ALTER TABLE mobile_app_settings ADD COLUMN IF NOT EXISTS apk_public_id TEXT`;
      await sql`ALTER TABLE mobile_app_settings ADD COLUMN IF NOT EXISTS apk_file_name TEXT`;
      await sql`ALTER TABLE mobile_app_settings ADD COLUMN IF NOT EXISTS apk_file_size_bytes BIGINT`;
      await sql`ALTER TABLE mobile_app_settings ADD COLUMN IF NOT EXISTS apk_uploaded_at TIMESTAMPTZ`;
      await sql`ALTER TABLE mobile_app_settings ADD COLUMN IF NOT EXISTS release_date DATE`;
      await sql`ALTER TABLE mobile_app_settings ADD COLUMN IF NOT EXISTS badge_text TEXT NOT NULL DEFAULT 'Google Play'`;
      await sql`ALTER TABLE mobile_app_settings ADD COLUMN IF NOT EXISTS is_coming_soon BOOLEAN NOT NULL DEFAULT TRUE`;
      await sql`ALTER TABLE mobile_app_settings ADD COLUMN IF NOT EXISTS force_download BOOLEAN NOT NULL DEFAULT TRUE`;
      await sql`ALTER TABLE mobile_app_settings ADD COLUMN IF NOT EXISTS open_target TEXT NOT NULL DEFAULT '_blank'`;
      await sql`ALTER TABLE mobile_app_settings ADD COLUMN IF NOT EXISTS display_order INTEGER NOT NULL DEFAULT 1`;
      await sql`ALTER TABLE mobile_app_settings ADD COLUMN IF NOT EXISTS updated_by_admin_id INTEGER`;
      const [existing] = await sql`SELECT id FROM mobile_app_settings ORDER BY display_order ASC, id ASC LIMIT 1`;
      if (!existing) {
        await sql`
          INSERT INTO mobile_app_settings (
            platform, app_name, app_logo_url, app_logo_public_id, play_store_url,
            package_name, current_version, latest_version, version_code, release_notes,
            download_mode, apk_url, apk_public_id, apk_file_name, apk_file_size_bytes,
            apk_uploaded_at, release_date, description, button_text, badge_text,
            is_enabled, is_coming_soon, force_download, open_target, display_order
          ) VALUES (
            ${defaultMobileAppSettings.platform}, ${defaultMobileAppSettings.app_name},
            ${defaultMobileAppSettings.app_logo_url}, ${defaultMobileAppSettings.app_logo_public_id},
            ${defaultMobileAppSettings.play_store_url}, ${defaultMobileAppSettings.package_name},
            ${defaultMobileAppSettings.current_version}, ${defaultMobileAppSettings.latest_version},
            ${defaultMobileAppSettings.version_code}, ${defaultMobileAppSettings.release_notes},
            ${defaultMobileAppSettings.download_mode}, ${defaultMobileAppSettings.apk_url},
            ${defaultMobileAppSettings.apk_public_id}, ${defaultMobileAppSettings.apk_file_name},
            ${defaultMobileAppSettings.apk_file_size_bytes}, ${defaultMobileAppSettings.apk_uploaded_at},
            ${defaultMobileAppSettings.release_date}, ${defaultMobileAppSettings.description},
            ${defaultMobileAppSettings.button_text}, ${defaultMobileAppSettings.badge_text},
            ${defaultMobileAppSettings.is_enabled}, ${defaultMobileAppSettings.is_coming_soon},
            ${defaultMobileAppSettings.force_download},
            ${defaultMobileAppSettings.open_target}, ${defaultMobileAppSettings.display_order}
          )`;
      }
    })().catch((error) => {
      mobileAppSettingsReady = null;
      throw error;
    });
  }
  return mobileAppSettingsReady;
};

const getMobileAppSettingsRow = async () => {
  await ensureMobileAppSettingsSchema();
  const [row] = await sql`
    SELECT *
    FROM mobile_app_settings
    ORDER BY display_order ASC, id ASC
    LIMIT 1`;
  return { ...defaultMobileAppSettings, ...(row || {}) };
};

const safeNullableText = (value, maxLength = 1000) => {
  const text = String(value ?? "").trim();
  if (!text) return null;
  return text.slice(0, maxLength);
};

const mobileAppAbsoluteUrl = (req, routePath) => {
  const base = (process.env.API_PUBLIC_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
  return `${base}${routePath}`;
};

const mobileAppApkDir = () =>
  path.resolve(process.env.APK_UPLOAD_DIR || path.join(API_PROJECT_DIR, "..", "mmr-mobile-app-uploads"));

const safeApkFileName = (value = "mmr-app.apk") => {
  const base = path.basename(String(value || "mmr-app.apk")).replace(/[^\w.\-]+/g, "_");
  const withExtension = base.toLowerCase().endsWith(".apk") ? base : `${base}.apk`;
  return withExtension || "mmr-app.apk";
};

const normalizeMobileAppPayload = (body = {}, current = defaultMobileAppSettings) => {
  const url = safeNullableText(body.play_store_url, 1200);
  if (url && !/^https:\/\/play\.google\.com\/store\/apps\/details\?/i.test(url)) {
    throw new Error("Play Store URL must be a valid Google Play app link.");
  }
  const target = body.open_target === "_self" ? "_self" : "_blank";
  const mode = body.download_mode === "play_store" ? "play_store" : "apk";
  const order = Number(body.display_order);
  return {
    platform: safeNullableText(body.platform, 80) || current.platform || "google_play",
    app_name: safeNullableText(body.app_name, 180) || "MMR Constructions",
    play_store_url: url,
    package_name: safeNullableText(body.package_name, 180),
    current_version: safeNullableText(body.current_version, 60),
    latest_version: safeNullableText(body.latest_version, 60),
    version_code: safeNullableText(body.version_code, 60),
    release_notes: safeNullableText(body.release_notes, 4000),
    download_mode: mode,
    release_date: safeNullableText(body.release_date, 20),
    description: safeNullableText(body.description, 2000),
    button_text: safeNullableText(body.button_text, 80) || "Download App",
    badge_text: safeNullableText(body.badge_text, 80) || "Google Play",
    is_enabled: parseBool(body.is_enabled, current.is_enabled),
    is_coming_soon: parseBool(body.is_coming_soon, current.is_coming_soon),
    force_download: parseBool(body.force_download, current.force_download),
    open_target: target,
    display_order: Number.isInteger(order) ? order : Number(current.display_order || 1),
  };
};

const requirePlotManagementSchema = (() => {
  let ready;
  return () => {
    if (!ready) {
      ready = (async () => {
        await sql`
          CREATE TABLE IF NOT EXISTS plot_polygon_coordinates (
            plot_id INTEGER PRIMARY KEY REFERENCES plots(plot_id) ON DELETE CASCADE,
            coordinates JSONB NOT NULL DEFAULT '[]'::jsonb,
            label_x NUMERIC,
            label_y NUMERIC,
            updated_by_admin_id INTEGER,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )`;
        await sql`
          CREATE TABLE IF NOT EXISTS plot_polygon_history (
            id SERIAL PRIMARY KEY,
            plot_id INTEGER NOT NULL REFERENCES plots(plot_id) ON DELETE CASCADE,
            old_coordinates JSONB NOT NULL DEFAULT '[]'::jsonb,
            new_coordinates JSONB NOT NULL DEFAULT '[]'::jsonb,
            changed_by_admin_id INTEGER,
            change_reason TEXT,
            changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )`;
        await sql`
          CREATE TABLE IF NOT EXISTS plot_details_extended (
            plot_id INTEGER PRIMARY KEY REFERENCES plots(plot_id) ON DELETE CASCADE,
            size_label VARCHAR(120),
            width_ft NUMERIC,
            length_ft NUMERIC,
            facing_direction VARCHAR(80),
            is_corner_plot BOOLEAN DEFAULT FALSE,
            road_width_ft NUMERIC,
            features JSONB NOT NULL DEFAULT '[]'::jsonb,
            description TEXT,
            block_name VARCHAR(120),
            sector_name VARCHAR(120),
            updated_by_admin_id INTEGER,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )`;
        await sql`
          CREATE TABLE IF NOT EXISTS plot_images (
            id SERIAL PRIMARY KEY,
            plot_id INTEGER NOT NULL REFERENCES plots(plot_id) ON DELETE CASCADE,
            image_url TEXT NOT NULL,
            image_path TEXT NOT NULL,
            caption TEXT,
            image_order INTEGER NOT NULL DEFAULT 0,
            uploaded_by_id INTEGER,
            uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )`;
        await sql`
          CREATE TABLE IF NOT EXISTS plot_bulk_import_log (
            id SERIAL PRIMARY KEY,
            site_id INTEGER NOT NULL REFERENCES sites(site_id) ON DELETE CASCADE,
            imported_by_id INTEGER,
            original_filename TEXT,
            total_rows INTEGER NOT NULL DEFAULT 0,
            success_count INTEGER NOT NULL DEFAULT 0,
            failed_count INTEGER NOT NULL DEFAULT 0,
            error_details JSONB NOT NULL DEFAULT '[]'::jsonb,
            status VARCHAR(30) NOT NULL DEFAULT 'Processing',
            started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            completed_at TIMESTAMPTZ
          )`;
        await sql`
          CREATE TABLE IF NOT EXISTS plot_booking_history (
            id SERIAL PRIMARY KEY,
            plot_id INTEGER NOT NULL REFERENCES plots(plot_id) ON DELETE CASCADE,
            booking_id INTEGER,
            user_id INTEGER,
            event_type VARCHAR(80) NOT NULL,
            event_note TEXT,
            triggered_by_admin INTEGER,
            triggered_by_user INTEGER,
            plot_status_at_time VARCHAR(40),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )`;
        await sql`CREATE INDEX IF NOT EXISTS idx_plot_polygon_history_plot ON plot_polygon_history(plot_id, changed_at DESC)`;
        await sql`CREATE INDEX IF NOT EXISTS idx_plot_images_plot ON plot_images(plot_id, image_order ASC)`;
        await sql`CREATE INDEX IF NOT EXISTS idx_plot_bulk_import_site ON plot_bulk_import_log(site_id, started_at DESC)`;
        await sql`CREATE INDEX IF NOT EXISTS idx_plot_booking_history_plot ON plot_booking_history(plot_id, created_at DESC)`;
      })();
    }
    return ready;
  };
})();

const requireSiteDocumentsSchema = (() => {
  let ready;
  return () => {
    if (!ready) {
      ready = (async () => {
        await sql`
          CREATE TABLE IF NOT EXISTS site_documents (
            document_id SERIAL PRIMARY KEY,
            site_id INTEGER NOT NULL REFERENCES sites(site_id) ON DELETE CASCADE,
            document_name VARCHAR(180) NOT NULL,
            document_type VARCHAR(100),
            description TEXT,
            file_url TEXT NOT NULL,
            file_public_id TEXT NOT NULL,
            file_name TEXT NOT NULL,
            file_mime_type VARCHAR(100) NOT NULL,
            file_size_bytes INTEGER NOT NULL,
            created_by_admin_id INTEGER,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )`;
        await sql`
          CREATE INDEX IF NOT EXISTS idx_site_documents_site_created
          ON site_documents(site_id, created_at DESC)`;
      })();
    }
    return ready;
  };
})();

const requireEmiCalculatorSchema = (() => {
  let ready;
  return () => {
    if (!ready) {
      ready = (async () => {
        await sql`
          CREATE TABLE IF NOT EXISTS emi_calculator_master (
            id SERIAL PRIMARY KEY,
            plot_size VARCHAR(120) NOT NULL,
            plot_price NUMERIC(14,2) NOT NULL DEFAULT 0,
            down_payment NUMERIC(14,2) NOT NULL DEFAULT 0,
            loan_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
            interest_rate NUMERIC(8,2) NOT NULL DEFAULT 0,
            tenure_months INTEGER NOT NULL DEFAULT 0,
            monthly_emi NUMERIC(14,2) NOT NULL DEFAULT 0,
            processing_fee NUMERIC(14,2) NOT NULL DEFAULT 0,
            display_order INTEGER NOT NULL DEFAULT 0,
            is_active BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )`;
        await sql`CREATE INDEX IF NOT EXISTS idx_emi_calculator_active_order ON emi_calculator_master(is_active, display_order, id)`;
        await sql`CREATE INDEX IF NOT EXISTS idx_emi_calculator_plot_size ON emi_calculator_master(plot_size)`;
      })();
    }
    return ready;
  };
})();

const requireMlmSchema = (() => {
  let ready;
  return () => {
    if (!ready) {
      ready = (async () => {
        await sql`
          CREATE TABLE IF NOT EXISTS associate_referral_links (
            id SERIAL PRIMARY KEY,
            associate_user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
            invite_code VARCHAR(80) NOT NULL UNIQUE,
            referral_url TEXT,
            total_clicks INTEGER NOT NULL DEFAULT 0,
            total_registrations INTEGER NOT NULL DEFAULT 0,
            is_active BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )`;
        await sql`
          CREATE TABLE IF NOT EXISTS referral_registrations (
            id SERIAL PRIMARY KEY,
            sponsor_user_id INTEGER REFERENCES users(user_id),
            referred_user_id INTEGER UNIQUE REFERENCES users(user_id) ON DELETE CASCADE,
            sponsor_invite_code VARCHAR(80),
            registration_source VARCHAR(80) DEFAULT 'ReferralLink',
            referral_level INTEGER NOT NULL DEFAULT 1,
            status VARCHAR(30) NOT NULL DEFAULT 'Pending',
            approved_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )`;
        await sql`
          CREATE TABLE IF NOT EXISTS mlm_tree_closure (
            id SERIAL PRIMARY KEY,
            ancestor_user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
            descendant_user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
            depth INTEGER NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (ancestor_user_id, descendant_user_id)
          )`;
        await sql`
          CREATE TABLE IF NOT EXISTS associate_ranks (
            rank_id SERIAL PRIMARY KEY,
            rank_name VARCHAR(80) NOT NULL UNIQUE,
            min_direct_sales_gaj NUMERIC(12,2) NOT NULL DEFAULT 0,
            min_total_network_sales_gaj NUMERIC(12,2) NOT NULL DEFAULT 0,
            commission_multiplier NUMERIC(8,2) NOT NULL DEFAULT 1,
            is_active BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )`;
        await sql`
          CREATE TABLE IF NOT EXISTS associate_rank_history (
            id SERIAL PRIMARY KEY,
            associate_user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
            old_rank_id INTEGER REFERENCES associate_ranks(rank_id),
            new_rank_id INTEGER REFERENCES associate_ranks(rank_id),
            changed_reason TEXT,
            changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )`;
        await sql`
          CREATE TABLE IF NOT EXISTS commission_rules (
            rule_id SERIAL PRIMARY KEY,
            commission_type VARCHAR(30) NOT NULL,
            level_depth INTEGER NOT NULL DEFAULT 1,
            plot_area_unit VARCHAR(30) NOT NULL DEFAULT 'gaj',
            amount_per_100_gaj NUMERIC(14,2) NOT NULL DEFAULT 0,
            duration_months INTEGER NOT NULL DEFAULT 144,
            is_active BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )`;
        await sql`
          CREATE TABLE IF NOT EXISTS commission_monthly_schedule (
            schedule_id SERIAL PRIMARY KEY,
            commission_id INTEGER REFERENCES commission_transactions(commission_id) ON DELETE CASCADE,
            associate_user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
            booking_id INTEGER REFERENCES bookings(booking_id) ON DELETE CASCADE,
            month_no INTEGER NOT NULL,
            due_month DATE NOT NULL,
            amount NUMERIC(14,2) NOT NULL DEFAULT 0,
            status VARCHAR(30) NOT NULL DEFAULT 'Pending',
            paid_at TIMESTAMPTZ,
            payment_reference TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (commission_id, month_no)
          )`;
        await sql`
          CREATE TABLE IF NOT EXISTS associate_status_history (
            id SERIAL PRIMARY KEY,
            associate_user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
            old_status VARCHAR(40),
            new_status VARCHAR(40) NOT NULL,
            reason TEXT,
            duration_days INTEGER,
            changed_by_admin_id INTEGER,
            changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )`;
        await sql`
          CREATE TABLE IF NOT EXISTS referral_clicks (
            id SERIAL PRIMARY KEY,
            associate_user_id INTEGER REFERENCES users(user_id) ON DELETE CASCADE,
            invite_code VARCHAR(80),
            ip_address TEXT,
            user_agent TEXT,
            clicked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )`;
        await sql`
          CREATE TABLE IF NOT EXISTS associate_payout_requests (
            payout_id SERIAL PRIMARY KEY,
            associate_user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
            requested_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
            approved_amount NUMERIC(14,2),
            status VARCHAR(30) NOT NULL DEFAULT 'Requested',
            payment_reference TEXT,
            admin_note TEXT,
            reviewed_by_admin_id INTEGER,
            requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            reviewed_at TIMESTAMPTZ,
            paid_at TIMESTAMPTZ
          )`;
        await sql`CREATE INDEX IF NOT EXISTS idx_referral_reg_sponsor ON referral_registrations(sponsor_user_id, created_at DESC)`;
        await sql`CREATE INDEX IF NOT EXISTS idx_mlm_tree_ancestor ON mlm_tree_closure(ancestor_user_id, depth)`;
        await sql`CREATE INDEX IF NOT EXISTS idx_mlm_tree_descendant ON mlm_tree_closure(descendant_user_id, depth)`;
        await sql`
          DELETE FROM commission_rules duplicate
          USING commission_rules keeper
          WHERE duplicate.rule_id > keeper.rule_id
            AND duplicate.is_active = TRUE
            AND keeper.is_active = TRUE
            AND duplicate.commission_type = keeper.commission_type
            AND duplicate.level_depth = keeper.level_depth
            AND duplicate.plot_area_unit = keeper.plot_area_unit`;
        await sql`
          CREATE UNIQUE INDEX IF NOT EXISTS uq_commission_rules_active_level
          ON commission_rules (commission_type, level_depth, plot_area_unit)
          WHERE is_active = TRUE`;
        await sql`CREATE INDEX IF NOT EXISTS idx_commission_rules_active ON commission_rules(is_active, commission_type, level_depth)`;
        await sql`CREATE INDEX IF NOT EXISTS idx_commission_schedule_assoc ON commission_monthly_schedule(associate_user_id, due_month)`;
        await sql`CREATE INDEX IF NOT EXISTS idx_payout_assoc ON associate_payout_requests(associate_user_id, requested_at DESC)`;
        await seedMlmDefaults();
        await createDashboardViews();
      })();
    }
    return ready;
  };
})();

const createDashboardViews = async () => {
  try {
    // Drop and recreate views to ensure they're always up-to-date
    await sql.unsafe(`DROP VIEW IF EXISTS vw_site_plot_summary CASCADE`);
    await sql.unsafe(`DROP VIEW IF EXISTS vw_admin_dashboard_stats CASCADE`);

    // Site Plot Summary View - optimized to avoid duplicate counting
    await sql.unsafe(`
      CREATE VIEW vw_site_plot_summary AS
      SELECT
        s.site_id,
        s.site_name,
        COUNT(DISTINCT p.plot_id) AS total_plots,
        COUNT(DISTINCT CASE WHEN b.booking_status IN ('Confirmed', 'PaymentPending', 'InProcess') THEN p.plot_id END) AS booked,
        COUNT(DISTINCT CASE WHEN b.booking_status = 'Confirmed' AND (p.possession_date IS NULL OR p.possession_date <= NOW()) THEN p.plot_id END) AS sold,
        COUNT(DISTINCT p.plot_id) - COUNT(DISTINCT CASE WHEN b.booking_status IN ('Confirmed', 'PaymentPending', 'InProcess') THEN p.plot_id END) AS vacant
      FROM sites s
      LEFT JOIN plots p ON s.site_id = p.site_id
      LEFT JOIN bookings b ON p.plot_id = b.plot_id
      WHERE s.is_active = TRUE
      GROUP BY s.site_id, s.site_name
      ORDER BY s.site_name
    `);

    // Admin Dashboard Stats View with safe table references
    await sql.unsafe(`
      CREATE VIEW vw_admin_dashboard_stats AS
      SELECT
        COALESCE((SELECT COUNT(DISTINCT user_id) FROM users WHERE user_type = 'Customer' AND account_status = 'Active'), 0) AS total_customers,
        COALESCE((SELECT COUNT(DISTINCT user_id) FROM users WHERE user_type = 'Associate' AND account_status = 'Active'), 0) AS total_associates,
        COALESCE((SELECT COUNT(DISTINCT plot_id) FROM bookings WHERE booking_status = 'Confirmed'), 0) AS total_plots_sold,
        0 AS monthly_emi_due,
        COALESCE((SELECT COUNT(*) FROM users WHERE user_type = 'Associate' AND account_status = 'Pending'), 0) AS pending_approvals,
        0 AS open_enquiries,
        COALESCE((SELECT SUM(net_amount) FROM commission_transactions WHERE commission_status = 'Pending'), 0)::BIGINT AS commission_due,
        0::BIGINT AS total_revenue
    `);

    console.log("[Dashboard Views] Created vw_site_plot_summary and vw_admin_dashboard_stats");
  } catch (error) {
    console.error("[Dashboard Views] Error creating views:", error.message);
    // Don't throw - allow the app to continue even if views fail to create
    // The dashboard queries will fail with clear error messages instead
  }
};

const seedMlmDefaults = async () => {
  await sql`
    INSERT INTO associate_ranks (rank_name, min_direct_sales_gaj, min_total_network_sales_gaj, commission_multiplier)
    VALUES ('Associate', 0, 0, 1), ('Senior Associate', 500, 1500, 1.1), ('Leader', 1500, 5000, 1.25)
    ON CONFLICT (rank_name) DO NOTHING`;
  await sql`
    INSERT INTO commission_rules (commission_type, level_depth, plot_area_unit, amount_per_100_gaj, duration_months)
    SELECT * FROM (VALUES
      ('Direct', 1, 'gaj', 600::numeric, 144),
      ('Upline', 2, 'gaj', 150::numeric, 144),
      ('Upline', 3, 'gaj', 75::numeric, 144)
    ) AS seed(commission_type, level_depth, plot_area_unit, amount_per_100_gaj, duration_months)
    WHERE NOT EXISTS (
      SELECT 1 FROM commission_rules rule
      WHERE rule.is_active = TRUE
        AND rule.commission_type = seed.commission_type
        AND rule.level_depth = seed.level_depth
        AND rule.plot_area_unit = seed.plot_area_unit
    )`;
};

const publicReferralUrl = (req, inviteCode) => `${process.env.FRONTEND_URL || "https://mmrconstructions.in"}/signup?ref=${encodeURIComponent(inviteCode)}`;

const ensureAssociateReferralLink = async (req, associate) => {
  await requireMlmSchema();
  const inviteCode = associate.invitation_code || associate.member_id || `MMR${associate.user_id}`;
  const referralUrl = publicReferralUrl(req, inviteCode);
  const [link] = await sql`
    INSERT INTO associate_referral_links (associate_user_id, invite_code, referral_url)
    VALUES (${associate.user_id}, ${inviteCode}, ${referralUrl})
    ON CONFLICT (invite_code) DO UPDATE SET
      associate_user_id = EXCLUDED.associate_user_id,
      referral_url = EXCLUDED.referral_url,
      updated_at = NOW()
    RETURNING *`;
  return link;
};

const syncMlmTreeAndReferrals = async () => {
  try {
    await sql`
      INSERT INTO mlm_tree_closure (ancestor_user_id, descendant_user_id, depth)
      SELECT user_id, user_id, 0 FROM users
      ON CONFLICT DO NOTHING`;

    const sponsoredUsers = await sql`
      SELECT user_id, sponsor_user_id, invitation_code FROM users WHERE sponsor_user_id IS NOT NULL`;

    for (const u of sponsoredUsers) {
      await sql`
        INSERT INTO referral_registrations (sponsor_user_id, referred_user_id, status, approved_at)
        VALUES (${u.sponsor_user_id}, ${u.user_id}, 'Approved', NOW())
        ON CONFLICT (referred_user_id) DO UPDATE SET status = 'Approved', approved_at = NOW()`;

      await sql`
        INSERT INTO mlm_network (associate_user_id, sponsor_user_id, level)
        VALUES (${u.user_id}, ${u.sponsor_user_id},
          COALESCE((SELECT level FROM mlm_network WHERE associate_user_id = ${u.sponsor_user_id}), 0) + 1)
        ON CONFLICT (associate_user_id) DO NOTHING`;

      await sql`
        INSERT INTO mlm_tree_closure (ancestor_user_id, descendant_user_id, depth)
        VALUES (${u.sponsor_user_id}, ${u.user_id}, 1)
        ON CONFLICT DO NOTHING`;

      await sql`
        INSERT INTO mlm_tree_closure (ancestor_user_id, descendant_user_id, depth)
        SELECT ancestor_user_id, ${u.user_id}, depth + 1
        FROM mlm_tree_closure
        WHERE descendant_user_id = ${u.sponsor_user_id}
        ON CONFLICT DO NOTHING`;
    }
  } catch (err) {
    console.error('[syncMlmTreeAndReferrals] Error syncing tree closure:', err);
  }
};

const linkApprovedReferral = async (userId) => {
  await requireMlmSchema();
  const [user] = await sql`SELECT user_id, sponsor_user_id, invitation_code FROM users WHERE user_id = ${userId}`;
  if (!user?.sponsor_user_id) {
    await sql`
      INSERT INTO mlm_tree_closure (ancestor_user_id, descendant_user_id, depth)
      VALUES (${userId}, ${userId}, 0)
      ON CONFLICT DO NOTHING`;
    return;
  }
  await sql`
    INSERT INTO referral_registrations (sponsor_user_id, referred_user_id, sponsor_invite_code, status, approved_at)
    VALUES (${user.sponsor_user_id}, ${user.user_id}, ${user.invitation_code || null}, 'Approved', NOW())
    ON CONFLICT (referred_user_id) DO UPDATE SET status = 'Approved', approved_at = NOW()`;
  await sql`
    INSERT INTO mlm_network (associate_user_id, sponsor_user_id, level)
    VALUES (${user.user_id}, ${user.sponsor_user_id},
      COALESCE((SELECT level FROM mlm_network WHERE associate_user_id = ${user.sponsor_user_id}), 0) + 1)
    ON CONFLICT (associate_user_id) DO NOTHING`;
  await sql`
    INSERT INTO mlm_tree_closure (ancestor_user_id, descendant_user_id, depth)
    VALUES (${user.user_id}, ${user.user_id}, 0)
    ON CONFLICT DO NOTHING`;
  await sql`
    INSERT INTO mlm_tree_closure (ancestor_user_id, descendant_user_id, depth)
    SELECT ancestor_user_id, ${user.user_id}, depth + 1
    FROM mlm_tree_closure
    WHERE descendant_user_id = ${user.sponsor_user_id}
    ON CONFLICT DO NOTHING`;
  await sql`
    INSERT INTO mlm_tree_closure (ancestor_user_id, descendant_user_id, depth)
      VALUES (${user.sponsor_user_id}, ${user.user_id}, 1)
    ON CONFLICT DO NOTHING`;
};

const requireCommissionEngineSchema = (() => {
  let ready;
  return () => {
    if (!ready) {
      ready = (async () => {
        await sql`
          CREATE TABLE IF NOT EXISTS commission_engine_settings (
            id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
            commission_model TEXT NOT NULL DEFAULT 'Upline'
              CHECK (commission_model IN ('Upline', 'LevelWise', 'EqualDistribution')),
            maximum_levels INTEGER NOT NULL DEFAULT 3 CHECK (maximum_levels BETWEEN 1 AND 50),
            direct_percentage NUMERIC(8,4) NOT NULL DEFAULT 10 CHECK (direct_percentage BETWEEN 0 AND 100),
            upline_percentage NUMERIC(8,4) NOT NULL DEFAULT 2 CHECK (upline_percentage BETWEEN 0 AND 100),
            seller_percentage NUMERIC(8,4) NOT NULL DEFAULT 50 CHECK (seller_percentage BETWEEN 0 AND 100),
            equal_distribution_percentage NUMERIC(8,4) NOT NULL DEFAULT 50 CHECK (equal_distribution_percentage BETWEEN 0 AND 100),
            equal_distribution_enabled BOOLEAN NOT NULL DEFAULT TRUE,
            distribution_scope TEXT NOT NULL DEFAULT 'TopAssociateNetwork',
            payment_mode_rules JSONB NOT NULL DEFAULT '{"full_payment":"instant","emi":"installment_wise"}'::jsonb,
            eligibility_rules JSONB NOT NULL DEFAULT '{"require_active_associate":true,"exclude_blacklisted":true,"minimum_plot_amount":0,"minimum_payment_amount":0}'::jsonb,
            bonus_rules JSONB NOT NULL DEFAULT '{}'::jsonb,
            is_active BOOLEAN NOT NULL DEFAULT TRUE,
            version INTEGER NOT NULL DEFAULT 1,
            created_by_admin_id INTEGER,
            updated_by_admin_id INTEGER,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )`;
        await sql`
          CREATE TABLE IF NOT EXISTS commission_engine_levels (
            id BIGSERIAL PRIMARY KEY,
            settings_id SMALLINT NOT NULL DEFAULT 1 REFERENCES commission_engine_settings(id) ON DELETE CASCADE,
            commission_model TEXT NOT NULL CHECK (commission_model IN ('Upline', 'LevelWise', 'EqualDistribution')),
            level_no INTEGER NOT NULL CHECK (level_no BETWEEN 1 AND 50),
            percentage NUMERIC(8,4) NOT NULL CHECK (percentage BETWEEN 0 AND 100),
            is_active BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (settings_id, commission_model, level_no)
          )`;
        await sql`
          CREATE TABLE IF NOT EXISTS commission_engine_audit (
            audit_id BIGSERIAL PRIMARY KEY,
            settings_id SMALLINT NOT NULL,
            old_value JSONB NOT NULL,
            new_value JSONB NOT NULL,
            changed_by_admin_id INTEGER,
            reason TEXT NOT NULL,
            changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )`;
        await sql.unsafe(`
          CREATE OR REPLACE FUNCTION prevent_commission_engine_audit_mutation()
          RETURNS trigger AS $$
          BEGIN
            RAISE EXCEPTION 'Commission engine audit history is immutable';
          END;
          $$ LANGUAGE plpgsql
        `);
        await sql.unsafe(`
          DROP TRIGGER IF EXISTS trg_commission_engine_audit_immutable ON commission_engine_audit;
          CREATE TRIGGER trg_commission_engine_audit_immutable
          BEFORE UPDATE OR DELETE ON commission_engine_audit
          FOR EACH ROW EXECUTE FUNCTION prevent_commission_engine_audit_mutation()
        `);
        await sql`
          CREATE TABLE IF NOT EXISTS commission_source_events (
            event_id BIGSERIAL PRIMARY KEY,
            booking_id INTEGER NOT NULL REFERENCES bookings(booking_id) ON DELETE RESTRICT,
            source_type TEXT NOT NULL CHECK (source_type IN ('FullPayment','InitialPayment','EmiPayment','PartialPayment','Manual')),
            source_id TEXT NOT NULL,
            payment_type TEXT NOT NULL,
            received_amount NUMERIC(14,2) NOT NULL CHECK (received_amount > 0),
            plot_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
            plot_area_gaj NUMERIC(14,2) NOT NULL DEFAULT 0,
            commission_model TEXT NOT NULL,
            engine_version INTEGER NOT NULL,
            generated_by_admin_id INTEGER,
            generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (booking_id, source_type, source_id)
          )`;
        await sql`ALTER TABLE commission_transactions ADD COLUMN IF NOT EXISTS commission_event_id BIGINT`;
        await sql`ALTER TABLE commission_transactions ADD COLUMN IF NOT EXISTS commission_model TEXT`;
        await sql`ALTER TABLE commission_transactions ADD COLUMN IF NOT EXISTS commission_level INTEGER`;
        await sql`ALTER TABLE commission_transactions ADD COLUMN IF NOT EXISTS commission_percentage NUMERIC(8,4)`;
        await sql`ALTER TABLE commission_transactions ADD COLUMN IF NOT EXISTS calculation_base NUMERIC(14,2)`;
        await sql`ALTER TABLE commission_transactions ADD COLUMN IF NOT EXISTS source_type TEXT`;
        await sql`ALTER TABLE commission_transactions ADD COLUMN IF NOT EXISTS source_reference TEXT`;
        await sql`ALTER TABLE commission_transactions ADD COLUMN IF NOT EXISTS engine_version INTEGER`;
        await sql`ALTER TABLE commission_transactions ADD COLUMN IF NOT EXISTS distribution_role TEXT`;
        await sql`ALTER TABLE commission_transactions ADD COLUMN IF NOT EXISTS distribution_participants INTEGER`;
        await sql`ALTER TABLE commission_transactions ADD COLUMN IF NOT EXISTS seller_user_id INTEGER`;
        await sql`ALTER TABLE commission_engine_settings ADD COLUMN IF NOT EXISTS seller_percentage NUMERIC(8,4) NOT NULL DEFAULT 50`;
        await sql`ALTER TABLE commission_engine_settings ADD COLUMN IF NOT EXISTS equal_distribution_percentage NUMERIC(8,4) NOT NULL DEFAULT 50`;
        await sql`ALTER TABLE commission_engine_settings ADD COLUMN IF NOT EXISTS equal_distribution_enabled BOOLEAN NOT NULL DEFAULT TRUE`;
        await sql`ALTER TABLE commission_engine_settings ADD COLUMN IF NOT EXISTS distribution_scope TEXT NOT NULL DEFAULT 'TopAssociateNetwork'`;
        await sql`ALTER TABLE commission_engine_settings ADD COLUMN IF NOT EXISTS payment_mode_rules JSONB NOT NULL DEFAULT '{"full_payment":"instant","emi":"installment_wise"}'::jsonb`;
        await sql.unsafe(`
          DO $$
          BEGIN
            IF EXISTS (
              SELECT 1 FROM pg_constraint
              WHERE conname = 'commission_engine_settings_commission_model_check'
                AND conrelid = 'commission_engine_settings'::regclass
            ) THEN
              ALTER TABLE commission_engine_settings DROP CONSTRAINT commission_engine_settings_commission_model_check;
            END IF;
            ALTER TABLE commission_engine_settings
              ADD CONSTRAINT commission_engine_settings_commission_model_check
              CHECK (commission_model IN ('Upline', 'LevelWise', 'EqualDistribution'));

            IF EXISTS (
              SELECT 1 FROM pg_constraint
              WHERE conname = 'commission_engine_levels_commission_model_check'
                AND conrelid = 'commission_engine_levels'::regclass
            ) THEN
              ALTER TABLE commission_engine_levels DROP CONSTRAINT commission_engine_levels_commission_model_check;
            END IF;
            ALTER TABLE commission_engine_levels
              ADD CONSTRAINT commission_engine_levels_commission_model_check
              CHECK (commission_model IN ('Upline', 'LevelWise', 'EqualDistribution'));
          END $$;
        `);
        await sql`INSERT INTO commission_engine_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`;
        await sql`
          INSERT INTO commission_engine_levels (settings_id, commission_model, level_no, percentage)
          VALUES (1,'LevelWise',1,10),(1,'LevelWise',2,5),(1,'LevelWise',3,3),(1,'LevelWise',4,2),(1,'LevelWise',5,1)
          ON CONFLICT (settings_id, commission_model, level_no) DO NOTHING`;
        await sql`CREATE INDEX IF NOT EXISTS idx_commission_levels_model_active ON commission_engine_levels(settings_id, commission_model, is_active, level_no)`;
        await sql`CREATE INDEX IF NOT EXISTS idx_commission_engine_audit_changed ON commission_engine_audit(changed_at DESC)`;
        await sql`CREATE INDEX IF NOT EXISTS idx_commission_events_booking_date ON commission_source_events(booking_id, generated_at DESC)`;
        await sql`
          CREATE UNIQUE INDEX IF NOT EXISTS uq_commission_transaction_event_level
          ON commission_transactions(commission_event_id, associate_user_id, commission_level)
          WHERE commission_event_id IS NOT NULL`;
      })();
    }
    return ready;
  };
})();

const commissionEngineSnapshot = async (db = sql) => {
  await requireCommissionEngineSchema();
  const [settingsRow] = await db`
    SELECT settings.*, admin.full_name AS updated_by
    FROM commission_engine_settings settings
    LEFT JOIN admin_users admin ON admin.admin_id = settings.updated_by_admin_id
    WHERE settings.id = 1`;
  const levels = await db`
    SELECT level_no, percentage, is_active
    FROM commission_engine_levels
    WHERE settings_id = 1 AND commission_model = ${settingsRow.commission_model}
    ORDER BY level_no`;
  return { ...settingsRow, levels };
};

const generateCommissionForPayment = async (req, {
  bookingId,
  sourceType,
  sourceId,
  receivedAmount,
  paymentType,
}) => {
  await requireMlmSchema();
  await requireCommissionEngineSchema();
  const amountReceived = Number(receivedAmount || 0);
  if (!(amountReceived > 0)) return { generated: 0, reason: "No received amount" };

  return sql.begin(async (db) => {
    await db`SELECT pg_advisory_xact_lock(${Number(bookingId)})`;
    const [booking] = await db`
      SELECT b.booking_id, b.user_id, b.payment_type, b.advance_amount,
             p.plot_id, p.plot_area, p.area_unit, p.base_price, p.plot_number,
             s.site_name, buyer.sponsor_user_id
      FROM bookings b
      JOIN users buyer ON buyer.user_id = b.user_id
      JOIN plots p ON p.plot_id = b.plot_id
      JOIN sites s ON s.site_id = p.site_id
      WHERE b.booking_id = ${bookingId}`;
    if (!booking?.sponsor_user_id) return { generated: 0, reason: "No sponsor" };

    const engine = await commissionEngineSnapshot(db);
    if (!engine.is_active) return { generated: 0, reason: "Commission engine inactive" };
    const eligibility = engine.eligibility_rules || {};
    if (Number(booking.base_price || 0) < Number(eligibility.minimum_plot_amount || 0)) {
      return { generated: 0, reason: "Plot amount below eligibility minimum" };
    }
    if (amountReceived < Number(eligibility.minimum_payment_amount || 0)) {
      return { generated: 0, reason: "Payment amount below eligibility minimum" };
    }

    const [event] = await db`
      INSERT INTO commission_source_events (
        booking_id, source_type, source_id, payment_type, received_amount,
        plot_amount, plot_area_gaj, commission_model, engine_version, generated_by_admin_id
      ) VALUES (
        ${booking.booking_id}, ${sourceType}, ${String(sourceId)}, ${paymentType},
        ${amountReceived}, ${Number(booking.base_price || 0)}, ${Number(booking.plot_area || 0)},
        ${engine.commission_model}, ${engine.version}, ${req?.admin?.admin_id || null}
      )
      ON CONFLICT (booking_id, source_type, source_id) DO NOTHING
      RETURNING event_id`;
    if (!event) return { generated: 0, reason: "Payment event already processed" };

    if (engine.commission_model === "EqualDistribution") {
      const sellerUserId = Number(booking.sponsor_user_id);
      const sellerPercentage = Number(engine.seller_percentage ?? 50);
      const equalPercentage = Number(engine.equal_distribution_percentage ?? (100 - sellerPercentage));
      if ([sellerPercentage, equalPercentage].some(value => !Number.isFinite(value) || value < 0 || value > 100)) {
        return { generated: 0, reason: "Invalid equal distribution percentages" };
      }
      if (Math.round((sellerPercentage + equalPercentage) * 10000) / 10000 > 100) {
        return { generated: 0, reason: "Equal distribution percentages exceed 100%" };
      }

      const [seller] = await db`
        SELECT user_id, account_status
        FROM users
        WHERE user_id = ${sellerUserId} AND user_type = 'Associate'`;
      if (!seller) return { generated: 0, reason: "Seller associate not found" };
      if (eligibility.require_active_associate !== false && seller.account_status !== "Active") {
        return { generated: 0, reason: "Seller associate inactive" };
      }
      if (eligibility.exclude_blacklisted !== false && seller.account_status === "Blacklisted") {
        return { generated: 0, reason: "Seller associate blacklisted" };
      }

      const [rootRow] = await db`
        SELECT ancestor_user_id
        FROM mlm_tree_closure
        WHERE descendant_user_id = ${sellerUserId}
        ORDER BY depth DESC
        LIMIT 1`;
      const networkRootId = Number(rootRow?.ancestor_user_id || sellerUserId);
      const networkRows = await db`
        SELECT u.user_id, u.account_status
        FROM users u
        WHERE u.user_type = 'Associate'
          AND (
            u.user_id = ${networkRootId}
            OR EXISTS (
              SELECT 1 FROM mlm_tree_closure c
              WHERE c.ancestor_user_id = ${networkRootId}
                AND c.descendant_user_id = u.user_id
            )
          )`;
      const eligibleNetwork = networkRows.filter((member) => {
        if (Number(member.user_id) === sellerUserId) return false;
        if (eligibility.require_active_associate !== false && member.account_status !== "Active") return false;
        if (eligibility.exclude_blacklisted !== false && member.account_status === "Blacklisted") return false;
        return true;
      });

      const sellerAmount = Math.round((amountReceived * sellerPercentage / 100) * 100) / 100;
      const distributionPool = engine.equal_distribution_enabled === false
        ? 0
        : Math.round((amountReceived * equalPercentage / 100) * 100) / 100;
      const participantCount = eligibleNetwork.length;
      const shareAmount = participantCount > 0
        ? Math.floor((distributionPool / participantCount) * 100) / 100
        : 0;

      let generated = 0;
      let totalCommission = 0;
      if (sellerAmount > 0) {
        const [commission] = await db`
          INSERT INTO commission_transactions (
            associate_user_id, related_booking_id, commission_type, gaj_sold,
            gross_amount, deduction_amount, net_amount, commission_month, commission_status,
            commission_event_id, commission_model, commission_level, commission_percentage,
            calculation_base, source_type, source_reference, engine_version,
            distribution_role, distribution_participants, seller_user_id
          ) VALUES (
            ${sellerUserId}, ${booking.booking_id}, 'Direct', ${Number(booking.plot_area || 0)},
            ${sellerAmount}, 0, ${sellerAmount}, ${new Date().toISOString().slice(0, 7)}, 'Pending',
            ${event.event_id}, ${engine.commission_model}, 0, ${sellerPercentage},
            ${amountReceived}, ${sourceType}, ${String(sourceId)}, ${engine.version},
            'Seller', ${participantCount}, ${sellerUserId}
          )
          ON CONFLICT DO NOTHING
          RETURNING commission_id`;
        if (commission) {
          await db`
            INSERT INTO associate_sales_tracker (associate_user_id, total_gaj_sold, total_commission_earned)
            VALUES (${sellerUserId}, 0, ${sellerAmount})
            ON CONFLICT (associate_user_id) DO UPDATE SET
              total_commission_earned = associate_sales_tracker.total_commission_earned + ${sellerAmount},
              updated_at = NOW()`;
          generated++;
          totalCommission += sellerAmount;
        }
      }

      for (const member of eligibleNetwork) {
        if (!(shareAmount > 0)) continue;
        const [commission] = await db`
          INSERT INTO commission_transactions (
            associate_user_id, related_booking_id, commission_type, gaj_sold,
            gross_amount, deduction_amount, net_amount, commission_month, commission_status,
            commission_event_id, commission_model, commission_level, commission_percentage,
            calculation_base, source_type, source_reference, engine_version,
            distribution_role, distribution_participants, seller_user_id
          ) VALUES (
            ${member.user_id}, ${booking.booking_id}, 'Upline', ${Number(booking.plot_area || 0)},
            ${shareAmount}, 0, ${shareAmount}, ${new Date().toISOString().slice(0, 7)}, 'Pending',
            ${event.event_id}, ${engine.commission_model}, 1, ${equalPercentage},
            ${amountReceived}, ${sourceType}, ${String(sourceId)}, ${engine.version},
            'EqualDistribution', ${participantCount}, ${sellerUserId}
          )
          ON CONFLICT DO NOTHING
          RETURNING commission_id`;
        if (!commission) continue;
        await db`
          INSERT INTO associate_sales_tracker (associate_user_id, total_gaj_sold, total_commission_earned)
          VALUES (${member.user_id}, 0, ${shareAmount})
          ON CONFLICT (associate_user_id) DO UPDATE SET
            total_commission_earned = associate_sales_tracker.total_commission_earned + ${shareAmount},
            updated_at = NOW()`;
        generated++;
        totalCommission += shareAmount;
      }

      return {
        generated,
        total_commission: Math.round(totalCommission * 100) / 100,
        model: engine.commission_model,
        version: engine.version,
        event_id: event.event_id,
        seller_user_id: sellerUserId,
        seller_commission: sellerAmount,
        equal_distribution_pool: distributionPool,
        participant_count: participantCount,
        per_participant_share: shareAmount,
      };
    }

    const ancestors = await db`
      SELECT ancestor_user_id, depth
      FROM mlm_tree_closure
      WHERE descendant_user_id = ${booking.sponsor_user_id}
      UNION ALL
      SELECT ${booking.sponsor_user_id}::int AS ancestor_user_id, 0 AS depth`;
    const candidates = new Map();
    for (const row of ancestors) {
      const level = Number(row.ancestor_user_id) === Number(booking.sponsor_user_id)
        ? 1
        : Number(row.depth) + 1;
      if (level <= Number(engine.maximum_levels) && !candidates.has(row.ancestor_user_id)) {
        candidates.set(row.ancestor_user_id, level);
      }
    }

    let generated = 0;
    let totalCommission = 0;
    for (const [associateUserId, level] of candidates.entries()) {
      const [associate] = await db`
        SELECT account_status
        FROM users
        WHERE user_id = ${associateUserId} AND user_type = 'Associate'`;
      if (!associate) continue;
      if (eligibility.require_active_associate !== false && associate.account_status !== "Active") continue;
      if (eligibility.exclude_blacklisted !== false && associate.account_status === "Blacklisted") continue;

      let percentage = 0;
      if (engine.commission_model === "Upline") {
        percentage = level === 1 ? Number(engine.direct_percentage) : Number(engine.upline_percentage);
      } else {
        percentage = Number(engine.levels.find(item => Number(item.level_no) === level && item.is_active)?.percentage || 0);
      }
      if (!(percentage > 0)) continue;
      const commissionAmount = Math.round((amountReceived * percentage / 100) * 100) / 100;
      if (!(commissionAmount > 0)) continue;

      const commissionType = level === 1 ? "Direct" : "Upline";
      const [commission] = await db`
        INSERT INTO commission_transactions (
          associate_user_id, related_booking_id, commission_type, gaj_sold,
          gross_amount, deduction_amount, net_amount, commission_month, commission_status,
          commission_event_id, commission_model, commission_level, commission_percentage,
          calculation_base, source_type, source_reference, engine_version
        ) VALUES (
          ${associateUserId}, ${booking.booking_id}, ${commissionType}, ${Number(booking.plot_area || 0)},
          ${commissionAmount}, 0, ${commissionAmount}, ${new Date().toISOString().slice(0, 7)}, 'Pending',
          ${event.event_id}, ${engine.commission_model}, ${level}, ${percentage},
          ${amountReceived}, ${sourceType}, ${String(sourceId)}, ${engine.version}
        )
        ON CONFLICT DO NOTHING
        RETURNING commission_id`;
      if (!commission) continue;
      await db`
        INSERT INTO associate_sales_tracker (associate_user_id, total_gaj_sold, total_commission_earned)
        VALUES (${associateUserId}, 0, ${commissionAmount})
        ON CONFLICT (associate_user_id) DO UPDATE SET
          total_commission_earned = associate_sales_tracker.total_commission_earned + ${commissionAmount},
          updated_at = NOW()`;
      generated++;
      totalCommission += commissionAmount;
    }
    return {
      generated,
      total_commission: Math.round(totalCommission * 100) / 100,
      model: engine.commission_model,
      version: engine.version,
      event_id: event.event_id,
    };
  });
};

const generateMlmCommissionForBooking = async (req, bookingId) => {
  await requireMlmSchema();
  const [booking] = await sql`
    SELECT b.booking_id, b.user_id, p.plot_id, p.plot_area, p.area_unit, p.plot_number, s.site_name,
           buyer.sponsor_user_id
    FROM bookings b
    JOIN users buyer ON buyer.user_id = b.user_id
    JOIN plots p ON p.plot_id = b.plot_id
    JOIN sites s ON s.site_id = p.site_id
    WHERE b.booking_id = ${bookingId}`;
  if (!booking?.sponsor_user_id) return { generated: 0, reason: "No sponsor" };

  const rules = await sql`SELECT * FROM commission_rules WHERE is_active = TRUE ORDER BY level_depth`;
  const ancestors = await sql`
    SELECT ancestor_user_id, depth
    FROM mlm_tree_closure
    WHERE descendant_user_id = ${booking.sponsor_user_id}
    UNION ALL SELECT ${booking.sponsor_user_id}::int AS ancestor_user_id, 1 AS depth`;

  const uniqueAncestors = new Map();
  for (const row of ancestors) {
    const depth = Number(row.ancestor_user_id) === Number(booking.sponsor_user_id) ? 1 : Number(row.depth) + 1;
    if (!uniqueAncestors.has(row.ancestor_user_id)) uniqueAncestors.set(row.ancestor_user_id, depth);
  }

  let generated = 0;
  for (const [associateUserId, depth] of uniqueAncestors.entries()) {
    const [associate] = await sql`SELECT account_status FROM users WHERE user_id = ${associateUserId} AND user_type = 'Associate'`;
    if (!associate || associate.account_status === "Blacklisted") continue;
    const expectedType = depth === 1 ? "Direct" : "Upline";
    const rule = rules.find(r =>
      r.commission_type === expectedType
      && Number(r.level_depth) === Number(depth)
      && String(r.plot_area_unit || "gaj").toLowerCase() === String(booking.area_unit || "gaj").toLowerCase()
    );
    if (!rule) continue;
    const gajSold = Number(booking.plot_area || 0);
    const monthlyAmount = (gajSold / 100) * Number(rule.amount_per_100_gaj || 0);
    if (!monthlyAmount) continue;
    const [existing] = await sql`
      SELECT commission_id FROM commission_transactions
      WHERE associate_user_id = ${associateUserId}
        AND related_booking_id = ${booking.booking_id}
        AND commission_type = ${rule.commission_type}
      LIMIT 1`;
    if (existing) continue;
    const [commission] = await sql`
      INSERT INTO commission_transactions (
        associate_user_id, related_booking_id, commission_type, gaj_sold,
        gross_amount, deduction_amount, net_amount, commission_month, commission_status
      ) VALUES (
        ${associateUserId}, ${booking.booking_id}, ${rule.commission_type},
        ${gajSold}, ${monthlyAmount}, 0, ${monthlyAmount},
        ${new Date().toISOString().slice(0, 7)}, 'Pending'
      )
      RETURNING commission_id`;
    for (let month = 1; month <= Number(rule.duration_months || 144); month++) {
      await sql`
        INSERT INTO commission_monthly_schedule (
          commission_id, associate_user_id, booking_id, month_no, due_month, amount
        ) VALUES (
          ${commission.commission_id}, ${associateUserId}, ${booking.booking_id}, ${month},
          (date_trunc('month', NOW()) + (${month - 1} || ' months')::interval)::date,
          ${monthlyAmount}
        )
        ON CONFLICT DO NOTHING`;
    }
    await sql`
      INSERT INTO associate_sales_tracker (associate_user_id, total_gaj_sold, total_commission_earned)
      VALUES (${associateUserId}, ${depth === 1 ? gajSold : 0}, ${monthlyAmount})
      ON CONFLICT (associate_user_id) DO UPDATE SET
        total_gaj_sold = associate_sales_tracker.total_gaj_sold + ${depth === 1 ? gajSold : 0},
        total_commission_earned = associate_sales_tracker.total_commission_earned + ${monthlyAmount}`;
    await addUserNotification({
      userId: associateUserId,
      adminId: req?.admin?.admin_id || null,
      title: "Commission generated",
      message: `Commission generated for Plot ${booking.plot_number} at ${booking.site_name}.`,
    });
    generated++;
  }
  return { generated };
};

const calculateEmiAmount = ({ plotPrice, downPayment, interestRate, tenureMonths }) => {
  const price = Number(plotPrice) || 0;
  const down = Number(downPayment) || 0;
  const tenure = Math.max(Number(tenureMonths) || 0, 0);
  const annualRate = Math.max(Number(interestRate) || 0, 0);
  const loanAmount = Math.max(price - down, 0);
  if (!loanAmount || !tenure) return { loanAmount, monthlyEmi: 0 };
  const monthlyRate = annualRate / 12 / 100;
  if (!monthlyRate) return { loanAmount, monthlyEmi: loanAmount / tenure };
  const factor = Math.pow(1 + monthlyRate, tenure);
  return { loanAmount, monthlyEmi: loanAmount * monthlyRate * factor / (factor - 1) };
};

const normalizeEmiPlanPayload = (body = {}) => {
  const plotPrice = Number(body.plot_price);
  const downPayment = Number(body.down_payment);
  const interestRate = Number(body.interest_rate);
  const tenureMonths = Number(body.tenure_months);
  const processingFee = body.processing_fee === "" || body.processing_fee == null ? 0 : Number(body.processing_fee);
  const displayOrder = body.display_order === "" || body.display_order == null ? 0 : Number(body.display_order);

  if (!String(body.plot_size || "").trim()) throw new Error("plot_size is required");
  if (!Number.isFinite(plotPrice) || plotPrice < 0) throw new Error("valid plot_price is required");
  if (!Number.isFinite(downPayment) || downPayment < 0) throw new Error("valid down_payment is required");
  if (downPayment > plotPrice) throw new Error("down_payment cannot be greater than plot_price");
  if (!Number.isFinite(interestRate) || interestRate < 0) throw new Error("valid interest_rate is required");
  if (!Number.isInteger(tenureMonths) || tenureMonths <= 0) throw new Error("valid tenure_months is required");
  if (!Number.isFinite(processingFee) || processingFee < 0) throw new Error("valid processing_fee is required");
  if (!Number.isInteger(displayOrder)) throw new Error("valid display_order is required");

  const calculated = calculateEmiAmount({ plotPrice, downPayment, interestRate, tenureMonths });
  return {
    plot_size: String(body.plot_size).trim(),
    plot_price: plotPrice,
    down_payment: downPayment,
    loan_amount: Number(calculated.loanAmount.toFixed(2)),
    interest_rate: interestRate,
    tenure_months: tenureMonths,
    monthly_emi: Number(calculated.monthlyEmi.toFixed(2)),
    processing_fee: processingFee,
    display_order: displayOrder,
    is_active: parseBool(body.is_active, true),
  };
};

const logPlotAudit = async (req, action, targetRecordId, newValue = null) => {
  await sql`
    INSERT INTO audit_log (actor_type, actor_id, actor_name, module, action, target_table, target_record_id, new_value)
    VALUES ('Admin', ${req.admin?.admin_id || null}, ${req.admin?.full_name || null},
            'PlotManagement', ${action}, 'plots', ${targetRecordId}, ${newValue})`;
};

const addPlotBookingHistory = async ({
  plotId,
  bookingId = null,
  userId = null,
  eventType,
  eventNote = null,
  triggeredByAdmin = null,
  triggeredByUser = null,
  plotStatusAtTime = null,
}) => {
  await sql`
    INSERT INTO plot_booking_history
      (plot_id, booking_id, user_id, event_type, event_note,
       triggered_by_admin, triggered_by_user, plot_status_at_time)
    VALUES (${plotId}, ${bookingId}, ${userId}, ${eventType}, ${eventNote},
            ${triggeredByAdmin}, ${triggeredByUser}, ${plotStatusAtTime})`;
};

const addUserNotification = async ({ userId, adminId = null, title = null, message, channel = "InApp" }) => {
  if (!userId || !message) return;
  await sql`
    INSERT INTO notification_log (user_id, sent_by_admin_id, channel, title, message)
    VALUES (${userId}, ${adminId}, ${channel}, ${title}, ${message})`;
  try {
    const [user] = await sql`SELECT mobile_no FROM users WHERE user_id = ${userId}`;
    if (user?.mobile_no) {
      await whatsappEvents.enqueue("general_notification", user.mobile_no, { message: title ? `${title}: ${message}` : message }, userId, adminId, 5);
    }
  } catch (error) {
    console.error("[WhatsApp Notification Queue Error]", error?.message || error);
  }
};

const logAdminAudit = async (req, module, action, targetTable, targetRecordId, newValue = null) => {
  await sql`
    INSERT INTO audit_log (actor_type, actor_id, actor_name, module, action, target_table, target_record_id, new_value, ip_address)
    VALUES ('Admin', ${req.admin?.admin_id || null}, ${req.admin?.full_name || null},
            ${module}, ${action}, ${targetTable}, ${targetRecordId}, ${newValue}, ${req.ip || null})`;
};

const validatePolygonCoordinates = (coordinates) =>
  Array.isArray(coordinates) &&
  coordinates.length > 0 &&
  coordinates.every((point) =>
    point &&
    (Array.isArray(point)
      ? Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1]))
      : Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.y)))
  );

const normalizeCoordinates = (coordinates) =>
  coordinates.map((point) => Array.isArray(point)
    ? { x: Number(point[0]), y: Number(point[1]) }
    : { x: Number(point.x), y: Number(point.y) });

const sitePrefixFromName = (siteName = "") => {
  const words = String(siteName || "").trim().split(/\s+/).filter(Boolean);
  const prefix = words.length >= 2
    ? `${words[0][0] || ""}${words[1][0] || ""}`
    : String(siteName || "").replace(/[^a-zA-Z]/g, "").slice(0, 2);
  return (prefix || "PL").toUpperCase();
};

const uniqueSitePrefix = async (siteName = "", requestedPrefix = "", excludeSiteId = null) => {
  const base = String(requestedPrefix || sitePrefixFromName(siteName))
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, 8)
    .toUpperCase() || "PL";
  const rows = await sql`
    SELECT site_id, site_prefix
    FROM sites
    WHERE UPPER(site_prefix) LIKE ${base + "%"}
      AND (${excludeSiteId}::int IS NULL OR site_id <> ${excludeSiteId})`;
  const used = new Set(rows.map((row) => String(row.site_prefix || "").toUpperCase()));
  if (!used.has(base)) return base;
  let sequence = 1;
  while (used.has(`${base}${sequence}`)) sequence += 1;
  return `${base}${sequence}`;
};

const validatePlotImageFile = (file) => {
  const ext = path.extname(file?.originalname || "").toLowerCase();
  const allowedExt = [".jpg", ".jpeg", ".png"];
  const allowedMime = ["image/jpeg", "image/png"];
  return allowedExt.includes(ext) && allowedMime.includes(file?.mimetype);
};

const publicBaseUrl = (req) => process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;

const cleanFileName = (filename) =>
  path.basename(filename || "plot-image").replace(/[^a-zA-Z0-9._-]/g, "_");

let siteHtmlMapSchemaReady;
const ensureSiteHtmlMapSchema = () => {
  if (!siteHtmlMapSchemaReady) {
    siteHtmlMapSchemaReady = (async () => {
      await sql`ALTER TABLE sites ADD COLUMN IF NOT EXISTS html_map_code TEXT`;
      await sql`ALTER TABLE sites ADD COLUMN IF NOT EXISTS html_map_file_url TEXT`;
      await sql`ALTER TABLE sites ADD COLUMN IF NOT EXISTS html_map_updated_at TIMESTAMPTZ`;
      await sql`ALTER TABLE sites ADD COLUMN IF NOT EXISTS site_prefix VARCHAR(12)`;
    })();
  }
  return siteHtmlMapSchemaReady;
};

const sanitizeHtmlMapCode = (html = "") => {
  let code = String(html || "").trim();
  if (!code) return null;

  code = code
    .replace(/<script\b[^>]*\bsrc\s*=\s*["'][^"']*["'][^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<link\b[^>]*>/gi, "")
    .replace(/<iframe\b[\s\S]*?<\/iframe>/gi, "")
    .replace(/<object\b[\s\S]*?<\/object>/gi, "")
    .replace(/<embed\b[^>]*>/gi, "")
    .replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi, "")
    .replace(/\s(?:src|href)\s*=\s*["']https?:\/\/[^"']*["']/gi, "")
    .replace(/\bwindow\.location\b/gi, "window.__blocked_location")
    .replace(/\bdocument\.location\b/gi, "document.__blocked_location")
    .replace(/\blocation\.(href|replace|assign)\b/gi, "location.__blocked");

  if (!/<html[\s>]/i.test(code)) {
    code = `<!doctype html><html><head><meta charset="utf-8"></head><body>${code}</body></html>`;
  }
  return code;
};

const htmlMapFromRequest = (req) => {
  const file = req.files?.html_map?.[0] || req.file || null;
  if (file) {
    const ext = path.extname(file.originalname || "").toLowerCase();
    if (ext !== ".html") throw new Error("Only HTML files are allowed for plot map upload.");
    return sanitizeHtmlMapCode(file.buffer.toString("utf8"));
  }
  return sanitizeHtmlMapCode(req.body?.html_map_code || "");
};

const parseImportRows = (file) => {
  const ext = path.extname(file.originalname || "").toLowerCase();
  if (![".xlsx", ".csv"].includes(ext)) {
    throw new Error("Only .xlsx and .csv files are allowed.");
  }
  const workbook = xlsx.read(file.buffer, {
    type: "buffer",
    sheetRows: 2001,
    cellFormula: false,
    cellHTML: false,
    cellStyles: false,
  });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return [];
  const rows = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: "", raw: false });
  if (rows.length > 2000) {
    throw new Error("Import file can contain a maximum of 2000 rows.");
  }
  return rows;
};

const normalizeImportValue = (value) =>
  typeof value === "string" ? value.trim() : value;

const normalizeImportKey = (key = "") =>
  String(key || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

const plotImportTemplateFields = [
  "Plot Number", "Plot Name", "Status", "Plot Type", "Plot Size", "Area", "Length", "Width",
  "Facing", "Road Width", "Block", "Phase", "PLC", "Corner Plot", "Park Facing",
  "East", "West", "North", "South", "Customer Name", "Customer Mobile", "Booking Date",
  "Registry Status", "Registry Date", "Price", "Total Price", "Booking Amount",
  "Balance Amount", "Description", "Remarks",
];

const generatedPlotPolygons = (count) => {
  const total = Math.max(0, Number(count) || 0);
  if (!total) return [];
  const cols = Math.ceil(Math.sqrt(total * 1.35));
  const rows = Math.ceil(total / cols);
  const margin = 5;
  const gap = 1.2;
  const width = (100 - margin * 2 - gap * (cols - 1)) / cols;
  const height = Math.min(8, (100 - margin * 2 - gap * (rows - 1)) / rows);
  return Array.from({ length: total }, (_, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    const x = margin + col * (width + gap);
    const y = margin + row * (height + gap);
    return [
      { x: Number(x.toFixed(2)), y: Number(y.toFixed(2)) },
      { x: Number((x + width).toFixed(2)), y: Number(y.toFixed(2)) },
      { x: Number((x + width).toFixed(2)), y: Number((y + height).toFixed(2)) },
      { x: Number(x.toFixed(2)), y: Number((y + height).toFixed(2)) },
    ];
  });
};

const plotDetector2Statuses = ["Available", "Booked", "Processing", "Sold", "Reserved", "Cancelled"];

// Generate 6-digit OTP
const genOTP = () => String(Math.floor(100000 + Math.random() * 900000));

// Generate member ID: MMR00001
const genMemberID = async (userType) => {
  const [row] = await sql`
    SELECT COALESCE(MAX(
      CASE
        WHEN member_id ~ '^MMR[0-9]+$'
          THEN SUBSTRING(member_id FROM 4)::integer
        WHEN member_id ~ '^MMR-[AC]-[0-9]+$'
          THEN SUBSTRING(member_id FROM 7)::integer
        ELSE 0 END
    ), 0) + 1 AS seq
    FROM users`;
  return "MMR" + String(row.seq).padStart(5, "0");
};

// Generate invite code for Associates
const genInviteCode = () =>
  "MMR" + Math.random().toString(36).substring(2, 8).toUpperCase();

/* ==========================
   SIMPLE API KEY AUTH  (existing)
========================== */
const apiAuth = (req, res, next) => {
  const apiKey = req.headers["x-api-key"];
  if (!apiKey || apiKey !== process.env.API_KEY)
    return res.status(401).json({ error: "Unauthorized" });
  next();
};

/* ==========================
   JWT MIDDLEWARE — USER
========================== */
const verifyUserToken = async (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer "))
    return err(res, "No token provided", 401);
  try {
    const decoded = jwt.verify(auth.split(" ")[1], process.env.JWT_SECRET);
    const [user] = await sql`
      SELECT user_id, member_id, user_type, account_status, is_active
      FROM users
      WHERE user_id = ${decoded.user_id}`;
    if (!user) return err(res, "User account not found", 401);
    if (!["Active", "Approved"].includes(String(user.account_status)) || user.is_active === false)
      return err(res, "User account is not active", 403);
    req.user = { ...decoded, ...user };
    return next();
  } catch (error) {
    console.error("[User Auth Error]", error?.message || error);
    return err(res, "Invalid or expired token", 401);
  }
};

const requireAssociate = (req, res, next) => {
  if (req.user?.user_type !== "Associate")
    return err(res, "Associate access required", 403);
  return next();
};

/* ==========================
   JWT MIDDLEWARE — ADMIN
========================== */
const verifyAdminToken = (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer "))
    return err(res, "No admin token", 401);
  const token = auth.split(" ")[1];
  try {
    req.admin = jwt.verify(token, adminJwtSecret());
    return next();
  } catch (e1) {
    try {
      const fallbackSecret = process.env.JWT_SECRET || "mmr_constructions_jwt_secret_2026_key";
      req.admin = jwt.verify(token, fallbackSecret);
      return next();
    } catch (e2) {
      try {
        req.admin = jwt.verify(token, "mmr_constructions_jwt_secret_2026_key");
        return next();
      } catch (e3) {
        return err(res, "Invalid or expired admin token", 401);
      }
    }
  }
};

// Role guard for admin
const role = (...allowed) => (req, res, next) => {
  if (!allowed.includes(req.admin?.role))
    return err(res, "Forbidden — insufficient role", 403);
  next();
};

/* ==========================
   COMPANY SETTINGS
   GET public, updates admin-only
========================== */
const getCompanySettings = async (req, res) => {
  try {
    const settings = await getCompanySettingsRow();
    return ok(res, settings, "Company settings fetched.");
  } catch (e) {
    console.error("[Company Settings Fetch Error]", e);
    return err(res, "Failed to load company settings");
  }
};

app.get(["/api/company-settings", "/company-settings"], getCompanySettings);

app.get("/api/admin/company-settings",
  verifyAdminToken,
  role("SuperAdmin", "SiteManager", "SupportStaff"),
  async (req, res) => {
    try {
      const settings = await getCompanySettingsRow();
      return ok(res, settings, "Company settings fetched.");
    } catch (e) {
      console.error("[Admin Company Settings Fetch Error]", e);
      return err(res, "Failed to load company settings");
    }
  }
);

app.put("/api/admin/company-settings",
  verifyAdminToken,
  role("SuperAdmin", "SiteManager"),
  async (req, res) => {
    try {
      await ensureCompanySettingsSchema();
      const payload = normalizeCompanyPayload(req.body);
      const current = await getCompanySettingsRow();
      const next = { ...current, ...payload };
      const [updated] = await sql`
        UPDATE company_settings SET
          company_name = ${next.company_name},
          company_logo_url = ${next.company_logo_url},
          company_address = ${next.company_address},
          company_email = ${next.company_email},
          company_phone = ${next.company_phone},
          company_whatsapp = ${next.company_whatsapp},
          company_website = ${next.company_website},
          company_description = ${next.company_description},
          support_email = ${next.support_email},
          support_phone = ${next.support_phone},
          facebook_url = ${next.facebook_url},
          instagram_url = ${next.instagram_url},
          twitter_url = ${next.twitter_url},
          youtube_url = ${next.youtube_url},
          linkedin_url = ${next.linkedin_url},
          favicon_url = ${next.favicon_url},
          gst_number = ${next.gst_number},
          pan_number = ${next.pan_number},
          copyright_text = ${next.copyright_text},
          updated_at = NOW()
        WHERE id = ${current.id}
        RETURNING *`;
      await sql`
        INSERT INTO audit_log (actor_type, actor_id, actor_name, module, action, target_table, target_record_id, new_value)
        VALUES ('Admin', ${req.admin.admin_id}, ${req.admin.full_name},
                'CompanySettings', 'UpdateCompanySettings', 'company_settings', ${current.id}, ${JSON.stringify(payload)})`;
      return ok(res, updated, "Company settings updated.");
    } catch (e) {
      console.error("[Company Settings Update Error]", e);
      return err(res, "Failed to update company settings");
    }
  }
);

/* ==========================
   HOME EXPERIENCE SETTINGS, BOOK PLOT BACKGROUNDS & LEADS
========================== */
app.get("/api/home-page/settings", async (_req, res) => {
  try {
    await ensureHomeExperienceSchema();
    const settings = await getCachedOrFetch("home-page-settings", 15000, async () => {
      const [row] = await sql`
        SELECT display_type, show_hero_slider, show_information_section, section_visibility
        FROM home_page_settings WHERE id = 1 AND is_active = TRUE AND is_deleted = FALSE`;
      return row || { display_type: "hero_slider", show_hero_slider: true, show_information_section: true, section_visibility: {} };
    });
    return ok(res, settings);
  } catch (e) {
    console.error("[Home Settings Fetch Error]", e);
    return err(res, "Failed to load home page settings");
  }
});

app.get("/api/admin/home-page/settings", verifyAdminToken, role("SuperAdmin", "SiteManager"), async (_req, res) => {
  try {
    await ensureHomeExperienceSchema();
    const [settings] = await sql`SELECT * FROM home_page_settings WHERE id = 1`;
    return ok(res, settings);
  } catch (e) { return err(res, e.message); }
});

app.put("/api/admin/home-page/settings", verifyAdminToken, role("SuperAdmin", "SiteManager"), async (req, res) => {
  try {
    await ensureHomeExperienceSchema();
    const displayType = "hero_slider";
    const sectionVisibility = req.body.section_visibility && typeof req.body.section_visibility === "object"
      ? Object.fromEntries(["investors", "sites", "why_choose", "emi_calculator", "buyback", "earn", "facilities", "cta", "contact"]
          .map((key) => [key, parseBool(req.body.section_visibility[key], true)]))
      : null;
    const [settings] = await sql`
      UPDATE home_page_settings SET
        display_type = ${displayType},
        show_hero_slider = TRUE,
        show_information_section = ${parseBool(req.body.show_information_section, true)},
        section_visibility = CASE WHEN ${sectionVisibility === null} THEN section_visibility ELSE ${sql.json(sectionVisibility || {})} END,
        updated_at = NOW()
      WHERE id = 1 RETURNING *`;
    await logAdminAudit(req, "HomePage", "UpdateSettings", "home_page_settings", 1, sql.json(settings));
    invalidateApiCache("home-page-settings");
    return ok(res, settings, "Home page settings updated.");
  } catch (e) { return err(res, e.message); }
});

app.get("/api/investors", async (_req, res) => {
  try {
    await ensureHomeExperienceSchema();
    const investors = await getCachedOrFetch("investors", 15000, async () => {
      const showcase = await sql`
        SELECT id::text as id, name, profile_image_url, display_order, created_at
        FROM investors
        WHERE is_active = TRUE AND is_deleted = FALSE`;

      const portalInvestors = await sql`
        SELECT ('portal_' || id::text) as id,
               full_name as name,
               COALESCE(profile_picture_url, '') as profile_image_url,
               0 as display_order,
               created_at
        FROM investor_users
        WHERE (status = 'active' OR status = 'approved')
          AND (deleted_at IS NULL)
          AND (is_verified = TRUE OR status = 'approved' OR status = 'active')`;

      const combined = [...showcase, ...portalInvestors];
      combined.sort((a, b) => (a.display_order - b.display_order) || (new Date(a.created_at) - new Date(b.created_at)));

      return combined.map(item => ({
        id: item.id,
        name: item.name,
        profile_image_url: item.profile_image_url,
        display_order: item.display_order
      }));
    });
    return ok(res, investors);
  } catch (e) { return err(res, "Failed to load investors"); }
});

app.get("/api/admin/investors", verifyAdminToken, role("SuperAdmin", "SiteManager"), async (_req, res) => {
  try { await ensureHomeExperienceSchema(); return ok(res, await sql`SELECT * FROM investors WHERE is_deleted = FALSE ORDER BY display_order, created_at`); }
  catch (e) { return err(res, e.message); }
});

app.post("/api/admin/investors", verifyAdminToken, role("SuperAdmin", "SiteManager"), upload.single("profile_image"), async (req, res) => {
  try {
    await ensureHomeExperienceSchema(); const name = String(req.body.name || "").trim();
    if (!name) return err(res, "Investor name is required", 400);
    if (!req.file || !/^image\/(jpeg|png|webp)$/.test(req.file.mimetype)) return err(res, "Profile image is required (JPG, PNG or WEBP)", 400);
    const { url } = await saveFileToVPS(req.file.buffer, { module: "investor", entityId: name, entityType: "Investor", originalName: req.file.originalname });
    const [created] = await sql`INSERT INTO investors(name, profile_image_url, profile_image_public_id, display_order, is_active)
      VALUES(${name}, ${url}, ${null}, ${Number(req.body.display_order)||0}, ${parseBool(req.body.is_active,true)}) RETURNING *`;
    invalidateApiCache("investors");
    return ok(res, created, "Investor added.", 201);
  } catch (e) { return err(res, e.message); }
});

app.put("/api/admin/investors/:id", verifyAdminToken, role("SuperAdmin", "SiteManager"), upload.single("profile_image"), async (req, res) => {
  try {
    await ensureHomeExperienceSchema(); const [current] = await sql`SELECT * FROM investors WHERE id=${req.params.id} AND is_deleted=FALSE`;
    if (!current) return err(res, "Investor not found", 404);
    const name = String(req.body.name || "").trim(); if (!name) return err(res, "Investor name is required", 400);
    let url=current.profile_image_url, publicId=current.profile_image_public_id;
    if(req.file){ if(!/^image\/(jpeg|png|webp)$/.test(req.file.mimetype)) return err(res,"Profile image must be JPG, PNG or WEBP",400);
      const saved = await saveFileToVPS(req.file.buffer, { module: "investor", entityId: req.params.id, entityType: "Investor", originalName: req.file.originalname });
      url = saved.url; publicId = null;
      await deleteFileFromStorage(current.profile_image_url, current.profile_image_public_id); }
    const [updated]=await sql`UPDATE investors SET name=${name},profile_image_url=${url},profile_image_public_id=${publicId},display_order=${Number(req.body.display_order)||0},is_active=${parseBool(req.body.is_active,true)},updated_at=NOW() WHERE id=${req.params.id} RETURNING *`;
    invalidateApiCache("investors");
    return ok(res,updated,"Investor updated.");
  } catch(e){return err(res,e.message);}
});

app.patch("/api/admin/investors/:id/status", verifyAdminToken, role("SuperAdmin", "SiteManager"), async(req,res)=>{
  try{await ensureHomeExperienceSchema();const [row]=await sql`UPDATE investors SET is_active=${parseBool(req.body.is_active,false)},updated_at=NOW() WHERE id=${req.params.id} AND is_deleted=FALSE RETURNING *`;if(!row)return err(res,"Investor not found",404);invalidateApiCache("investors");return ok(res,row,"Investor status updated.");}catch(e){return err(res,e.message);}
});

app.delete("/api/admin/investors/:id", verifyAdminToken, role("SuperAdmin", "SiteManager"), async(req,res)=>{
  try{await ensureHomeExperienceSchema();const [row]=await sql`UPDATE investors SET is_deleted=TRUE,is_active=FALSE,updated_at=NOW() WHERE id=${req.params.id} AND is_deleted=FALSE RETURNING id,profile_image_url,profile_image_public_id`;if(!row)return err(res,"Investor not found",404);await deleteFileFromStorage(row.profile_image_url, row.profile_image_public_id);invalidateApiCache("investors");return ok(res,{},"Investor deleted.");}catch(e){return err(res,e.message);}
});

app.get("/api/book-plot/backgrounds", async (_req, res) => {
  try {
    await ensureHomeExperienceSchema();
    const images = await getCachedOrFetch("book-plot-backgrounds", 15000, async () => {
      return await sql`
        SELECT id, image_url, alt_text, display_order
        FROM book_plot_background_images
        WHERE is_active = TRUE AND is_deleted = FALSE
        ORDER BY display_order, id`;
    });
    return ok(res, images);
  } catch (e) { return err(res, "Failed to load Book Plot backgrounds"); }
});

app.get("/api/admin/book-plot/backgrounds", verifyAdminToken, role("SuperAdmin", "SiteManager"), async (_req, res) => {
  try {
    await ensureHomeExperienceSchema();
    return ok(res, await sql`SELECT * FROM book_plot_background_images WHERE is_deleted = FALSE ORDER BY display_order, id`);
  } catch (e) { return err(res, e.message); }
});

app.post("/api/admin/book-plot/backgrounds", verifyAdminToken, role("SuperAdmin", "SiteManager"), upload.single("background_image"), async (req, res) => {
  try {
    await ensureHomeExperienceSchema();
    let imageUrl = String(req.body.image_url || "").trim();
    let publicId = null;
    if (req.file) {
      const saved = await saveFileToVPS(req.file.buffer, { module: "background", entityId: "bg", entityType: "Background", originalName: req.file.originalname });
      imageUrl = saved.url; publicId = null;
    }
    if (!imageUrl) return err(res, "Background image is required", 400);
    const [image] = await sql`
      INSERT INTO book_plot_background_images (image_url, image_public_id, alt_text, display_order, is_active)
      VALUES (${imageUrl}, ${publicId}, ${String(req.body.alt_text || "").trim() || null},
              ${Number(req.body.display_order) || 0}, ${parseBool(req.body.is_active, true)}) RETURNING *`;
    return ok(res, image, "Background image added.", 201);
  } catch (e) { return err(res, e.message); }
});

app.put("/api/admin/book-plot/backgrounds/:id", verifyAdminToken, role("SuperAdmin", "SiteManager"), async (req, res) => {
  try {
    await ensureHomeExperienceSchema();
    const [image] = await sql`
      UPDATE book_plot_background_images SET alt_text = ${String(req.body.alt_text || "").trim() || null},
        display_order = ${Number(req.body.display_order) || 0}, is_active = ${parseBool(req.body.is_active, true)}, updated_at = NOW()
      WHERE id = ${req.params.id} AND is_deleted = FALSE RETURNING *`;
    if (!image) return err(res, "Background image not found", 404);
    return ok(res, image, "Background image updated.");
  } catch (e) { return err(res, e.message); }
});

app.delete("/api/admin/book-plot/backgrounds/:id", verifyAdminToken, role("SuperAdmin", "SiteManager"), async (req, res) => {
  try {
    await ensureHomeExperienceSchema();
    const [image] = await sql`
      UPDATE book_plot_background_images SET is_deleted = TRUE, is_active = FALSE, updated_at = NOW()
      WHERE id = ${req.params.id} AND is_deleted = FALSE RETURNING id, image_url, image_public_id`;
    if (!image) return err(res, "Background image not found", 404);
    await deleteFileFromStorage(image.image_url, image.image_public_id);
    return ok(res, {}, "Background image deleted.");
  } catch (e) { return err(res, e.message); }
});

app.post("/api/book-plot/leads", optionalUserToken, async (req, res) => {
  try {
    await ensureHomeExperienceSchema();
    const fullName = String(req.body.full_name || "").trim();
    const mobile = String(req.body.contact_number || "").replace(/\D/g, "");
    const siteId = req.body.site_id ? Number(req.body.site_id) : null;
    const customSiteName = String(req.body.custom_site_name || "").trim() || null;
    if (fullName.length < 2) return err(res, "Full name is required", 400);
    if (!/^[6-9]\d{9}$/.test(mobile)) return err(res, "Enter a valid 10 digit mobile number", 400);
    if (!siteId && !customSiteName) return err(res, "Select or enter a site/project", 400);
    if (siteId) {
      const [site] = await sql`SELECT site_id FROM sites WHERE site_id = ${siteId} AND is_active = TRUE`;
      if (!site) return err(res, "Selected site is not active", 400);
    }
    const [lead] = await sql`
      INSERT INTO book_plot_leads (full_name, contact_number, site_id, custom_site_name, user_id)
      VALUES (${fullName}, ${mobile}, ${siteId}, ${customSiteName}, ${req.user?.user_id || null})
      RETURNING id, created_at`;
    const inquiryNumber = `BPL-${new Date(lead.created_at).toISOString().slice(0,10).replace(/-/g, "")}-${String(lead.id).padStart(6, "0")}`;
    await sql`UPDATE book_plot_leads SET inquiry_number = ${inquiryNumber} WHERE id = ${lead.id}`;
    return ok(res, { inquiry_number: inquiryNumber, inquiry_date: lead.created_at }, "Your inquiry has been submitted.", 201);
  } catch (e) { console.error("[Book Plot Lead Error]", e); return err(res, "Failed to submit inquiry"); }
});

const bookPlotLeadQuery = (search, status) => sql`
  SELECT l.id, l.inquiry_number, l.full_name, l.contact_number, l.site_id,
         s.site_name AS selected_site, l.custom_site_name, l.created_at,
         CASE WHEN l.user_id IS NULL THEN 'Guest' ELSE 'Registered' END AS user_type, l.status
  FROM book_plot_leads l LEFT JOIN sites s ON s.site_id = l.site_id
  WHERE l.is_deleted = FALSE
    AND (${status || null}::text IS NULL OR l.status = ${status || null})
    AND (${search || null}::text IS NULL OR l.inquiry_number ILIKE ${`%${search || ""}%`}
      OR l.full_name ILIKE ${`%${search || ""}%`} OR l.contact_number ILIKE ${`%${search || ""}%`}
      OR s.site_name ILIKE ${`%${search || ""}%`} OR l.custom_site_name ILIKE ${`%${search || ""}%`})`;

app.get("/api/admin/book-plot/leads", verifyAdminToken, role("SuperAdmin", "SiteManager"), async (req, res) => {
  try {
    await ensureHomeExperienceSchema();
    const page = Math.max(1, Number(req.query.page) || 1), limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const search = String(req.query.search || "").trim(), status = String(req.query.status || "").trim();
    const rows = await bookPlotLeadQuery(search, status);
    return ok(res, { items: rows.slice((page - 1) * limit, page * limit), pagination: { page, limit, total: rows.length, pages: Math.ceil(rows.length / limit) } });
  } catch (e) { return err(res, e.message); }
});

app.patch("/api/admin/book-plot/leads/:id/status", verifyAdminToken, role("SuperAdmin", "SiteManager"), async (req, res) => {
  try {
    await ensureHomeExperienceSchema();
    const status = String(req.body.status || "");
    if (!["New", "Contacted", "Follow Up", "Converted", "Closed"].includes(status)) return err(res, "Invalid status", 400);
    const [lead] = await sql`UPDATE book_plot_leads SET status = ${status}, updated_at = NOW() WHERE id = ${req.params.id} AND is_deleted = FALSE RETURNING id, status`;
    if (!lead) return err(res, "Lead not found", 404);
    return ok(res, lead, "Lead status updated.");
  } catch (e) { return err(res, e.message); }
});

app.get("/api/admin/book-plot/leads/export", verifyAdminToken, role("SuperAdmin", "SiteManager"), async (req, res) => {
  try {
    await ensureHomeExperienceSchema();
    const rows = await bookPlotLeadQuery(String(req.query.search || "").trim(), String(req.query.status || "").trim());
    const sheet = xlsx.utils.json_to_sheet(rows.map(r => ({
      "Inquiry Id": r.inquiry_number, Name: r.full_name, "Mobile Number": r.contact_number,
      "Selected Site": r.selected_site || "", "Custom Site Name": r.custom_site_name || "",
      "Inquiry Date": r.created_at, "User Type": r.user_type, Status: r.status,
    })));
    const workbook = xlsx.utils.book_new(); xlsx.utils.book_append_sheet(workbook, sheet, "Book Plot Leads");
    const buffer = xlsx.write(workbook, { type: "buffer", bookType: "xlsx" });
    res.setHeader("Content-Disposition", `attachment; filename=book-plot-leads-${new Date().toISOString().slice(0,10)}.xlsx`);
    res.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"); return res.send(buffer);
  } catch (e) { return err(res, e.message); }
});

/* ==========================
   HOME PAGE SLIDERS
   Public active list + protected admin CRUD
========================== */
app.get("/api/home-sliders", async (_req, res) => {
  try {
    await ensureHomeSlidersSchema();
    const sliders = await getCachedOrFetch("home-sliders", 15000, async () => {
      return await sql`
        SELECT id, title, subtitle, description, image_url,
               button_text, button_link, button_icon,
               button2_text, button2_link, button2_icon,
               tag_text, tag_icon, thumbnail_url, thumbnail_title, thumbnail_subtitle,
               stats_json, show_image, show_tag, show_title, show_subtitle,
               show_description, show_button1, show_button2, show_stats, show_thumbnail,
               display_order, created_at, updated_at
        FROM home_sliders
        WHERE is_active = TRUE
        ORDER BY display_order ASC, id ASC`;
    });
    return ok(res, sliders, "Active home sliders fetched.");
  } catch (e) {
    console.error("[Home Sliders Fetch Error]", e);
    return err(res, "Failed to load home sliders");
  }
});

app.get("/api/admin/home-sliders",
  verifyAdminToken,
  role("SuperAdmin", "SiteManager"),
  async (_req, res) => {
    try {
      await ensureHomeSlidersSchema();
      const sliders = await sql`
        SELECT id, title, subtitle, description, image_url,
               button_text, button_link, button_icon,
               button2_text, button2_link, button2_icon,
               tag_text, tag_icon, thumbnail_url, thumbnail_title, thumbnail_subtitle,
               stats_json, show_image, show_tag, show_title, show_subtitle,
               show_description, show_button1, show_button2, show_stats, show_thumbnail,
               display_order, is_active, created_at, updated_at
        FROM home_sliders
        ORDER BY display_order ASC, id ASC`;
      return ok(res, sliders, "Home sliders fetched.");
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.get("/api/admin/home-sliders/:id",
  verifyAdminToken,
  role("SuperAdmin", "SiteManager"),
  async (req, res) => {
    try {
      await ensureHomeSlidersSchema();
      const [slider] = await sql`
        SELECT id, title, subtitle, description, image_url,
               button_text, button_link, button_icon,
               button2_text, button2_link, button2_icon,
               tag_text, tag_icon, thumbnail_url, thumbnail_title, thumbnail_subtitle,
               stats_json, show_image, show_tag, show_title, show_subtitle,
               show_description, show_button1, show_button2, show_stats, show_thumbnail,
               display_order, is_active, created_at, updated_at
        FROM home_sliders
        WHERE id = ${req.params.id}`;
      if (!slider) return err(res, "Slider not found", 404);
      return ok(res, slider, "Home slider fetched.");
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.post("/api/admin/home-sliders",
  verifyAdminToken,
  role("SuperAdmin", "SiteManager"),
  upload.single("slider_image"),
  async (req, res) => {
    try {
      await ensureHomeSlidersSchema();
      const title = String(req.body.title || "").trim();
      if (!title) return err(res, "Slider title is required", 400);

      let imageUrl = String(req.body.image_url || "").trim();
      let imagePublicId = null;
      if (req.file) {
        const saved = await saveFileToVPS(req.file.buffer, { module: "slider", entityId: title, entityType: "HomeSlider", originalName: req.file.originalname });
        imageUrl = saved.url;
        imagePublicId = null;
      }
      if (!imageUrl) return err(res, "Slider image is required", 400);

      const [slider] = await sql`
        INSERT INTO home_sliders (
          title, subtitle, description, image_url, image_public_id,
          button_text, button_link, button_icon,
          button2_text, button2_link, button2_icon,
          tag_text, tag_icon, thumbnail_url, thumbnail_title, thumbnail_subtitle,
          stats_json, show_image, show_tag, show_title, show_subtitle,
          show_description, show_button1, show_button2, show_stats, show_thumbnail,
          display_order, is_active,
          created_by_admin_id, updated_by_admin_id
        ) VALUES (
          ${title},
          ${String(req.body.subtitle || "").trim() || null},
          ${String(req.body.description || "").trim() || null},
          ${imageUrl},
          ${imagePublicId},
          ${String(req.body.button_text || "").trim() || null},
          ${normalizeSliderLink(req.body.button_link)},
          ${String(req.body.button_icon || "").trim() || "fas fa-arrow-right"},
          ${String(req.body.button2_text || "").trim() || null},
          ${normalizeSliderLink(req.body.button2_link)},
          ${String(req.body.button2_icon || "").trim() || "fas fa-arrow-right"},
          ${String(req.body.tag_text || "").trim() || null},
          ${String(req.body.tag_icon || "").trim() || "fas fa-star"},
          ${String(req.body.thumbnail_url || "").trim() || imageUrl},
          ${String(req.body.thumbnail_title || "").trim() || title},
          ${String(req.body.thumbnail_subtitle || "").trim() || null},
          ${sql.json(parseSliderStats(req.body.stats_json))},
          ${parseBool(req.body.show_image, true)},
          ${parseBool(req.body.show_tag, true)},
          ${parseBool(req.body.show_title, true)},
          ${parseBool(req.body.show_subtitle, true)},
          ${parseBool(req.body.show_description, true)},
          ${parseBool(req.body.show_button1, true)},
          ${parseBool(req.body.show_button2, true)},
          ${parseBool(req.body.show_stats, true)},
          ${parseBool(req.body.show_thumbnail, true)},
          ${Number.isInteger(Number(req.body.display_order)) ? Number(req.body.display_order) : 0},
          ${parseBool(req.body.is_active, true)},
          ${req.admin.admin_id || null},
          ${req.admin.admin_id || null}
        )
        RETURNING id, title`;
      await logAdminAudit(req, "HomeSlider", "CreateSlider", "home_sliders", slider.id, sql.json({ title }));
      return ok(res, slider, "Home slider created.", 201);
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.post("/api/admin/home-sliders/bulk",
  verifyAdminToken,
  role("SuperAdmin", "SiteManager"),
  upload.array("slider_images", 20),
  async (req, res) => {
    try {
      await ensureHomeSlidersSchema();
      const files = Array.isArray(req.files) ? req.files : [];
      if (!files.length) return err(res, "Select at least one slider image", 400);
      if (files.some((file) => !/^image\/(jpeg|png|webp)$/.test(file.mimetype))) {
        return err(res, "Only JPG, JPEG, PNG and WEBP slider images are allowed.", 400);
      }

      const [{ next_order }] = await sql`
        SELECT COALESCE(MAX(display_order), -1) + 1 AS next_order
        FROM home_sliders`;
      const created = [];

      for (const [index, file] of files.entries()) {
        const saved = await saveFileToVPS(file.buffer, { module: "slider", entityId: `bulk_${index+1}`, entityType: "HomeSlider", originalName: file.originalname });
        const originalName = path.basename(file.originalname || `Slider ${index + 1}`, path.extname(file.originalname || ""));
        const title = originalName.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim() || `Slider ${index + 1}`;
        const [slider] = await sql`
          INSERT INTO home_sliders (
            title, image_url, image_public_id, thumbnail_url, thumbnail_title,
            display_order, is_active, created_by_admin_id, updated_by_admin_id
          ) VALUES (
            ${title},
            ${saved.url},
            ${null},
            ${saved.url},
            ${title},
            ${Number(next_order) + index},
            TRUE,
            ${req.admin.admin_id || null},
            ${req.admin.admin_id || null}
          )
          RETURNING id, title, image_url, display_order, is_active`;
        created.push(slider);
      }

      await logAdminAudit(req, "HomeSlider", "BulkCreateSliders", "home_sliders", null, sql.json({ count: created.length }));
      return ok(res, created, `${created.length} slider image${created.length === 1 ? "" : "s"} uploaded.`, 201);
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.put("/api/admin/home-sliders/:id",
  verifyAdminToken,
  role("SuperAdmin", "SiteManager"),
  upload.single("slider_image"),
  async (req, res) => {
    try {
      await ensureHomeSlidersSchema();
      const [existing] = await sql`
        SELECT id, image_url, image_public_id
        FROM home_sliders
        WHERE id = ${req.params.id}`;
      if (!existing) return err(res, "Slider not found", 404);

      let imageUrl = String(req.body.image_url || "").trim() || existing.image_url;
      let imagePublicId = existing.image_public_id;
      if (req.file) {
        const saved = await saveFileToVPS(req.file.buffer, { module: "slider", entityId: req.params.id, entityType: "HomeSlider", originalName: req.file.originalname });
        imageUrl = saved.url;
        imagePublicId = null;
        await deleteFileFromStorage(existing.image_url, existing.image_public_id);
      }

      const title = String(req.body.title || "").trim();
      if (!title) return err(res, "Slider title is required", 400);
      await sql`
        UPDATE home_sliders SET
          title = ${title},
          subtitle = ${String(req.body.subtitle || "").trim() || null},
          description = ${String(req.body.description || "").trim() || null},
          image_url = ${imageUrl},
          image_public_id = ${imagePublicId},
          button_text = ${String(req.body.button_text || "").trim() || null},
          button_link = ${normalizeSliderLink(req.body.button_link)},
          button_icon = ${String(req.body.button_icon || "").trim() || "fas fa-arrow-right"},
          button2_text = ${String(req.body.button2_text || "").trim() || null},
          button2_link = ${normalizeSliderLink(req.body.button2_link)},
          button2_icon = ${String(req.body.button2_icon || "").trim() || "fas fa-arrow-right"},
          tag_text = ${String(req.body.tag_text || "").trim() || null},
          tag_icon = ${String(req.body.tag_icon || "").trim() || "fas fa-star"},
          thumbnail_url = ${String(req.body.thumbnail_url || "").trim() || imageUrl},
          thumbnail_title = ${String(req.body.thumbnail_title || "").trim() || title},
          thumbnail_subtitle = ${String(req.body.thumbnail_subtitle || "").trim() || null},
          stats_json = ${sql.json(parseSliderStats(req.body.stats_json))},
          show_image = ${parseBool(req.body.show_image, true)},
          show_tag = ${parseBool(req.body.show_tag, true)},
          show_title = ${parseBool(req.body.show_title, true)},
          show_subtitle = ${parseBool(req.body.show_subtitle, true)},
          show_description = ${parseBool(req.body.show_description, true)},
          show_button1 = ${parseBool(req.body.show_button1, true)},
          show_button2 = ${parseBool(req.body.show_button2, true)},
          show_stats = ${parseBool(req.body.show_stats, true)},
          show_thumbnail = ${parseBool(req.body.show_thumbnail, true)},
          display_order = ${Number.isInteger(Number(req.body.display_order)) ? Number(req.body.display_order) : 0},
          is_active = ${parseBool(req.body.is_active, true)},
          updated_by_admin_id = ${req.admin.admin_id || null},
          updated_at = NOW()
        WHERE id = ${req.params.id}`;
      await logAdminAudit(req, "HomeSlider", "UpdateSlider", "home_sliders", req.params.id, sql.json({ title }));
      return ok(res, {}, "Home slider updated.");
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.delete("/api/admin/home-sliders/:id",
  verifyAdminToken,
  role("SuperAdmin", "SiteManager"),
  async (req, res) => {
    try {
      await ensureHomeSlidersSchema();
      const [slider] = await sql`
        UPDATE home_sliders
        SET is_active = FALSE,
            updated_by_admin_id = ${req.admin.admin_id || null},
            updated_at = NOW()
        WHERE id = ${req.params.id}
        RETURNING id`;
      if (!slider) return err(res, "Slider not found", 404);
      await logAdminAudit(req, "HomeSlider", "DeactivateSlider", "home_sliders", req.params.id, sql.json({ is_active: false }));
      return ok(res, {}, "Home slider deactivated.");
    } catch (e) {
      return err(res, e.message);
    }
  }
);

/* ==========================
   COMPANY VERIFICATION DOCUMENTS
   Public active list + protected admin CRUD
========================== */
app.get("/api/company-documents", async (_req, res) => {
  try {
    await ensureCompanyDocumentsSchema();
    const documents = await sql`
      SELECT id, document_name, document_name_hi, document_description, document_description_hi,
             document_type, document_type_hi,
             file_url, file_type, mime_type, original_file_name,
             file_size_bytes, display_order, created_at, updated_at
      FROM company_documents
      WHERE is_active = TRUE
      ORDER BY display_order ASC, id ASC`;
    return ok(res, documents, "Active company documents fetched.");
  } catch (e) {
    console.error("[Company Documents Fetch Error]", e);
    return err(res, "Failed to load company documents");
  }
});

app.get("/api/company-documents/:id/file", async (req, res) => {
  try {
    await ensureCompanyDocumentsSchema();
    const [document] = await sql`
      SELECT id, document_name, file_data, mime_type, original_file_name
      FROM company_documents
      WHERE id = ${req.params.id} AND is_active = TRUE`;
    if (!document || !document.file_data) return err(res, "Document file not found", 404);

    const safeName = String(document.original_file_name || document.document_name || "company-document")
      .replace(/[\r\n"]/g, "_");
    const disposition = req.query.download === "1" ? "attachment" : "inline";
    res.setHeader("Content-Type", document.mime_type || "application/octet-stream");
    res.setHeader("Content-Disposition", `${disposition}; filename="${safeName}"`);
    res.setHeader("Content-Length", document.file_data.length);
    res.setHeader("Cache-Control", "public, max-age=3600");
    return res.send(document.file_data);
  } catch (e) {
    console.error("[Company Document File Error]", e);
    return err(res, "Failed to load company document");
  }
});

app.get("/api/admin/company-documents",
  verifyAdminToken,
  role("SuperAdmin", "SiteManager"),
  async (_req, res) => {
    try {
      await ensureCompanyDocumentsSchema();
      const documents = await sql`
        SELECT id, document_name, document_name_hi, document_description, document_description_hi,
               document_type, document_type_hi,
               file_url, file_public_id, file_type, mime_type,
               original_file_name, file_size_bytes, display_order,
               is_active, created_at, updated_at
        FROM company_documents
        ORDER BY display_order ASC, id ASC`;
      return ok(res, documents, "Company documents fetched.");
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.post("/api/admin/company-documents",
  verifyAdminToken,
  role("SuperAdmin", "SiteManager"),
  upload.single("company_document"),
  async (req, res) => {
    try {
      await ensureCompanyDocumentsSchema();
      const documentName = String(req.body.document_name || "").trim();
      if (!documentName) return err(res, "Document name is required", 400);
      if (!req.file) return err(res, "Document file is required", 400);

      const extension = path.extname(req.file.originalname || "").toLowerCase();
      const fileType = extension === ".pdf" ? "pdf" : "image";
      const [document] = await sql`
        INSERT INTO company_documents (
          document_name, document_name_hi, document_description, document_description_hi,
          document_type, document_type_hi,
          file_url, file_public_id, file_data, file_type, mime_type,
          original_file_name, file_size_bytes, display_order, is_active,
          created_by_admin_id, updated_by_admin_id
        ) VALUES (
          ${documentName},
          ${String(req.body.document_name_hi || "").trim() || null},
          ${String(req.body.document_description || "").trim() || null},
          ${String(req.body.document_description_hi || "").trim() || null},
          ${String(req.body.document_type || "").trim() || null},
          ${String(req.body.document_type_hi || "").trim() || null},
          ${null}, ${null}, ${req.file.buffer}, ${fileType},
          ${req.file.mimetype || null}, ${req.file.originalname || null},
          ${req.file.size || null},
          ${Number.isInteger(Number(req.body.display_order)) ? Number(req.body.display_order) : 0},
          ${parseBool(req.body.is_active, true)},
          ${req.admin.admin_id || null}, ${req.admin.admin_id || null}
        )
        RETURNING id, document_name`;
      await sql`
        UPDATE company_documents
        SET file_url = ${`/api/company-documents/${document.id}/file`}
        WHERE id = ${document.id}`;
      await logAdminAudit(req, "CompanyDocuments", "CreateDocument", "company_documents", document.id, sql.json({ document_name: documentName }));
      return ok(res, document, "Company document created.", 201);
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.put("/api/admin/company-documents/:id",
  verifyAdminToken,
  role("SuperAdmin", "SiteManager"),
  upload.single("company_document"),
  async (req, res) => {
    try {
      await ensureCompanyDocumentsSchema();
      const [existing] = await sql`
        SELECT * FROM company_documents WHERE id = ${req.params.id}`;
      if (!existing) return err(res, "Company document not found", 404);

      const documentName = String(req.body.document_name || "").trim();
      if (!documentName) return err(res, "Document name is required", 400);
      let fileUrl = existing.file_url;
      let filePublicId = null;
      let fileData = existing.file_data;
      let fileType = existing.file_type;
      let mimeType = existing.mime_type;
      let originalFileName = existing.original_file_name;
      let fileSizeBytes = existing.file_size_bytes;

      if (req.file) {
        fileUrl = `/api/company-documents/${existing.id}/file`;
        fileData = req.file.buffer;
        fileType = path.extname(req.file.originalname || "").toLowerCase() === ".pdf" ? "pdf" : "image";
        mimeType = req.file.mimetype || null;
        originalFileName = req.file.originalname || null;
        fileSizeBytes = req.file.size || null;
      }

      await sql`
        UPDATE company_documents SET
          document_name = ${documentName},
          document_name_hi = ${String(req.body.document_name_hi || "").trim() || null},
          document_description = ${String(req.body.document_description || "").trim() || null},
          document_description_hi = ${String(req.body.document_description_hi || "").trim() || null},
          document_type = ${String(req.body.document_type || "").trim() || null},
          document_type_hi = ${String(req.body.document_type_hi || "").trim() || null},
          file_url = ${fileUrl},
          file_public_id = ${filePublicId},
          file_data = ${fileData},
          file_type = ${fileType},
          mime_type = ${mimeType},
          original_file_name = ${originalFileName},
          file_size_bytes = ${fileSizeBytes},
          display_order = ${Number.isInteger(Number(req.body.display_order)) ? Number(req.body.display_order) : 0},
          is_active = ${parseBool(req.body.is_active, existing.is_active)},
          updated_by_admin_id = ${req.admin.admin_id || null},
          updated_at = NOW()
        WHERE id = ${req.params.id}`;
      await logAdminAudit(req, "CompanyDocuments", "UpdateDocument", "company_documents", req.params.id, sql.json({ document_name: documentName }));
      return ok(res, {}, "Company document updated.");
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.delete("/api/admin/company-documents/:id",
  verifyAdminToken,
  role("SuperAdmin", "SiteManager"),
  async (req, res) => {
    try {
      await ensureCompanyDocumentsSchema();
      const [document] = await sql`
        UPDATE company_documents
        SET is_active = FALSE,
            updated_by_admin_id = ${req.admin.admin_id || null},
            updated_at = NOW()
        WHERE id = ${req.params.id}
        RETURNING id`;
      if (!document) return err(res, "Company document not found", 404);
      await logAdminAudit(req, "CompanyDocuments", "DeactivateDocument", "company_documents", req.params.id, sql.json({ is_active: false }));
      return ok(res, {}, "Company document deactivated.");
    } catch (e) {
      return err(res, e.message);
    }
  }
);

const uploadCompanyAsset = (field) => [
  verifyAdminToken,
  role("SuperAdmin", "SiteManager"),
  companyAssetUpload.single("file"),
  async (req, res) => {
    try {
      if (!req.file) return err(res, "File is required.", 400);
      await ensureCompanySettingsSchema();
      const current = await getCompanySettingsRow();
      const uploaded = await saveFileToVPS(req.file.buffer, { module: "company", entityId: "settings", entityType: "CompanyAsset", originalName: req.file.originalname });
      const [updated] = field === "favicon_url"
        ? await sql`
            UPDATE company_settings
            SET favicon_url = ${uploaded.url}, updated_at = NOW()
            WHERE id = ${current.id}
            RETURNING *`
        : await sql`
            UPDATE company_settings
            SET company_logo_url = ${uploaded.url}, updated_at = NOW()
            WHERE id = ${current.id}
            RETURNING *`;
      await sql`
        INSERT INTO audit_log (actor_type, actor_id, actor_name, module, action, target_table, target_record_id, new_value)
        VALUES ('Admin', ${req.admin.admin_id}, ${req.admin.full_name},
                'CompanySettings', ${field === "favicon_url" ? "UploadFavicon" : "UploadLogo"},
                'company_settings', ${current.id}, ${JSON.stringify({ [field]: uploaded.url })})`;
      return ok(res, updated, field === "favicon_url" ? "Favicon uploaded." : "Logo uploaded.");
    } catch (e) {
      console.error("[Company Asset Upload Error]", e);
      return err(res, e.message || "Failed to upload company asset");
    }
  }
];

app.post("/api/admin/company-settings/logo", ...uploadCompanyAsset("company_logo_url"));
app.post("/api/admin/company-settings/favicon", ...uploadCompanyAsset("favicon_url"));

/* ==========================
   MOBILE APP DOWNLOAD SETTINGS
   Public header display + protected admin management
========================== */
app.get("/api/mobile-app", async (req, res) => {
  try {
    const settings = await getMobileAppSettingsRow();
    if (!settings.is_enabled) {
      return ok(res, null, "Mobile app download is disabled.");
    }
    const isApkMode = settings.download_mode === "apk";
    const apkDownloadUrl = settings.apk_url ? mobileAppAbsoluteUrl(req, "/api/mobile-app/apk/download") : null;
    return ok(res, {
      platform: settings.platform,
      app_name: settings.app_name,
      app_logo_url: settings.app_logo_url,
      play_store_url: settings.play_store_url,
      apk_download_url: apkDownloadUrl,
      download_url: isApkMode ? apkDownloadUrl : settings.play_store_url,
      download_mode: settings.download_mode,
      package_name: settings.package_name,
      current_version: settings.current_version,
      latest_version: settings.latest_version,
      version_code: settings.version_code,
      release_notes: settings.release_notes,
      apk_file_name: settings.apk_file_name,
      apk_file_size_bytes: settings.apk_file_size_bytes,
      apk_uploaded_at: settings.apk_uploaded_at,
      release_date: settings.release_date,
      description: settings.description,
      button_text: settings.button_text,
      badge_text: settings.badge_text,
      is_enabled: settings.is_enabled,
      is_coming_soon: settings.is_coming_soon,
      force_download: settings.force_download,
      open_target: settings.open_target,
      display_order: settings.display_order,
      updated_at: settings.updated_at,
    }, "Mobile app settings fetched.");
  } catch (e) {
    console.error("[Mobile App Public Fetch Error]", e);
    return err(res, "Failed to load mobile app settings");
  }
});

app.get("/api/mobile-app/apk/download", async (req, res) => {
  try {
    const settings = await getMobileAppSettingsRow();
    if (!settings.is_enabled || settings.is_coming_soon) return err(res, "App download is not available yet.", 404);
    if (settings.download_mode !== "apk" || !settings.apk_url) return err(res, "APK download is not configured.", 404);

    const safeName = safeApkFileName(settings.apk_file_name || `${settings.app_name || "mmr-app"}.apk`);
    res.setHeader("Content-Type", "application/vnd.android.package-archive");
    if (settings.apk_file_size_bytes) res.setHeader("Content-Length", String(settings.apk_file_size_bytes));
    res.setHeader("Content-Disposition", `${settings.force_download ? "attachment" : "inline"}; filename="${safeName}"`);
    res.setHeader("Cache-Control", "public, max-age=300, must-revalidate");
    if (String(settings.apk_url).startsWith("/api/mobile-app/apk/file/")) {
      const fileName = safeApkFileName(settings.apk_file_name);
      const filePath = path.join(mobileAppApkDir(), fileName);
      return res.download(filePath, safeName);
    }
    return res.redirect(302, settings.apk_url);
  } catch (e) {
    console.error("[Mobile App APK Download Error]", e);
    return err(res, "Failed to start APK download");
  }
});

app.get("/api/mobile-app/apk/file/:fileName", async (req, res) => {
  try {
    const settings = await getMobileAppSettingsRow();
    if (!settings.is_enabled || settings.is_coming_soon || settings.download_mode !== "apk") {
      return err(res, "App download is not available yet.", 404);
    }
    const requestedName = safeApkFileName(req.params.fileName);
    const configuredName = safeApkFileName(settings.apk_file_name);
    if (requestedName !== configuredName) return err(res, "APK file not found.", 404);
    const filePath = path.join(mobileAppApkDir(), configuredName);
    res.setHeader("Content-Type", "application/vnd.android.package-archive");
    if (settings.apk_file_size_bytes) res.setHeader("Content-Length", String(settings.apk_file_size_bytes));
    res.setHeader("Content-Disposition", `${settings.force_download ? "attachment" : "inline"}; filename="${configuredName}"`);
    res.setHeader("Cache-Control", "public, max-age=300, must-revalidate");
    return res.download(filePath, configuredName);
  } catch (e) {
    console.error("[Mobile App APK File Error]", e);
    return err(res, "APK file not found.", 404);
  }
});

app.get("/api/admin/mobile-app",
  verifyAdminToken,
  role("SuperAdmin", "SiteManager"),
  async (_req, res) => {
    try {
      const settings = await getMobileAppSettingsRow();
      return ok(res, settings, "Mobile app settings fetched.");
    } catch (e) {
      console.error("[Admin Mobile App Fetch Error]", e);
      return err(res, "Failed to load mobile app settings");
    }
  }
);

app.put("/api/admin/mobile-app",
  verifyAdminToken,
  role("SuperAdmin", "SiteManager"),
  async (req, res) => {
    try {
      const current = await getMobileAppSettingsRow();
      const payload = normalizeMobileAppPayload(req.body, current);
      const [updated] = await sql`
        UPDATE mobile_app_settings SET
          platform = ${payload.platform},
          app_name = ${payload.app_name},
          play_store_url = ${payload.play_store_url},
          package_name = ${payload.package_name},
          current_version = ${payload.current_version},
          latest_version = ${payload.latest_version},
          version_code = ${payload.version_code},
          release_notes = ${payload.release_notes},
          download_mode = ${payload.download_mode},
          release_date = ${payload.release_date},
          description = ${payload.description},
          button_text = ${payload.button_text},
          badge_text = ${payload.badge_text},
          is_enabled = ${payload.is_enabled},
          is_coming_soon = ${payload.is_coming_soon},
          force_download = ${payload.force_download},
          open_target = ${payload.open_target},
          display_order = ${payload.display_order},
          updated_by_admin_id = ${req.admin.admin_id || null},
          updated_at = NOW()
        WHERE id = ${current.id}
        RETURNING *`;
      await logAdminAudit(req, "MobileApp", "UpdateSettings", "mobile_app_settings", updated.id, sql.json(payload));
      return ok(res, updated, "Mobile app settings saved.");
    } catch (e) {
      console.error("[Admin Mobile App Update Error]", e);
      return err(res, e.message || "Failed to save mobile app settings", /Play Store URL/.test(e.message || "") ? 400 : 500);
    }
  }
);

app.patch("/api/admin/mobile-app/visibility",
  verifyAdminToken,
  role("SuperAdmin", "SiteManager"),
  async (req, res) => {
    try {
      const current = await getMobileAppSettingsRow();
      const isEnabled = parseBool(req.body?.is_enabled, current.is_enabled);
      const [updated] = await sql`
        UPDATE mobile_app_settings SET
          is_enabled = ${isEnabled},
          updated_by_admin_id = ${req.admin.admin_id || null},
          updated_at = NOW()
        WHERE id = ${current.id}
        RETURNING *`;
      await logAdminAudit(req, "MobileApp", isEnabled ? "EnableDownload" : "DisableDownload", "mobile_app_settings", updated.id, sql.json({ is_enabled: isEnabled }));
      return ok(res, updated, isEnabled ? "Download app section enabled." : "Download app section disabled.");
    } catch (e) {
      console.error("[Admin Mobile App Visibility Error]", e);
      return err(res, "Failed to update visibility");
    }
  }
);

app.post("/api/admin/mobile-app/logo",
  verifyAdminToken,
  role("SuperAdmin", "SiteManager"),
  mobileAppLogoUpload.single("logo"),
  async (req, res) => {
    try {
      if (!req.file) return err(res, "App logo file is required.", 400);
      const current = await getMobileAppSettingsRow();
      const saved = await saveFileToVPS(req.file.buffer, { module: "mobile_app", entityId: "logo", entityType: "AppLogo", originalName: req.file.originalname });
      const [updated] = await sql`
        UPDATE mobile_app_settings SET
          app_logo_url = ${saved.url},
          app_logo_public_id = ${null},
          updated_by_admin_id = ${req.admin.admin_id || null},
          updated_at = NOW()
        WHERE id = ${current.id}
        RETURNING *`;
      await deleteFileFromStorage(current.app_logo_url, current.app_logo_public_id);
      await logAdminAudit(req, "MobileApp", "UploadLogo", "mobile_app_settings", updated.id, sql.json({ app_logo_url: saved.url }));
      return ok(res, updated, "App logo uploaded.");
    } catch (e) {
      console.error("[Admin Mobile App Logo Upload Error]", e);
      return err(res, e.message || "Failed to upload app logo");
    }
  }
);

app.post("/api/admin/mobile-app/apk",
  verifyAdminToken,
  role("SuperAdmin", "SiteManager"),
  mobileAppApkUpload.single("apk"),
  async (req, res) => {
    try {
      if (!req.file) return err(res, "APK file is required.", 400);
      const current = await getMobileAppSettingsRow();
      const apkDir = mobileAppApkDir();
      await fs.mkdir(apkDir, { recursive: true });
      const finalName = safeApkFileName(req.file.filename || req.file.originalname || "mmr-app.apk");
      const version = safeNullableText(req.body?.latest_version, 60)
        || safeNullableText(req.body?.current_version, 60)
        || current.latest_version
        || current.current_version;
      const versionCode = safeNullableText(req.body?.version_code, 60) || current.version_code;
      const releaseNotes = safeNullableText(req.body?.release_notes, 4000) || current.release_notes;
      const [updated] = await sql`
        UPDATE mobile_app_settings SET
          apk_url = ${`/api/mobile-app/apk/file/${finalName}`},
          apk_public_id = ${`local:${finalName}`},
          apk_file_name = ${finalName},
          apk_file_size_bytes = ${req.file.size || null},
          apk_uploaded_at = NOW(),
          download_mode = 'apk',
          latest_version = ${version},
          current_version = ${version || current.current_version},
          version_code = ${versionCode},
          release_notes = ${releaseNotes},
          is_coming_soon = FALSE,
          updated_by_admin_id = ${req.admin.admin_id || null},
          updated_at = NOW()
        WHERE id = ${current.id}
        RETURNING *`;
      if (current.apk_public_id) {
        if (String(current.apk_public_id).startsWith("local:")) {
          const oldName = safeApkFileName(String(current.apk_public_id).replace(/^local:/, ""));
          fs.unlink(path.join(apkDir, oldName)).catch((error) =>
            console.warn("[Mobile App Old Local APK Delete Warning]", error?.message || error)
          );
        } else {
          cloudinary.uploader.destroy(current.apk_public_id, { resource_type: "raw" }).catch((error) =>
            console.warn("[Mobile App Old APK Delete Warning]", error?.message || error)
          );
        }
      }
      await logAdminAudit(req, "MobileApp", "UploadApk", "mobile_app_settings", updated.id, sql.json({
        apk_file_name: updated.apk_file_name,
        apk_file_size_bytes: updated.apk_file_size_bytes,
        latest_version: updated.latest_version,
      }));
      return ok(res, updated, "APK uploaded and set as the active download.");
    } catch (e) {
      console.error("[Admin Mobile App APK Upload Error]", e);
      return err(res, e.message || "Failed to upload APK");
    }
  }
);

app.post("/api/admin/mobile-app/apk/signature",
  verifyAdminToken,
  role("SuperAdmin", "SiteManager"),
  async (req, res) => {
    try {
      const originalName = String(req.body?.file_name || "mmr-app.apk").trim();
      if (!originalName.toLowerCase().endsWith(".apk")) return err(res, "Only Android .apk files are allowed.", 400);
      const cloudName = envValue("CLOUDINARY_CLOUD_NAME");
      const apiKey = envValue("CLOUDINARY_API_KEY");
      const apiSecret = envValue("CLOUDINARY_API_SECRET");
      if (!cloudName || !apiKey || !apiSecret) {
        return err(res, "Cloudinary configuration missing. Check CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET.", 500);
      }
      const publicId = `${Date.now()}-${Math.round(Math.random() * 1e6)}-${path.basename(originalName, ".apk").replace(/[^\w.-]+/g, "_")}`;
      const timestamp = Math.floor(Date.now() / 1000);
      const paramsToSign = {
        folder: CLOUDINARY_FOLDER.mobile_app_apk,
        public_id: publicId,
        timestamp,
      };
      const signature = cloudinary.utils.api_sign_request(paramsToSign, apiSecret);
      return ok(res, {
        cloud_name: cloudName,
        api_key: apiKey,
        folder: CLOUDINARY_FOLDER.mobile_app_apk,
        public_id: publicId,
        timestamp,
        signature,
        upload_url: `https://api.cloudinary.com/v1_1/${cloudName}/raw/upload`,
      }, "APK upload signature created.");
    } catch (e) {
      console.error("[Admin Mobile App APK Signature Error]", e);
      return err(res, "Failed to prepare APK upload");
    }
  }
);

app.post("/api/admin/mobile-app/apk/complete",
  verifyAdminToken,
  role("SuperAdmin", "SiteManager"),
  async (req, res) => {
    try {
      const secureUrl = safeNullableText(req.body?.secure_url || req.body?.url, 1600);
      const publicId = safeNullableText(req.body?.public_id, 500);
      if (!secureUrl || !publicId) return err(res, "Uploaded APK URL and public id are required.", 400);
      const current = await getMobileAppSettingsRow();
      const fileName = safeNullableText(req.body?.file_name || req.body?.original_filename, 255) || "app.apk";
      if (!fileName.toLowerCase().endsWith(".apk")) return err(res, "Only Android .apk files are allowed.", 400);
      const bytes = Number(req.body?.bytes || req.body?.file_size_bytes || 0);
      const version = safeNullableText(req.body?.latest_version, 60)
        || safeNullableText(req.body?.current_version, 60)
        || current.latest_version
        || current.current_version;
      const versionCode = safeNullableText(req.body?.version_code, 60) || current.version_code;
      const releaseNotes = safeNullableText(req.body?.release_notes, 4000) || current.release_notes;
      const [updated] = await sql`
        UPDATE mobile_app_settings SET
          apk_url = ${secureUrl},
          apk_public_id = ${publicId},
          apk_file_name = ${fileName},
          apk_file_size_bytes = ${Number.isFinite(bytes) && bytes > 0 ? bytes : null},
          apk_uploaded_at = NOW(),
          download_mode = 'apk',
          latest_version = ${version},
          current_version = ${version || current.current_version},
          version_code = ${versionCode},
          release_notes = ${releaseNotes},
          is_coming_soon = FALSE,
          updated_by_admin_id = ${req.admin.admin_id || null},
          updated_at = NOW()
        WHERE id = ${current.id}
        RETURNING *`;
      if (current.apk_public_id && current.apk_public_id !== publicId) {
        cloudinary.uploader.destroy(current.apk_public_id, { resource_type: "raw" }).catch((error) =>
          console.warn("[Mobile App Old APK Delete Warning]", error?.message || error)
        );
      }
      await logAdminAudit(req, "MobileApp", "UploadApk", "mobile_app_settings", updated.id, sql.json({
        apk_file_name: updated.apk_file_name,
        apk_file_size_bytes: updated.apk_file_size_bytes,
        latest_version: updated.latest_version,
      }));
      return ok(res, updated, "APK uploaded and set as the active download.");
    } catch (e) {
      console.error("[Admin Mobile App APK Complete Error]", e);
      return err(res, e.message || "Failed to save APK upload");
    }
  }
);

app.delete("/api/admin/mobile-app/logo",
  verifyAdminToken,
  role("SuperAdmin", "SiteManager"),
  async (req, res) => {
    try {
      const current = await getMobileAppSettingsRow();
      if (current.app_logo_public_id) {
        await cloudinary.uploader.destroy(current.app_logo_public_id).catch((error) =>
          console.warn("[Mobile App Logo Delete Warning]", error?.message || error)
        );
      }
      const [updated] = await sql`
        UPDATE mobile_app_settings SET
          app_logo_url = NULL,
          app_logo_public_id = NULL,
          updated_by_admin_id = ${req.admin.admin_id || null},
          updated_at = NOW()
        WHERE id = ${current.id}
        RETURNING *`;
      await logAdminAudit(req, "MobileApp", "DeleteLogo", "mobile_app_settings", updated.id, sql.json({ app_logo_url: null }));
      return ok(res, updated, "App logo removed.");
    } catch (e) {
      console.error("[Admin Mobile App Logo Delete Error]", e);
      return err(res, "Failed to delete app logo");
    }
  }
);

const inquiryStatuses = ["New", "Contacted", "Follow Up", "Interested", "Converted", "Closed"];
let inquirySchemaReady;
const ensureInquirySchema = () => {
  if (!inquirySchemaReady) {
    inquirySchemaReady = (async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS inquiries (
          inquiry_id SERIAL PRIMARY KEY,
          full_name VARCHAR(150) NOT NULL,
          mobile_no VARCHAR(20) NOT NULL,
          email VARCHAR(150),
          site_id INTEGER REFERENCES sites(site_id) ON DELETE SET NULL,
          site_name VARCHAR(180),
          plot_number VARCHAR(80),
          inquiry_message TEXT,
          inquiry_type VARCHAR(80) DEFAULT 'General Enquiry',
          source_page VARCHAR(180) DEFAULT 'Website',
          status VARCHAR(30) NOT NULL DEFAULT 'New',
          remarks TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`;
      await sql`ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS email VARCHAR(150)`;
      await sql`ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS site_id INTEGER REFERENCES sites(site_id) ON DELETE SET NULL`;
      await sql`ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS site_name VARCHAR(180)`;
      await sql`ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS plot_number VARCHAR(80)`;
      await sql`ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS inquiry_message TEXT`;
      await sql`ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS inquiry_type VARCHAR(80) DEFAULT 'General Enquiry'`;
      await sql`ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS source_page VARCHAR(180) DEFAULT 'Website'`;
      await sql`ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS status VARCHAR(30) NOT NULL DEFAULT 'New'`;
      await sql`ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS remarks TEXT`;
      await sql`ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`;
      await sql`ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`;
      await sql`CREATE INDEX IF NOT EXISTS idx_inquiries_created_at ON inquiries (created_at DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS idx_inquiries_status ON inquiries (status)`;
    })();
  }
  return inquirySchemaReady;
};

/* ==========================
   ─────────────────────────
   EXISTING APIS (unchanged)
   ─────────────────────────
========================== */

// GET ALL USERS API
app.get("/api/users", async (req, res) => {
  try {
    const users = await sql`SELECT * FROM users`;
    res.json(users);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ALL USERS (NO AUTH)
app.get("/api/usersNew", async (req, res) => {
  try {
    const users = await sql`SELECT id, full_name, email FROM users`;
    res.json(users);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET DAYS (NO JWT)
app.get("/api/days", async (req, res) => {
  try {
    const days = [
      { id: 1, name: "Monday" },   { id: 2, name: "Tuesday" },
      { id: 3, name: "Wednesday" }, { id: 4, name: "Thursday" },
      { id: 5, name: "Friday" },   { id: 6, name: "Saturday" },
      { id: 7, name: "Sunday" },
    ];
    res.json(days);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET USER BY ID
app.get("/api/users/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const user = await sql`SELECT * FROM users WHERE id = ${id}`;
    res.json(user[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ==========================
   ─────────────────────────
   AUTH — USER
   POST /api/auth/send-otp
   POST /api/auth/register
   POST /api/auth/login
   POST /api/auth/refresh
   POST /api/auth/forgot-password
   POST /api/auth/reset-password
   ─────────────────────────
========================== */

// Send OTP (registration / login)
app.post("/api/auth/send-otp", async (req, res) => {
  try {
    const { mobile_no, purpose = "Login" } = req.body;
    if (!mobile_no) return err(res, "mobile_no required", 400);

    const otp  = genOTP();
    const exp  = new Date(Date.now() + 10 * 60 * 1000); // 10 min

    // Invalidate old OTPs
    await sql`
      UPDATE otp_log SET is_used = TRUE
      WHERE mobile = ${mobile_no} AND purpose = ${purpose} AND is_used = FALSE`;

    await sql`
      INSERT INTO otp_log (user_type, reference_id, mobile, otp_code, purpose, expires_at)
      VALUES ('User', 0, ${mobile_no}, ${otp}, ${purpose}, ${exp})`;

    // TODO: Integrate real SMS gateway (Fast2SMS / MSG91)
    return ok(res, { mobile_no }, "OTP sent successfully");
  } catch (e) {
    return err(res, e.message);
  }
});

// Register (multi-step — submit all at once after form)
app.post("/api/auth/register", upload.fields([
  { name: "pan_card",      maxCount: 1 },
  { name: "aadhar_card",   maxCount: 1 },
  { name: "profile_photo", maxCount: 1 },
]), async (req, res) => {
  try {
    const {
      user_type, full_name, date_of_birth, gender,
      father_name, mother_name, spouse_name,
      mobile_no, alternate_mobile, email,
      pan_number, aadhar_number, otp_code,
      password,                                   // ← FIX: password field add kiya
      // Address
      perm_address_line1, perm_city, perm_state, perm_pin,
      local_address_line1, local_city, local_pin,
      // Bank
      account_holder_name, account_number, ifsc_code, branch_name, bank_name,
      // Nominee
      nominee_name, nominee_dob, nominee_gender, nominee_pan,
      nominee_aadhar, nominee_relationship,
      // Associate
      sponsor_invite_code,
      // Declaration
      terms_accepted,
    } = req.body;

    // ── Validate required fields ──
    if (!user_type || !full_name || !mobile_no || !pan_number || !aadhar_number)
      return err(res, "Required fields missing", 400);
    if (!["Customer", "Associate", "Investor"].includes(user_type))
      return err(res, "user_type must be Customer, Associate, or Investor", 400);

    if (!terms_accepted || terms_accepted !== "true")
      return err(res, "Terms & Conditions must be accepted", 400);

    // ── Verify OTP ──
    const [otpRow] = await sql`
      SELECT * FROM otp_log
      WHERE mobile = ${mobile_no} AND otp_code = ${otp_code}
        AND purpose = 'Registration' AND is_used = FALSE
        AND expires_at > NOW()
      ORDER BY otp_id DESC LIMIT 1`;

    if (!otpRow) return err(res, "Invalid or expired OTP", 400);

    // ── Duplicate checks ──
    const [dupMobile] = await sql`SELECT user_id FROM users WHERE mobile_no = ${mobile_no}`;
    if (dupMobile) return err(res, "Mobile number already registered", 409);

    const [dupPAN] = await sql`SELECT user_id FROM users WHERE pan_number = ${pan_number}`;
    if (dupPAN) return err(res, "PAN already registered", 409);

    const [dupAadhar] = await sql`SELECT user_id FROM users WHERE aadhar_number = ${aadhar_number}`;
    if (dupAadhar) return err(res, "Aadhar already registered", 409);

    // ── Find sponsor ──
    let sponsorUserId = null;
    if (sponsor_invite_code) {
      const [sponsor] = await sql`
        SELECT user_id FROM users WHERE invitation_code = ${sponsor_invite_code}
          AND account_status = 'Active'`;
      if (!sponsor) return err(res, "Invalid sponsor invitation code", 400);
      sponsorUserId = sponsor.user_id;
    }
    if (!sponsorUserId && user_type !== "Investor") {
      sponsorUserId = await getDefaultSponsorUserId();
    }

    // ── Hash password if provided ──
    const passwordHash = password ? await bcrypt.hash(password, 12) : null;

    // ── Insert User ──
    const [newUser] = await sql`
      INSERT INTO users (
        user_type, full_name, date_of_birth, gender,
        father_name, mother_name, spouse_name,
        mobile_no, alternate_mobile, email,
        pan_number, aadhar_number, is_otp_verified,
        password_hash,
        sponsor_user_id, account_status
      ) VALUES (
        ${user_type}, ${full_name}, ${date_of_birth || null}, ${gender || null},
        ${father_name || null}, ${mother_name || null}, ${spouse_name || null},
        ${mobile_no}, ${alternate_mobile || null}, ${email || null},
        ${pan_number.toUpperCase()}, ${aadhar_number}, TRUE,
        ${passwordHash},
        ${sponsorUserId}, 'Pending'
      ) RETURNING user_id, full_name, mobile_no, user_type`;

    const userId = newUser.user_id;

    // ── Addresses ──
    if (perm_address_line1) {
      await sql`
        INSERT INTO user_addresses (user_id, address_type, address_line1, city, state, pin_code)
        VALUES (${userId}, 'Permanent', ${perm_address_line1}, ${perm_city || null},
                ${perm_state || null}, ${perm_pin || null})`;
    }
    if (local_address_line1) {
      await sql`
        INSERT INTO user_addresses (user_id, address_type, address_line1, city, pin_code)
        VALUES (${userId}, 'Local', ${local_address_line1}, ${local_city || null}, ${local_pin || null})`;
    }

    // ── Bank Details ──
    if (account_number && ifsc_code) {
      await sql`
        INSERT INTO user_bank_details
          (user_id, account_holder_name, account_number, ifsc_code, branch_name, bank_name)
        VALUES (${userId}, ${account_holder_name || full_name}, ${account_number},
                ${ifsc_code.toUpperCase()}, ${branch_name || null}, ${bank_name || null})`;
    }

    // ── Nominee ──
    if (nominee_name) {
      await sql`
        INSERT INTO user_nominees
          (user_id, nominee_name, date_of_birth, gender, pan_number, aadhar_number, relationship)
        VALUES (${userId}, ${nominee_name}, ${nominee_dob || null}, ${nominee_gender || null},
                ${nominee_pan || null}, ${nominee_aadhar || null}, ${nominee_relationship || null})`;
    }

    // ── Documents — Cloudinary upload ──
    const fileFields = [
      { field: "pan_card",      type: "PANCard"      },
      { field: "aadhar_card",   type: "AadharCard"   },
      { field: "profile_photo", type: "ProfilePhoto" },
    ];

    for (const { field, type } of fileFields) {
      const f = req.files?.[field]?.[0];
      if (!f) continue;
      const { url } = await saveFileToVPS(f.buffer, { module: "user", entityId: userId, entityType: type, originalName: f.originalname });
      await sql`
        INSERT INTO user_documents (user_id, document_type, file_path, cloudinary_public_id)
        VALUES (${userId}, ${type}, ${url}, ${null})`;
    }

    // ── Mark OTP used ──
    await sql`UPDATE otp_log SET is_used = TRUE WHERE otp_id = ${otpRow.otp_id}`;

    // ── Audit ──
    await sql`
      INSERT INTO audit_log (actor_type, actor_id, actor_name, module, action, target_table, target_record_id)
      VALUES ('User', ${userId}, ${full_name}, 'Auth', 'Registered', 'users', ${userId})`;

    return ok(res, { user_id: userId, full_name, user_type: newUser.user_type },
      "Registration submitted. Pending admin approval.", 201);
  } catch (e) {
    return err(res, e.message);
  }
});


// Register Quick (Signup form se — sirf basic details, email OTP verify hoga)
app.post("/api/auth/register-quick", async (req, res) => {
  try {
    const { user_type, full_name, email, mobile_no, password, sponsor_invite_code } = req.body;

    if (!user_type || !full_name || !email || !mobile_no || !password)
      return err(res, "user_type, full_name, email, mobile_no, password required", 400);
    if (!["Customer", "Associate", "Investor"].includes(user_type))
      return err(res, "user_type must be Customer, Associate, or Investor", 400);

    const cleanEmail = String(email).trim().toLowerCase();
    const cleanMobile = String(mobile_no).replace(/\D/g, "");

    // Duplicate checks
    const [dupMobile] = await sql`SELECT user_id FROM users WHERE RIGHT(regexp_replace(mobile_no, '\\D', '', 'g'), 10) = ${cleanMobile}`;
    const [dupInvestorMobile] = await sql`SELECT id FROM investor_users WHERE RIGHT(regexp_replace(mobile_number, '\\D', '', 'g'), 10) = ${cleanMobile} AND (deleted_at IS NULL) LIMIT 1`;
    if (dupMobile || dupInvestorMobile) return err(res, "Mobile number already registered", 409);

    const [dupEmail] = await sql`SELECT user_id FROM users WHERE LOWER(email) = ${cleanEmail}`;
    const [dupInvestorEmail] = await sql`SELECT id FROM investor_users WHERE LOWER(email) = ${cleanEmail} AND (deleted_at IS NULL) LIMIT 1`;
    if (dupEmail || dupInvestorEmail) return err(res, "Email already registered", 409);

    let sponsorUserId = null;
    if (sponsor_invite_code && user_type !== "Investor") {
      const [sponsor] = await sql`
        SELECT user_id FROM users WHERE invitation_code = ${sponsor_invite_code}
          AND account_status = 'Active'`;
      if (!sponsor) return err(res, "Invalid sponsor invitation code", 400);
      sponsorUserId = sponsor.user_id;
    }
    if (!sponsorUserId && user_type !== "Investor") {
      sponsorUserId = await getDefaultSponsorUserId();
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const otp = String(Math.floor(100000 + Math.random() * 900000));
    const exp = new Date(Date.now() + 10 * 60 * 1000);

    await sql`
      CREATE TABLE IF NOT EXISTS pending_registrations (
        email TEXT PRIMARY KEY,
        mobile_no TEXT NOT NULL,
        user_type TEXT NOT NULL,
        full_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        sponsor_user_id INTEGER,
        sponsor_invite_code TEXT,
        optional_data JSONB NOT NULL DEFAULT '{}'::jsonb,
        otp_code TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;

    await sql`DELETE FROM pending_registrations WHERE email = ${cleanEmail} OR mobile_no = ${cleanMobile}`;
    await sql`
      INSERT INTO pending_registrations (
        email, mobile_no, user_type, full_name, password_hash, sponsor_user_id, sponsor_invite_code, otp_code, expires_at
      ) VALUES (
        ${cleanEmail}, ${cleanMobile}, ${user_type}, ${full_name.trim()}, ${passwordHash}, ${sponsorUserId}, ${sponsor_invite_code || null}, ${otp}, ${exp}
      )`;

    try {
      await sendEmail({
        to: cleanEmail,
        subject: "Verify your MMR Constructions account",
        html: otpEmailHtml(otp, "Verification")
      });
    } catch (mailErr) {
      console.warn("Mail send error:", mailErr.message);
    }

    return ok(res, { email: cleanEmail, user_type }, "Registration initiated. OTP sent to your email.", 201);
  } catch (e) {
    return err(res, e.message);
  }
});

// Verify Email OTP (signup ke baad)
app.post("/api/auth/verify-email-otp", async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) return err(res, "email and otp required", 400);
    const cleanEmail = String(email).trim().toLowerCase();

    const [pending] = await sql`SELECT * FROM pending_registrations WHERE email = ${cleanEmail}`;
    if (!pending) return err(res, "No pending registration found. Please sign up again.", 400);
    if (new Date() > new Date(pending.expires_at)) {
      await sql`DELETE FROM pending_registrations WHERE email = ${cleanEmail}`;
      return err(res, "OTP expired. Please sign up again.", 400);
    }
    if (pending.otp_code !== String(otp).trim()) {
      return err(res, "Invalid OTP. Please check and try again.", 400);
    }

    if (pending.user_type === "Investor") {
      const [createdInvestor] = await sql`
        INSERT INTO investor_users (
          full_name, mobile_number, email, password_hash, status, is_verified, created_at, updated_at
        ) VALUES (
          ${pending.full_name}, ${pending.mobile_no}, ${pending.email}, ${pending.password_hash},
          'active', true, NOW(), NOW()
        )
        RETURNING id, full_name, email, mobile_number, status, is_verified`;

      await sql`DELETE FROM pending_registrations WHERE email = ${cleanEmail}`;

      const payload = {
        id: createdInvestor.id,
        user_id: createdInvestor.id,
        user_type: "Investor",
        role: "Investor",
        email: createdInvestor.email,
        full_name: createdInvestor.full_name
      };
      const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || "7d" });
      const refreshToken = jwt.sign(payload, process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET, { expiresIn: "30d" });

      return ok(res, {
        token,
        refresh_token: refreshToken,
        user: {
          id: createdInvestor.id,
          user_id: createdInvestor.id,
          full_name: createdInvestor.full_name,
          email: createdInvestor.email,
          mobile_no: createdInvestor.mobile_number,
          user_type: "Investor"
        }
      }, "Investor email verified successfully.");
    }

    // Customer or Associate
    const [sequence] = await sql`
      SELECT COALESCE(MAX(
        CASE
          WHEN member_id ~ '^MMR[0-9]+$' THEN SUBSTRING(member_id FROM 4)::integer
          WHEN member_id ~ '^MMR-[AC]-[0-9]+$' THEN SUBSTRING(member_id FROM 7)::integer
          ELSE 0 END
      ), 0) + 1 AS next_value FROM users`;
    const memberId = `MMR${String(Number(sequence?.next_value || 1)).padStart(5, '0')}`;

    const [createdUser] = await sql`
      INSERT INTO users (
        user_type, full_name, mobile_no, email,
        password_hash, sponsor_user_id, member_id,
        account_status, email_verified, email_verified_at, is_otp_verified
      ) VALUES (
        ${pending.user_type}, ${pending.full_name}, ${pending.mobile_no}, ${pending.email},
        ${pending.password_hash}, ${pending.sponsor_user_id}, ${memberId},
        ${pending.user_type === 'Customer' ? 'Active' : 'Pending'}, TRUE, NOW(), TRUE
      )
      RETURNING user_id, full_name, email, user_type, member_id, invitation_code`;

    await sql`DELETE FROM pending_registrations WHERE email = ${cleanEmail}`;

    const payload = {
      user_id:   createdUser.user_id,
      user_type: createdUser.user_type,
      member_id: createdUser.member_id,
      mobile_no: pending.mobile_no,
      email:     createdUser.email,
    };
    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || "7d" });
    const refreshToken = jwt.sign(payload, process.env.JWT_REFRESH_SECRET, { expiresIn: "30d" });

    return ok(res, {
      token,
      refresh_token: refreshToken,
      user: {
        user_id: createdUser.user_id,
        full_name: createdUser.full_name,
        user_type: createdUser.user_type,
        member_id: createdUser.member_id,
        email: createdUser.email
      }
    }, "Email verified successfully.");
  } catch (e) {
    return err(res, e.message);
  }
});

// Resend Email OTP
app.post("/api/auth/resend-email-otp", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return err(res, "email required", 400);

    const [user] = await sql`SELECT user_id FROM users WHERE email = ${email.toLowerCase().trim()}`;
    if (!user) return err(res, "Email not registered", 404);

    const otp = genOTP();
    const exp = new Date(Date.now() + 10 * 60 * 1000);

    await sql`
      UPDATE otp_log SET is_used = TRUE
      WHERE mobile = ${email.toLowerCase().trim()} AND purpose = 'EmailVerification' AND is_used = FALSE`;

    await sql`
      INSERT INTO otp_log (user_type, reference_id, mobile, otp_code, purpose, expires_at)
      VALUES ('User', ${user.user_id}, ${email.toLowerCase().trim()}, ${otp}, 'EmailVerification', ${exp})`;

    return ok(res, {}, "OTP resent to your email.");
  } catch (e) {
    return err(res, e.message);
  }
});

// Login
app.post("/api/auth/login", async (req, res) => {
  try {
    const { mobile_no, email, identifier, password, otp_code } = req.body;
    const loginId = String(identifier || email || mobile_no || "").trim().toLowerCase();
    const loginEmail = loginId.includes("@") ? loginId : null;
    const loginMobile = loginId.replace(/\D/g, "");
    const cleanMobile = loginMobile.length >= 10 ? loginMobile.slice(-10) : (loginMobile || null);

    if (!loginEmail && !cleanMobile) {
      return err(res, "Email or phone number required", 400);
    }

    let [user] = loginEmail
      ? await sql`
          SELECT user_id, full_name, email, mobile_no, user_type, account_status,
                 member_id, invitation_code, password_hash, email_verified, is_otp_verified
          FROM users
          WHERE LOWER(email) = ${loginEmail}`
      : await sql`
          SELECT user_id, full_name, email, mobile_no, user_type, account_status,
                 member_id, invitation_code, password_hash, email_verified, is_otp_verified
          FROM users
          WHERE RIGHT(regexp_replace(mobile_no, '\\D', '', 'g'), 10) = ${cleanMobile}`;

    if (!user) {
      const [investor] = loginEmail
        ? await sql`SELECT id, full_name, email, mobile_number, password_hash, status, is_verified FROM investor_users WHERE LOWER(email) = ${loginEmail} AND deleted_at IS NULL LIMIT 1`
        : await sql`SELECT id, full_name, email, mobile_number, password_hash, status, is_verified FROM investor_users WHERE RIGHT(regexp_replace(mobile_number, '\\D', '', 'g'), 10) = ${cleanMobile} AND deleted_at IS NULL LIMIT 1`;

      if (investor) {
        if (!investor.is_verified || investor.status === "pending_verification") {
          return err(res, "Please verify your email address before login.", 403);
        }
        if (investor.status === "inactive" || investor.status === "rejected") {
          return err(res, `Account is currently ${investor.status}. Contact support.`, 403);
        }
        if (password) {
          const valid = await bcrypt.compare(password, investor.password_hash);
          if (!valid) return err(res, "Invalid credentials", 401);
        } else {
          return err(res, "Password required for investor login.", 400);
        }

        const payload = {
          id: investor.id,
          user_id: investor.id,
          user_type: "Investor",
          role: "Investor",
          email: investor.email,
          full_name: investor.full_name,
        };

        const jwtSecret = process.env.JWT_SECRET || "mmr_constructions_jwt_secret_2026_key";
        const jwtRefreshSecret = process.env.JWT_REFRESH_SECRET || jwtSecret;
        const token = jwt.sign(payload, jwtSecret, { expiresIn: process.env.JWT_EXPIRES_IN || "7d" });
        const refreshToken = jwt.sign(payload, jwtRefreshSecret, { expiresIn: "30d" });

        return ok(res, {
          token,
          refresh_token: refreshToken,
          user: {
            id: investor.id,
            user_id: investor.id,
            full_name: investor.full_name,
            user_type: "Investor",
            email: investor.email,
            mobile_no: investor.mobile_number,
            account_status: investor.status,
            email_verified: Boolean(investor.is_verified)
          }
        }, "Investor login successful");
      }

      return err(res, "User not found", 404);
    }

    if (!(user.email_verified || user.is_otp_verified)) {
      return err(res, "Please verify your email address before login.", 403);
    }

    if (!["Active", "Approved"].includes(String(user.account_status))) {
      const message = user.account_status === "Pending"
        ? "Account pending admin approval"
        : "Account is not active. Contact support.";
      return err(res, message, 403);
    }

    // OTP login
    if (otp_code) {
      if (!loginMobile) return err(res, "OTP login requires mobile number", 400);
      const [otpRow] = await sql`
        SELECT * FROM otp_log
        WHERE mobile = ${loginMobile} AND otp_code = ${otp_code}
          AND purpose = 'Login' AND is_used = FALSE AND expires_at > NOW()
        ORDER BY otp_id DESC LIMIT 1`;
      if (!otpRow) return err(res, "Invalid or expired OTP", 401);
      await sql`UPDATE otp_log SET is_used = TRUE WHERE otp_id = ${otpRow.otp_id}`;
    }
    // Password login
    else if (password) {
      if (!user.password_hash) return err(res, "No password set. Use OTP login.", 400);
      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) return err(res, "Invalid credentials", 401);
    } else {
      return err(res, "Provide password or otp_code", 400);
    }

    const payload = {
      user_id:    user.user_id,
      user_type:  user.user_type,
      member_id:  user.member_id,
      mobile_no:  user.mobile_no,
      email:      user.email,
    };

    const jwtSecret = process.env.JWT_SECRET || "mmr_constructions_jwt_secret_2026_key";
    const jwtRefreshSecret = process.env.JWT_REFRESH_SECRET || jwtSecret;
    const token        = jwt.sign(payload, jwtSecret,         { expiresIn: process.env.JWT_EXPIRES_IN || "7d" });
    const refreshToken = jwt.sign(payload, jwtRefreshSecret, { expiresIn: "30d" });

    return ok(res, {
      token, refresh_token: refreshToken,
      user: { user_id: user.user_id, full_name: user.full_name,
              user_type: user.user_type, member_id: user.member_id,
              invitation_code: user.invitation_code, email: user.email,
              account_status: user.account_status,
              email_verified: Boolean(user.email_verified || user.is_otp_verified) },
    }, "Login successful");
  } catch (e) {
    return err(res, e.message);
  }
});

// Refresh Token
app.post("/api/auth/refresh", async (req, res) => {
  try {
    const { refresh_token } = req.body;
    if (!refresh_token) return err(res, "refresh_token required", 400);
    const decoded = jwt.verify(refresh_token, process.env.JWT_REFRESH_SECRET);
    const token   = jwt.sign(
      { user_id: decoded.user_id, user_type: decoded.user_type,
        member_id: decoded.member_id, mobile_no: decoded.mobile_no },
      process.env.JWT_SECRET, { expiresIn: "7d" }
    );
    return ok(res, { token }, "Token refreshed");
  } catch {
    return err(res, "Invalid refresh token", 401);
  }
});

// Forgot Password — send OTP
app.post("/api/auth/forgot-password", async (req, res) => {
  try {
    const email = String(req.body.email || "").toLowerCase().trim();
    const mobileNo = String(req.body.mobile_no || "").replace(/\D/g, "");
    if (!email && !mobileNo) return err(res, "email required", 400);

    const [user] = email
      ? await sql`
          SELECT user_id, full_name, email, mobile_no
          FROM users
          WHERE LOWER(email) = ${email}`
      : await sql`
          SELECT user_id, full_name, email, mobile_no
          FROM users
          WHERE mobile_no = ${mobileNo}`;

    if (!user) {
      const [investor] = email
        ? await sql`SELECT id, full_name, email, mobile_number FROM investor_users WHERE LOWER(email) = ${email} AND deleted_at IS NULL LIMIT 1`
        : await sql`SELECT id, full_name, email, mobile_number FROM investor_users WHERE mobile_number = ${mobileNo} AND deleted_at IS NULL LIMIT 1`;

      if (investor) {
        const resetEmail = String(investor.email).toLowerCase().trim();
        const otp = String(Math.floor(100000 + Math.random() * 900000));
        const expires = new Date(Date.now() + 15 * 60 * 1000);

        await sql`
          UPDATE investor_users
          SET reset_otp = ${otp}, reset_otp_expires = ${expires}
          WHERE id = ${investor.id}`;

        try {
          await sendEmail(resetEmail, "MMR Investor Password Reset OTP", otpEmailHtml(otp, "Password Reset"));
        } catch (mailErr) {
          console.warn("[Investor Reset Mail Error]", mailErr.message);
        }

        return ok(res, { email: resetEmail, user_type: "Investor" }, "OTP sent to your registered email");
      }

      return err(res, "Email not registered", 404);
    }

    if (!user.email) return err(res, "Registered email not available for this account", 400);

    const resetEmail = String(user.email).toLowerCase().trim();
    const otp = String(Math.floor(100000 + Math.random() * 900000));

    await sql`
      UPDATE otp_log SET is_used = TRUE
      WHERE mobile = ${resetEmail} AND purpose = 'ResetPassword' AND is_used = FALSE`;
    await sql`
      INSERT INTO otp_log (user_type, reference_id, mobile, otp_code, purpose, expires_at)
      VALUES ('User', ${user.user_id}, ${resetEmail}, ${otp}, 'ResetPassword',
              ${new Date(Date.now() + 10*60*1000)})`;

    try {
      await sendEmail(resetEmail, "MMR password reset OTP", otpEmailHtml(otp, "Password Reset"));
    } catch (mailErr) {
      console.warn("Mail send error:", mailErr.message);
    }
    return ok(res, { email: resetEmail }, "OTP sent to your registered email");
  } catch (e) {
    return err(res, e.message);
  }
});

app.post("/api/auth/reset-password", async (req, res) => {
  try {
    const email = String(req.body.email || "").toLowerCase().trim();
    const { otp_code, otp, new_password } = req.body;
    const rawOtp = String(otp_code || otp || "").trim();

    if (!email || !rawOtp || !new_password)
      return err(res, "email, otp, and new_password required", 400);
    if (String(new_password).length < 8)
      return err(res, "New password minimum 8 characters required", 400);

    const [investor] = await sql`
      SELECT id, reset_otp, reset_otp_expires FROM investor_users
      WHERE LOWER(email) = ${email} AND deleted_at IS NULL LIMIT 1`;

    if (investor && investor.reset_otp === rawOtp && new Date() <= new Date(investor.reset_otp_expires)) {
      const salt = await bcrypt.genSalt(10);
      const password_hash = await bcrypt.hash(new_password, salt);
      await sql`
        UPDATE investor_users
        SET password_hash = ${password_hash}, reset_otp = NULL, reset_otp_expires = NULL, updated_at = NOW()
        WHERE id = ${investor.id}`;
      return ok(res, {}, "Password reset successfully");
    }

    const [otpRow] = await sql`
      SELECT * FROM otp_log
      WHERE mobile = ${email} AND otp_code = ${rawOtp}
        AND purpose = 'ResetPassword' AND is_used = FALSE AND expires_at > NOW()
      ORDER BY otp_id DESC LIMIT 1`;
    if (!otpRow) return err(res, "Invalid or expired OTP", 400);

    const hash = await bcrypt.hash(new_password, 12);
    await sql`UPDATE users SET password_hash = ${hash}, updated_at = NOW() WHERE user_id = ${otpRow.reference_id}`;
    await sql`UPDATE otp_log SET is_used = TRUE WHERE otp_id = ${otpRow.otp_id}`;

    return ok(res, {}, "Password reset successfully");
  } catch (e) {
    return err(res, e.message);
  }
});

app.post("/api/auth/change-password", verifyUserToken, async (req, res) => {
  try {
    const { current_password, new_password, confirm_password } = req.body;
    if (!current_password || !new_password || !confirm_password)
      return err(res, "current_password, new_password, confirm_password required", 400);
    if (new_password.length < 8)
      return err(res, "New password minimum 8 characters required", 400);
    if (new_password !== confirm_password)
      return err(res, "New password and confirm password do not match", 400);

    const [user] = await sql`
      SELECT user_id, full_name, email, password_hash
      FROM users
      WHERE user_id = ${req.user.user_id}`;

    if (!user) return err(res, "User not found", 404);
    if (!user.password_hash) return err(res, "No password set for this account", 400);

    const valid = await bcrypt.compare(current_password, user.password_hash);
    if (!valid) return err(res, "Current password is incorrect", 400);
    if (await bcrypt.compare(new_password, user.password_hash))
      return err(res, "New password must be different from current password", 400);

    const newHash = await bcrypt.hash(new_password, 12);
    await sql`UPDATE users SET password_hash = ${newHash}, updated_at = NOW() WHERE user_id = ${user.user_id}`;

    if (user.email) {
      try {
        await sendEmail(user.email, "MMR password changed", passwordChangedEmailHtml(user.full_name || "User"));
      } catch (mailError) {
        console.warn("[user-change-password] Confirmation email failed:", mailError.message);
      }
    }

    return ok(res, {}, "Password changed successfully");
  } catch (e) {
    return err(res, e.message);
  }
});
/* ==========================
   ─────────────────────────
   AUTH — ADMIN
   POST /api/admin/auth/login
   POST /api/admin/auth/refresh
   ─────────────────────────
========================== */

app.post("/api/admin/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return err(res, "email & password required", 400);

    const [admin] = await sql`
      SELECT a.admin_id, a.full_name, a.email, a.password_hash,
             a.is_active, a.is_locked, a.failed_login_attempts,
             r.role_name AS role
      FROM admin_users a
      JOIN admin_roles r ON a.role_id = r.role_id
      WHERE a.email = ${email}`;

    if (!admin)      return err(res, "Invalid credentials", 401);
    if (!admin.is_active) return err(res, "Account deactivated", 403);
    if (admin.is_locked)  return err(res, "Account locked after 5 failed attempts. Contact Super Admin.", 403);

    const valid = await bcrypt.compare(password, admin.password_hash);

    if (!valid) {
      const attempts = admin.failed_login_attempts + 1;
      await sql`
        UPDATE admin_users SET
          failed_login_attempts = ${attempts},
          is_locked = ${attempts >= 5}
        WHERE admin_id = ${admin.admin_id}`;
      return err(res, `Invalid credentials. ${5 - attempts} attempts remaining.`, 401);
    }

    // Reset failed attempts, set last login
    await sql`
      UPDATE admin_users SET failed_login_attempts = 0, last_login_at = NOW()
      WHERE admin_id = ${admin.admin_id}`;

    const payload = { admin_id: admin.admin_id, email: admin.email,
                      full_name: admin.full_name, role: admin.role };

    const token        = jwt.sign(payload, adminJwtSecret(),               { expiresIn: "8h" });
    const refreshToken = jwt.sign(payload, process.env.JWT_REFRESH_SECRET || adminJwtSecret(), { expiresIn: "1d" });

    // Log session
    try {
      await sql`
        INSERT INTO admin_sessions (admin_id, session_token)
        VALUES (${admin.admin_id}, ${token})`;
      await sql`
        INSERT INTO audit_log (actor_type, actor_id, actor_name, module, action)
        VALUES ('Admin', ${admin.admin_id}, ${admin.full_name}, 'Auth', 'AdminLogin')`;
    } catch (logErr) {
      console.warn("[Admin Login Log Warning]:", logErr.message);
    }

    return ok(res, { token, refresh_token: refreshToken,
      admin: { admin_id: admin.admin_id, full_name: admin.full_name,
               email: admin.email, role: admin.role }
    }, "Admin login successful");
  } catch (e) {
    return err(res, e.message);
  }
});

app.post("/api/admin/auth/refresh", async (req, res) => {
  try {
    const { refresh_token } = req.body;
    if (!refresh_token) return err(res, "refresh_token required", 400);
    const decoded = jwt.verify(refresh_token, process.env.JWT_REFRESH_SECRET);
    const token   = jwt.sign(
      { admin_id: decoded.admin_id, email: decoded.email,
        full_name: decoded.full_name, role: decoded.role },
      adminJwtSecret(), { expiresIn: "8h" }
    );
    return ok(res, { token }, "Token refreshed");
  } catch {
    return err(res, "Invalid refresh token", 401);
  }
});

app.post(["/api/admin/change-password", "/api/admin/auth/change-password"], verifyAdminToken, async (req, res) => {
  try {
    const { current_password, new_password, confirm_password } = req.body;
    const adminId = req.admin?.admin_id;

    if (!adminId) {
      return res.status(401).json({ success: false, message: "Unauthorized admin session" });
    }

    if (!current_password || !new_password || !confirm_password) {
      return res.status(400).json({ success: false, message: "All password fields are required." });
    }

    if (new_password.length < 6) {
      return res.status(400).json({ success: false, message: "New password must be at least 6 characters long." });
    }

    if (new_password !== confirm_password) {
      return res.status(400).json({ success: false, message: "New password and confirm password do not match." });
    }

    const [admin] = await sql`
      SELECT admin_id, full_name, email, password_hash
      FROM admin_users
      WHERE admin_id = ${adminId}`;

    if (!admin) {
      return res.status(404).json({ success: false, message: "Admin account not found." });
    }

    const valid = await bcrypt.compare(current_password, admin.password_hash);
    if (!valid) {
      return res.status(400).json({ success: false, message: "Incorrect current password." });
    }

    const isSame = await bcrypt.compare(new_password, admin.password_hash);
    if (isSame) {
      return res.status(400).json({ success: false, message: "New password must be different from current password." });
    }

    const newHash = await bcrypt.hash(new_password, 10);
    await sql`
      UPDATE admin_users
      SET password_hash = ${newHash},
          failed_login_attempts = 0,
          is_locked = false,
          updated_at = NOW()
      WHERE admin_id = ${admin.admin_id}`;

    try {
      if (admin.email) {
        await sendEmail(admin.email, 'MMR Admin — Password Changed', passwordChangedEmailHtml(admin.full_name || 'Admin'));
      }
    } catch (mailErr) {
      console.warn("[admin-change-password] Confirmation email failed:", mailErr.message);
    }

    return res.json({ success: true, message: "Password changed successfully." });
  } catch (e) {
    console.error("[Admin Change Password Error]", e);
    return res.status(500).json({ success: false, message: "Failed to change password." });
  }
});


/* ==========================
   ADMIN IMPERSONATION — LOGIN AS USER
   POST /api/admin/login-as-user
========================== */
app.post("/api/admin/login-as-user", verifyAdminToken, async (req, res) => {
  try {
    const { user_id, user_type } = req.body;
    if (!user_id || !user_type) {
      return err(res, "user_id and user_type are required", 400);
    }

    const normalizedType = String(user_type).trim();
    const cleanUserId = Number(user_id);
    if (!cleanUserId || isNaN(cleanUserId)) {
      return err(res, "Valid user_id is required", 400);
    }

    let targetUser = null;
    let redirectUrl = "";
    let payload = {};

    if (["Customer", "Associate"].includes(normalizedType)) {
      const [user] = await sql`
        SELECT user_id, full_name, email, mobile_no, user_type, account_status, member_id, invitation_code
        FROM users
        WHERE user_id = ${cleanUserId}`;

      if (!user) {
        return err(res, "User account not found", 404);
      }

      if (user.account_status !== "Active") {
        return err(res, `Account cannot be accessed because status is '${user.account_status}'.`, 403);
      }

      targetUser = user;
      redirectUrl = user.user_type === "Associate" ? "/associate/dashboard" : "/user/dashboard";

      payload = {
        user_id: user.user_id,
        user_type: user.user_type,
        member_id: user.member_id,
        mobile_no: user.mobile_no,
        email: user.email,
        full_name: user.full_name,
        impersonated_by_admin_id: req.admin?.admin_id || req.admin?.id || 1
      };
    } else if (normalizedType === "Investor") {
      const [investor] = await sql`
        SELECT id, full_name, email, mobile_number, status, is_verified
        FROM investor_users
        WHERE id = ${cleanUserId} AND deleted_at IS NULL`;

      if (!investor) {
        return err(res, "Investor account not found", 404);
      }

      if (investor.status !== "active" || !investor.is_verified) {
        return err(res, `Investor account is not active or verified (status: ${investor.status}).`, 403);
      }

      targetUser = {
        user_id: investor.id,
        id: investor.id,
        full_name: investor.full_name,
        email: investor.email,
        mobile_no: investor.mobile_number,
        user_type: "Investor",
        account_status: investor.status
      };
      redirectUrl = "/investor/dashboard";

      payload = {
        id: investor.id,
        user_id: investor.id,
        user_type: "Investor",
        role: "Investor",
        email: investor.email,
        full_name: investor.full_name,
        impersonated_by_admin_id: req.admin?.admin_id || req.admin?.id || 1
      };
    } else {
      return err(res, "Invalid user_type. Expected 'Customer', 'Associate', or 'Investor'.", 400);
    }

    const jwtSecret = process.env.JWT_SECRET || "mmr_constructions_jwt_secret_2026_key";
    const jwtRefreshSecret = process.env.JWT_REFRESH_SECRET || jwtSecret;
    const token = jwt.sign(payload, jwtSecret, { expiresIn: "2h" });
    const refreshToken = jwt.sign(payload, jwtRefreshSecret, { expiresIn: "7d" });

    try {
      const adminId = req.admin?.admin_id || req.admin?.id || 1;
      const adminName = req.admin?.full_name || req.admin?.name || 'Admin';
      await sql`
        INSERT INTO audit_log (actor_type, actor_id, actor_name, module, action, target_table, target_record_id, new_value)
        VALUES ('Admin', ${adminId}, ${adminName},
                'AdminImpersonation', 'LoginAsUser',
                ${normalizedType === 'Investor' ? 'investor_users' : 'users'},
                ${cleanUserId},
                ${JSON.stringify({ target_user_type: normalizedType, target_name: targetUser.full_name, target_email: targetUser.email, ip: req.ip, user_agent: req.headers['user-agent'] })})`;
    } catch (auditErr) {
      console.warn("[Audit Log Warning]:", auditErr.message);
    }

    return ok(res, {
      token,
      refresh_token: refreshToken,
      user: targetUser,
      redirect_url: redirectUrl
    }, `Successfully generated login session for ${targetUser.full_name}`);
  } catch (e) {
    return res.status(400).json({ success: false, message: e.message || "Failed to impersonate user" });
  }
});

/* ==========================
   ─────────────────────────
   USER PROFILE  (JWT protected)
   GET  /api/profile
   PUT  /api/profile
   GET  /api/profile/documents
   POST /api/profile/upload-doc
   ─────────────────────────
========================== */

app.get("/api/profile", verifyUserToken, async (req, res) => {
  try {
    const [user] = await sql`
      SELECT u.user_id, u.member_id, u.user_type, u.full_name, u.date_of_birth,
             u.gender, u.father_name, u.mother_name, u.spouse_name,
             u.mobile_no, u.alternate_mobile, u.email,
             u.pan_number, u.aadhar_number, u.account_status,
             u.email_verified, u.is_otp_verified,
             COALESCE(k.status, 'Not Submitted') AS kyc_status,
             k.admin_remarks AS kyc_remarks,
             u.invitation_code, u.registered_at,
             sp.full_name AS sponsor_name, sp.member_id AS sponsor_id,
             pa.city, pa.state, pa.pin_code,
             b.bank_name, b.account_number, b.ifsc_code,
             n.nominee_name, n.relationship AS nominee_relationship
      FROM users u
      LEFT JOIN users sp               ON u.sponsor_user_id = sp.user_id
      LEFT JOIN user_addresses pa      ON u.user_id = pa.user_id AND pa.address_type = 'Permanent'
      LEFT JOIN user_bank_details b    ON u.user_id = b.user_id
      LEFT JOIN user_nominees n        ON u.user_id = n.user_id
      LEFT JOIN user_kyc_profiles k    ON u.user_id = k.user_id
      WHERE u.user_id = ${req.user.user_id}`;

    if (!user) return err(res, "User not found", 404);
    return ok(res, user);
  } catch (e) {
    return err(res, e.message);
  }
});

app.put("/api/profile", verifyUserToken, async (req, res) => {
  try {
    const { alternate_mobile, email, spouse_name,
            account_holder_name, bank_name, branch_name,
            nominee_name, nominee_relationship } = req.body;
    const uid = req.user.user_id;

    if (email) {
      const cleanEm = String(email).trim().toLowerCase();
      const [dupEmailUser] = await sql`SELECT user_id FROM users WHERE LOWER(email) = ${cleanEm} AND user_id <> ${uid}`;
      const [dupEmailInvestor] = await sql`SELECT id FROM investor_users WHERE LOWER(email) = ${cleanEm} AND deleted_at IS NULL LIMIT 1`;
      if (dupEmailUser || dupEmailInvestor) {
        return err(res, "Email address is already registered to another account (Customer, Associate, or Investor).", 409);
      }
    }

    await sql`
      UPDATE users SET
        alternate_mobile = COALESCE(${alternate_mobile || null}, alternate_mobile),
        email            = COALESCE(${email || null}, email),
        spouse_name      = COALESCE(${spouse_name || null}, spouse_name),
        updated_at       = NOW()
      WHERE user_id = ${uid}`;

    if (bank_name || account_holder_name || branch_name) {
      await sql`
        UPDATE user_bank_details SET
          bank_name           = COALESCE(${bank_name || null}, bank_name),
          account_holder_name = COALESCE(${account_holder_name || null}, account_holder_name),
          branch_name         = COALESCE(${branch_name || null}, branch_name),
          updated_at          = NOW()
        WHERE user_id = ${uid}`;
    }
    if (nominee_name || nominee_relationship) {
      await sql`
        UPDATE user_nominees SET
          nominee_name = COALESCE(${nominee_name || null}, nominee_name),
          relationship = COALESCE(${nominee_relationship || null}, relationship),
          updated_at   = NOW()
        WHERE user_id = ${uid}`;
    }
    return ok(res, {}, "Profile updated");
  } catch (e) {
    return err(res, e.message);
  }
});

app.get("/api/profile/documents", verifyUserToken, async (req, res) => {
  try {
    const docs = await sql`
      SELECT document_id, document_type, file_path, file_name, uploaded_at,
             is_verified, rejection_note, review_status, admin_remarks, reupload_requested
      FROM user_documents WHERE user_id = ${req.user.user_id} AND is_active = TRUE`;
    return ok(res, docs);
  } catch (e) {
    return err(res, e.message);
  }
});

app.post("/api/profile/upload-doc",
  verifyUserToken,
  upload.single("document"),
  async (req, res) => {
    try {
      const { document_type } = req.body;
      if (!req.file) return err(res, "No file uploaded", 400);
      if (!["PANCard","AadharCard","Passport","DrivingLicense","AddressProof","IdentityProof","ProfilePhoto","Other"].includes(document_type))
        return err(res, "Invalid document_type", 400);

      // Save to VPS Storage
      const { url } = await saveFileToVPS(req.file.buffer, {
        module: "user",
        entityId: req.user.user_id,
        entityType: document_type,
        originalName: req.file.originalname,
      });

      // Purana doc deactivate karo
      await sql`
        UPDATE user_documents SET is_active = FALSE
        WHERE user_id = ${req.user.user_id} AND document_type = ${document_type}`;

      const [doc] = await sql`
        INSERT INTO user_documents (
          user_id, document_type, file_path, cloudinary_public_id, file_name, file_size_kb,
          review_status, is_verified, rejection_note, admin_remarks, reupload_requested
        )
        VALUES (${req.user.user_id}, ${document_type}, ${url},
                ${null}, ${req.file.originalname}, ${Math.round(req.file.size / 1024)},
                'Submitted', FALSE, NULL, NULL, FALSE)
        RETURNING document_id`;

      await sql`
        INSERT INTO user_kyc_profiles (user_id, status, submitted_at)
        VALUES (${req.user.user_id}, 'Submitted', NOW())
        ON CONFLICT (user_id) DO UPDATE SET
          status = 'Submitted', submitted_at = NOW(), admin_remarks = NULL,
          reviewed_at = NULL, reviewed_by_admin_id = NULL, updated_at = NOW()`;

      return ok(res, { document_id: doc.document_id, url }, "Document uploaded", 201);
    } catch (e) {
      return err(res, e.message);
    }
  }
);

/* ==========================
   ─────────────────────────
   SITES & PLOTS  (public)
   GET /api/sites
   GET /api/sites/:id
   GET /api/sites/:id/plots
   GET /api/plots/:id
   ─────────────────────────
========================== */

app.get("/api/sites", async (req, res) => {
  try {
    await ensureSiteHtmlMapSchema();
    const sites = await sql`
      SELECT s.site_id, s.site_id AS id, s.site_name, s.site_prefix, s.city, s.state,
             s.full_address, s.full_address AS address,
             s.map_image_url AS layout_map_url, NULL::text AS contact_phone,
             s.description, s.starting_price, s.total_area, s.highlights,
             s.property_image_url, s.map_image_url, s.display_on_home_page,
             s.site_status, s.has_govt_approval,
             COUNT(p.plot_id)                                              AS total_plots,
             COUNT(p.plot_id) FILTER (WHERE p.plot_status = 'Vacant')     AS vacant,
             COUNT(p.plot_id) FILTER (WHERE p.plot_status = 'InProcess')  AS in_process,
             COUNT(p.plot_id) FILTER (WHERE p.plot_status = 'Booked')     AS booked,
             COUNT(p.plot_id) FILTER (WHERE p.plot_status = 'Sold')       AS sold
      FROM sites s
      LEFT JOIN plots p ON s.site_id = p.site_id AND p.is_active = TRUE
      WHERE s.site_status = 'Active'
      GROUP BY s.site_id ORDER BY s.site_id`;
    return ok(res, sites);
  } catch (e) {
    return err(res, e.message);
  }
});

app.get("/api/sites/home", async (req, res) => {
  try {
    await ensureSiteHtmlMapSchema();
    const sites = await getCachedOrFetch("sites-home", 15000, async () => {
      return await sql`
        SELECT s.site_id, s.site_name, s.site_prefix, s.city, s.state, s.full_address,
               s.description, s.starting_price, s.total_area, s.highlights,
               s.property_image_url, s.map_image_url, s.display_on_home_page,
               s.site_status, s.has_govt_approval,
               COUNT(p.plot_id)                                             AS total_plots,
               COUNT(p.plot_id) FILTER (WHERE p.plot_status = 'Vacant')    AS vacant,
               COUNT(p.plot_id) FILTER (WHERE p.plot_status = 'InProcess') AS in_process,
               COUNT(p.plot_id) FILTER (WHERE p.plot_status = 'Booked')    AS booked,
               COUNT(p.plot_id) FILTER (WHERE p.plot_status = 'Sold')      AS sold
        FROM sites s
        LEFT JOIN plots p ON s.site_id = p.site_id AND p.is_active = TRUE
        WHERE s.site_status = 'Active' AND COALESCE(s.display_on_home_page, TRUE) = TRUE
        GROUP BY s.site_id ORDER BY s.site_id`;
    });
    return ok(res, sites);
  } catch (e) {
    return err(res, e.message);
  }
});

app.get("/api/sites/:id", async (req, res) => {
  try {
    await ensureSiteHtmlMapSchema();
    const { id } = req.params;
    const [site] = await sql`SELECT * FROM sites WHERE site_id = ${id}`;
    if (!site) return err(res, "Site not found", 404);

    const landmarks = await sql`
      SELECT * FROM site_landmarks WHERE site_id = ${id} ORDER BY sort_order`;
    const photos = await sql`
      SELECT photo_id, file_path, caption, sort_order, is_cover_photo
      FROM site_photos WHERE site_id = ${id} AND is_active = TRUE ORDER BY sort_order`;
    const category_counts = await sql`
      SELECT plot_category, COUNT(*)::int AS count
      FROM plots
      WHERE site_id = ${id} AND is_active = TRUE
      GROUP BY plot_category
      ORDER BY plot_category`;

    return ok(res, {
      ...site,
      id: site.site_id,
      address: site.full_address,
      layout_map_url: site.map_image_url,
      contact_phone: site.contact_phone || null,
      landmarks,
      photos,
      category_counts,
    });
  } catch (e) {
    return err(res, e.message);
  }
});

app.get("/api/sites/:id/html-map", async (req, res) => {
  try {
    await ensureSiteHtmlMapSchema();
    const { id } = req.params;
    const [site] = await sql`
      SELECT site_id, site_name, html_map_code, html_map_file_url, html_map_updated_at
      FROM sites
      WHERE site_id = ${id}`;
    if (!site) return err(res, "Site not found", 404);
    return ok(res, {
      site_id: site.site_id,
      site_name: site.site_name,
      html_map_code: site.html_map_code || null,
      html_map_file_url: site.html_map_file_url || null,
      html_map_updated_at: site.html_map_updated_at || null,
      available: Boolean(site.html_map_code || site.html_map_file_url),
    });
  } catch (e) {
    return err(res, e.message);
  }
});

app.get("/api/sites/:id/plot-status", async (req, res) => {
  try {
    const { id } = req.params;
    const rows = await sql`
      SELECT plot_id, plot_number, plot_status
      FROM plots
      WHERE site_id = ${id} AND is_active = TRUE
      ORDER BY plot_number`;
    return ok(res, rows);
  } catch (e) {
    return err(res, e.message);
  }
});

app.get("/api/sites/:id/map", async (req, res) => {
  try {
    await ensureSiteHtmlMapSchema();
    const { id } = req.params;
    const [site] = await sql`
      SELECT site_id, site_id AS id, site_name, site_prefix, city, state, full_address, description,
             starting_price, total_area, highlights, property_image_url,
             map_image_url, map_image_url AS layout_map_url, site_status, total_plots, display_on_home_page
      FROM sites
      WHERE site_id = ${id}`;
    if (!site) return err(res, "Site not found", 404);

    const plots = await sql`
      SELECT p.plot_id, p.plot_id AS id, p.plot_number, p.plot_area, p.plot_category,
             p.base_price, p.down_payment, p.monthly_emi, p.emi_tenure_months,
             p.file_charge, p.plot_status, p.coordinates_x, p.coordinates_y,
             d.size_label, COALESCE(pc.coordinates, '[]'::jsonb) AS polygon_coordinates,
             pc.label_x, pc.label_y,
             b.booking_id, b.booking_date, b.confirmed_at,
             u.user_id AS customer_id, u.full_name AS customer_name, u.mobile_no AS customer_mobile,
             CASE
               WHEN b.booking_id IS NULL THEN 'Not Started'
               WHEN b.booking_status = 'Confirmed' THEN 'Paid'
               WHEN b.booking_status = 'Cancelled' THEN 'Cancelled'
               WHEN b.advance_amount > 0 THEN 'Partial'
               ELSE 'Pending'
             END AS payment_status,
             CASE p.plot_status
               WHEN 'Vacant' THEN '#22c55e'
               WHEN 'InProcess' THEN '#eab308'
               WHEN 'Booked' THEN '#ef4444'
               WHEN 'Sold' THEN '#6b7280'
               ELSE '#6b7280'
             END AS status_color
      FROM plots p
      LEFT JOIN plot_polygon_coordinates pc ON pc.plot_id = p.plot_id
      LEFT JOIN plot_details_extended d ON d.plot_id = p.plot_id
      LEFT JOIN LATERAL (
        SELECT *
        FROM bookings b
        WHERE b.plot_id = p.plot_id
        ORDER BY CASE WHEN b.booking_status = 'Cancelled' THEN 1 ELSE 0 END, b.created_at DESC
        LIMIT 1
      ) b ON TRUE
      LEFT JOIN users u ON u.user_id = b.user_id
      WHERE p.site_id = ${id} AND p.is_active = TRUE
      ORDER BY NULLIF(regexp_replace(p.plot_number, '\\D', '', 'g'), '')::int NULLS LAST, p.plot_number`;
    const stats = plots.reduce((acc, plot) => {
      acc.total += 1;
      const key = String(plot.plot_status || "").toLowerCase();
      if (key === "inprocess") acc.inprocess += 1;
      else if (key === "booked") acc.booked += 1;
      else if (key === "sold") acc.sold += 1;
      else if (key === "vacant") acc.vacant += 1;
      return acc;
    }, { total: 0, vacant: 0, inprocess: 0, booked: 0, sold: 0 });

    return ok(res, { site, plots, stats });
  } catch (e) {
    return err(res, e.message);
  }
});

app.get("/api/sites/:id/documents", async (req, res) => {
  try {
    await requireSiteDocumentsSchema();
    const [site] = await sql`SELECT site_id FROM sites WHERE site_id = ${req.params.id}`;
    if (!site) return err(res, "Site not found", 404);
    const documents = await sql`
      SELECT document_id, site_id, document_name, document_type, description,
             file_url, file_name, file_mime_type, file_size_bytes, created_at, updated_at
      FROM site_documents
      WHERE site_id = ${req.params.id}
      ORDER BY created_at DESC`;
    return ok(res, documents);
  } catch (e) {
    return err(res, e.message);
  }
});

app.get("/api/sites/:id/plots", async (req, res) => {
  try {
    const { id } = req.params;
    const { status, category } = req.query;
    const statusFilter = status ? String(status) : null;
    const categoryFilter = category ? String(category) : null;

    let plots = await sql`
      SELECT p.plot_id, p.plot_number, p.plot_area, p.plot_category,
             p.base_price, p.down_payment, p.monthly_emi, p.emi_tenure_months,
             p.file_charge, p.plot_status, p.coordinates_x, p.coordinates_y,
             COALESCE(pc.coordinates, '[]'::jsonb) AS polygon_coordinates,
             pc.label_x, pc.label_y
      FROM plots p
      LEFT JOIN plot_polygon_coordinates pc ON pc.plot_id = p.plot_id
      WHERE p.site_id = ${id} AND p.is_active = TRUE
        AND (${statusFilter}::plot_status_enum IS NULL OR p.plot_status = ${statusFilter}::plot_status_enum)
        AND (${categoryFilter}::plot_category_enum IS NULL OR p.plot_category = ${categoryFilter}::plot_category_enum)
      ORDER BY p.plot_number`;

    return ok(res, plots);
  } catch (e) {
    return err(res, e.message);
  }
});

app.get("/api/plots/:id", async (req, res) => {
  try {
    const [plot] = await sql`
      SELECT p.*, s.site_name, s.city, s.full_address,
             b.booking_id, b.booking_date, b.confirmed_at,
             u.user_id AS customer_id, u.full_name AS customer_name, u.mobile_no AS customer_mobile,
             CASE
               WHEN b.booking_id IS NULL THEN 'Not Started'
               WHEN b.booking_status = 'Confirmed' THEN 'Paid'
               WHEN b.booking_status = 'Cancelled' THEN 'Cancelled'
               WHEN b.advance_amount > 0 THEN 'Partial'
               ELSE 'Pending'
             END AS payment_status
      FROM plots p JOIN sites s ON p.site_id = s.site_id
      LEFT JOIN LATERAL (
        SELECT *
        FROM bookings b
        WHERE b.plot_id = p.plot_id
        ORDER BY CASE WHEN b.booking_status = 'Cancelled' THEN 1 ELSE 0 END, b.created_at DESC
        LIMIT 1
      ) b ON TRUE
      LEFT JOIN users u ON u.user_id = b.user_id
      WHERE p.plot_id = ${req.params.id}`;
    if (!plot) return err(res, "Plot not found", 404);

    const [extended] = await sql`
      SELECT size_label, width_ft, length_ft, facing_direction, is_corner_plot,
             road_width_ft, features, description, block_name, sector_name
      FROM plot_details_extended
      WHERE plot_id = ${req.params.id}`;
    const images = await sql`
      SELECT image_url, caption, image_order
      FROM plot_images
      WHERE plot_id = ${req.params.id}
      ORDER BY image_order ASC, id ASC`;
    const [polygon] = await sql`
      SELECT coordinates, label_x, label_y
      FROM plot_polygon_coordinates
      WHERE plot_id = ${req.params.id}`;

    return ok(res, {
      ...plot,
      site: {
        id: plot.site_id,
        site_name: plot.site_name,
        city: plot.city,
        address: plot.full_address,
        full_address: plot.full_address,
      },
      extended: extended || null,
      images,
      polygon: polygon || { coordinates: [], label_x: null, label_y: null },
    });
  } catch (e) {
    return err(res, e.message);
  }
});

/* ==========================
   ─────────────────────────
   BOOKINGS  (JWT required)
   GET  /api/bookings          — my bookings
   POST /api/bookings          — create booking
   GET  /api/bookings/:id      — booking detail
   POST /api/bookings/:id/upload-proof
   ─────────────────────────
========================== */

app.get("/api/bookings", verifyUserToken, async (req, res) => {
  try {
    const bookings = await sql`
      SELECT b.booking_id, b.booking_serial, b.booking_date, b.booking_status,
             b.advance_amount, b.payment_type, b.created_at,
             CASE
               WHEN b.booking_status = 'Confirmed' THEN 'Paid'
               WHEN b.advance_amount > 0 THEN 'Partial'
               ELSE 'Unpaid'
             END AS payment_status,
             COALESCE(pay.total_paid, b.advance_amount, 0)::numeric AS total_paid,
             p.plot_number, p.plot_area, p.plot_category,
             s.site_name, s.city
      FROM bookings b
      JOIN plots p ON b.plot_id = p.plot_id
      JOIN sites  s ON p.site_id  = s.site_id
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(e.paid_amount) FILTER (WHERE e.emi_status = 'Paid'), 0) + COALESCE(b.advance_amount, 0) AS total_paid
        FROM emi_schedules e
        WHERE e.booking_id = b.booking_id
      ) pay ON TRUE
      WHERE b.user_id = ${req.user.user_id}
      ORDER BY b.created_at DESC`;
    return ok(res, bookings);
  } catch (e) {
    return err(res, e.message);
  }
});

app.post("/api/bookings", verifyUserToken, async (req, res) => {
  try {
    const { plot_id, payment_type, advance_amount } = req.body;
    if (!plot_id || !payment_type || !advance_amount)
      return err(res, "plot_id, payment_type, advance_amount required", 400);
    if (!["EMI", "FullPayment", "DownPayment"].includes(payment_type))
      return err(res, "Invalid payment_type", 400);
    if (!Number.isFinite(Number(advance_amount)) || Number(advance_amount) <= 0)
      return err(res, "advance_amount must be greater than 0", 400);

    const [user] = await sql`
      SELECT u.account_status, u.is_active,
             (COALESCE(u.email_verified, FALSE) OR COALESCE(u.is_otp_verified, FALSE)) AS email_verified,
             COALESCE(k.status, 'Not Submitted') AS kyc_status
      FROM users u
      LEFT JOIN user_kyc_profiles k ON k.user_id = u.user_id
      WHERE u.user_id = ${req.user.user_id}`;
    if (!user || !["Active", "Approved"].includes(String(user.account_status)))
      return err(res, "User must be approved and active before booking.", 403);
    if (!user.email_verified)
      return err(res, "Please verify your email address before booking a plot.", 403);
    if (user.kyc_status !== "Approved")
      return err(res, "Your KYC documents must be approved before booking a plot.", 403);

    // Check plot is vacant
    const [plot] = await sql`SELECT * FROM plots WHERE plot_id = ${plot_id}`;
    if (!plot) return err(res, "Plot not found", 404);
    if (plot.plot_status !== "Vacant")
      return err(res, "Plot is not available for booking", 409);

    // Generate serial
    const [seq] = await sql`
      SELECT COALESCE(MAX(CAST(SUBSTRING(booking_serial FROM 10) AS INT)),0)+1 AS n
      FROM bookings WHERE booking_serial LIKE 'MMR-' || to_char(NOW(),'YYYY') || '-%'`;
    const serial = `MMR-${new Date().getFullYear()}-${String(seq.n).padStart(5,"0")}`;

    const [booking] = await sql`
      INSERT INTO bookings (booking_serial, user_id, plot_id, payment_type, advance_amount)
      VALUES (${serial}, ${req.user.user_id}, ${plot_id}, ${payment_type}, ${advance_amount})
      RETURNING booking_id, booking_serial, booking_status`;

    if (payment_type === "EMI") {
      const start = new Date();
      start.setMonth(start.getMonth() + 1);
      for (let i = 1; i <= Number(plot.emi_tenure_months || 60); i++) {
        const due = new Date(start);
        due.setMonth(due.getMonth() + (i - 1));
        await sql`
          INSERT INTO emi_schedules (booking_id, user_id, installment_no, due_date, emi_amount)
          VALUES (${booking.booking_id}, ${req.user.user_id}, ${i}, ${due.toISOString().split("T")[0]}, ${plot.monthly_emi || 0})
          ON CONFLICT (booking_id, installment_no) DO NOTHING`;
      }
    }

    // Mark plot Booked immediately so public availability updates on refresh.
    await sql`UPDATE plots SET plot_status = 'Booked', updated_at = NOW() WHERE plot_id = ${plot_id}`;
    await sql`
      INSERT INTO plot_status_history (plot_id, old_status, new_status, reason)
      VALUES (${plot_id}, 'Vacant', 'Booked', 'Booking submitted by user')`;
    await addPlotBookingHistory({
      plotId: plot_id,
      bookingId: booking.booking_id,
      userId: req.user.user_id,
      eventType: "BookingSubmitted",
      eventNote: "Booking submitted by user",
      triggeredByUser: req.user.user_id,
      plotStatusAtTime: "Booked",
    });
    await addUserNotification({
      userId: req.user.user_id,
      title: "Booking submitted",
      message: `Aapki booking ${serial} submit ho gayi, admin review karega`,
    });

    return ok(res, booking, "Booking submitted. Awaiting admin confirmation.", 201);
  } catch (e) {
    return err(res, e.message);
  }
});

app.get("/api/bookings/:id", verifyUserToken, async (req, res) => {
  try {
    const [booking] = await sql`
      SELECT b.*, p.plot_number, p.plot_area, p.plot_category,
             p.base_price, p.down_payment, p.monthly_emi, p.emi_tenure_months, p.file_charge,
             s.site_name, s.city, s.full_address
      FROM bookings b
      JOIN plots p ON b.plot_id = p.plot_id
      JOIN sites  s ON p.site_id = s.site_id
      WHERE b.booking_id = ${req.params.id} AND b.user_id = ${req.user.user_id}`;
    if (!booking) return err(res, "Booking not found", 404);
    const emi_schedule = await sql`
      SELECT emi_id, installment_no, due_date, emi_amount, late_fee_amount,
             total_due, paid_amount, paid_date, emi_status
      FROM emi_schedules
      WHERE booking_id = ${req.params.id}
      ORDER BY installment_no`;
    return ok(res, {
      ...booking,
      plot: {
        id: booking.plot_id,
        plot_number: booking.plot_number,
        plot_area: booking.plot_area,
        plot_category: booking.plot_category,
        base_price: booking.base_price,
        down_payment: booking.down_payment,
        monthly_emi: booking.monthly_emi,
        emi_tenure_months: booking.emi_tenure_months,
        file_charge: booking.file_charge,
      },
      site: {
        id: booking.site_id,
        site_name: booking.site_name,
        city: booking.city,
        address: booking.full_address,
      },
      emi_schedule,
    });
  } catch (e) {
    return err(res, e.message);
  }
});

app.post("/api/bookings/:id/upload-proof",
  verifyUserToken,
  upload.single("payment_proof"),
  async (req, res) => {
    try {
      if (!req.file) return err(res, "No file uploaded", 400);
      const [booking] = await sql`
        SELECT booking_id, plot_id, user_id, booking_serial FROM bookings
        WHERE booking_id = ${req.params.id} AND user_id = ${req.user.user_id}`;
      if (!booking) return err(res, "Booking not found", 404);

      // Save to VPS Storage
      const { url } = await saveFileToVPS(
        req.file.buffer,
        { module: "proof", entityId: booking.booking_id, entityType: "BookingProof", originalName: req.file.originalname }
      );

      await sql`
        INSERT INTO booking_payment_proofs (booking_id, file_path, cloudinary_public_id)
        VALUES (${booking.booking_id}, ${url}, ${null})`;

      await sql`
        UPDATE bookings SET booking_status = 'PaymentPending', updated_at = NOW()
        WHERE booking_id = ${booking.booking_id}`;
      await addPlotBookingHistory({
        plotId: booking.plot_id,
        bookingId: booking.booking_id,
        userId: booking.user_id,
        eventType: "PaymentProofUploaded",
        eventNote: "User uploaded payment proof",
        triggeredByUser: booking.user_id,
        plotStatusAtTime: "InProcess",
      });
      await addUserNotification({
        userId: booking.user_id,
        title: "Payment proof submitted",
        message: `Payment proof ${booking.booking_serial} ke liye submit ho gaya. Admin verify karega.`,
      });

      return ok(res, { url }, "Payment proof uploaded");
    } catch (e) {
      return err(res, e.message);
    }
  }
);

/* ==========================
   ─────────────────────────
   EMI  (JWT required)
   GET  /api/emi               — all EMIs for my bookings
   GET  /api/emi/:bookingId    — EMI schedule for a booking
   POST /api/emi/:emiId/upload-proof
   GET  /api/emi/:emiId/voucher
   ─────────────────────────
========================== */

app.get("/api/emi", verifyUserToken, async (req, res) => {
  try {
    const emis = await sql`
      SELECT e.emi_id, e.installment_no, e.due_date, e.emi_amount,
             e.late_fee_amount, e.total_due, e.paid_amount, e.paid_date,
             e.emi_status, e.voucher_file_path,
             p.plot_number, s.site_name,
             CASE WHEN CURRENT_DATE > e.due_date AND e.emi_status = 'Pending'
                  THEN (CURRENT_DATE - e.due_date) ELSE 0 END AS overdue_days
      FROM emi_schedules e
      JOIN bookings b ON e.booking_id = b.booking_id
      JOIN plots    p ON b.plot_id = p.plot_id
      JOIN sites    s ON p.site_id = s.site_id
      WHERE e.user_id = ${req.user.user_id}
      ORDER BY e.due_date ASC`;
    return ok(res, emis);
  } catch (e) {
    return err(res, e.message);
  }
});

app.get("/api/emi/:bookingId", verifyUserToken, async (req, res) => {
  try {
    const emis = await sql`
      SELECT e.* FROM emi_schedules e
      JOIN bookings b ON e.booking_id = b.booking_id
      WHERE e.booking_id = ${req.params.bookingId} AND b.user_id = ${req.user.user_id}
      ORDER BY e.installment_no`;
    return ok(res, emis);
  } catch (e) {
    return err(res, e.message);
  }
});

app.post("/api/emi/:emiId/upload-proof",
  verifyUserToken,
  upload.single("payment_proof"),
  async (req, res) => {
    try {
      if (!req.file) return err(res, "No file uploaded", 400);
      const { payment_mode, reference_no } = req.body;

      const [emi] = await sql`
        SELECT e.emi_id FROM emi_schedules e
        JOIN bookings b ON e.booking_id = b.booking_id
        WHERE e.emi_id = ${req.params.emiId} AND b.user_id = ${req.user.user_id}`;
      if (!emi) return err(res, "EMI not found", 404);

      // Save to VPS Storage
      const { url } = await saveFileToVPS(
        req.file.buffer,
        { module: "proof", entityId: emi.emi_id, entityType: "EmiProof", originalName: req.file.originalname }
      );

      await sql`
        INSERT INTO emi_payment_proofs (emi_id, file_path, cloudinary_public_id, payment_mode, reference_no)
        VALUES (${emi.emi_id}, ${url}, ${null}, ${payment_mode || null}, ${reference_no || null})`;

      await sql`
        UPDATE emi_schedules SET emi_status = 'ProofSubmitted', updated_at = NOW()
        WHERE emi_id = ${emi.emi_id}`;

      return ok(res, { url }, "EMI proof submitted. Awaiting admin confirmation.");
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.get("/api/emi/:emiId/voucher", verifyUserToken, async (req, res) => {
  try {
    const [v] = await sql`
      SELECT pv.* FROM payment_vouchers pv
      WHERE pv.voucher_type = 'EMI' AND pv.reference_id = ${req.params.emiId}
        AND pv.user_id = ${req.user.user_id}`;
    if (!v) return err(res, "Voucher not found", 404);
    return ok(res, v);
  } catch (e) {
    return err(res, e.message);
  }
});

/* ==========================
   ─────────────────────────
   ASSOCIATE / MLM  (JWT required)
   GET /api/associate/dashboard
   GET /api/associate/network
   GET /api/associate/commissions
   GET /api/associate/invite-code
   ─────────────────────────
========================== */

app.get("/api/referral/validate/:inviteCode", async (req, res) => {
  try {
    await requireMlmSchema();
    const inviteCode = String(req.params.inviteCode || "").replace(/\*/g, "").trim().toUpperCase();
    const [sponsor] = await sql`
      SELECT u.user_id, u.member_id, u.full_name, u.invitation_code, u.account_status,
             l.referral_url, l.total_clicks, l.total_registrations, l.is_active
      FROM users u
      LEFT JOIN associate_referral_links l ON l.associate_user_id = u.user_id
      WHERE (
          UPPER(COALESCE(u.invitation_code, '')) = ${inviteCode}
          OR UPPER(COALESCE(u.member_id, '')) = ${inviteCode}
          OR UPPER(regexp_replace(COALESCE(u.member_id, ''), '^MMR-[AC]-', 'MMR')) = ${inviteCode}
          OR UPPER(COALESCE(l.invite_code, '')) = ${inviteCode}
        )
        AND u.user_type = 'Associate'
      LIMIT 1`;
    if (!sponsor || sponsor.account_status !== "Active" || sponsor.is_active === false) {
      return err(res, "Invalid or inactive invite code", 404);
    }
    return ok(res, { valid: true, sponsor });
  } catch (e) {
    return err(res, e.message);
  }
});

app.get("/api/referral/:inviteCode", async (req, res) => {
  try {
    await requireMlmSchema();
    const inviteCode = String(req.params.inviteCode || "").replace(/\*/g, "").trim().toUpperCase();
    const [sponsor] = await sql`
      SELECT u.user_id, u.member_id, u.full_name, u.invitation_code, u.account_status,
             l.invite_code, l.referral_url, l.is_active
      FROM users u
      LEFT JOIN associate_referral_links l ON l.associate_user_id = u.user_id
      WHERE (
          UPPER(COALESCE(u.invitation_code, '')) = ${inviteCode}
          OR UPPER(COALESCE(u.member_id, '')) = ${inviteCode}
          OR UPPER(regexp_replace(COALESCE(u.member_id, ''), '^MMR-[AC]-', 'MMR')) = ${inviteCode}
          OR UPPER(COALESCE(l.invite_code, '')) = ${inviteCode}
        )
        AND u.user_type = 'Associate'
      LIMIT 1`;
    if (!sponsor || sponsor.account_status !== "Active" || sponsor.is_active === false) {
      return err(res, "Invalid or inactive invite code", 404);
    }
    await sql`
      INSERT INTO referral_clicks (associate_user_id, invite_code, ip_address, user_agent)
      VALUES (${sponsor.user_id}, ${inviteCode}, ${req.ip || null}, ${req.get("user-agent") || null})`;
    await ensureAssociateReferralLink(req, sponsor);
    await sql`
      UPDATE associate_referral_links SET total_clicks = total_clicks + 1, updated_at = NOW()
      WHERE associate_user_id = ${sponsor.user_id}`;
    return ok(res, {
      sponsor: {
        user_id: sponsor.user_id,
        member_id: sponsor.member_id,
        full_name: sponsor.full_name,
        invite_code: sponsor.invite_code || sponsor.invitation_code || sponsor.member_id,
        referral_url: sponsor.referral_url || publicReferralUrl(req, sponsor.invite_code || sponsor.invitation_code || sponsor.member_id),
      }
    });
  } catch (e) {
    return err(res, e.message);
  }
});

app.get("/api/associate/dashboard", verifyUserToken, requireAssociate, async (req, res) => {
  try {
    const [tracker] = await sql`
      SELECT * FROM associate_sales_tracker WHERE associate_user_id = ${req.user.user_id}`;

    const pendingComm = await sql`
      SELECT COALESCE(SUM(net_amount),0) AS pending
      FROM commission_transactions
      WHERE associate_user_id = ${req.user.user_id} AND commission_status = 'Pending'`;

    const [networkCount] = await sql`
      SELECT COUNT(*) AS count FROM mlm_network WHERE sponsor_user_id = ${req.user.user_id}`;

    const recentCommissions = await sql`
      SELECT commission_id, commission_type, net_amount, commission_month,
             commission_status, created_at
      FROM commission_transactions
      WHERE associate_user_id = ${req.user.user_id}
      ORDER BY created_at DESC LIMIT 5`;

    return ok(res, {
      tracker,
      pending_commission: pendingComm[0]?.pending || 0,
      direct_network_count: networkCount?.count || 0,
      recent_commissions: recentCommissions,
      // Milestone flags
      milestone_achieved: (tracker?.total_gaj_sold || 0) >= 2000,
      current_monthly_net: Math.floor((tracker?.total_gaj_sold || 0) / 100) * 600,
    });
  } catch (e) {
    return err(res, e.message);
  }
});

app.get("/api/dashboard", verifyUserToken, async (req, res) => {
  try {
    const userId = req.user.user_id;
    const isAssociate = req.user.user_type === "Associate";

    const [summary, monthlySales] = await Promise.all([
      sql`
        SELECT
          (SELECT COUNT(*)::int
           FROM bookings
           WHERE user_id = ${userId}
             AND booking_status <> 'Cancelled') AS user_booked_plots,
          (SELECT COALESCE(SUM(COALESCE(total_due, emi_amount, 0)), 0)::numeric
           FROM emi_schedules
           WHERE user_id = ${userId}
             AND emi_status IN ('Pending', 'Overdue', 'ProofSubmitted')) AS user_emi_due,
          (SELECT COUNT(*)::int
           FROM emi_schedules
           WHERE user_id = ${userId}
             AND emi_status = 'Paid') AS user_payments,
          (SELECT COUNT(*)::int
           FROM notification_log
           WHERE user_id = ${userId}
             AND is_read = FALSE) AS user_notifications`,
      sql`
        WITH months AS (
          SELECT generate_series(
            date_trunc('month', CURRENT_DATE) - INTERVAL '11 months',
            date_trunc('month', CURRENT_DATE),
            INTERVAL '1 month'
          ) AS month_start
        ),
        sales AS (
          SELECT
            date_trunc('month', COALESCE(b.confirmed_at, b.booking_date, b.created_at)) AS month_start,
            COUNT(DISTINCT b.booking_id)::int AS sales_count,
            COALESCE(SUM(COALESCE(p.base_price, b.advance_amount, 0)), 0)::numeric AS sales_amount
          FROM bookings b
          JOIN plots p ON p.plot_id = b.plot_id
          JOIN users buyer ON buyer.user_id = b.user_id
          WHERE b.booking_status = 'Confirmed'
            AND (
              (${isAssociate} = TRUE AND buyer.sponsor_user_id = ${userId})
              OR
              (${isAssociate} = FALSE AND b.user_id = ${userId})
            )
            AND COALESCE(b.confirmed_at, b.booking_date, b.created_at)
                >= date_trunc('month', CURRENT_DATE) - INTERVAL '11 months'
          GROUP BY 1
        )
        SELECT
          to_char(m.month_start, 'Mon YYYY') AS month,
          COALESCE(s.sales_count, 0)::int AS sales_count,
          COALESCE(s.sales_amount, 0)::numeric AS sales_amount
        FROM months m
        LEFT JOIN sales s ON s.month_start = m.month_start
        ORDER BY m.month_start`
    ]);

    let associateSalesStats = null;
    if (isAssociate) {
      const [associateStats] = await sql`
        SELECT
          COALESCE(t.total_gaj_sold, 0)::numeric AS total_gaj_sold,
          COALESCE(t.total_commission_earned, 0)::numeric AS commission_earned,
          COALESCE((
            SELECT SUM(c.net_amount)
            FROM commission_transactions c
            WHERE c.associate_user_id = ${userId}
              AND c.commission_status = 'Pending'
          ), 0)::numeric AS pending_commission,
          COALESCE((
            SELECT COUNT(*)
            FROM users u
            WHERE u.sponsor_user_id = ${userId}
              AND u.account_status = 'Active'
          ), 0)::int AS direct_referrals
        FROM users u
        LEFT JOIN associate_sales_tracker t ON t.associate_user_id = u.user_id
        WHERE u.user_id = ${userId}`;
      associateSalesStats = associateStats || {
        total_gaj_sold: 0,
        commission_earned: 0,
        pending_commission: 0,
        direct_referrals: 0,
      };
    }

    return ok(res, {
      userMonthlySalesChartData: monthlySales,
      userBookedPlots: Number(summary?.user_booked_plots || 0),
      userEmiDue: Number(summary?.user_emi_due || 0),
      userPayments: Number(summary?.user_payments || 0),
      userNotifications: Number(summary?.user_notifications || 0),
      associateSalesStats,
    });
  } catch (e) {
    console.error("[User Dashboard API Error]", e);
    return err(res, e.message);
  }
});

app.get("/api/associate/network", verifyUserToken, requireAssociate, async (req, res) => {
  try {
    await syncMlmTreeAndReferrals();
    const network = await sql`
      SELECT u.user_id, u.member_id, u.full_name, u.mobile_no,
             u.email, u.sponsor_user_id, u.account_status, u.registered_at,
             COALESCE(t.total_gaj_sold, 0) AS total_gaj_sold,
             COALESCE(t.total_commission_earned, 0) AS total_commission_earned,
             COALESCE((
               SELECT SUM(c.net_amount) FROM commission_transactions c
               WHERE c.associate_user_id = u.user_id AND c.commission_status = 'Pending'
             ), 0) AS pending_commission,
             c.depth AS level
      FROM mlm_tree_closure c
      JOIN users u ON c.descendant_user_id = u.user_id
      LEFT JOIN associate_sales_tracker t ON u.user_id = t.associate_user_id
      WHERE c.ancestor_user_id = ${req.user.user_id}
        AND c.depth > 0
      ORDER BY c.depth, u.registered_at DESC`;

    return ok(res, network);
  } catch (e) {
    return err(res, e.message);
  }
});

app.get("/api/admin/mlm/network",
  verifyAdminToken,
  role("SuperAdmin","FinanceManager","SiteManager"),
  async (_req, res) => {
    try {
      await requireMlmSchema();
      const network = await sql`
        SELECT u.user_id, u.member_id, u.full_name, u.mobile_no, u.email,
               u.sponsor_user_id, u.account_status, u.registered_at,
               COALESCE(n.level, 1) AS level,
               COALESCE(t.total_gaj_sold, 0) AS total_gaj_sold,
               COALESCE(t.total_commission_earned, 0) AS total_commission_earned,
               COALESCE((
                 SELECT SUM(c.net_amount) FROM commission_transactions c
                 WHERE c.associate_user_id = u.user_id AND c.commission_status = 'Pending'
               ), 0) AS pending_commission
        FROM users u
        LEFT JOIN mlm_network n ON n.associate_user_id = u.user_id
        LEFT JOIN associate_sales_tracker t ON t.associate_user_id = u.user_id
        WHERE u.user_type = 'Associate'
        ORDER BY COALESCE(n.level, 1), u.registered_at`;
      return ok(res, network);
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.get("/api/associate/commissions", verifyUserToken, requireAssociate, async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;
    const statusFilter = status ? String(status) : null;

    const commissions = await sql`
      SELECT c.commission_id, c.commission_type, c.gaj_sold,
             c.gross_amount, c.deduction_amount, c.net_amount,
             c.commission_month, c.commission_status,
             c.paid_at, c.payment_reference, c.created_at,
             c.commission_model, c.commission_level, c.commission_percentage,
             c.calculation_base, c.source_type, c.source_reference, c.engine_version,
             b.booking_serial, p.plot_number, s.site_name
      FROM commission_transactions c
      LEFT JOIN bookings b ON c.related_booking_id = b.booking_id
      LEFT JOIN plots    p ON b.plot_id = p.plot_id
      LEFT JOIN sites    s ON p.site_id = s.site_id
      WHERE c.associate_user_id = ${req.user.user_id}
        AND (${statusFilter}::text IS NULL OR c.commission_status = ${statusFilter})
      ORDER BY c.created_at DESC
      LIMIT ${limit} OFFSET ${offset}`;

    const [total] = await sql`
      SELECT COUNT(*) AS count FROM commission_transactions
      WHERE associate_user_id = ${req.user.user_id}
        AND (${statusFilter}::text IS NULL OR commission_status = ${statusFilter})`;

    return ok(res, { commissions, total: total.count, page: +page, limit: +limit });
  } catch (e) {
    return err(res, e.message);
  }
});

app.get("/api/associate/invite-code", verifyUserToken, requireAssociate, async (req, res) => {
  try {
    const [user] = await sql`
      SELECT user_id, invitation_code, member_id, full_name FROM users WHERE user_id = ${req.user.user_id}`;
    const link = await ensureAssociateReferralLink(req, user);
    return ok(res, { invitation_code: user.invitation_code, member_id: user.member_id, ...link });
  } catch (e) {
    return err(res, e.message);
  }
});

app.get("/api/associate/referral-link", verifyUserToken, requireAssociate, async (req, res) => {
  try {
    const [user] = await sql`
      SELECT user_id, invitation_code, member_id, full_name, user_type, account_status
      FROM users WHERE user_id = ${req.user.user_id}`;
    if (!user || user.user_type !== "Associate" || user.account_status !== "Active")
      return err(res, "Only active associates can access referral link", 403);
    return ok(res, await ensureAssociateReferralLink(req, user));
  } catch (e) {
    return err(res, e.message);
  }
});

const getDefaultSponsorUserId = async () => {
  const [defaultUser] = await sql`
    SELECT user_id FROM users
    WHERE LOWER(email) = 'mmrconstructions@hotmail.com' OR mobile_no = '7071951011' OR user_id = 1 OR member_id = 'MMR-ASC-0001'
    ORDER BY user_id ASC LIMIT 1`;
  return defaultUser?.user_id || 1;
};

const ensureAdminReferralLink = async (req) => {
  await requireMlmSchema();
  const passwordHash = await bcrypt.hash("Mmr@2026", 12);
  let [adminAssoc] = await sql`
    SELECT user_id, invitation_code, member_id, full_name, email, user_type, account_status
    FROM users
    WHERE LOWER(email) = 'mmrconstructions@hotmail.com' OR mobile_no = '7071951011' OR user_id = 1 OR member_id = 'MMR-ASC-0001'
    ORDER BY user_id ASC
    LIMIT 1`;

  if (!adminAssoc) {
    const [inserted] = await sql`
      INSERT INTO users (user_id, member_id, full_name, email, mobile_no, password_hash, user_type, account_status, invitation_code, is_active, is_verified)
      VALUES (1, 'MMR-ASC-0001', 'Suraj Kumar Verma', 'mmrconstructions@hotmail.com', '7071951011', ${passwordHash}, 'Associate', 'Active', 'MMR0001', TRUE, TRUE)
      ON CONFLICT (user_id) DO UPDATE SET
        full_name = EXCLUDED.full_name,
        email = EXCLUDED.email,
        mobile_no = EXCLUDED.mobile_no,
        account_status = 'Active',
        is_active = TRUE
      RETURNING user_id, invitation_code, member_id, full_name, email, user_type, account_status`;
    adminAssoc = inserted;
  }

  const link = await ensureAssociateReferralLink(req, adminAssoc);
  return {
    user_id: adminAssoc.user_id,
    full_name: adminAssoc.full_name,
    member_id: adminAssoc.member_id || 'MMR-ASC-0001',
    invite_code: link.invite_code,
    referral_url: link.referral_url,
    total_clicks: Number(link.total_clicks || 0),
    total_registrations: Number(link.total_registrations || 0),
  };
};

app.get("/api/admin/referral-link", verifyAdminToken, async (req, res) => {
  try {
    const adminLink = await ensureAdminReferralLink(req);
    return ok(res, adminLink);
  } catch (e) {
    return err(res, e.message);
  }
});

app.post("/api/admin/referral-link/regenerate", verifyAdminToken, async (req, res) => {
  try {
    const adminLink = await ensureAdminReferralLink(req);
    const inviteCode = `MMR0001`;
    await sql`UPDATE users SET invitation_code = ${inviteCode}, updated_at = NOW() WHERE user_id = ${adminLink.user_id}`;
    const updatedLink = await ensureAssociateReferralLink(req, { ...adminLink, user_id: adminLink.user_id, invitation_code: inviteCode });
    return ok(res, { ...adminLink, ...updatedLink }, "Admin referral link refreshed");
  } catch (e) {
    return err(res, e.message);
  }
});

app.post("/api/associate/referral-link/regenerate", verifyUserToken, requireAssociate, async (req, res) => {
  try {
    await requireMlmSchema();
    const [user] = await sql`SELECT user_id, member_id, user_type, account_status FROM users WHERE user_id = ${req.user.user_id}`;
    if (!user || user.user_type !== "Associate" || user.account_status !== "Active")
      return err(res, "Only active associates can regenerate referral link", 403);
    const inviteCode = `MMR${user.member_id || user.user_id}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    await sql`UPDATE users SET invitation_code = ${inviteCode}, updated_at = NOW() WHERE user_id = ${user.user_id}`;
    return ok(res, await ensureAssociateReferralLink(req, { ...user, invitation_code: inviteCode }), "Referral link regenerated");
  } catch (e) {
    return err(res, e.message);
  }
});

app.get("/api/associate/referrals", verifyUserToken, requireAssociate, async (req, res) => {
  try {
    await requireMlmSchema();
    const statusFilter = String(req.query.status || "");
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
    const rows = await sql`
      SELECT rr.*, u.member_id, u.full_name, u.email, u.mobile_no, u.user_type, u.account_status,
             COALESCE(t.total_gaj_sold, 0) AS total_sales_gaj,
             COUNT(b.booking_id) AS booking_count,
             COUNT(*) OVER() AS total_count
      FROM referral_registrations rr
      JOIN users u ON u.user_id = rr.referred_user_id
      LEFT JOIN associate_sales_tracker t ON t.associate_user_id = u.user_id
      LEFT JOIN bookings b ON b.user_id = u.user_id
      WHERE rr.sponsor_user_id = ${req.user.user_id}
        AND (${statusFilter} = '' OR rr.status = ${statusFilter})
      GROUP BY rr.id, u.user_id, t.total_gaj_sold
      ORDER BY rr.created_at DESC
      LIMIT ${limit} OFFSET ${(page - 1) * limit}`;
    const total = Number(rows[0]?.total_count || 0);
    return ok(res, { items: rows.map(({ total_count, ...row }) => row), total, page, limit });
  } catch (e) {
    return err(res, e.message);
  }
});

app.get("/api/associate/network/tree", verifyUserToken, requireAssociate, async (req, res) => {
  try {
    await requireMlmSchema();
    await syncMlmTreeAndReferrals();
    const rows = await sql`
      SELECT u.user_id, u.member_id, u.full_name, u.user_type, u.sponsor_user_id,
             u.account_status AS status, COALESCE(r.rank_name, 'Associate') AS rank,
             COALESCE(t.total_gaj_sold, 0) AS total_gaj_sold,
             COALESCE(t.total_commission_earned, 0) AS commission_earned
      FROM mlm_tree_closure c
      JOIN users u ON u.user_id = c.descendant_user_id
      LEFT JOIN associate_sales_tracker t ON t.associate_user_id = u.user_id
      LEFT JOIN associate_ranks r ON r.rank_id = t.current_rank_id
      WHERE c.ancestor_user_id = ${req.user.user_id}
      ORDER BY c.depth, u.full_name`;
    const byId = new Map(rows.map(row => [row.user_id, { ...row, children: [] }]));
    const root = byId.get(req.user.user_id) || { children: [] };
    for (const node of byId.values()) {
      if (node.user_id === req.user.user_id) continue;
      const parent = byId.get(node.sponsor_user_id);
      (parent || root).children.push(node);
    }
    return ok(res, root);
  } catch (e) {
    return err(res, e.message);
  }
});

app.get("/api/associate/commissions/schedule", verifyUserToken, requireAssociate, async (req, res) => {
  try {
    await requireMlmSchema();
    const statusFilter = String(req.query.status || "");
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const rows = await sql`
      SELECT s.*, b.booking_serial, p.plot_number, site.site_name,
             COUNT(*) OVER() AS total_count
      FROM commission_monthly_schedule s
      LEFT JOIN bookings b ON b.booking_id = s.booking_id
      LEFT JOIN plots p ON p.plot_id = b.plot_id
      LEFT JOIN sites site ON site.site_id = p.site_id
      WHERE s.associate_user_id = ${req.user.user_id}
        AND (${statusFilter} = '' OR s.status = ${statusFilter})
      ORDER BY s.due_month ASC
      LIMIT ${limit} OFFSET ${(page - 1) * limit}`;
    const total = Number(rows[0]?.total_count || 0);
    return ok(res, { items: rows.map(({ total_count, ...row }) => row), total, page, limit });
  } catch (e) {
    return err(res, e.message);
  }
});

app.get("/api/associate/payouts", verifyUserToken, requireAssociate, async (req, res) => {
  try {
    await requireMlmSchema();
    const payouts = await sql`
      SELECT * FROM associate_payout_requests
      WHERE associate_user_id = ${req.user.user_id}
      ORDER BY requested_at DESC`;
    return ok(res, payouts);
  } catch (e) {
    return err(res, e.message);
  }
});

app.post("/api/associate/payouts/request", verifyUserToken, requireAssociate, async (req, res) => {
  try {
    await requireMlmSchema();
    const amount = Number(req.body.requested_amount);
    if (!Number.isFinite(amount) || amount <= 0) return err(res, "requested_amount must be greater than zero", 400);
    const [blocked] = await sql`SELECT user_id FROM users WHERE user_id = ${req.user.user_id} AND account_status IN ('Suspended','Blacklisted')`;
    if (blocked) return err(res, "Suspended or blacklisted associate cannot request payout", 403);
    const [payout] = await sql`
      INSERT INTO associate_payout_requests (associate_user_id, requested_amount)
      VALUES (${req.user.user_id}, ${amount})
      RETURNING *`;
    return ok(res, payout, "Payout request submitted", 201);
  } catch (e) {
    return err(res, e.message);
  }
});

/* ==========================
   ─────────────────────────
   NOTIFICATIONS  (JWT required)
   GET   /api/notifications
   PATCH /api/notifications/:id/read
   PATCH /api/notifications/read-all
   ─────────────────────────
========================== */

app.get("/api/notifications", verifyUserToken, async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    const notifs = await sql`
      SELECT notif_id, title, message, channel, is_read, read_at, sent_at, delivery_status
      FROM notification_log
      WHERE user_id = ${req.user.user_id}
      ORDER BY sent_at DESC LIMIT ${limit} OFFSET ${offset}`;

    const [unread] = await sql`
      SELECT COUNT(*) AS count FROM notification_log
      WHERE user_id = ${req.user.user_id} AND is_read = FALSE`;

    return ok(res, { notifications: notifs, unread_count: unread.count });
  } catch (e) {
    return err(res, e.message);
  }
});

app.patch("/api/notifications/:id/read", verifyUserToken, async (req, res) => {
  try {
    await sql`
      UPDATE notification_log SET is_read = TRUE, read_at = NOW()
      WHERE notif_id = ${req.params.id} AND user_id = ${req.user.user_id}`;
    return ok(res, {}, "Marked as read");
  } catch (e) {
    return err(res, e.message);
  }
});

app.patch("/api/notifications/read-all", verifyUserToken, async (req, res) => {
  try {
    await sql`
      UPDATE notification_log SET is_read = TRUE, read_at = NOW()
      WHERE user_id = ${req.user.user_id} AND is_read = FALSE`;
    return ok(res, {}, "All notifications marked as read");
  } catch (e) {
    return err(res, e.message);
  }
});

/* ==========================
   ─────────────────────────
   BUYBACK  (JWT required)
   POST /api/buyback/apply
   GET  /api/buyback/status
   ─────────────────────────
========================== */

app.get("/api/buyback/terms", async (req, res) => {
  try {
    return ok(res, await getBuybackTermsRow(), "Buyback terms fetched.");
  } catch (e) {
    console.error("[Buyback Terms Load Error]", e);
    return err(res, "Failed to load Buyback Terms & Conditions.");
  }
});

app.get("/api/admin/buyback/terms", verifyAdminToken, async (req, res) => {
  try {
    return ok(res, await getBuybackTermsRow(), "Buyback terms fetched.");
  } catch (e) {
    console.error("[Admin Buyback Terms Load Error]", e);
    return err(res, "Failed to load Buyback Terms & Conditions.");
  }
});

app.put("/api/admin/buyback/terms", verifyAdminToken, async (req, res) => {
  try {
    const title = String(req.body?.title || "").trim();
    const summary = String(req.body?.summary || "").trim();
    const content = String(req.body?.content || "").trim();

    if (!title) return err(res, "Title is required.", 400);
    if (!content) return err(res, "Terms & Conditions content is required.", 400);
    if (title.length > 200) return err(res, "Title must be 200 characters or fewer.", 400);
    if (summary.length > 1000) return err(res, "Summary must be 1000 characters or fewer.", 400);
    if (content.length > 50000) return err(res, "Terms content must be 50,000 characters or fewer.", 400);

    await ensureBuybackTermsSchema();
    const [current] = await sql`SELECT id FROM buyback_terms ORDER BY id LIMIT 1`;
    const [updated] = await sql`
      UPDATE buyback_terms
      SET title = ${title},
          summary = ${summary || null},
          content = ${content},
          updated_by_admin_id = ${req.admin?.admin_id || null},
          updated_at = NOW()
      WHERE id = ${current.id}
      RETURNING id, title, summary, content, created_at, updated_at`;

    return ok(res, updated, "Buyback Terms & Conditions updated successfully.");
  } catch (e) {
    console.error("[Admin Buyback Terms Update Error]", e);
    return err(res, "Failed to update Buyback Terms & Conditions.");
  }
});

app.post("/api/buyback/apply", verifyUserToken, async (req, res) => {
  try {
    const { booking_id } = req.body;
    if (!booking_id) return err(res, "booking_id required", 400);

    const [booking] = await sql`
      SELECT b.booking_id, b.plot_id, b.booking_date, b.booking_status,
             p.base_price
      FROM bookings b JOIN plots p ON b.plot_id = p.plot_id
      WHERE b.booking_id = ${booking_id} AND b.user_id = ${req.user.user_id}
        AND b.booking_status = 'Confirmed'`;

    if (!booking) return err(res, "Valid confirmed booking not found", 404);

    // Check 2-year window
    const purchaseDate   = new Date(booking.booking_date);
    const twoYearCutoff  = new Date(purchaseDate);
    twoYearCutoff.setFullYear(twoYearCutoff.getFullYear() + 2);
    const eligible = new Date() <= twoYearCutoff;

    const [app_] = await sql`
      INSERT INTO buyback_applications
        (booking_id, user_id, plot_id, original_price, eligibility_check, purchase_date)
      VALUES (${booking.booking_id}, ${req.user.user_id}, ${booking.plot_id},
              ${booking.base_price}, ${eligible}, ${purchaseDate.toISOString().split("T")[0]})
      RETURNING buyback_id, buyback_amount, eligibility_check`;

    await sql`
      UPDATE bookings SET booking_status = 'BuybackApplied', updated_at = NOW()
      WHERE booking_id = ${booking_id}`;
    await addPlotBookingHistory({
      plotId: booking.plot_id,
      bookingId: booking.booking_id,
      userId: req.user.user_id,
      eventType: "BuybackApplied",
      eventNote: "Buyback applied by user",
      triggeredByUser: req.user.user_id,
      plotStatusAtTime: "Booked",
    });

    return ok(res, {
      buyback_id:        app_.buyback_id,
      buyback_amount:    app_.buyback_amount,
      eligible:          app_.eligibility_check,
    }, eligible
      ? "Buyback applied. Admin will process your request."
      : "Applied but 2-year window may have passed. Admin will verify.", 201);
  } catch (e) {
    return err(res, e.message);
  }
});

app.get("/api/buyback/status", verifyUserToken, async (req, res) => {
  try {
    const apps = await sql`
      SELECT ba.*, p.plot_number, s.site_name
      FROM buyback_applications ba
      JOIN plots p ON ba.plot_id = p.plot_id
      JOIN sites s ON p.site_id  = s.site_id
      WHERE ba.user_id = ${req.user.user_id}
      ORDER BY ba.applied_at DESC`;
    return ok(res, apps);
  } catch (e) {
    return err(res, e.message);
  }
});

/* ==========================
   ─────────────────────────
   ADMIN — USER MANAGEMENT
   GET  /api/admin/users/pending
   GET  /api/admin/users
   GET  /api/admin/users/:id
   POST /api/admin/users/:id/approve
   POST /api/admin/users/:id/reject
   POST /api/admin/users/:id/request-info
   POST /api/admin/users/:id/blacklist
   ─────────────────────────
========================== */

const adminUserSortMap = {
  name: "u.full_name",
  full_name: "u.full_name",
  email: "u.email",
  mobile_no: "u.mobile_no",
  status: "u.account_status",
  account_status: "u.account_status",
  date: "u.registered_at",
  registered_at: "u.registered_at",
  created_at: "u.registered_at",
  updated_at: "u.updated_at",
  user_type: "u.user_type",
  member_id: "u.member_id",
};

const adminUsersResponse = (res, rows, totalRecords, page, pageSize) => {
  const totalPages = Math.max(1, Math.ceil(totalRecords / pageSize));
  return res.json({
    success: true,
    data: rows,
    users: rows,
    total: totalRecords,
    totalRecords,
    currentPage: page,
    page,
    pageSize,
    limit: pageSize,
    totalPages,
  });
};

const getAdminUsersPage = async (query, defaults = {}) => {
  const page = Math.max(1, Number(query.page || defaults.page || 1));
  const pageSize = Math.min(100, Math.max(1, Number(query.pageSize || query.limit || defaults.pageSize || 20)));
  const offset = (page - 1) * pageSize;
  const sortBy = adminUserSortMap[query.sortBy || query.sort_by || defaults.sortBy || "registered_at"] || "u.registered_at";
  const sortDir = String(query.sortDir || query.sort_dir || defaults.sortDir || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
  const where = [];
  const params = [];

  const add = (condition, value) => {
    params.push(value);
    where.push(condition.replace("?", `$${params.length}`));
  };

  if (defaults.statuses?.length) {
    params.push(defaults.statuses);
    where.push(`u.account_status::text = ANY($${params.length})`);
  }

  if (query.status) add("u.account_status::text = ?", query.status);
  if (query.user_type) add("LOWER(u.user_type::text) = LOWER(?)", query.user_type);
  if (query.verification_status) add("COALESCE(u.email_verified, u.is_otp_verified, FALSE) = ?", query.verification_status === "verified");
  if (query.date_from) add("u.registered_at::date >= ?::date", query.date_from);
  if (query.date_to) add("u.registered_at::date <= ?::date", query.date_to);
  if (defaults.activeOnly) where.push("COALESCE(u.is_active, TRUE) = TRUE");

  if (query.search) {
    params.push(`%${String(query.search).trim()}%`);
    const idx = `$${params.length}`;
    where.push(`(
      u.full_name ILIKE ${idx}
      OR u.email ILIKE ${idx}
      OR u.mobile_no ILIKE ${idx}
      OR u.member_id ILIKE ${idx}
      OR u.invitation_code ILIKE ${idx}
      OR CAST(u.user_id AS TEXT) ILIKE ${idx}
    )`);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = await sql.unsafe(`
    SELECT u.user_id, u.member_id, u.user_type, u.full_name, u.mobile_no,
           u.email, u.account_status, u.registered_at, u.updated_at,
           pa.address_line1 AS address, pa.city, pa.state, pa.pin_code,
           u.invitation_code, sp.full_name AS sponsor_name,
           COALESCE(doc.doc_count, 0)::int AS doc_count
    FROM users u
    LEFT JOIN users sp ON u.sponsor_user_id = sp.user_id
    LEFT JOIN user_addresses pa ON pa.user_id = u.user_id AND pa.address_type = 'Permanent'
    LEFT JOIN (
      SELECT user_id, COUNT(*) AS doc_count
      FROM user_documents
      WHERE is_active = TRUE
      GROUP BY user_id
    ) doc ON doc.user_id = u.user_id
    ${whereSql}
    ORDER BY ${sortBy} ${sortDir}, u.user_id DESC
    LIMIT $${params.length + 1} OFFSET $${params.length + 2}
  `, [...params, pageSize, offset]);

  const [total] = await sql.unsafe(`
    SELECT COUNT(*)::int AS count
    FROM users u
    ${whereSql}
  `, params);

  return { rows, totalRecords: Number(total?.count || 0), page, pageSize };
};

const adminInquiriesResponse = (res, rows, totalRecords, page, pageSize, counts = []) => {
  const totalPages = Math.max(1, Math.ceil(totalRecords / pageSize));
  const statusCounts = inquiryStatuses.reduce((acc, status) => {
    acc[status] = 0;
    return acc;
  }, {});
  counts.forEach((row) => { statusCounts[row.status] = Number(row.count || 0); });
  return res.json({
    success: true,
    data: rows,
    inquiries: rows,
    total: totalRecords,
    totalRecords,
    currentPage: page,
    page,
    pageSize,
    limit: pageSize,
    totalPages,
    counts: statusCounts,
  });
};

const getAdminInquiriesPage = async (query) => {
  await ensureInquirySchema();
  const page = Math.max(1, Number(query.page || 1));
  const pageSize = Math.min(100, Math.max(1, Number(query.pageSize || query.limit || 20)));
  const offset = (page - 1) * pageSize;
  const sortMap = {
    created_at: "created_at",
    full_name: "full_name",
    mobile_no: "mobile_no",
    email: "email",
    status: "status",
    inquiry_type: "inquiry_type",
    site_name: "site_name",
  };
  const sortBy = sortMap[query.sortBy || query.sort_by || "created_at"] || "created_at";
  const sortDir = String(query.sortDir || query.sort_dir || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
  const where = [];
  const params = [];
  const add = (condition, value) => {
    params.push(value);
    where.push(condition.replace("?", `$${params.length}`));
  };

  if (query.status && query.status !== "all") add("status = ?", query.status);
  if (query.inquiry_type) add("inquiry_type = ?", query.inquiry_type);
  if (query.date_from) add("created_at::date >= ?::date", query.date_from);
  if (query.date_to) add("created_at::date <= ?::date", query.date_to);
  if (query.search) {
    params.push(`%${String(query.search).trim()}%`);
    const idx = `$${params.length}`;
    where.push(`(
      full_name ILIKE ${idx}
      OR mobile_no ILIKE ${idx}
      OR COALESCE(email, '') ILIKE ${idx}
      OR COALESCE(site_name, '') ILIKE ${idx}
      OR COALESCE(plot_number, '') ILIKE ${idx}
      OR COALESCE(inquiry_message, '') ILIKE ${idx}
      OR COALESCE(inquiry_type, '') ILIKE ${idx}
      OR CAST(inquiry_id AS TEXT) ILIKE ${idx}
    )`);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = await sql.unsafe(`
    SELECT inquiry_id, full_name, mobile_no, email, site_name, plot_number,
           inquiry_message, inquiry_type, source_page, status, remarks,
           created_at, updated_at
    FROM inquiries
    ${whereSql}
    ORDER BY ${sortBy} ${sortDir}, inquiry_id DESC
    LIMIT $${params.length + 1} OFFSET $${params.length + 2}
  `, [...params, pageSize, offset]);

  const [total] = await sql.unsafe(`SELECT COUNT(*)::int AS count FROM inquiries ${whereSql}`, params);
  const counts = await sql`SELECT status, COUNT(*)::int AS count FROM inquiries GROUP BY status`;
  return { rows, totalRecords: Number(total?.count || 0), page, pageSize, counts };
};

const captchaSecret = () => process.env.CAPTCHA_SECRET || process.env.JWT_SECRET || "local-captcha-secret";
const captchaMaxAgeMs = 5 * 60 * 1000;

function signCaptcha(payload) {
  return crypto.createHmac("sha256", captchaSecret()).update(payload).digest("hex");
}

function createCaptchaChallenge() {
  const left = crypto.randomInt(2, 10);
  const right = crypto.randomInt(1, 9);
  const answer = String(left + right);
  const issuedAt = Date.now();
  const nonce = crypto.randomBytes(12).toString("hex");
  const payload = `${nonce}.${issuedAt}.${answer}`;
  return {
    question: `${left} + ${right}`,
    token: `${nonce}.${issuedAt}.${signCaptcha(payload)}`,
  };
}

function verifyCaptchaChallenge(token, answer) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return false;

  const [nonce, issuedAtRaw, signature] = parts;
  const issuedAt = Number(issuedAtRaw);
  const submittedAnswer = String(answer || "").trim();
  if (!nonce || !Number.isFinite(issuedAt) || !submittedAnswer) return false;
  if (Date.now() - issuedAt > captchaMaxAgeMs || issuedAt > Date.now() + 30_000) return false;

  for (let expected = 3; expected <= 18; expected++) {
    if (submittedAnswer !== String(expected)) continue;
    const payload = `${nonce}.${issuedAt}.${expected}`;
    const expectedSignature = signCaptcha(payload);
    const actualBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expectedSignature);
    if (actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer)) {
      return true;
    }
  }

  return false;
}

app.get("/api/captcha/enquiry", (req, res) => {
  return ok(res, createCaptchaChallenge(), "Captcha generated");
});

app.post("/api/inquiries", async (req, res) => {
  try {
    await ensureInquirySchema();
    const body = req.body || {};
    const fullName = String(body.full_name || body.name || "").trim();
    const mobileNo = String(body.mobile_no || body.mobile || "").replace(/\D/g, "").slice(0, 15);
    const email = String(body.email || "").trim().toLowerCase() || null;
    const siteName = String(body.site_name || body.property_name || body.interest || "").trim() || null;
    const siteId = body.site_id ? Number(body.site_id) : null;
    const plotNumber = String(body.plot_number || "").trim() || null;
    const message = String(body.inquiry_message || body.message || "").trim() || null;
    const inquiryType = String(body.inquiry_type || body.interest || "General Enquiry").trim() || "General Enquiry";
    const sourcePage = String(body.source_page || "Website").trim() || "Website";
    const captchaToken = body.captcha_token;
    const captchaAnswer = body.captcha_answer;

    if (!fullName) return err(res, "Full name is required", 400);
    if (!mobileNo) return err(res, "Mobile number is required", 400);
    if (!/^[6-9]\d{9}$/.test(mobileNo)) return err(res, "Valid Indian mobile number is required", 400);
    if (!verifyCaptchaChallenge(captchaToken, captchaAnswer)) return err(res, "Captcha verification failed. Please try again.", 400);
    if (siteId) {
      const [site] = await sql`SELECT site_id FROM sites WHERE site_id=${siteId} AND is_active=TRUE`;
      if (!site) return err(res, "Selected site is not active", 400);
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return err(res, "Valid email is required", 400);

    const [created] = await sql`
      INSERT INTO inquiries (
        full_name, mobile_no, email, site_id, site_name, plot_number,
        inquiry_message, inquiry_type, source_page, status
      )
      VALUES (
        ${fullName}, ${mobileNo}, ${email}, ${siteId}, ${siteName}, ${plotNumber},
        ${message}, ${inquiryType}, ${sourcePage}, 'New'
      )
      RETURNING inquiry_id, full_name, mobile_no, email, site_name, plot_number,
                inquiry_message, inquiry_type, source_page, status, remarks,
                created_at, updated_at`;

    return ok(res, created, "Inquiry submitted successfully", 201);
  } catch (e) {
    console.error("[Inquiry Submit Error]", e);
    return err(res, e.message);
  }
});

app.get("/api/admin/inquiries",
  verifyAdminToken,
  role("SuperAdmin","SupportStaff","SiteManager"),
  async (req, res) => {
    try {
      const result = await getAdminInquiriesPage(req.query);
      console.log("[Admin Inquiry Fetch Response]", { total: result.totalRecords, page: result.page });
      return adminInquiriesResponse(res, result.rows, result.totalRecords, result.page, result.pageSize, result.counts);
    } catch (e) {
      console.error("[Admin Inquiry Fetch Error]", e);
      return err(res, e.message);
    }
  }
);

app.get("/api/admin/inquiries/:id",
  verifyAdminToken,
  role("SuperAdmin","SupportStaff","SiteManager"),
  async (req, res) => {
    try {
      await ensureInquirySchema();
      const [inquiry] = await sql`
        SELECT inquiry_id, full_name, mobile_no, email, site_name, plot_number,
               inquiry_message, inquiry_type, source_page, status, remarks,
               created_at, updated_at
        FROM inquiries
        WHERE inquiry_id = ${req.params.id}`;
      if (!inquiry) return err(res, "Inquiry not found", 404);
      return ok(res, inquiry);
    } catch (e) {
      console.error("[Admin Inquiry Detail Error]", e);
      return err(res, e.message);
    }
  }
);

app.put("/api/admin/inquiries/:id",
  verifyAdminToken,
  role("SuperAdmin","SupportStaff","SiteManager"),
  async (req, res) => {
    try {
      await ensureInquirySchema();
      const status = String(req.body.status || "").trim();
      const remarks = req.body.remarks == null ? null : String(req.body.remarks).trim();
      if (status && !inquiryStatuses.includes(status)) return err(res, "Invalid inquiry status", 400);

      const [updated] = await sql`
        UPDATE inquiries SET
          status = COALESCE(${status || null}, status),
          remarks = COALESCE(${remarks}, remarks),
          updated_at = NOW()
        WHERE inquiry_id = ${req.params.id}
        RETURNING inquiry_id, full_name, mobile_no, email, site_name, plot_number,
                  inquiry_message, inquiry_type, source_page, status, remarks,
                  created_at, updated_at`;
      if (!updated) return err(res, "Inquiry not found", 404);
      console.log("[Admin Inquiry Update]", updated);
      return ok(res, updated, "Inquiry updated successfully");
    } catch (e) {
      console.error("[Admin Inquiry Update Error]", e);
      return err(res, e.message);
    }
  }
);

app.delete("/api/admin/inquiries/:id",
  verifyAdminToken,
  role("SuperAdmin"),
  async (req, res) => {
    try {
      await ensureInquirySchema();
      const [deleted] = await sql`
        DELETE FROM inquiries
        WHERE inquiry_id = ${req.params.id}
        RETURNING inquiry_id`;
      if (!deleted) return err(res, "Inquiry not found", 404);
      console.log("[Admin Inquiry Delete]", deleted);
      return ok(res, deleted, "Inquiry deleted successfully");
    } catch (e) {
      console.error("[Admin Inquiry Delete Error]", e);
      return err(res, e.message);
    }
  }
);

app.get("/api/admin/users/pending",
  verifyAdminToken,
  role("SuperAdmin","SupportStaff"),
  async (req, res) => {
    try {
      const result = await getAdminUsersPage(req.query, {
        statuses: ["Pending", "InfoRequested", "InfoSubmitted"],
        sortBy: "registered_at",
        sortDir: "asc",
      });
      return adminUsersResponse(res, result.rows, result.totalRecords, result.page, result.pageSize);
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.get("/api/admin/users",
  verifyAdminToken,
  role("SuperAdmin","SupportStaff"),
  async (req, res) => {
    try {
      const result = await getAdminUsersPage(req.query);
      return adminUsersResponse(res, result.rows, result.totalRecords, result.page, result.pageSize);
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.get("/api/admin/customers",
  verifyAdminToken,
  role("SuperAdmin","SupportStaff"),
  async (req, res) => {
    try {
      const result = await getAdminUsersPage(
        { ...req.query, user_type: "Customer" },
        { sortBy: "registered_at", sortDir: "desc", activeOnly: true },
      );
      return adminUsersResponse(res, result.rows, result.totalRecords, result.page, result.pageSize);
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.post("/api/admin/customers",
  verifyAdminToken,
  role("SuperAdmin","SupportStaff"),
  async (req, res) => {
    try {
      const fullName = String(req.body.full_name || "").trim();
      const email = String(req.body.email || "").toLowerCase().trim();
      const mobileNo = String(req.body.mobile_no || req.body.phone || "").replace(/\D/g, "");
      const password = String(req.body.password || "");
      const confirmPassword = String(req.body.confirm_password || "");
      const accountStatus = "Pending";
      const address = String(req.body.address || "").trim();
      const city = String(req.body.city || "").trim();
      const state = String(req.body.state || "").trim();
      const pinCode = String(req.body.pin_code || req.body.pincode || "").trim();

      if (!fullName) return err(res, "Name is required", 400);
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return err(res, "Valid email is required", 400);
      if (!mobileNo) return err(res, "Phone number is required", 400);
      if (!password) return err(res, "Password is required", 400);
      if (password.length < 6) return err(res, "Password must be at least 6 characters", 400);
      if (password !== confirmPassword) return err(res, "Confirm password must match password", 400);
      if (!["Active", "Pending", "Suspended", "Blacklisted"].includes(accountStatus)) {
        return err(res, "Invalid status", 400);
      }

      const cleanMobile10 = String(mobileNo).replace(/\D/g, "").slice(-10);

      const [dupEmail] = await sql`SELECT user_id FROM users WHERE LOWER(email) = ${email}`;
      const [dupInvestorEmail] = await sql`SELECT id FROM investor_users WHERE LOWER(email) = ${email} AND deleted_at IS NULL LIMIT 1`;
      if (dupEmail || dupInvestorEmail) return err(res, "Email already exists in another Customer, Associate, or Investor account", 409);

      const [dupMobile] = await sql`SELECT user_id FROM users WHERE RIGHT(regexp_replace(mobile_no, '\\D', '', 'g'), 10) = ${cleanMobile10}`;
      const [dupInvestorMobile] = await sql`SELECT id FROM investor_users WHERE RIGHT(regexp_replace(mobile_number, '\\D', '', 'g'), 10) = ${cleanMobile10} AND deleted_at IS NULL LIMIT 1`;
      if (dupMobile || dupInvestorMobile) return err(res, "Phone number already exists in another Customer, Associate, or Investor account", 409);

      const passwordHash = await bcrypt.hash(password, 12);
      const memberId = await genMemberID("Customer");

      const [customer] = await sql`
        INSERT INTO users (
          user_type, full_name, email, mobile_no, password_hash,
          member_id, account_status, is_otp_verified, email_verified,
          email_verified_at, is_active, is_verified, approved_by_admin_id, approved_at
        )
        VALUES (
          'Customer', ${fullName}, ${email}, ${mobileNo}, ${passwordHash},
          ${memberId}, ${accountStatus}, FALSE, FALSE,
          NULL, TRUE, FALSE, NULL, NULL
        )
        RETURNING user_id, member_id, user_type, full_name, email, mobile_no,
                  account_status, registered_at, updated_at`;

      if (address || city || state || pinCode) {
        await sql`
          INSERT INTO user_addresses (user_id, address_type, address_line1, city, state, pin_code)
          VALUES (${customer.user_id}, 'Permanent', ${address || null}, ${city || null}, ${state || null}, ${pinCode || null})`;
      }

      const verificationOtp = genOTP();
      await sql`
        INSERT INTO otp_log (user_type, reference_id, mobile, otp_code, purpose, expires_at)
        VALUES ('User', ${customer.user_id}, ${email}, ${verificationOtp}, 'EmailVerification', NOW() + INTERVAL '10 minutes')`;
      await sendEmail(email, "Verify your MMR customer account", otpEmailHtml(verificationOtp, "Email Verification"));

      await sql`
        INSERT INTO audit_log (actor_type, actor_id, actor_name, module, action, target_table, target_record_id, new_value)
        VALUES ('Admin', ${req.admin.admin_id}, ${req.admin.full_name},
                'CustomerManagement', 'Created', 'users', ${customer.user_id},
                ${JSON.stringify({ email, mobile_no: mobileNo, member_id: memberId, status: accountStatus })})`;

      return ok(res, customer, "Customer created. Verification email sent.", 201);
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.put("/api/admin/customers/:id",
  verifyAdminToken,
  role("SuperAdmin","SupportStaff"),
  async (req, res) => {
    try {
      const uid = req.params.id;
      const fullName = String(req.body.full_name || "").trim();
      const email = String(req.body.email || "").toLowerCase().trim();
      const mobileNo = String(req.body.mobile_no || req.body.phone || "").replace(/\D/g, "");
      const accountStatus = String(req.body.account_status || req.body.status || "").trim();
      const address = String(req.body.address || "").trim();
      const city = String(req.body.city || "").trim();
      const state = String(req.body.state || "").trim();
      const pinCode = String(req.body.pin_code || req.body.pincode || "").trim();

      if (!fullName) return err(res, "Name is required", 400);
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return err(res, "Valid email is required", 400);
      if (!mobileNo) return err(res, "Phone number is required", 400);
      if (!["Active", "Pending", "Suspended", "Blacklisted"].includes(accountStatus)) {
        return err(res, "Invalid status", 400);
      }

      const [existing] = await sql`
        SELECT user_id FROM users
        WHERE user_id = ${uid} AND LOWER(user_type::text) = 'customer'`;
      if (!existing) return err(res, "Customer not found", 404);

      const cleanMobile10 = String(mobileNo).replace(/\D/g, "").slice(-10);

      const [dupEmail] = await sql`SELECT user_id FROM users WHERE LOWER(email) = ${email} AND user_id <> ${uid}`;
      const [dupInvestorEmail] = await sql`SELECT id FROM investor_users WHERE LOWER(email) = ${email} AND deleted_at IS NULL LIMIT 1`;
      if (dupEmail || dupInvestorEmail) return err(res, "Email already exists in another Customer, Associate, or Investor account", 409);

      const [dupMobile] = await sql`SELECT user_id FROM users WHERE RIGHT(regexp_replace(mobile_no, '\\D', '', 'g'), 10) = ${cleanMobile10} AND user_id <> ${uid}`;
      const [dupInvestorMobile] = await sql`SELECT id FROM investor_users WHERE RIGHT(regexp_replace(mobile_number, '\\D', '', 'g'), 10) = ${cleanMobile10} AND deleted_at IS NULL LIMIT 1`;
      if (dupMobile || dupInvestorMobile) return err(res, "Phone number already exists in another Customer, Associate, or Investor account", 409);

      const [customer] = await sql`
        UPDATE users SET
          full_name = ${fullName},
          email = ${email},
          mobile_no = ${mobileNo},
          account_status = ${accountStatus},
          updated_at = NOW()
        WHERE user_id = ${uid} AND LOWER(user_type::text) = 'customer'
        RETURNING user_id, member_id, user_type, full_name, email, mobile_no,
                  account_status, registered_at, updated_at`;

      await sql`
        DELETE FROM user_addresses
        WHERE user_id = ${uid} AND address_type = 'Permanent'`;
      if (address || city || state || pinCode) {
        await sql`
          INSERT INTO user_addresses (user_id, address_type, address_line1, city, state, pin_code)
          VALUES (${uid}, 'Permanent', ${address || null}, ${city || null}, ${state || null}, ${pinCode || null})`;
      }

      await sql`
        INSERT INTO audit_log (actor_type, actor_id, actor_name, module, action, target_table, target_record_id, new_value)
        VALUES ('Admin', ${req.admin.admin_id}, ${req.admin.full_name},
                'CustomerManagement', 'Updated', 'users', ${uid},
                ${JSON.stringify({ email, mobile_no: mobileNo, status: accountStatus })})`;

      return ok(res, customer, "Customer updated successfully");
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.delete("/api/admin/customers/:id",
  verifyAdminToken,
  role("SuperAdmin"),
  async (req, res) => {
    try {
      const uid = req.params.id;
      const [customer] = await sql`
        UPDATE users SET account_status = 'Blacklisted', is_active = FALSE, updated_at = NOW()
        WHERE user_id = ${uid} AND LOWER(user_type::text) = 'customer'
        RETURNING user_id`;
      if (!customer) return err(res, "Customer not found", 404);

      await sql`
        INSERT INTO audit_log (actor_type, actor_id, actor_name, module, action, target_table, target_record_id)
        VALUES ('Admin', ${req.admin.admin_id}, ${req.admin.full_name},
                'CustomerManagement', 'Deleted', 'users', ${uid})`;

      return ok(res, {}, "Customer deleted successfully");
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.get("/api/admin/users/:id",
  verifyAdminToken,
  role("SuperAdmin","SupportStaff"),
  async (req, res) => {
    try {
      const uid = req.params.id;
      const [user] = await sql`SELECT * FROM users WHERE user_id = ${uid}`;
      if (!user) return err(res, "User not found", 404);

      const [address]  = await sql`SELECT * FROM user_addresses    WHERE user_id = ${uid} AND address_type = 'Permanent'`;
      const [bank]     = await sql`SELECT * FROM user_bank_details  WHERE user_id = ${uid}`;
      const [nominee]  = await sql`SELECT * FROM user_nominees      WHERE user_id = ${uid}`;
      const documents  = await sql`SELECT * FROM user_documents     WHERE user_id = ${uid} AND is_active = TRUE`;

      return ok(res, { ...user, address, bank, nominee, documents });
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.post("/api/admin/users/:id/approve",
  verifyAdminToken,
  role("SuperAdmin"),
  async (req, res) => {
    try {
      const uid   = req.params.id;
      const { verify_note } = req.body;
      const [user] = await sql`
        SELECT user_id, user_type, full_name, account_status, member_id, invitation_code
        FROM users
        WHERE user_id = ${uid}`;
      if (!user) return err(res, "User not found", 404);
      if (user.account_status === "Active") return err(res, "Already approved", 400);

      const memberId = user.member_id || await genMemberID(user.user_type);
      const invCode = user.user_type === "Associate"
        ? (user.invitation_code || memberId)
        : null;

      await sql`
        UPDATE users SET
          account_status = 'Active', member_id = ${memberId},
          invitation_code = ${user.user_type === "Associate" ? invCode : user.invitation_code},
          approved_by_admin_id = ${req.admin.admin_id}, approved_at = NOW(), updated_at = NOW()
        WHERE user_id = ${uid}`;

      // For associate: insert tracker + MLM node
      if (user.user_type === "Associate") {
        await sql`
          INSERT INTO associate_sales_tracker (associate_user_id)
          VALUES (${uid}) ON CONFLICT (associate_user_id) DO NOTHING`;

        const [sponsor] = await sql`SELECT sponsor_user_id FROM users WHERE user_id = ${uid}`;
        const sponsorId = sponsor?.sponsor_user_id || null;
        await sql`
          INSERT INTO mlm_network (associate_user_id, sponsor_user_id, level)
          VALUES (${uid}, ${sponsorId},
                  CASE WHEN ${sponsorId}::int IS NULL THEN 1
                       ELSE COALESCE((SELECT level FROM mlm_network WHERE associate_user_id = ${sponsorId}), 0) + 1
                  END) ON CONFLICT (associate_user_id) DO NOTHING`;
        await linkApprovedReferral(uid);
      }

      await sql`
        INSERT INTO audit_log (actor_type, actor_id, actor_name, module, action,
                               target_table, target_record_id, new_value)
        VALUES ('Admin', ${req.admin.admin_id}, ${req.admin.full_name},
                'UserApproval', 'Approved', 'users', ${uid},
                ${JSON.stringify({ member_id: memberId, note: verify_note || "" })})`;

      return ok(res, { member_id: memberId, invitation_code: invCode },
        `User approved. Member ID: ${memberId}`);
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.post("/api/admin/users/:id/reject",
  verifyAdminToken,
  role("SuperAdmin"),
  async (req, res) => {
    try {
      const uid = req.params.id;
      const { rejection_reason, rejection_custom } = req.body;
      if (!rejection_reason) return err(res, "rejection_reason required", 400);

      await sql`
        UPDATE users SET account_status = 'Rejected',
          rejection_reason = ${rejection_reason},
          rejection_custom = ${rejection_custom || null},
          updated_at = NOW()
        WHERE user_id = ${uid}`;

      await sql`
        INSERT INTO audit_log (actor_type, actor_id, actor_name, module, action,
                               target_table, target_record_id, new_value)
        VALUES ('Admin', ${req.admin.admin_id}, ${req.admin.full_name},
                'UserApproval', 'Rejected', 'users', ${uid},
                ${JSON.stringify({ reason: rejection_reason, custom: rejection_custom })})`;

      return ok(res, {}, "User rejected");
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.post("/api/admin/users/:id/request-info",
  verifyAdminToken,
  role("SuperAdmin"),
  async (req, res) => {
    try {
      const { message } = req.body;
      if (!message) return err(res, "message required", 400);
      await sql`
        UPDATE users SET account_status = 'InfoRequested',
          info_request_note = ${message}, updated_at = NOW()
        WHERE user_id = ${req.params.id}`;
      return ok(res, {}, "Info requested from user");
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.post("/api/admin/users/:id/blacklist",
  verifyAdminToken,
  role("SuperAdmin"),
  async (req, res) => {
    try {
      const { reason } = req.body;
      if (!reason) return err(res, "reason required", 400);
      await sql`UPDATE users SET account_status = 'Blacklisted', updated_at = NOW() WHERE user_id = ${req.params.id}`;
      await sql`
        INSERT INTO blacklist_registry (user_id, blacklisted_by_admin_id, blacklist_reason)
        VALUES (${req.params.id}, ${req.admin.admin_id}, ${reason})`;
      return ok(res, {}, "User blacklisted");
    } catch (e) {
      return err(res, e.message);
    }
  }
);

/* ==========================
   ─────────────────────────
   ADMIN — BOOKING & EMI
   GET  /api/admin/bookings
   POST /api/admin/bookings/:id/confirm
   POST /api/admin/bookings/:id/cancel
   GET  /api/admin/emi/overdue
   POST /api/admin/emi/:id/confirm
   ─────────────────────────
========================== */

app.get("/api/admin/bookings",
  verifyAdminToken,
  role("SuperAdmin","SiteManager","FinanceManager"),
  async (req, res) => {
    try {
      const { status, site_id, payment_status, from_date, to_date, search, page = 1, limit = 20 } = req.query;
      const safeLimit = Math.min(Number(limit) || 20, 100);
      const offset = ((Number(page) || 1) - 1) * safeLimit;
      const statusFilter = status ? String(status) : null;
      const siteIdFilter = site_id ? Number(site_id) : null;
      const paymentStatusFilter = payment_status ? String(payment_status) : null;
      const fromDateFilter = from_date ? String(from_date) : null;
      const toDateFilter = to_date ? String(to_date) : null;
      const searchFilter = search ? String(search) : null;

      const conds = [];
      if (statusFilter) conds.push(sql`b.booking_status = ${statusFilter}`);
      if (siteIdFilter) conds.push(sql`s.site_id = ${siteIdFilter}`);
      if (fromDateFilter) conds.push(sql`b.booking_date::date >= ${fromDateFilter}::date`);
      if (toDateFilter) conds.push(sql`b.booking_date::date <= ${toDateFilter}::date`);
      if (paymentStatusFilter) {
        conds.push(sql`(
          CASE
            WHEN b.booking_status = 'Confirmed' THEN 'Paid'
            WHEN b.advance_amount > 0 THEN 'Partial'
            ELSE 'Unpaid'
          END
        ) = ${paymentStatusFilter}`);
      }
      if (searchFilter) {
        const q = `%${searchFilter}%`;
        conds.push(sql`(
          b.booking_serial ILIKE ${q} OR
          u.full_name ILIKE ${q} OR
          u.mobile_no ILIKE ${q}
        )`);
      }

      let whereSql = sql`TRUE`;
      if (conds.length > 0) {
        whereSql = conds.reduce((acc, curr) => sql`${acc} AND ${curr}`);
      }

      const bookings = await sql`
        SELECT b.booking_id, b.booking_serial, b.booking_date, b.booking_status,
               b.advance_amount, b.payment_type, b.payment_method, b.workflow_status,
               b.required_booking_amount, b.remaining_balance,
               CASE
                 WHEN b.booking_status = 'Confirmed' THEN 'Paid'
                 WHEN b.advance_amount > 0 THEN 'Partial'
                 ELSE 'Unpaid'
               END AS payment_status,
               u.full_name AS customer_name, u.member_id, u.mobile_no,
               p.plot_number, p.plot_area, s.site_name, s.city,
               ap.appointment_date, ap.start_time, ap.end_time, ap.status AS appointment_status,
               proof.file_path AS proof_url
        FROM bookings b
        JOIN users u  ON b.user_id  = u.user_id
        JOIN plots p  ON b.plot_id  = p.plot_id
        JOIN sites s  ON p.site_id  = s.site_id
        LEFT JOIN LATERAL (
          SELECT file_path
          FROM booking_payment_proofs
          WHERE booking_id = b.booking_id
          LIMIT 1
        ) proof ON TRUE
        LEFT JOIN booking_appointments ap ON ap.booking_id = b.booking_id
        WHERE ${whereSql}
        ORDER BY b.created_at DESC
        LIMIT ${safeLimit} OFFSET ${offset}`;

      return ok(res, bookings);
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.get("/api/admin/bookings/:id",
  verifyAdminToken,
  role("SuperAdmin","SiteManager","FinanceManager"),
  async (req, res) => {
    try {
      const [booking] = await sql`
        SELECT b.*,
               json_build_object(
                 'id', u.user_id,
                 'full_name', u.full_name,
                 'member_id', u.member_id,
                 'mobile_no', u.mobile_no,
                 'email', u.email,
                 'user_type', u.user_type
               ) AS customer,
               json_build_object(
                 'id', p.plot_id,
                 'plot_number', p.plot_number,
                 'plot_area', p.plot_area,
                 'plot_category', p.plot_category,
                 'base_price', p.base_price,
                 'down_payment', p.down_payment,
                 'monthly_emi', p.monthly_emi,
                 'emi_tenure_months', p.emi_tenure_months,
                 'file_charge', p.file_charge,
                 'plot_status', p.plot_status,
                 'site_name', s.site_name
               ) AS plot,
               json_build_object(
                 'id', s.site_id,
                 'site_name', s.site_name,
                 'city', s.city,
                 'address', s.full_address
               ) AS site
        FROM bookings b
        JOIN users u ON u.user_id = b.user_id
        JOIN plots p ON p.plot_id = b.plot_id
        JOIN sites s ON s.site_id = p.site_id
        WHERE b.booking_id = ${req.params.id}`;
      if (!booking) return err(res, "Booking not found", 404);

      const payment_proofs = await sql`
        SELECT *
        FROM booking_payment_proofs
        WHERE booking_id = ${req.params.id}`;
      const emi_schedule = await sql`
        SELECT emi_id, installment_no, due_date, emi_amount, late_fee_amount,
               total_due, paid_amount, paid_date, emi_status
        FROM emi_schedules
        WHERE booking_id = ${req.params.id}
        ORDER BY installment_no`;
      const history = await sql`
        SELECT event_type, event_note, plot_status_at_time, created_at
        FROM plot_booking_history
        WHERE booking_id = ${req.params.id}
        ORDER BY created_at DESC`;
      const [appointment] = await sql`
        SELECT * FROM booking_appointments WHERE booking_id = ${req.params.id}`;
      const payments = await sql`
        SELECT * FROM booking_payment_records WHERE booking_id = ${req.params.id} ORDER BY created_at DESC`;

      return ok(res, { ...booking, payment_proofs, emi_schedule, history, appointment, payments });
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.post("/api/admin/bookings/:id/confirm",
  verifyAdminToken,
  role("SuperAdmin","SiteManager","FinanceManager"),
  async (req, res) => {
    try {
      const bid = req.params.id;
      const { notes } = req.body || {};
      const [booking] = await sql`SELECT * FROM bookings WHERE booking_id = ${bid}`;
      if (!booking) return err(res, "Booking not found", 404);
      if (booking.booking_status === "Confirmed")
        return err(res, "Already confirmed", 400);

      const [plot] = await sql`SELECT base_price, monthly_emi, emi_tenure_months FROM plots WHERE plot_id = ${booking.plot_id}`;
      if (booking.payment_type === "EMI") {
        const start  = new Date(); start.setMonth(start.getMonth() + 1);
        for (let i = 1; i <= Number(plot.emi_tenure_months || 60); i++) {
          const due = new Date(start);
          due.setMonth(due.getMonth() + (i - 1));
          await sql`
            INSERT INTO emi_schedules (booking_id, user_id, installment_no, due_date, emi_amount)
            VALUES (${bid}, ${booking.user_id}, ${i}, ${due.toISOString().split("T")[0]}, ${plot.monthly_emi || 0})
            ON CONFLICT (booking_id, installment_no) DO NOTHING`;
        }
      }

      await sql`
        UPDATE bookings SET booking_status = 'Confirmed',
          confirmed_by_admin_id = ${req.admin.admin_id}, confirmed_at = NOW(), updated_at = NOW()
        WHERE booking_id = ${bid}`;

      await sql`UPDATE plots SET plot_status = 'Booked', updated_at = NOW() WHERE plot_id = ${booking.plot_id}`;

      await sql`
        INSERT INTO plot_status_history (plot_id, old_status, new_status, changed_by_admin_id, reason)
        VALUES (${booking.plot_id}, 'InProcess', 'Booked', ${req.admin.admin_id}, 'Booking Confirmed')`;

      await sql`
        INSERT INTO audit_log (actor_type, actor_id, actor_name, module, action, target_table, target_record_id)
        VALUES ('Admin', ${req.admin.admin_id}, ${req.admin.full_name},
                'BookingManagement', 'BookingConfirmed', 'bookings', ${bid})`;
      await addPlotBookingHistory({
        plotId: booking.plot_id,
        bookingId: bid,
        userId: booking.user_id,
        eventType: "BookingConfirmed",
        eventNote: notes || "Payment verified by admin",
        triggeredByAdmin: req.admin.admin_id,
        plotStatusAtTime: "Booked",
      });
      await addUserNotification({
        userId: booking.user_id,
        adminId: req.admin.admin_id,
        title: "Booking confirmed",
        message: "Badhaai! Aapki booking confirm ho gayi.",
      });
      const commissionResult = await generateCommissionForPayment(req, {
        bookingId: bid,
        sourceType: booking.payment_type === "FullPayment" ? "FullPayment" : "InitialPayment",
        sourceId: `booking-${bid}`,
        receivedAmount: booking.payment_type === "FullPayment" ? plot.base_price : booking.advance_amount,
        paymentType: booking.payment_type,
      });
      await logAdminAudit(req, "MLM", "GenerateCommissionOnBookingConfirm", "bookings", bid, sql.json(commissionResult));

      return ok(res, {}, booking.payment_type === "EMI"
        ? `Booking confirmed. ${plot.emi_tenure_months} EMIs generated.`
        : "Booking confirmed.");
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.post("/api/admin/bookings/:id/cancel",
  verifyAdminToken,
  role("SuperAdmin","SiteManager","FinanceManager"),
  async (req, res) => {
    try {
      const reason = req.body?.reason || req.body?.cancellation_reason;
      if (!reason) return err(res, "reason required", 400);

      const [booking] = await sql`SELECT plot_id, user_id FROM bookings WHERE booking_id = ${req.params.id}`;
      if (!booking) return err(res, "Booking not found", 404);

      await sql`
        UPDATE bookings SET booking_status = 'Cancelled',
          cancellation_reason = ${reason}, cancelled_by_admin_id = ${req.admin.admin_id},
          cancelled_at = NOW(), updated_at = NOW()
        WHERE booking_id = ${req.params.id}`;

      await sql`UPDATE plots SET plot_status = 'Vacant', updated_at = NOW() WHERE plot_id = ${booking.plot_id}`;
      await addPlotBookingHistory({
        plotId: booking.plot_id,
        bookingId: req.params.id,
        userId: booking.user_id,
        eventType: "BookingCancelled",
        eventNote: reason,
        triggeredByAdmin: req.admin.admin_id,
        plotStatusAtTime: "Vacant",
      });
      await logAdminAudit(req, "BookingManagement", "BookingCancelled", "bookings", req.params.id, sql.json({ reason }));
      await addUserNotification({
        userId: booking.user_id,
        adminId: req.admin.admin_id,
        title: "Booking cancelled",
        message: `Aapki booking cancel ho gayi. Reason: ${reason}`,
      });

      return ok(res, {}, "Booking cancelled. Plot set to Vacant.");
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.patch("/api/admin/bookings/:id/confirm",
  verifyAdminToken,
  role("SuperAdmin","SiteManager","FinanceManager"),
  async (req, res) => {
    try {
      const bid = req.params.id;
      const { notes } = req.body || {};
      const [booking] = await sql`SELECT * FROM bookings WHERE booking_id = ${bid}`;
      if (!booking) return err(res, "Booking not found", 404);
      if (booking.booking_status === "Confirmed") return err(res, "Already confirmed", 400);
      const [plot] = await sql`SELECT base_price, monthly_emi, emi_tenure_months FROM plots WHERE plot_id = ${booking.plot_id}`;
      if (booking.payment_type === "EMI") {
        const start = new Date(); start.setMonth(start.getMonth() + 1);
        for (let i = 1; i <= Number(plot.emi_tenure_months || 60); i++) {
          const due = new Date(start); due.setMonth(due.getMonth() + (i - 1));
          await sql`
            INSERT INTO emi_schedules (booking_id, user_id, installment_no, due_date, emi_amount)
            VALUES (${bid}, ${booking.user_id}, ${i}, ${due.toISOString().split("T")[0]}, ${plot.monthly_emi || 0})
            ON CONFLICT (booking_id, installment_no) DO NOTHING`;
        }
      }
      await sql`
        UPDATE bookings SET booking_status = 'Confirmed',
          confirmed_by_admin_id = ${req.admin.admin_id}, confirmed_at = NOW(), updated_at = NOW()
        WHERE booking_id = ${bid}`;
      await sql`UPDATE plots SET plot_status = 'Booked', updated_at = NOW() WHERE plot_id = ${booking.plot_id}`;
      await addPlotBookingHistory({
        plotId: booking.plot_id,
        bookingId: bid,
        userId: booking.user_id,
        eventType: "BookingConfirmed",
        eventNote: notes || "Payment verified by admin",
        triggeredByAdmin: req.admin.admin_id,
        plotStatusAtTime: "Booked",
      });
      await logAdminAudit(req, "BookingManagement", "BookingConfirmed", "bookings", bid, sql.json({ notes: notes || null }));
      await addUserNotification({
        userId: booking.user_id,
        adminId: req.admin.admin_id,
        title: "Booking confirmed",
        message: "Badhaai! Aapki booking confirm ho gayi.",
      });
      const [plotForCommission] = await sql`SELECT base_price FROM plots WHERE plot_id = ${booking.plot_id}`;
      const commissionResult = await generateCommissionForPayment(req, {
        bookingId: bid,
        sourceType: booking.payment_type === "FullPayment" ? "FullPayment" : "InitialPayment",
        sourceId: `booking-${bid}`,
        receivedAmount: booking.payment_type === "FullPayment" ? plotForCommission?.base_price : booking.advance_amount,
        paymentType: booking.payment_type,
      });
      await logAdminAudit(req, "MLM", "GenerateCommissionOnBookingConfirm", "bookings", bid, sql.json(commissionResult));
      return ok(res, {}, "Booking confirmed.");
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.patch("/api/admin/bookings/:id/cancel",
  verifyAdminToken,
  role("SuperAdmin","SiteManager","FinanceManager"),
  async (req, res) => {
    try {
      const reason = req.body?.reason || req.body?.cancellation_reason;
      if (!reason) return err(res, "reason required", 400);
      const [booking] = await sql`SELECT plot_id, user_id FROM bookings WHERE booking_id = ${req.params.id}`;
      if (!booking) return err(res, "Booking not found", 404);
      await sql`
        UPDATE bookings SET booking_status = 'Cancelled',
          cancellation_reason = ${reason}, cancelled_by_admin_id = ${req.admin.admin_id},
          cancelled_at = NOW(), updated_at = NOW()
        WHERE booking_id = ${req.params.id}`;
      await sql`UPDATE plots SET plot_status = 'Vacant', updated_at = NOW() WHERE plot_id = ${booking.plot_id}`;
      await addPlotBookingHistory({
        plotId: booking.plot_id,
        bookingId: req.params.id,
        userId: booking.user_id,
        eventType: "BookingCancelled",
        eventNote: reason,
        triggeredByAdmin: req.admin.admin_id,
        plotStatusAtTime: "Vacant",
      });
      await logAdminAudit(req, "BookingManagement", "BookingCancelled", "bookings", req.params.id, sql.json({ reason }));
      await addUserNotification({
        userId: booking.user_id,
        adminId: req.admin.admin_id,
        title: "Booking cancelled",
        message: `Aapki booking cancel ho gayi. Reason: ${reason}`,
      });
      return ok(res, {}, "Booking cancelled. Plot set to Vacant.");
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.get("/api/admin/emi/overdue",
  verifyAdminToken,
  role("SuperAdmin","FinanceManager"),
  async (req, res) => {
    try {
      // Auto-mark overdue
      await sql`
        UPDATE emi_schedules SET emi_status = 'Overdue', updated_at = NOW()
        WHERE emi_status = 'Pending' AND due_date < CURRENT_DATE`;

      const overdue = await sql`
        SELECT e.emi_id, e.installment_no, e.due_date, e.emi_amount,
               (CURRENT_DATE - e.due_date) AS overdue_days,
               ROUND(e.emi_amount * 0.05, 2) AS late_fee_due,
               u.full_name, u.member_id, u.mobile_no,
               p.plot_number, s.site_name
        FROM emi_schedules e
        JOIN users    u ON e.user_id   = u.user_id
        JOIN bookings b ON e.booking_id = b.booking_id
        JOIN plots    p ON b.plot_id   = p.plot_id
        JOIN sites    s ON p.site_id   = s.site_id
        WHERE e.emi_status = 'Overdue'
        ORDER BY e.due_date ASC`;

      return ok(res, overdue);
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.post("/api/admin/emi/:id/confirm",
  verifyAdminToken,
  role("SuperAdmin","FinanceManager"),
  async (req, res) => {
    try {
      const emiId = req.params.id;
      const { paid_amount } = req.body;
      if (!paid_amount) return err(res, "paid_amount required", 400);

      const [emi] = await sql`SELECT * FROM emi_schedules WHERE emi_id = ${emiId}`;
      if (!emi) return err(res, "EMI not found", 404);

      const lateFee = new Date() > new Date(emi.due_date)
        ? Math.round(emi.emi_amount * 0.05 * 100) / 100 : 0;

      // Voucher serial
      const [seq] = await sql`
        SELECT COALESCE(MAX(CAST(REPLACE(voucher_serial,'U-','') AS INT)),0)+1 AS n
        FROM payment_vouchers WHERE voucher_serial LIKE 'U-%'`;
      const vSerial = `U-${seq.n}`;

      await sql`
        UPDATE emi_schedules SET
          emi_status = 'Paid', paid_amount = ${paid_amount},
          paid_date  = CURRENT_DATE, late_fee_amount = ${lateFee},
          voucher_file_path = ${'vouchers/' + vSerial + '.pdf'},
          confirmed_by_admin_id = ${req.admin.admin_id}, confirmed_at = NOW(), updated_at = NOW()
        WHERE emi_id = ${emiId}`;

      await sql`
        INSERT INTO payment_vouchers (voucher_serial, voucher_type, reference_id, user_id, amount, generated_by_admin_id)
        VALUES (${vSerial}, 'EMI', ${emiId}, ${emi.user_id},
                ${parseFloat(paid_amount) + lateFee}, ${req.admin.admin_id})`;

      const commissionResult = await generateCommissionForPayment(req, {
        bookingId: emi.booking_id,
        sourceType: "EmiPayment",
        sourceId: `emi-${emiId}`,
        receivedAmount: paid_amount,
        paymentType: "EMI",
      });
      await logAdminAudit(req, "MLM", "GenerateCommissionOnEmiApproval", "emi_schedules", emiId, sql.json(commissionResult));

      return ok(res, { voucher_serial: vSerial, late_fee: lateFee, commission: commissionResult },
        "EMI payment confirmed. Voucher generated.");
    } catch (e) {
      return err(res, e.message);
    }
  }
);

/* ==========================
   ADMIN - PLOT MANAGEMENT EXTENSIONS
========================== */

app.put("/api/admin/plots/:plotId/polygon",
  verifyAdminToken,
  role("SuperAdmin","SiteManager"),
  async (req, res) => {
    try {
      const { coordinates, label_x, label_y, change_reason } = req.body;
      if (!validatePolygonCoordinates(coordinates)) {
        return err(res, "coordinates must be a non-empty array of { x, y } points.", 400);
      }
      const plotId = req.params.plotId;
      const normalized = normalizeCoordinates(coordinates);
      const [plot] = await sql`SELECT plot_id FROM plots WHERE plot_id = ${plotId}`;
      if (!plot) return err(res, "Plot not found", 404);

      const [current] = await sql`
        SELECT coordinates FROM plot_polygon_coordinates WHERE plot_id = ${plotId}`;
      if (current) {
        await sql`
          INSERT INTO plot_polygon_history
            (plot_id, old_coordinates, new_coordinates, changed_by_admin_id, change_reason)
          VALUES (${plotId}, ${sql.json(current.coordinates || [])}, ${sql.json(normalized)},
                  ${req.admin.admin_id}, ${change_reason || null})`;
      }

      const [updated] = await sql`
        INSERT INTO plot_polygon_coordinates
          (plot_id, coordinates, label_x, label_y, updated_by_admin_id, updated_at)
        VALUES (${plotId}, ${sql.json(normalized)}, ${asNumberOrNull(label_x)}, ${asNumberOrNull(label_y)},
                ${req.admin.admin_id}, NOW())
        ON CONFLICT (plot_id) DO UPDATE SET
          coordinates = EXCLUDED.coordinates,
          label_x = EXCLUDED.label_x,
          label_y = EXCLUDED.label_y,
          updated_by_admin_id = EXCLUDED.updated_by_admin_id,
          updated_at = NOW()
        RETURNING plot_id, coordinates, label_x, label_y`;
      await logPlotAudit(req, "UpdatePolygon", plotId);
      return ok(res, updated);
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.post("/api/admin/plots/:id/polygon",
  verifyAdminToken,
  role("SuperAdmin","SiteManager"),
  async (req, res) => {
    try {
      const { coordinates, label_x, label_y, change_reason } = req.body;
      if (!validatePolygonCoordinates(coordinates)) {
        return err(res, "coordinates must be a non-empty array of points.", 400);
      }
      const plotId = req.params.id;
      const normalized = normalizeCoordinates(coordinates);
      const [plot] = await sql`SELECT plot_id FROM plots WHERE plot_id = ${plotId}`;
      if (!plot) return err(res, "Plot not found", 404);
      const [current] = await sql`
        SELECT coordinates FROM plot_polygon_coordinates WHERE plot_id = ${plotId}`;
      if (current) {
        await sql`
          INSERT INTO plot_polygon_history
            (plot_id, old_coordinates, new_coordinates, changed_by_admin_id, change_reason)
          VALUES (${plotId}, ${sql.json(current.coordinates || [])}, ${sql.json(normalized)},
                  ${req.admin.admin_id}, ${change_reason || null})`;
      }
      const [updated] = await sql`
        INSERT INTO plot_polygon_coordinates
          (plot_id, coordinates, label_x, label_y, updated_by_admin_id, updated_at)
        VALUES (${plotId}, ${sql.json(normalized)}, ${asNumberOrNull(label_x)}, ${asNumberOrNull(label_y)},
                ${req.admin.admin_id}, NOW())
        ON CONFLICT (plot_id) DO UPDATE SET
          coordinates = EXCLUDED.coordinates,
          label_x = EXCLUDED.label_x,
          label_y = EXCLUDED.label_y,
          updated_by_admin_id = EXCLUDED.updated_by_admin_id,
          updated_at = NOW()
        RETURNING plot_id, coordinates, label_x, label_y`;
      await logPlotAudit(req, "UpdatePolygon", plotId);
      return ok(res, updated);
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.get("/api/admin/plots/:plotId/polygon",
  verifyAdminToken,
  role("SuperAdmin","SiteManager","SupportStaff"),
  async (req, res) => {
    try {
      const [polygon] = await sql`
        SELECT plot_id, coordinates, label_x, label_y
        FROM plot_polygon_coordinates
        WHERE plot_id = ${req.params.plotId}`;
      return ok(res, polygon || {
        plot_id: Number(req.params.plotId),
        coordinates: [],
        label_x: null,
        label_y: null,
      });
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.get("/api/admin/plots/:plotId/polygon-history",
  verifyAdminToken,
  role("SuperAdmin","SiteManager"),
  async (req, res) => {
    try {
      const history = await sql`
        SELECT id, plot_id, old_coordinates, new_coordinates,
               changed_by_admin_id, change_reason, changed_at
        FROM plot_polygon_history
        WHERE plot_id = ${req.params.plotId}
        ORDER BY changed_at DESC`;
      return ok(res, history);
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.put("/api/admin/plots/:plotId/polygon/restore/:historyId",
  verifyAdminToken,
  role("SuperAdmin"),
  async (req, res) => {
    try {
      const { plotId, historyId } = req.params;
      const [history] = await sql`
        SELECT * FROM plot_polygon_history
        WHERE id = ${historyId} AND plot_id = ${plotId}`;
      if (!history) return err(res, "History record not found", 404);

      const [current] = await sql`
        SELECT coordinates, label_x, label_y
        FROM plot_polygon_coordinates
        WHERE plot_id = ${plotId}`;
      await sql`
        INSERT INTO plot_polygon_history
          (plot_id, old_coordinates, new_coordinates, changed_by_admin_id, change_reason)
        VALUES (${plotId}, ${sql.json(current?.coordinates || [])}, ${sql.json(history.old_coordinates || [])},
                ${req.admin.admin_id}, ${`Restored from history #${historyId}`})`;

      const [updated] = await sql`
        INSERT INTO plot_polygon_coordinates
          (plot_id, coordinates, label_x, label_y, updated_by_admin_id, updated_at)
        VALUES (${plotId}, ${sql.json(history.old_coordinates || [])}, ${current?.label_x || null},
                ${current?.label_y || null}, ${req.admin.admin_id}, NOW())
        ON CONFLICT (plot_id) DO UPDATE SET
          coordinates = EXCLUDED.coordinates,
          updated_by_admin_id = EXCLUDED.updated_by_admin_id,
          updated_at = NOW()
        RETURNING plot_id, coordinates, label_x, label_y`;
      await logPlotAudit(req, "RestorePolygon", plotId);
      return ok(res, updated, "Polygon restored successfully.");
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.get("/api/admin/plots/:plotId/details",
  verifyAdminToken,
  role("SuperAdmin","SiteManager","SupportStaff"),
  async (req, res) => {
    try {
      const [plot] = await sql`
        SELECT plot_id AS id, plot_number, plot_area, plot_category, base_price,
               down_payment, monthly_emi, emi_tenure_months, file_charge, plot_status
        FROM plots
        WHERE plot_id = ${req.params.plotId}`;
      if (!plot) return err(res, "Plot not found", 404);
      const [extended] = await sql`
        SELECT size_label, width_ft, length_ft, facing_direction, is_corner_plot,
               road_width_ft, features, description, block_name, sector_name
        FROM plot_details_extended
        WHERE plot_id = ${req.params.plotId}`;
      return ok(res, { plot, extended: extended || null });
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.put("/api/admin/plots/:plotId/details",
  verifyAdminToken,
  role("SuperAdmin","SiteManager"),
  async (req, res) => {
    try {
      const plotId = req.params.plotId;
      const [plot] = await sql`SELECT plot_id FROM plots WHERE plot_id = ${plotId}`;
      if (!plot) return err(res, "Plot not found", 404);
      const {
        size_label, width_ft, length_ft, facing_direction, is_corner_plot,
        road_width_ft, features, description, block_name, sector_name,
      } = req.body;
      const normalizedFeatures = Array.isArray(features) ? features : [];
      const [details] = await sql`
        INSERT INTO plot_details_extended
          (plot_id, size_label, width_ft, length_ft, facing_direction, is_corner_plot,
           road_width_ft, features, description, block_name, sector_name, updated_by_admin_id, updated_at)
        VALUES (${plotId}, ${size_label || null}, ${asNumberOrNull(width_ft)}, ${asNumberOrNull(length_ft)},
                ${facing_direction || null}, ${Boolean(is_corner_plot)}, ${asNumberOrNull(road_width_ft)},
                ${sql.json(normalizedFeatures)}, ${description || null}, ${block_name || null},
                ${sector_name || null}, ${req.admin.admin_id}, NOW())
        ON CONFLICT (plot_id) DO UPDATE SET
          size_label = EXCLUDED.size_label,
          width_ft = EXCLUDED.width_ft,
          length_ft = EXCLUDED.length_ft,
          facing_direction = EXCLUDED.facing_direction,
          is_corner_plot = EXCLUDED.is_corner_plot,
          road_width_ft = EXCLUDED.road_width_ft,
          features = EXCLUDED.features,
          description = EXCLUDED.description,
          block_name = EXCLUDED.block_name,
          sector_name = EXCLUDED.sector_name,
          updated_by_admin_id = EXCLUDED.updated_by_admin_id,
          updated_at = NOW()
        RETURNING plot_id, size_label, width_ft, length_ft, facing_direction, is_corner_plot,
                  road_width_ft, features, description, block_name, sector_name`;
      await logPlotAudit(req, "UpdatePlotDetails", plotId);
      return ok(res, details);
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.post("/api/admin/plots/:plotId/images",
  verifyAdminToken,
  role("SuperAdmin","SiteManager"),
  plotImageUpload.single("image"),
  async (req, res) => {
    try {
      if (!req.file || !validatePlotImageFile(req.file)) {
        return err(res, "Only JPG, JPEG, and PNG files are allowed.", 400);
      }
      const plotId = req.params.plotId;
      const [plot] = await sql`SELECT plot_id FROM plots WHERE plot_id = ${plotId}`;
      if (!plot) return err(res, "Plot not found", 404);

      const folder = path.join(process.cwd(), "uploads", "plots", String(plotId));
      await fs.mkdir(folder, { recursive: true });
      const filename = `${Date.now()}_${cleanFileName(req.file.originalname)}`;
      const imagePath = path.join(folder, filename);
      await fs.writeFile(imagePath, req.file.buffer);
      const relativePath = path.posix.join("uploads", "plots", String(plotId), filename);
      const imageUrl = `${publicBaseUrl(req)}/${relativePath}`;

      const [image] = await sql`
        INSERT INTO plot_images
          (plot_id, image_url, image_path, caption, image_order, uploaded_by_id)
        VALUES (${plotId}, ${imageUrl}, ${imagePath}, ${req.body.caption || null},
                ${Number(req.body.image_order || 0)}, ${req.admin.admin_id})
        RETURNING id, plot_id, image_url, caption, image_order`;
      await logPlotAudit(req, "UploadPlotImage", plotId);
      return ok(res, image, "Success", 201);
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.get("/api/admin/plots/:plotId/images",
  verifyAdminToken,
  role("SuperAdmin","SiteManager","SupportStaff"),
  async (req, res) => {
    try {
      const images = await sql`
        SELECT id, plot_id, image_url, caption, image_order, uploaded_at
        FROM plot_images
        WHERE plot_id = ${req.params.plotId}
        ORDER BY image_order ASC, id ASC`;
      return ok(res, images);
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.put("/api/admin/plots/:plotId/images/:imageId",
  verifyAdminToken,
  role("SuperAdmin","SiteManager"),
  async (req, res) => {
    try {
      const [existing] = await sql`
        SELECT id FROM plot_images
        WHERE id = ${req.params.imageId} AND plot_id = ${req.params.plotId}`;
      if (!existing) return err(res, "Image not found", 404);
      const [image] = await sql`
        UPDATE plot_images SET
          caption = COALESCE(${req.body.caption ?? null}, caption),
          image_order = COALESCE(${req.body.image_order != null ? Number(req.body.image_order) : null}, image_order),
          updated_at = NOW()
        WHERE id = ${req.params.imageId} AND plot_id = ${req.params.plotId}
        RETURNING id, plot_id, image_url, caption, image_order`;
      await logPlotAudit(req, "UpdatePlotImage", req.params.plotId);
      return ok(res, image);
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.delete("/api/admin/plots/:plotId/images/:imageId",
  verifyAdminToken,
  role("SuperAdmin","SiteManager"),
  async (req, res) => {
    try {
      const [image] = await sql`
        SELECT id, image_path FROM plot_images
        WHERE id = ${req.params.imageId} AND plot_id = ${req.params.plotId}`;
      if (!image) return err(res, "Image not found", 404);
      if (image.image_path) await fs.unlink(image.image_path).catch(() => {});
      await sql`DELETE FROM plot_images WHERE id = ${req.params.imageId} AND plot_id = ${req.params.plotId}`;
      await logPlotAudit(req, "DeletePlotImage", req.params.plotId);
      return ok(res, null, "Image deleted.");
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.post("/api/admin/sites/:siteId/detect-plots",
  verifyAdminToken,
  role("SuperAdmin","SiteManager"),
  async (req, res) => {
    try {
      const [site] = await sql`
        SELECT site_id, site_name, site_prefix, total_plots
        FROM sites
        WHERE site_id = ${req.params.siteId}`;
      if (!site) return err(res, "Site not found", 404);
      const existingPlots = await sql`
        SELECT plot_id, plot_number
        FROM plots
        WHERE site_id = ${req.params.siteId} AND is_active = TRUE
        ORDER BY NULLIF(regexp_replace(plot_number, '\\D', '', 'g'), '')::int NULLS LAST, plot_number`;
      const total = Number(req.body?.total_plots || existingPlots.length || site.total_plots || 0);
      const prefix = String(site.site_prefix || sitePrefixFromName(site.site_name)).toUpperCase();
      const polygons = generatedPlotPolygons(total).map((coordinates, index) => ({
        plot_id: existingPlots[index]?.plot_id || null,
        plot_number: existingPlots[index]?.plot_number || `${prefix}-${String(index + 1).padStart(3, "0")}`,
        coordinates,
        confidence: .55,
        source: "generated-fallback",
      }));
      return ok(res, {
        site_id: Number(req.params.siteId),
        plots: polygons,
        detection_mode: "generated-fallback",
      }, "Editable plot polygons generated.");
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.post("/api/admin/sites/:siteId/detected-plots",
  verifyAdminToken,
  role("SuperAdmin","SiteManager"),
  async (req, res) => {
    try {
      const [site] = await sql`
        SELECT site_id, site_name, site_prefix
        FROM sites
        WHERE site_id = ${req.params.siteId}`;
      if (!site) return err(res, "Site not found", 404);
      const incoming = Array.isArray(req.body?.plots) ? req.body.plots : [];
      if (!incoming.length) return err(res, "plots must be a non-empty array.", 400);
      const prefix = String(site.site_prefix || sitePrefixFromName(site.site_name)).toUpperCase();
      let created = 0;
      let updated = 0;
      const saved = [];
      for (const [index, item] of incoming.entries()) {
        const coordinates = normalizeCoordinates(item.coordinates || item.polygon_coordinates || item.points || []);
        if (!validatePolygonCoordinates(coordinates) || coordinates.length < 3) {
          return err(res, `Plot ${index + 1} has invalid coordinates.`, 400);
        }
        const requestedNumber = String(item.plot_number || `${prefix}-${String(index + 1).padStart(3, "0")}`).trim();
        let [plot] = item.plot_id
          ? await sql`SELECT plot_id, plot_number FROM plots WHERE plot_id = ${item.plot_id} AND site_id = ${req.params.siteId} AND is_active = TRUE`
          : await sql`SELECT plot_id, plot_number FROM plots WHERE site_id = ${req.params.siteId} AND plot_number = ${requestedNumber} AND is_active = TRUE`;
        if (!plot) {
          [plot] = await sql`
            INSERT INTO plots (
              site_id, plot_number, plot_area, plot_category, base_price,
              down_payment, monthly_emi, emi_tenure_months, file_charge,
              plot_status, created_by_admin_id
            )
            VALUES (
              ${req.params.siteId}, ${requestedNumber}, ${Math.max(1, Number(item.plot_area || 1))},
              '100gaj'::plot_category_enum, ${asNumberOrNull(item.base_price) || 0},
              0, 0, 60, 0, 'Vacant'::plot_status_enum, ${req.admin.admin_id}
            )
            RETURNING plot_id, plot_number`;
          created += 1;
        } else {
          updated += 1;
        }
        await sql`
          INSERT INTO plot_polygon_coordinates
            (plot_id, coordinates, label_x, label_y, updated_by_admin_id, updated_at)
          VALUES (${plot.plot_id}, ${sql.json(coordinates)}, ${asNumberOrNull(item.label_x)}, ${asNumberOrNull(item.label_y)}, ${req.admin.admin_id}, NOW())
          ON CONFLICT (plot_id) DO UPDATE SET
            coordinates = EXCLUDED.coordinates,
            label_x = EXCLUDED.label_x,
            label_y = EXCLUDED.label_y,
            updated_by_admin_id = EXCLUDED.updated_by_admin_id,
            updated_at = NOW()`;
        saved.push({ plot_id: plot.plot_id, plot_number: plot.plot_number, coordinates });
      }
      await logAdminAudit(req, "SiteManagement", "SaveDetectedPlots", "sites", req.params.siteId, sql.json({ created, updated }));
      return ok(res, { created, updated, plots: saved }, "Detected plot polygons saved.");
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.get("/api/admin/sites/:siteId/plots/import-template",
  verifyAdminToken,
  role("SuperAdmin","SiteManager","SupportStaff"),
  async (_req, res) => {
    try {
      const worksheet = xlsx.utils.aoa_to_sheet([
        plotImportTemplateFields,
        ["GV-001", "GV-001", "Vacant", "Residential", "100 Gaj", 100, 45, 20, "East", 25, "A", "Phase 1", "Yes", "No", "No", "", "", "", "", "", "", "", "", "", 460000, 460000, 51000, 409000, "Near park road", ""],
      ]);
      const workbook = xlsx.utils.book_new();
      xlsx.utils.book_append_sheet(workbook, worksheet, "Plot Import");
      const buffer = xlsx.write(workbook, { type: "buffer", bookType: "xlsx" });
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", "attachment; filename=plot-import-template.xlsx");
      return res.send(buffer);
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.post("/api/admin/sites/:siteId/plots/bulk-import",
  verifyAdminToken,
  role("SuperAdmin","SiteManager"),
  importUpload.single("file"),
  async (req, res) => {
    try {
      if (!req.file) return err(res, "file is required", 400);
      let rows;
      try {
        rows = parseImportRows(req.file);
      } catch (parseError) {
        return err(res, parseError.message, 400);
      }

      const [site] = await sql`SELECT site_id FROM sites WHERE site_id = ${req.params.siteId}`;
      if (!site) return err(res, "Site not found", 404);
      const [log] = await sql`
        INSERT INTO plot_bulk_import_log
          (site_id, imported_by_id, original_filename, status)
        VALUES (${req.params.siteId}, ${req.admin.admin_id}, ${req.file.originalname}, 'Processing')
        RETURNING id`;

      let successCount = 0;
      let createdCount = 0;
      let updatedCount = 0;
      let duplicateCount = 0;
      const errors = [];
      const seen = new Set();
      const batchSize = 250;

      for (let batchStart = 0; batchStart < rows.length; batchStart += batchSize) {
        const batch = rows.slice(batchStart, batchStart + batchSize);
        for (const [batchIndex, rawRow] of batch.entries()) {
          const index = batchStart + batchIndex;
          const rowNumber = index + 2;
          const row = Object.fromEntries(
            Object.entries(rawRow).map(([key, value]) => [normalizeImportKey(key), normalizeImportValue(value)])
          );
          const plotNumber = String(row.plot_number || "").trim();
          const plotKey = plotNumber.toLowerCase();
        if (!plotNumber) {
          errors.push({ row: rowNumber, plot_number: plotNumber, error: "plot_number is required." });
          continue;
        }
          if (seen.has(plotKey)) {
            duplicateCount += 1;
            errors.push({ row: rowNumber, plot_number: plotNumber, error: "Duplicate plot number in uploaded file." });
          continue;
        }
          seen.add(plotKey);

          let [plot] = await sql`
          SELECT plot_id, plot_status FROM plots
          WHERE site_id = ${req.params.siteId} AND plot_number = ${plotNumber}
          LIMIT 1`;

          const status = row.status ? String(row.status).replace(/\s+/g, "") : null;
          const allowedStatuses = new Set(["Vacant", "InProcess", "Booked", "Sold"]);
          if (status && !allowedStatuses.has(status)) {
            errors.push({ row: rowNumber, plot_number: plotNumber, error: "Status must be Vacant, InProcess, Booked, or Sold." });
            continue;
          }

          try {
            const importedArea =
              asNumberOrNull(row.plot_size) ??
              asNumberOrNull(row.area) ??
              asNumberOrNull(row.plot_area) ??
              (asNumberOrNull(row.width) && asNumberOrNull(row.length)
                ? asNumberOrNull(row.width) * asNumberOrNull(row.length)
                : null);
            const importedPrice =
              asNumberOrNull(row.total_price) ??
              asNumberOrNull(row.price) ??
              asNumberOrNull(row.base_price);
            const importedBooking =
              asNumberOrNull(row.booking_amount) ??
              asNumberOrNull(row.down_payment);
            if (!plot) {
              if (!importedArea) {
                errors.push({ row: rowNumber, plot_number: plotNumber, error: "Area or Plot Size is required when creating a new plot." });
                continue;
              }
              [plot] = await sql`
                INSERT INTO plots (
                  site_id, plot_number, plot_area, plot_category, base_price,
                  down_payment, monthly_emi, emi_tenure_months, file_charge,
                  plot_status, created_by_admin_id
                )
                VALUES (
                  ${req.params.siteId}, ${plotNumber}, ${importedArea},
                  ${String(row.plot_type || row.plot_category || "").toLowerCase().includes("50") ? "50gaj" : "100gaj"}::plot_category_enum,
                  ${importedPrice || 0}, ${importedBooking || 0}, ${asNumberOrNull(row.monthly_emi) || 0},
                  ${asNumberOrNull(row.emi_tenure_months) || 60}, ${asNumberOrNull(row.file_charge) || 0},
                  ${status || "Vacant"}::plot_status_enum, ${req.admin.admin_id}
                )
                RETURNING plot_id, plot_status`;
              createdCount += 1;
            } else {
              updatedCount += 1;
            }
            await sql`
              UPDATE plots SET
                plot_area = COALESCE(${importedArea}, plot_area),
                base_price = COALESCE(${importedPrice}, base_price),
                down_payment = COALESCE(${importedBooking}, down_payment),
                plot_status = COALESCE(${status || null}::plot_status_enum, plot_status),
                updated_at = NOW()
              WHERE plot_id = ${plot.plot_id}`;
            await sql`
              INSERT INTO plot_details_extended
                (plot_id, size_label, width_ft, length_ft, facing_direction, is_corner_plot,
                 road_width_ft, features, description, block_name, sector_name, updated_by_admin_id, updated_at)
              VALUES (
                ${plot.plot_id}, ${row.plot_name || row.plot_size || null}, ${asNumberOrNull(row.width)}, ${asNumberOrNull(row.length)},
                ${row.facing || null}, ${["yes", "true", "1"].includes(String(row.corner_plot || "").toLowerCase())},
                ${asNumberOrNull(row.road_width)},
                ${sql.json([
                  row.plc ? `PLC: ${row.plc}` : null,
                  row.east ? `East: ${row.east}` : null,
                  row.west ? `West: ${row.west}` : null,
                  row.north ? `North: ${row.north}` : null,
                  row.south ? `South: ${row.south}` : null,
                  row.customer_name ? `Customer: ${row.customer_name}` : null,
                  row.customer_mobile ? `Mobile: ${row.customer_mobile}` : null,
                  row.booking_date ? `Booking Date: ${row.booking_date}` : null,
                  row.registry_status ? `Registry: ${row.registry_status}` : null,
                  row.registry_date ? `Registry Date: ${row.registry_date}` : null,
                  row.balance_amount ? `Balance: ${row.balance_amount}` : null,
                  ["yes", "true", "1"].includes(String(row.park_facing || "").toLowerCase()) ? "Park Facing" : null,
                ].filter(Boolean))},
                ${row.description || row.remarks || null}, ${row.block || null}, ${row.phase || null}, ${req.admin.admin_id}, NOW()
              )
              ON CONFLICT (plot_id) DO UPDATE SET
                size_label = COALESCE(EXCLUDED.size_label, plot_details_extended.size_label),
                width_ft = COALESCE(EXCLUDED.width_ft, plot_details_extended.width_ft),
                length_ft = COALESCE(EXCLUDED.length_ft, plot_details_extended.length_ft),
                facing_direction = COALESCE(EXCLUDED.facing_direction, plot_details_extended.facing_direction),
                is_corner_plot = EXCLUDED.is_corner_plot,
                road_width_ft = COALESCE(EXCLUDED.road_width_ft, plot_details_extended.road_width_ft),
                features = CASE WHEN jsonb_array_length(EXCLUDED.features) > 0 THEN EXCLUDED.features ELSE plot_details_extended.features END,
                description = COALESCE(EXCLUDED.description, plot_details_extended.description),
                block_name = COALESCE(EXCLUDED.block_name, plot_details_extended.block_name),
                sector_name = COALESCE(EXCLUDED.sector_name, plot_details_extended.sector_name),
                updated_by_admin_id = EXCLUDED.updated_by_admin_id,
                updated_at = NOW()`;
            successCount += 1;
          } catch (updateError) {
            errors.push({ row: rowNumber, plot_number: plotNumber, error: updateError.message });
          }
        }
      }

      const totalRows = rows.length;
      const failedCount = errors.length;
      const status = totalRows === 0 || successCount === 0
        ? "Failed"
        : failedCount > 0 ? "PartialSuccess" : "Completed";
      await sql`
        UPDATE plot_bulk_import_log SET
          total_rows = ${totalRows},
          success_count = ${successCount},
          failed_count = ${failedCount},
          error_details = ${sql.json(errors)},
          status = ${status},
          completed_at = NOW()
        WHERE id = ${log.id}`;
      await logPlotAudit(req, "BulkImportPlots", req.params.siteId);
      return ok(res, {
        import_log_id: log.id,
        total_records: totalRows,
        total_rows: totalRows,
        created: createdCount,
        created_count: createdCount,
        updated: updatedCount,
        updated_count: updatedCount,
        success_count: successCount,
        failed: failedCount,
        failed_count: failedCount,
        duplicate: duplicateCount,
        duplicate_count: duplicateCount,
        errors,
      }, `${successCount} of ${totalRows} plot records imported successfully.`);
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.get("/api/admin/sites/:siteId/plots/import-history",
  verifyAdminToken,
  role("SuperAdmin","SiteManager"),
  async (req, res) => {
    try {
      const history = await sql`
        SELECT l.id, l.site_id, l.original_filename, l.total_rows, l.success_count,
               l.failed_count, l.error_details, l.status, l.started_at, l.completed_at,
               json_build_object('id', a.admin_id, 'full_name', a.full_name) AS imported_by
        FROM plot_bulk_import_log l
        LEFT JOIN admin_users a ON a.admin_id = l.imported_by_id
        WHERE l.site_id = ${req.params.siteId}
        ORDER BY l.started_at DESC`;
      return ok(res, history);
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.get("/api/admin/plots/:plotId/booking-history",
  verifyAdminToken,
  role("SuperAdmin","SiteManager","FinanceManager"),
  async (req, res) => {
    try {
      const history = await sql`
        SELECT h.id, h.event_type, h.event_note, h.plot_status_at_time,
               json_build_object(
                 'id', b.booking_id,
                 'booking_serial', b.booking_serial,
                 'user', CASE WHEN bu.user_id IS NULL THEN NULL ELSE json_build_object(
                   'id', bu.user_id,
                   'full_name', bu.full_name,
                   'member_id', bu.member_id
                 ) END
               ) AS booking,
               CASE WHEN au.admin_id IS NULL THEN NULL ELSE json_build_object(
                 'id', au.admin_id,
                 'full_name', au.full_name
               ) END AS triggered_by_admin,
               CASE WHEN tu.user_id IS NULL THEN NULL ELSE json_build_object(
                 'id', tu.user_id,
                 'full_name', tu.full_name
               ) END AS triggered_by_user,
               h.created_at
        FROM plot_booking_history h
        LEFT JOIN bookings b ON b.booking_id = h.booking_id
        LEFT JOIN users bu ON bu.user_id = b.user_id
        LEFT JOIN admin_users au ON au.admin_id = h.triggered_by_admin
        LEFT JOIN users tu ON tu.user_id = h.triggered_by_user
        WHERE h.plot_id = ${req.params.plotId}
        ORDER BY h.created_at DESC`;
      return ok(res, history);
    } catch (e) {
      return err(res, e.message);
    }
  }
);

/* ==========================
   ─────────────────────────
   ADMIN — SITES & PLOTS
   GET  /api/admin/sites
   POST /api/admin/sites
   PUT  /api/admin/sites/:id
   POST /api/admin/sites/:id/photo
   POST /api/admin/plots
   PUT  /api/admin/plots/:id/status
   ─────────────────────────
========================== */

app.get("/api/admin/sites/:id/documents",
  verifyAdminToken,
  role("SuperAdmin","SiteManager","SupportStaff"),
  async (req, res) => {
    try {
      await requireSiteDocumentsSchema();
      const documents = await sql`
        SELECT document_id, site_id, document_name, document_type, description,
               file_url, file_public_id, file_name, file_mime_type, file_size_bytes,
               created_at, updated_at
        FROM site_documents
        WHERE site_id = ${req.params.id}
        ORDER BY created_at DESC`;
      return ok(res, documents);
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.post("/api/admin/sites/:id/documents",
  verifyAdminToken,
  role("SuperAdmin","SiteManager"),
  siteDocumentUpload.single("site_document"),
  async (req, res) => {
    try {
      await requireSiteDocumentsSchema();
      const documentName = String(req.body.document_name || "").trim();
      if (!documentName) return err(res, "Document name is required", 400);
      if (!req.file) return err(res, "Document file is required", 400);
      const [site] = await sql`SELECT site_id FROM sites WHERE site_id = ${req.params.id}`;
      if (!site) return err(res, "Site not found", 404);

      const saved = await saveFileToVPS(
        req.file.buffer,
        { module: "site", entityId: req.params.id, entityType: "SiteDoc", originalName: req.file.originalname }
      );
      const [document] = await sql`
        INSERT INTO site_documents (
          site_id, document_name, document_type, description, file_url, file_public_id,
          file_name, file_mime_type, file_size_bytes, created_by_admin_id
        )
        VALUES (
          ${req.params.id}, ${documentName}, ${String(req.body.document_type || "").trim() || null},
          ${String(req.body.description || "").trim() || null}, ${saved.url}, ${null},
          ${req.file.originalname}, ${req.file.mimetype}, ${req.file.size}, ${req.admin.admin_id}
        )
        RETURNING *`;
      await logAdminAudit(req, "SiteManagement", "CreateSiteDocument", "site_documents", document.document_id, sql.json({
        site_id: Number(req.params.id),
        document_name: documentName,
      }));
      return ok(res, document, "Site document uploaded", 201);
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.put("/api/admin/sites/:siteId/documents/:documentId",
  verifyAdminToken,
  role("SuperAdmin","SiteManager"),
  siteDocumentUpload.single("site_document"),
  async (req, res) => {
    try {
      await requireSiteDocumentsSchema();
      const [existing] = await sql`
        SELECT *
        FROM site_documents
        WHERE document_id = ${req.params.documentId} AND site_id = ${req.params.siteId}`;
      if (!existing) return err(res, "Site document not found", 404);

      const documentName = String(req.body.document_name || existing.document_name).trim();
      if (!documentName) return err(res, "Document name is required", 400);
      let file = {
        url: existing.file_url,
        publicId: existing.file_public_id,
        name: existing.file_name,
        mime: existing.file_mime_type,
        size: existing.file_size_bytes,
      };

      if (req.file) {
        const saved = await saveFileToVPS(
          req.file.buffer,
          { module: "site", entityId: req.params.siteId, entityType: "SiteDoc", originalName: req.file.originalname }
        );
        file = {
          url: saved.url,
          publicId: null,
          name: req.file.originalname,
          mime: req.file.mimetype,
          size: req.file.size,
        };
        await deleteFileFromStorage(existing.file_url, existing.file_public_id);
      }

      const [document] = await sql`
        UPDATE site_documents SET
          document_name = ${documentName},
          document_type = ${String(req.body.document_type ?? existing.document_type ?? "").trim() || null},
          description = ${String(req.body.description ?? existing.description ?? "").trim() || null},
          file_url = ${file.url},
          file_public_id = ${file.publicId},
          file_name = ${file.name},
          file_mime_type = ${file.mime},
          file_size_bytes = ${file.size},
          updated_at = NOW()
        WHERE document_id = ${req.params.documentId} AND site_id = ${req.params.siteId}
        RETURNING *`;

      await logAdminAudit(req, "SiteManagement", "UpdateSiteDocument", "site_documents", document.document_id, sql.json({
        site_id: Number(req.params.siteId),
        file_replaced: Boolean(req.file),
      }));
      return ok(res, document, req.file ? "Site document replaced" : "Site document updated");
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.delete("/api/admin/sites/:siteId/documents/:documentId",
  verifyAdminToken,
  role("SuperAdmin","SiteManager"),
  async (req, res) => {
    try {
      await requireSiteDocumentsSchema();
      const [document] = await sql`
        DELETE FROM site_documents
        WHERE document_id = ${req.params.documentId} AND site_id = ${req.params.siteId}
        RETURNING document_id, file_url, file_public_id, file_mime_type`;
      if (!document) return err(res, "Site document not found", 404);
      await deleteFileFromStorage(document.file_url, document.file_public_id);
      await logAdminAudit(req, "SiteManagement", "DeleteSiteDocument", "site_documents", document.document_id, sql.json({
        site_id: Number(req.params.siteId),
      }));
      return ok(res, {}, "Site document deleted");
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.get("/api/admin/sites",
  verifyAdminToken,
  role("SuperAdmin","SiteManager","SupportStaff"),
  async (req, res) => {
    try {
      await ensureSiteHtmlMapSchema();
      const sites = await sql`
        SELECT s.site_id, s.site_name, s.site_prefix, s.city, s.state, s.full_address,
               s.description, s.starting_price, s.total_area, s.highlights,
               s.property_image_url, s.map_image_url, s.display_on_home_page,
               s.html_map_code, s.html_map_file_url, s.html_map_updated_at,
               s.site_status, s.has_govt_approval,
               s.total_plots AS planned_total_plots, s.created_at, s.updated_at,
               COUNT(p.plot_id)::int AS total_plots,
               COUNT(p.plot_id) FILTER (WHERE p.plot_status = 'Vacant')::int AS vacant,
               COUNT(p.plot_id) FILTER (WHERE p.plot_status = 'InProcess')::int AS in_process,
               COUNT(p.plot_id) FILTER (WHERE p.plot_status = 'Booked')::int AS booked,
               COUNT(p.plot_id) FILTER (WHERE p.plot_status = 'Sold')::int AS sold
        FROM sites s
        LEFT JOIN plots p ON p.site_id = s.site_id AND p.is_active = TRUE
        GROUP BY s.site_id, s.site_name, s.site_prefix, s.city, s.state, s.full_address,
                 s.description, s.starting_price, s.total_area, s.highlights,
                 s.property_image_url, s.map_image_url, s.display_on_home_page,
                 s.html_map_code, s.html_map_file_url, s.html_map_updated_at,
                 s.site_status, s.has_govt_approval, s.total_plots, s.created_at, s.updated_at
        ORDER BY s.site_id`;
      return ok(res, sites);
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.post("/api/admin/sites",
  verifyAdminToken,
  role("SuperAdmin","SiteManager"),
  upload.fields([
    { name: "property_image", maxCount: 1 },
    { name: "site_map", maxCount: 1 },
    { name: "html_map", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      await ensureSiteHtmlMapSchema();
      const {
        site_name, site_prefix, city, state, description, total_plots, site_status,
        starting_price, total_area, highlights, display_on_home_page,
      } = req.body;
      const full_address = req.body.full_address || req.body.address || null;
      if (!site_name || !city) return err(res, "site_name, city required", 400);
      let propertyImageUrl = null;
      let propertyImagePublicId = null;
      let mapUrl = null;
      let mapPublicId = null;
      const propertyFile = req.files?.property_image?.[0];
      const mapFile = req.files?.site_map?.[0];
      if (propertyFile) {
        const saved = await saveFileToVPS(propertyFile.buffer, { module: "site", entityId: site_name || "site", entityType: "SiteProperty", originalName: propertyFile.originalname });
        propertyImageUrl = saved.url;
        propertyImagePublicId = null;
      }
      if (mapFile) {
        const saved = await saveFileToVPS(mapFile.buffer, { module: "site", entityId: site_name || "site", entityType: "SiteMap", originalName: mapFile.originalname });
        mapUrl = saved.url;
        mapPublicId = null;
      }
      mapUrl = mapUrl || req.body.layout_map_url || null;
      const htmlMapCode = htmlMapFromRequest(req);
      const htmlMapUpdatedAt = htmlMapCode ? new Date() : null;
      const generatedPrefix = await uniqueSitePrefix(site_name, site_prefix);
      const [site] = await sql`
        INSERT INTO sites (
          site_name, site_prefix, city, state, full_address, description, total_plots,
          starting_price, total_area, highlights, property_image_url, property_image_public_id,
          display_on_home_page, site_status, map_image_url, map_public_id,
          html_map_code, html_map_file_url, html_map_updated_at, created_by_admin_id
        )
        VALUES (
          ${site_name}, ${generatedPrefix}, ${city}, ${state || "Uttar Pradesh"}, ${full_address || null},
          ${description || null}, ${Number(total_plots || 0)},
          ${starting_price ? Number(starting_price) : null}, ${total_area || null}, ${highlights || null},
          ${propertyImageUrl}, ${propertyImagePublicId}, ${parseBool(display_on_home_page, true)},
          ${site_status || "Active"}::site_status_enum, ${mapUrl}, ${mapPublicId},
          ${htmlMapCode}, ${null}, ${htmlMapUpdatedAt}, ${req.admin.admin_id}
        )
        RETURNING site_id, site_name`;
      if (htmlMapCode) {
        await sql`
          UPDATE sites
          SET html_map_file_url = ${`/api/sites/${site.site_id}/html-map`}
          WHERE site_id = ${site.site_id}`;
      }
      await logAdminAudit(req, "SiteManagement", "CreateSite", "sites", site.site_id, sql.json({ site_name, city }));
      return ok(res, site, "Site created", 201);
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.put("/api/admin/sites/:id",
  verifyAdminToken,
  role("SuperAdmin","SiteManager"),
  upload.fields([
    { name: "property_image", maxCount: 1 },
    { name: "site_map", maxCount: 1 },
    { name: "html_map", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      await ensureSiteHtmlMapSchema();
      const {
        site_name, site_prefix, city, state, description, total_plots, site_status, has_govt_approval,
        starting_price, total_area, highlights, display_on_home_page,
      } = req.body;
      const full_address = req.body.full_address || req.body.address || null;
      let propertyImageUrl = null;
      let propertyImagePublicId = null;
      let mapUrl = null;
      let mapPublicId = null;
      const [oldSite] = await sql`
        SELECT map_image_url, map_public_id, property_image_url, property_image_public_id FROM sites WHERE site_id = ${req.params.id}`;
      const propertyFile = req.files?.property_image?.[0];
      const mapFile = req.files?.site_map?.[0];
      if (propertyFile) {
        const saved = await saveFileToVPS(propertyFile.buffer, { module: "site", entityId: req.params.id, entityType: "SiteProperty", originalName: propertyFile.originalname });
        propertyImageUrl = saved.url;
        propertyImagePublicId = null;
        if (oldSite) {
          await deleteFileFromStorage(oldSite.property_image_url, oldSite.property_image_public_id);
        }
      }
      if (mapFile) {
        const saved = await saveFileToVPS(mapFile.buffer, { module: "site", entityId: req.params.id, entityType: "SiteMap", originalName: mapFile.originalname });
        mapUrl = saved.url;
        mapPublicId = null;
        if (oldSite) {
          await deleteFileFromStorage(oldSite.map_image_url, oldSite.map_public_id);
        }
      }
      mapUrl = mapUrl || req.body.layout_map_url || null;
      const htmlMapCode = htmlMapFromRequest(req);
      const htmlMapUpdatedAt = htmlMapCode ? new Date() : null;
      const generatedPrefix = site_name || site_prefix
        ? await uniqueSitePrefix(site_name || "", site_prefix || "", Number(req.params.id))
        : null;
      await sql`
        UPDATE sites SET
          site_name        = COALESCE(${site_name        || null}, site_name),
          site_prefix      = COALESCE(${generatedPrefix}, site_prefix),
          city             = COALESCE(${city             || null}, city),
          state            = COALESCE(${state            || null}, state),
          full_address     = COALESCE(${full_address     || null}, full_address),
          description      = COALESCE(${description      || null}, description),
          total_plots      = COALESCE(${total_plots ? Number(total_plots) : null}, total_plots),
          starting_price   = COALESCE(${starting_price ? Number(starting_price) : null}, starting_price),
          total_area       = COALESCE(${total_area       || null}, total_area),
          highlights       = COALESCE(${highlights       || null}, highlights),
          display_on_home_page = COALESCE(${display_on_home_page != null ? parseBool(display_on_home_page, true) : null}, display_on_home_page),
          site_status      = COALESCE(${site_status      || null}::site_status_enum, site_status),
          has_govt_approval= COALESCE(${has_govt_approval != null ? has_govt_approval : null}, has_govt_approval),
          property_image_url = COALESCE(${propertyImageUrl}, property_image_url),
          property_image_public_id = COALESCE(${propertyImagePublicId}, property_image_public_id),
          map_image_url    = COALESCE(${mapUrl}, map_image_url),
          map_public_id    = COALESCE(${mapPublicId}, map_public_id),
          html_map_code    = COALESCE(${htmlMapCode}, html_map_code),
          html_map_file_url = COALESCE(${htmlMapCode ? `/api/sites/${req.params.id}/html-map` : null}, html_map_file_url),
          html_map_updated_at = COALESCE(${htmlMapUpdatedAt}, html_map_updated_at),
          updated_at       = NOW()
        WHERE site_id = ${req.params.id}`;
      await logAdminAudit(req, "SiteManagement", "UpdateSite", "sites", req.params.id, sql.json(req.body || {}));
      return ok(res, {}, "Site updated");
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.delete("/api/admin/sites/:id",
  verifyAdminToken,
  role("SuperAdmin","SiteManager"),
  async (req, res) => {
    try {
      const siteId = req.params.id;
      const [usage] = await sql`
        SELECT
          COUNT(p.plot_id)::int AS plots,
          COUNT(b.booking_id)::int AS bookings
        FROM sites s
        LEFT JOIN plots p ON p.site_id = s.site_id AND p.is_active = TRUE
        LEFT JOIN bookings b ON b.plot_id = p.plot_id
        WHERE s.site_id = ${siteId}`;

      if (usage?.bookings > 0) {
        return err(res, "Site has linked bookings or sales. Marking inactive is safer than deleting.", 409);
      }
      if (usage?.plots > 0) {
        await sql`UPDATE plots SET is_active = FALSE, updated_at = NOW() WHERE site_id = ${siteId}`;
      }
      await sql`UPDATE sites SET site_status = 'Inactive', updated_at = NOW() WHERE site_id = ${siteId}`;
      return ok(res, {}, "Site deactivated safely");
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.post("/api/admin/sites/:siteId/html-map",
  verifyAdminToken,
  role("SuperAdmin","SiteManager"),
  upload.single("html_map"),
  async (req, res) => {
    try {
      await ensureSiteHtmlMapSchema();
      const siteId = req.params.siteId;
      const [site] = await sql`SELECT site_id FROM sites WHERE site_id = ${siteId}`;
      if (!site) return err(res, "Site not found", 404);
      const htmlMapCode = htmlMapFromRequest(req);
      if (!htmlMapCode) return err(res, "HTML map file or code is required.", 400);
      await sql`
        UPDATE sites
        SET html_map_code = ${htmlMapCode},
            html_map_file_url = ${`/api/sites/${siteId}/html-map`},
            html_map_updated_at = NOW(),
            updated_at = NOW()
        WHERE site_id = ${siteId}`;
      await logAdminAudit(req, "SiteManagement", "UpdateHtmlPlotMap", "sites", siteId, sql.json({ has_html_map: true }));
      return ok(res, {
        site_id: Number(siteId),
        html_map_file_url: `/api/sites/${siteId}/html-map`,
      }, "HTML plot map saved successfully.");
    } catch (e) {
      const status = /Only HTML files/.test(e.message) ? 400 : 500;
      return err(res, e.message, status);
    }
  }
);

app.post("/api/admin/sites/:id/map",
  verifyAdminToken,
  role("SuperAdmin","SiteManager"),
  upload.single("site_map"),
  async (req, res) => {
    try {
      if (!req.file) return err(res, "site_map image is required", 400);
      const [oldSite] = await sql`SELECT map_image_url, map_public_id FROM sites WHERE site_id = ${req.params.id}`;
      if (!oldSite) return err(res, "Site not found", 404);
      const saved = await saveFileToVPS(req.file.buffer, { module: "site", entityId: req.params.id, entityType: "SiteMap", originalName: req.file.originalname });
      await sql`
        UPDATE sites SET map_image_url = ${saved.url}, map_public_id = ${null}, updated_at = NOW()
        WHERE site_id = ${req.params.id}`;
      await deleteFileFromStorage(oldSite.map_image_url, oldSite.map_public_id);
      return ok(res, { map_image_url: saved.url }, "Map uploaded successfully");
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.post("/api/admin/sites/:id/map-image",
  verifyAdminToken,
  role("SuperAdmin","SiteManager"),
  upload.single("site_map"),
  async (req, res) => {
    try {
      if (!req.file) return err(res, "site_map image is required", 400);
      const [oldSite] = await sql`SELECT map_image_url, map_public_id FROM sites WHERE site_id = ${req.params.id}`;
      if (!oldSite) return err(res, "Site not found", 404);
      const saved = await saveFileToVPS(req.file.buffer, { module: "site", entityId: req.params.id, entityType: "SiteMap", originalName: req.file.originalname });
      await sql`
        UPDATE sites SET map_image_url = ${saved.url}, map_public_id = ${null}, updated_at = NOW()
        WHERE site_id = ${req.params.id}`;
      await deleteFileFromStorage(oldSite.map_image_url, oldSite.map_public_id);
      return ok(res, { map_image_url: saved.url }, "Map uploaded successfully");
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.post("/api/admin/sites/:id/property-image",
  verifyAdminToken,
  role("SuperAdmin","SiteManager"),
  upload.single("property_image"),
  async (req, res) => {
    try {
      if (!req.file) return err(res, "property_image is required", 400);
      const [oldSite] = await sql`SELECT property_image_url, property_image_public_id FROM sites WHERE site_id = ${req.params.id}`;
      if (!oldSite) return err(res, "Site not found", 404);
      const saved = await saveFileToVPS(req.file.buffer, { module: "site", entityId: req.params.id, entityType: "SiteProperty", originalName: req.file.originalname });
      await sql`
        UPDATE sites SET property_image_url = ${saved.url}, property_image_public_id = ${null}, updated_at = NOW()
        WHERE site_id = ${req.params.id}`;
      await deleteFileFromStorage(oldSite.property_image_url, oldSite.property_image_public_id);
      return ok(res, { property_image_url: saved.url }, "Property image uploaded successfully");
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.get("/api/admin/sites/:id/plots",
  verifyAdminToken,
  role("SuperAdmin","SiteManager","SupportStaff","FinanceManager"),
  async (req, res) => {
    try {
      const plots = await sql`
        SELECT
          p.plot_id, p.site_id, p.plot_number, p.plot_area, p.plot_category,
          p.base_price, p.down_payment, p.monthly_emi, p.emi_tenure_months,
          p.file_charge, p.plot_status, p.coordinates_x, p.coordinates_y,
          COALESCE(pc.coordinates, '[]'::jsonb) AS polygon_coordinates,
          pc.label_x, pc.label_y,
          d.size_label, d.width_ft, d.length_ft, d.facing_direction, d.is_corner_plot,
          d.road_width_ft, d.features, d.description AS extended_description,
          d.block_name, d.sector_name,
          b.booking_id, b.booking_serial, b.booking_date, b.booking_status,
          b.advance_amount AS booking_amount, b.advance_amount AS down_payment_paid,
          b.payment_type,
          u.user_id AS customer_id, u.member_id AS customer_member_id,
          u.full_name AS customer_name, u.mobile_no AS customer_mobile, u.email AS customer_email,
          COALESCE(pay.total_emi_paid, 0)::numeric AS emi_paid_amount,
          COALESCE(pay.total_paid, COALESCE(b.advance_amount, 0))::numeric AS total_paid,
          GREATEST(COALESCE(p.base_price, 0) - COALESCE(pay.total_paid, COALESCE(b.advance_amount, 0)), 0)::numeric AS remaining_payment,
          COALESCE(pay.pending_emi_count, 0)::int AS pending_emi_count,
          COALESCE(pay.proof_submitted_count, 0)::int AS proof_submitted_count,
          CASE
            WHEN b.booking_id IS NULL THEN 'No booking'
            WHEN b.booking_status = 'Cancelled' THEN 'Cancelled'
            WHEN COALESCE(pay.proof_submitted_count, 0) > 0 THEN 'Proof submitted'
            WHEN COALESCE(pay.pending_emi_count, 0) > 0 THEN 'Payment pending'
            WHEN b.booking_status = 'Confirmed' THEN 'Confirmed'
            ELSE b.booking_status::text
          END AS payment_status
        FROM plots p
        LEFT JOIN LATERAL (
          SELECT *
          FROM bookings b
          WHERE b.plot_id = p.plot_id
          ORDER BY
            CASE WHEN b.booking_status = 'Cancelled' THEN 1 ELSE 0 END,
            b.created_at DESC
          LIMIT 1
        ) b ON TRUE
        LEFT JOIN users u ON u.user_id = b.user_id
        LEFT JOIN LATERAL (
          SELECT
            COALESCE(SUM(e.paid_amount) FILTER (WHERE e.emi_status = 'Paid'), 0) AS total_emi_paid,
            COALESCE(b.advance_amount, 0) + COALESCE(SUM(e.paid_amount) FILTER (WHERE e.emi_status = 'Paid'), 0) AS total_paid,
            COUNT(*) FILTER (WHERE e.emi_status = 'Pending') AS pending_emi_count,
            COUNT(*) FILTER (WHERE e.emi_status = 'ProofSubmitted') AS proof_submitted_count
          FROM emi_schedules e
          WHERE e.booking_id = b.booking_id
        ) pay ON TRUE
        LEFT JOIN plot_polygon_coordinates pc ON pc.plot_id = p.plot_id
        LEFT JOIN plot_details_extended d ON d.plot_id = p.plot_id
        WHERE p.site_id = ${req.params.id} AND p.is_active = TRUE
        ORDER BY p.plot_number`;

      return ok(res, plots);
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.post("/api/admin/sites/:id/plots",
  verifyAdminToken,
  role("SuperAdmin","SiteManager"),
  async (req, res) => {
    try {
      const { plot_number, plot_area, plot_category,
              base_price, down_payment, monthly_emi, emi_tenure_months,
              file_charge, plot_status, coordinates_x, coordinates_y } = req.body;
      if (!plot_number || !plot_area || base_price == null)
        return err(res, "plot_number, plot_area, base_price required", 400);

      const [plot] = await sql`
        INSERT INTO plots (site_id, plot_number, plot_area, plot_category,
                           base_price, down_payment, monthly_emi, emi_tenure_months,
                           file_charge, plot_status, coordinates_x, coordinates_y,
                           created_by_admin_id)
        VALUES (${req.params.id}, ${plot_number}, ${plot_area},
                ${plot_category || (plot_area <= 50 ? "50gaj" : "100gaj")},
                ${base_price}, ${down_payment || 0}, ${monthly_emi || 0},
                ${emi_tenure_months || 60}, ${file_charge || 0},
                ${plot_status || "Vacant"}::plot_status_enum,
                ${coordinates_x || null}, ${coordinates_y || null}, ${req.admin.admin_id})
        RETURNING plot_id, plot_number, plot_status`;
      await logAdminAudit(req, "PlotManagement", "CreatePlot", "plots", plot.plot_id, sql.json({ site_id: req.params.id, plot_number }));
      return ok(res, plot, "Plot created", 201);
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.post("/api/admin/plots",
  verifyAdminToken,
  role("SuperAdmin","SiteManager"),
  async (req, res) => {
    try {
      const { site_id, plot_number, plot_area, plot_category,
              base_price, down_payment, monthly_emi, emi_tenure_months,
              file_charge, plot_status, coordinates_x, coordinates_y } = req.body;
      if (!site_id || !plot_number || !plot_area || base_price == null)
        return err(res, "site_id, plot_number, plot_area, base_price required", 400);

      const [plot] = await sql`
        INSERT INTO plots (site_id, plot_number, plot_area, plot_category,
                           base_price, down_payment, monthly_emi, emi_tenure_months,
                           file_charge, plot_status, coordinates_x, coordinates_y,
                           created_by_admin_id)
        VALUES (${site_id}, ${plot_number}, ${plot_area},
                ${plot_category || (plot_area <= 50 ? "50gaj" : "100gaj")},
                ${base_price}, ${down_payment || 0}, ${monthly_emi || 0},
                ${emi_tenure_months || 60}, ${file_charge || 0},
                ${plot_status || "Vacant"}::plot_status_enum,
                ${coordinates_x || null}, ${coordinates_y || null}, ${req.admin.admin_id})
        RETURNING plot_id, plot_number, plot_status`;
      await logAdminAudit(req, "PlotManagement", "CreatePlot", "plots", plot.plot_id, sql.json({ site_id, plot_number }));
      return ok(res, plot, "Plot created", 201);
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.put("/api/admin/plots/:id",
  verifyAdminToken,
  role("SuperAdmin","SiteManager"),
  async (req, res) => {
    try {
      const { plot_number, plot_area, plot_category, base_price, down_payment,
              monthly_emi, emi_tenure_months, file_charge, plot_status,
              coordinates_x, coordinates_y, reason } = req.body;
      const [oldPlot] = await sql`SELECT plot_status FROM plots WHERE plot_id = ${req.params.id}`;
      if (!oldPlot) return err(res, "Plot not found", 404);
      if (plot_status && plot_status !== oldPlot.plot_status && !reason) {
        return err(res, "reason required when changing plot_status", 400);
      }

      const [plot] = await sql`
        UPDATE plots SET
          plot_number = COALESCE(${plot_number || null}, plot_number),
          plot_area = COALESCE(${plot_area ? Number(plot_area) : null}, plot_area),
          plot_category = COALESCE(${plot_category || null}::plot_category_enum, plot_category),
          base_price = COALESCE(${base_price ? Number(base_price) : null}, base_price),
          down_payment = COALESCE(${down_payment != null ? Number(down_payment) : null}, down_payment),
          monthly_emi = COALESCE(${monthly_emi != null ? Number(monthly_emi) : null}, monthly_emi),
          emi_tenure_months = COALESCE(${emi_tenure_months ? Number(emi_tenure_months) : null}, emi_tenure_months),
          file_charge = COALESCE(${file_charge != null ? Number(file_charge) : null}, file_charge),
          plot_status = COALESCE(${plot_status || null}::plot_status_enum, plot_status),
          coordinates_x = ${coordinates_x ?? null},
          coordinates_y = ${coordinates_y ?? null},
          updated_at = NOW()
        WHERE plot_id = ${req.params.id}
        RETURNING plot_id, plot_number, plot_status`;
      if (!plot) return err(res, "Plot not found", 404);
      if (plot_status && plot_status !== oldPlot.plot_status) {
        await sql`
          INSERT INTO plot_status_history (plot_id, old_status, new_status, changed_by_admin_id, reason)
          VALUES (${req.params.id}, ${oldPlot.plot_status}::plot_status_enum,
                  ${plot_status}::plot_status_enum, ${req.admin.admin_id}, ${reason})`;
        await addPlotBookingHistory({
          plotId: req.params.id,
          eventType: "StatusChangedByAdmin",
          eventNote: reason,
          triggeredByAdmin: req.admin.admin_id,
          plotStatusAtTime: plot_status,
        });
      }
      await logAdminAudit(req, "PlotManagement", "UpdatePlot", "plots", req.params.id, sql.json(req.body || {}));
      return ok(res, plot, "Plot updated");
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.delete("/api/admin/plots/:id",
  verifyAdminToken,
  role("SuperAdmin","SiteManager"),
  async (req, res) => {
    try {
      const [booking] = await sql`SELECT booking_id FROM bookings WHERE plot_id = ${req.params.id} LIMIT 1`;
      if (booking) return err(res, "Plot has linked booking/payment records. Delete is blocked.", 409);
      const [plot] = await sql`
        UPDATE plots SET is_active = FALSE, updated_at = NOW()
        WHERE plot_id = ${req.params.id}
        RETURNING plot_id`;
      if (!plot) return err(res, "Plot not found", 404);
      return ok(res, {}, "Plot deleted safely");
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.put("/api/admin/plots/:id/status",
  verifyAdminToken,
  role("SuperAdmin","SiteManager"),
  async (req, res) => {
    try {
      const { new_status, reason } = req.body;
      if (!new_status) return err(res, "new_status required", 400);
      if (!reason) return err(res, "reason required", 400);

      const [plot] = await sql`SELECT plot_status FROM plots WHERE plot_id = ${req.params.id}`;
      if (!plot) return err(res, "Plot not found", 404);

      await sql`UPDATE plots SET plot_status = ${new_status}::plot_status_enum, updated_at = NOW() WHERE plot_id = ${req.params.id}`;
      await sql`
        INSERT INTO plot_status_history (plot_id, old_status, new_status, changed_by_admin_id, reason)
        VALUES (${req.params.id}, ${plot.plot_status}::plot_status_enum,
                ${new_status}::plot_status_enum, ${req.admin.admin_id}, ${reason || null})`;
      await addPlotBookingHistory({
        plotId: req.params.id,
        eventType: "StatusChanged",
        eventNote: reason || null,
        triggeredByAdmin: req.admin.admin_id,
        plotStatusAtTime: new_status,
      });
      await logPlotAudit(req, "StatusChanged", req.params.id);

      return ok(res, {}, "Plot status updated");
    } catch (e) {
      return err(res, e.message);
    }
  }
);

/* ==========================
   ─────────────────────────
   ADMIN — COMMISSION
   GET  /api/admin/commissions/pending
   POST /api/admin/commissions/:id/approve
   ─────────────────────────
========================== */

app.get("/api/emi-calculator/plans", async (req, res) => {
  try {
    await requireEmiCalculatorSchema();
    const plans = await sql`
      SELECT id, plot_size, plot_price, down_payment, loan_amount,
             interest_rate, tenure_months, monthly_emi, processing_fee,
             display_order, is_active, created_at, updated_at
      FROM emi_calculator_master
      WHERE is_active = TRUE
      ORDER BY display_order ASC, id ASC`;
    return ok(res, plans);
  } catch (e) {
    return err(res, e.message);
  }
});

app.get("/api/emi-calculator/details/:plotSize", async (req, res) => {
  try {
    await requireEmiCalculatorSchema();
    const plotSize = decodeURIComponent(req.params.plotSize || "");
    const [plan] = await sql`
      SELECT id, plot_size, plot_price, down_payment, loan_amount,
             interest_rate, tenure_months, monthly_emi, processing_fee,
             display_order, is_active, created_at, updated_at
      FROM emi_calculator_master
      WHERE is_active = TRUE AND LOWER(plot_size) = LOWER(${plotSize})
      ORDER BY display_order ASC, id ASC
      LIMIT 1`;
    if (!plan) return err(res, "EMI plan not found", 404);
    return ok(res, plan);
  } catch (e) {
    return err(res, e.message);
  }
});

app.get("/api/admin/emi-calculator",
  verifyAdminToken,
  role("SuperAdmin","FinanceManager","SiteManager"),
  async (req, res) => {
    try {
      await requireEmiCalculatorSchema();
      const {
        search = "",
        status = "",
        sort_by = "display_order",
        sort_dir = "asc",
        page = 1,
        limit = 10,
      } = req.query;
      const pageNumber = Math.max(Number(page) || 1, 1);
      const pageSize = Math.min(Math.max(Number(limit) || 10, 1), 100);
      const offset = (pageNumber - 1) * pageSize;
      const searchTerm = `%${String(search || "").trim()}%`;
      const statusFilter = String(status || "");
      const sortable = {
        plot_size: sql`plot_size`,
        plot_price: sql`plot_price`,
        down_payment: sql`down_payment`,
        interest_rate: sql`interest_rate`,
        tenure_months: sql`tenure_months`,
        monthly_emi: sql`monthly_emi`,
        display_order: sql`display_order`,
        created_at: sql`created_at`,
      };
      const sortColumn = sortable[sort_by] || sortable.display_order;
      const sortDirection = String(sort_dir).toLowerCase() === "desc" ? sql`DESC` : sql`ASC`;

      const rows = await sql`
        SELECT id, plot_size, plot_price, down_payment, loan_amount,
               interest_rate, tenure_months, monthly_emi, processing_fee,
               display_order, is_active, created_at, updated_at,
               COUNT(*) OVER() AS total_count
        FROM emi_calculator_master
        WHERE (${searchTerm} = '%%' OR plot_size ILIKE ${searchTerm})
          AND (${statusFilter} = '' OR is_active = ${statusFilter === "active"})
        ORDER BY ${sortColumn} ${sortDirection}, id ASC
        LIMIT ${pageSize} OFFSET ${offset}`;
      const total = Number(rows[0]?.total_count || 0);
      return ok(res, {
        items: rows.map(({ total_count, ...row }) => row),
        total,
        page: pageNumber,
        limit: pageSize,
        total_pages: Math.max(Math.ceil(total / pageSize), 1),
      });
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.get("/api/admin/emi-calculator/:id",
  verifyAdminToken,
  role("SuperAdmin","FinanceManager","SiteManager"),
  async (req, res) => {
    try {
      await requireEmiCalculatorSchema();
      const [plan] = await sql`SELECT * FROM emi_calculator_master WHERE id = ${req.params.id}`;
      if (!plan) return err(res, "EMI plan not found", 404);
      return ok(res, plan);
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.post("/api/admin/emi-calculator",
  verifyAdminToken,
  role("SuperAdmin","FinanceManager","SiteManager"),
  async (req, res) => {
    try {
      await requireEmiCalculatorSchema();
      const planData = normalizeEmiPlanPayload(req.body);
      const [plan] = await sql`
        INSERT INTO emi_calculator_master (
          plot_size, plot_price, down_payment, loan_amount, interest_rate,
          tenure_months, monthly_emi, processing_fee, display_order, is_active
        ) VALUES (
          ${planData.plot_size}, ${planData.plot_price}, ${planData.down_payment},
          ${planData.loan_amount}, ${planData.interest_rate}, ${planData.tenure_months},
          ${planData.monthly_emi}, ${planData.processing_fee}, ${planData.display_order},
          ${planData.is_active}
        )
        RETURNING *`;
      await logAdminAudit(req, "FinanceManagement", "CreateEmiCalculatorPlan", "emi_calculator_master", plan.id, sql.json(planData));
      return ok(res, plan, "EMI plan created", 201);
    } catch (e) {
      return err(res, e.message, /required|valid|cannot/.test(e.message) ? 400 : 500);
    }
  }
);

app.put("/api/admin/emi-calculator/:id",
  verifyAdminToken,
  role("SuperAdmin","FinanceManager","SiteManager"),
  async (req, res) => {
    try {
      await requireEmiCalculatorSchema();
      const planData = normalizeEmiPlanPayload(req.body);
      const [plan] = await sql`
        UPDATE emi_calculator_master SET
          plot_size = ${planData.plot_size},
          plot_price = ${planData.plot_price},
          down_payment = ${planData.down_payment},
          loan_amount = ${planData.loan_amount},
          interest_rate = ${planData.interest_rate},
          tenure_months = ${planData.tenure_months},
          monthly_emi = ${planData.monthly_emi},
          processing_fee = ${planData.processing_fee},
          display_order = ${planData.display_order},
          is_active = ${planData.is_active},
          updated_at = NOW()
        WHERE id = ${req.params.id}
        RETURNING *`;
      if (!plan) return err(res, "EMI plan not found", 404);
      await logAdminAudit(req, "FinanceManagement", "UpdateEmiCalculatorPlan", "emi_calculator_master", req.params.id, sql.json(planData));
      return ok(res, plan, "EMI plan updated");
    } catch (e) {
      return err(res, e.message, /required|valid|cannot/.test(e.message) ? 400 : 500);
    }
  }
);

app.delete("/api/admin/emi-calculator/:id",
  verifyAdminToken,
  role("SuperAdmin","FinanceManager","SiteManager"),
  async (req, res) => {
    try {
      await requireEmiCalculatorSchema();
      const [plan] = await sql`DELETE FROM emi_calculator_master WHERE id = ${req.params.id} RETURNING id`;
      if (!plan) return err(res, "EMI plan not found", 404);
      await logAdminAudit(req, "FinanceManagement", "DeleteEmiCalculatorPlan", "emi_calculator_master", req.params.id);
      return ok(res, {}, "EMI plan deleted");
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.get("/api/admin/associates/:id",
  verifyAdminToken,
  role("SuperAdmin","FinanceManager","SiteManager"),
  async (req, res) => {
    try {
      await requireMlmSchema();
      const [profile] = await sql`
        SELECT u.*, sp.full_name AS sponsor_name, sp.member_id AS sponsor_member_id,
               COALESCE(r.rank_name, 'Associate') AS rank_name,
               COALESCE(t.total_gaj_sold, 0) AS total_gaj_sold,
               COALESCE(t.total_commission_earned, 0) AS total_commission_earned
        FROM users u
        LEFT JOIN users sp ON sp.user_id = u.sponsor_user_id
        LEFT JOIN associate_sales_tracker t ON t.associate_user_id = u.user_id
        LEFT JOIN associate_ranks r ON r.rank_id = t.current_rank_id
        WHERE u.user_id = ${req.params.id} AND u.user_type = 'Associate'`;
      if (!profile) return err(res, "Associate not found", 404);
      const [directReferrals, commissions, payouts, statusHistory] = await Promise.all([
        sql`SELECT rr.*, u.full_name, u.member_id, u.account_status FROM referral_registrations rr JOIN users u ON u.user_id = rr.referred_user_id WHERE rr.sponsor_user_id = ${req.params.id} ORDER BY rr.created_at DESC LIMIT 50`,
        sql`SELECT * FROM commission_transactions WHERE associate_user_id = ${req.params.id} ORDER BY created_at DESC LIMIT 50`,
        sql`SELECT * FROM associate_payout_requests WHERE associate_user_id = ${req.params.id} ORDER BY requested_at DESC LIMIT 50`,
        sql`SELECT * FROM associate_status_history WHERE associate_user_id = ${req.params.id} ORDER BY changed_at DESC LIMIT 50`,
      ]);
      return ok(res, { profile, direct_referrals: directReferrals, commissions, payouts, status_history: statusHistory });
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.get("/api/admin/associates",
  verifyAdminToken,
  role("SuperAdmin","FinanceManager","SiteManager"),
  async (req, res) => {
    try {
      await requireMlmSchema();
      const { search = "", status = "", rank = "", sponsor = "", page = 1, limit = 30 } = req.query;
      const pageNumber = Math.max(Number(page) || 1, 1);
      const pageSize = Math.min(Math.max(Number(limit) || 30, 1), 100);
      const searchTerm = `%${String(search || "").trim()}%`;
      const rows = await sql`
        SELECT u.user_id, u.member_id, u.full_name, u.email, u.mobile_no, u.account_status,
               u.invitation_code, u.registered_at, sp.full_name AS sponsor_name,
               COALESCE(r.rank_name, 'Associate') AS rank_name,
               COALESCE(t.total_gaj_sold, 0) AS total_gaj_sold,
               COALESCE(t.total_commission_earned, 0) AS total_commission_earned,
               COUNT(*) OVER() AS total_count
        FROM users u
        LEFT JOIN users sp ON sp.user_id = u.sponsor_user_id
        LEFT JOIN associate_sales_tracker t ON t.associate_user_id = u.user_id
        LEFT JOIN associate_ranks r ON r.rank_id = t.current_rank_id
        WHERE u.user_type = 'Associate'
          AND (${searchTerm} = '%%' OR u.full_name ILIKE ${searchTerm} OR u.member_id ILIKE ${searchTerm} OR u.mobile_no ILIKE ${searchTerm})
          AND (${String(status)} = '' OR u.account_status = ${String(status)})
          AND (${String(rank)} = '' OR r.rank_name = ${String(rank)})
          AND (${String(sponsor)} = '' OR sp.member_id = ${String(sponsor)} OR sp.full_name ILIKE ${`%${String(sponsor)}%`})
        ORDER BY u.registered_at DESC
        LIMIT ${pageSize} OFFSET ${(pageNumber - 1) * pageSize}`;
      const total = Number(rows[0]?.total_count || 0);
      return ok(res, { items: rows.map(({ total_count, ...row }) => row), total, page: pageNumber, limit: pageSize });
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.get("/api/admin/associates/:id/network-tree",
  verifyAdminToken,
  role("SuperAdmin","FinanceManager","SiteManager"),
  async (req, res) => {
    try {
      await requireMlmSchema();
      await syncMlmTreeAndReferrals();
      const rows = await sql`
        SELECT u.user_id, u.member_id, u.full_name, u.user_type, u.sponsor_user_id,
               u.account_status AS status, COALESCE(r.rank_name, 'Associate') AS rank,
               COALESCE(t.total_gaj_sold, 0) AS total_gaj_sold,
               COALESCE(t.total_commission_earned, 0) AS commission_earned
        FROM mlm_tree_closure c
        JOIN users u ON u.user_id = c.descendant_user_id
        LEFT JOIN associate_sales_tracker t ON t.associate_user_id = u.user_id
        LEFT JOIN associate_ranks r ON r.rank_id = t.current_rank_id
        WHERE c.ancestor_user_id = ${req.params.id}
        ORDER BY c.depth, u.full_name`;
      const byId = new Map(rows.map(row => [row.user_id, { ...row, children: [] }]));
      const root = byId.get(Number(req.params.id)) || { children: [] };
      for (const node of byId.values()) {
        if (node.user_id === Number(req.params.id)) continue;
        const parent = byId.get(node.sponsor_user_id);
        (parent || root).children.push(node);
      }
      return ok(res, root);
    } catch (e) {
      return err(res, e.message);
    }
  }
);

const changeAssociateStatus = async (req, res, newStatus) => {
  try {
    await requireMlmSchema();
    const { reason = null, duration_days = null } = req.body || {};
    const [old] = await sql`SELECT account_status FROM users WHERE user_id = ${req.params.id} AND user_type = 'Associate'`;
    if (!old) return err(res, "Associate not found", 404);
    await sql`UPDATE users SET account_status = ${newStatus}, updated_at = NOW() WHERE user_id = ${req.params.id}`;
    await sql`
      INSERT INTO associate_status_history (associate_user_id, old_status, new_status, reason, duration_days, changed_by_admin_id)
      VALUES (${req.params.id}, ${old.account_status}, ${newStatus}, ${reason}, ${duration_days ? Number(duration_days) : null}, ${req.admin.admin_id})`;
    if (newStatus === "Blacklisted") {
      await sql`
        INSERT INTO blacklist_registry (user_id, blacklisted_by_admin_id, blacklist_reason)
        VALUES (${req.params.id}, ${req.admin.admin_id}, ${reason || 'Blacklisted by admin'})`;
    }
    await logAdminAudit(req, "MLM", `Associate${newStatus}`, "users", req.params.id, sql.json({ reason, duration_days }));
    return ok(res, {}, `Associate marked ${newStatus}`);
  } catch (e) {
    return err(res, e.message);
  }
};

app.post("/api/admin/associates/:id/suspend", verifyAdminToken, role("SuperAdmin","FinanceManager"), (req, res) => changeAssociateStatus(req, res, "Suspended"));
app.post("/api/admin/associates/:id/activate", verifyAdminToken, role("SuperAdmin","FinanceManager"), (req, res) => changeAssociateStatus(req, res, "Active"));
app.post("/api/admin/associates/:id/blacklist", verifyAdminToken, role("SuperAdmin","FinanceManager"), (req, res) => changeAssociateStatus(req, res, "Blacklisted"));
app.post("/api/admin/associates/:id/unblacklist", verifyAdminToken, role("SuperAdmin"), (req, res) => changeAssociateStatus(req, res, "Active"));

app.get("/api/admin/commissions",
  verifyAdminToken,
  role("SuperAdmin","FinanceManager"),
  async (req, res) => {
    try {
      const { status = "", associate_id = "", booking_id = "", from = "", to = "", page = 1, limit = 30 } = req.query;
      const pageNumber = Math.max(Number(page) || 1, 1);
      const pageSize = Math.min(Math.max(Number(limit) || 30, 1), 100);
      const rows = await sql`
        SELECT c.*, u.full_name AS associate_name, u.member_id, b.booking_serial, p.plot_number, s.site_name,
               COUNT(*) OVER() AS total_count
        FROM commission_transactions c
        JOIN users u ON u.user_id = c.associate_user_id
        LEFT JOIN bookings b ON b.booking_id = c.related_booking_id
        LEFT JOIN plots p ON p.plot_id = b.plot_id
        LEFT JOIN sites s ON s.site_id = p.site_id
        WHERE (${String(status)} = '' OR c.commission_status = ${String(status)})
          AND (${String(associate_id)} = '' OR c.associate_user_id = ${Number(associate_id) || 0})
          AND (${String(booking_id)} = '' OR c.related_booking_id = ${Number(booking_id) || 0})
          AND (${String(from)} = '' OR c.created_at::date >= ${String(from) || null}::date)
          AND (${String(to)} = '' OR c.created_at::date <= ${String(to) || null}::date)
        ORDER BY c.created_at DESC
        LIMIT ${pageSize} OFFSET ${(pageNumber - 1) * pageSize}`;
      const total = Number(rows[0]?.total_count || 0);
      return ok(res, { items: rows.map(({ total_count, ...row }) => row), total, page: pageNumber, limit: pageSize });
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.post("/api/admin/commissions/generate/:bookingId",
  verifyAdminToken,
  role("SuperAdmin","FinanceManager"),
  async (req, res) => {
    try {
      const [booking] = await sql`
        SELECT b.booking_id, b.payment_type, b.advance_amount, p.base_price
        FROM bookings b
        JOIN plots p ON p.plot_id = b.plot_id
        WHERE b.booking_id = ${req.params.bookingId}`;
      if (!booking) return err(res, "Booking not found", 404);
      const amount = Number(req.body?.received_amount || (
        booking.payment_type === "FullPayment" ? booking.base_price : booking.advance_amount
      ));
      const result = await generateCommissionForPayment(req, {
        bookingId: booking.booking_id,
        sourceType: "Manual",
        sourceId: String(req.body?.source_reference || `manual-${Date.now()}`),
        receivedAmount: amount,
        paymentType: booking.payment_type,
      });
      await logAdminAudit(req, "MLM", "GenerateCommission", "bookings", req.params.bookingId, sql.json(result));
      return ok(res, result, "Commission generation completed");
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.post("/api/admin/bookings/:id/partial-payment/approve",
  verifyAdminToken,
  role("SuperAdmin","FinanceManager"),
  async (req, res) => {
    try {
      const bookingId = Number(req.params.id);
      const receivedAmount = Number(req.body?.received_amount || 0);
      const reference = String(req.body?.payment_reference || "").trim();
      if (!(receivedAmount > 0)) return err(res, "received_amount must be greater than zero", 400);
      if (!reference) return err(res, "payment_reference is required", 400);
      const [booking] = await sql`SELECT booking_id FROM bookings WHERE booking_id = ${bookingId}`;
      if (!booking) return err(res, "Booking not found", 404);
      const result = await generateCommissionForPayment(req, {
        bookingId,
        sourceType: "PartialPayment",
        sourceId: `partial-${reference}`,
        receivedAmount,
        paymentType: "Partial",
      });
      await logAdminAudit(req, "MLM", "GenerateCommissionOnPartialPayment", "bookings", bookingId, sql.json({
        received_amount: receivedAmount,
        payment_reference: reference,
        commission: result,
      }));
      return ok(res, result, "Partial payment commission generated.");
    } catch (e) {
      return err(res, e.message, 400);
    }
  }
);

app.post("/api/admin/commissions/:id/reject",
  verifyAdminToken,
  role("SuperAdmin","FinanceManager"),
  async (req, res) => {
    try {
      const reason = req.body?.reason || "Rejected by admin";
      await requireMlmSchema();
      const [commission] = await sql`
        UPDATE commission_transactions SET commission_status = 'Rejected', updated_at = NOW()
        WHERE commission_id = ${req.params.id}
        RETURNING *`;
      if (!commission) return err(res, "Commission not found", 404);
      await sql`UPDATE commission_monthly_schedule SET status = 'Cancelled' WHERE commission_id = ${req.params.id}`;
      await logAdminAudit(req, "MLM", "RejectCommission", "commission_transactions", req.params.id, sql.json({ reason }));
      return ok(res, commission, "Commission rejected");
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.post("/api/admin/commissions/:id/adjust",
  verifyAdminToken,
  role("SuperAdmin"),
  async (req, res) => {
    try {
      const amount = Number(req.body?.net_amount);
      if (!Number.isFinite(amount) || amount < 0) return err(res, "valid net_amount required", 400);
      const [commission] = await sql`
        UPDATE commission_transactions SET net_amount = ${amount}, updated_at = NOW()
        WHERE commission_id = ${req.params.id}
        RETURNING *`;
      if (!commission) return err(res, "Commission not found", 404);
      await logAdminAudit(req, "MLM", "AdjustCommission", "commission_transactions", req.params.id, sql.json(req.body || {}));
      return ok(res, commission, "Commission adjusted");
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.get("/api/admin/commission-rules", verifyAdminToken, role("SuperAdmin","FinanceManager"), async (_req, res) => {
  try {
    await requireMlmSchema();
    return ok(res, await sql`SELECT * FROM commission_rules ORDER BY commission_type, level_depth`);
  } catch (e) {
    return err(res, e.message);
  }
});

app.get("/api/commission-engine/summary", verifyUserToken, async (_req, res) => {
  try {
    const snapshot = await commissionEngineSnapshot();
    return ok(res, {
      commission_model: snapshot.commission_model,
      maximum_levels: snapshot.maximum_levels,
      direct_percentage: snapshot.direct_percentage,
      upline_percentage: snapshot.upline_percentage,
      seller_percentage: snapshot.seller_percentage,
      equal_distribution_percentage: snapshot.equal_distribution_percentage,
      equal_distribution_enabled: snapshot.equal_distribution_enabled,
      distribution_scope: snapshot.distribution_scope,
      payment_mode_rules: snapshot.payment_mode_rules,
      eligibility_rules: snapshot.eligibility_rules,
      bonus_rules: snapshot.bonus_rules,
      is_active: snapshot.is_active,
      version: snapshot.version,
      levels: snapshot.levels.filter(level => level.is_active),
    });
  } catch (e) {
    return err(res, e.message);
  }
});

app.get("/api/admin/commission-engine/settings",
  verifyAdminToken,
  role("SuperAdmin","FinanceManager"),
  async (_req, res) => {
    try {
      const snapshot = await commissionEngineSnapshot();
      return ok(res, snapshot);
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.put("/api/admin/commission-engine/settings",
  verifyAdminToken,
  role("SuperAdmin","FinanceManager"),
  async (req, res) => {
    try {
      await requireCommissionEngineSchema();
      if (req.body?.confirmed !== true) {
        return err(res, "Commission model change requires explicit confirmation.", 400);
      }
      const reason = String(req.body?.reason || "").trim();
      if (!reason) return err(res, "Change reason is required.", 400);
      const commissionModel = String(req.body?.commission_model || "");
      if (!["Upline", "LevelWise", "EqualDistribution"].includes(commissionModel)) return err(res, "Invalid commission model.", 400);
      const maximumLevels = Number(req.body?.maximum_levels || 1);
      if (!Number.isInteger(maximumLevels) || maximumLevels < 1 || maximumLevels > 50) {
        return err(res, "Maximum levels must be between 1 and 50.", 400);
      }
      const directPercentage = Number(req.body?.direct_percentage || 0);
      const uplinePercentage = Number(req.body?.upline_percentage || 0);
      const sellerPercentage = Number(req.body?.seller_percentage ?? 50);
      const equalDistributionPercentage = Number(req.body?.equal_distribution_percentage ?? (100 - sellerPercentage));
      if ([directPercentage, uplinePercentage, sellerPercentage, equalDistributionPercentage].some(value => !Number.isFinite(value) || value < 0 || value > 100)) {
        return err(res, "Commission percentages must be between 0 and 100.", 400);
      }
      if (commissionModel === "EqualDistribution" && Math.round((sellerPercentage + equalDistributionPercentage) * 10000) / 10000 !== 100) {
        return err(res, "Seller Commission % and Equal Distribution % must total 100%.", 400);
      }
      const distributionScope = String(req.body?.distribution_scope || "TopAssociateNetwork");
      if (!["TopAssociateNetwork"].includes(distributionScope)) {
        return err(res, "Invalid distribution scope.", 400);
      }
      const levels = Array.isArray(req.body?.levels) ? req.body.levels : [];
      if (commissionModel === "LevelWise") {
        if (!levels.length) return err(res, "At least one level configuration is required.", 400);
        for (const level of levels) {
          const levelNo = Number(level.level_no);
          const percentage = Number(level.percentage);
          if (!Number.isInteger(levelNo) || levelNo < 1 || levelNo > maximumLevels) {
            return err(res, "Each level number must be within Maximum Levels.", 400);
          }
          if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) {
            return err(res, "Each level percentage must be between 0 and 100.", 400);
          }
        }
      }

      const updated = await sql.begin(async (db) => {
        await db`SELECT pg_advisory_xact_lock(hashtext('commission-engine-settings'))`;
        const oldSnapshot = await commissionEngineSnapshot(db);
        const [settingsRow] = await db`
          UPDATE commission_engine_settings SET
            commission_model = ${commissionModel},
            maximum_levels = ${maximumLevels},
            direct_percentage = ${directPercentage},
            upline_percentage = ${uplinePercentage},
            seller_percentage = ${sellerPercentage},
            equal_distribution_percentage = ${equalDistributionPercentage},
            equal_distribution_enabled = ${parseBool(req.body?.equal_distribution_enabled, true)},
            distribution_scope = ${distributionScope},
            payment_mode_rules = ${sql.json(req.body?.payment_mode_rules || { full_payment: "instant", emi: "installment_wise" })},
            eligibility_rules = ${sql.json(req.body?.eligibility_rules || {})},
            bonus_rules = ${sql.json(req.body?.bonus_rules || {})},
            is_active = ${parseBool(req.body?.is_active, true)},
            version = version + 1,
            updated_by_admin_id = ${req.admin.admin_id},
            updated_at = NOW()
          WHERE id = 1
          RETURNING *`;

        if (commissionModel === "LevelWise") {
          await db`
            UPDATE commission_engine_levels
            SET is_active = FALSE, updated_at = NOW()
            WHERE settings_id = 1 AND commission_model = 'LevelWise'`;
          for (const level of levels) {
            await db`
              INSERT INTO commission_engine_levels (
                settings_id, commission_model, level_no, percentage, is_active, updated_at
              ) VALUES (
                1, 'LevelWise', ${Number(level.level_no)}, ${Number(level.percentage)},
                ${parseBool(level.is_active, true)}, NOW()
              )
              ON CONFLICT (settings_id, commission_model, level_no) DO UPDATE SET
                percentage = EXCLUDED.percentage,
                is_active = EXCLUDED.is_active,
                updated_at = NOW()`;
          }
        }

        const newLevels = await db`
          SELECT level_no, percentage, is_active
          FROM commission_engine_levels
          WHERE settings_id = 1 AND commission_model = ${commissionModel}
          ORDER BY level_no`;
        const newSnapshot = { ...settingsRow, levels: newLevels };
        await db`
          INSERT INTO commission_engine_audit (
            settings_id, old_value, new_value, changed_by_admin_id, reason
          ) VALUES (
            1, ${sql.json(oldSnapshot)}, ${sql.json(newSnapshot)}, ${req.admin.admin_id}, ${reason}
          )`;
        return newSnapshot;
      });
      await logAdminAudit(req, "MLM", "UpdateCommissionEngine", "commission_engine_settings", 1, sql.json({ reason, version: updated.version }));
      return ok(res, updated, "Commission engine updated. Future transactions will use the new model.");
    } catch (e) {
      return err(res, e.message, 400);
    }
  }
);

app.get("/api/admin/commission-engine/audit",
  verifyAdminToken,
  role("SuperAdmin","FinanceManager"),
  async (req, res) => {
    try {
      await requireCommissionEngineSchema();
      const page = Math.max(Number(req.query.page) || 1, 1);
      const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
      const rows = await sql`
        SELECT a.*, admin.full_name AS changed_by
        FROM commission_engine_audit a
        LEFT JOIN admin_users admin ON admin.admin_id = a.changed_by_admin_id
        ORDER BY a.changed_at DESC
        LIMIT ${limit} OFFSET ${(page - 1) * limit}`;
      const [count] = await sql`SELECT COUNT(audit_id)::int AS total FROM commission_engine_audit`;
      return ok(res, { items: rows, total: count.total, page, limit });
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.post("/api/admin/commission-rules", verifyAdminToken, role("SuperAdmin","FinanceManager"), async (req, res) => {
  try {
    await requireMlmSchema();
    const commissionType = String(req.body.commission_type || "").trim();
    const levelDepth = Number(req.body.level_depth || 1);
    const plotAreaUnit = String(req.body.plot_area_unit || "gaj").trim().toLowerCase();
    const isActive = parseBool(req.body.is_active, true);
    if (!["Direct", "Upline", "Bonus", "Monthly"].includes(commissionType)) return err(res, "Invalid commission type", 400);
    if (!Number.isInteger(levelDepth) || levelDepth < 1) return err(res, "Level depth must be a positive whole number", 400);
    if (isActive) {
      const [existing] = await sql`
        SELECT rule_id FROM commission_rules
        WHERE commission_type = ${commissionType}
          AND level_depth = ${levelDepth}
          AND plot_area_unit = ${plotAreaUnit}
          AND is_active = TRUE`;
      if (existing) return err(res, "An active commission rule already exists for this type, level and area unit.", 409);
    }
    const [rule] = await sql`
      INSERT INTO commission_rules (commission_type, level_depth, plot_area_unit, amount_per_100_gaj, duration_months, is_active)
      VALUES (${commissionType}, ${levelDepth}, ${plotAreaUnit},
              ${Number(req.body.amount_per_100_gaj || 0)}, ${Number(req.body.duration_months || 144)}, ${isActive})
      RETURNING *`;
    return ok(res, rule, "Commission rule created", 201);
  } catch (e) {
    return err(res, e.message);
  }
});

app.put("/api/admin/commission-rules/:id", verifyAdminToken, role("SuperAdmin","FinanceManager"), async (req, res) => {
  try {
    await requireMlmSchema();
    const commissionType = String(req.body.commission_type || "").trim();
    const levelDepth = Number(req.body.level_depth || 1);
    const plotAreaUnit = String(req.body.plot_area_unit || "gaj").trim().toLowerCase();
    const isActive = parseBool(req.body.is_active, true);
    if (!["Direct", "Upline", "Bonus", "Monthly"].includes(commissionType)) return err(res, "Invalid commission type", 400);
    if (!Number.isInteger(levelDepth) || levelDepth < 1) return err(res, "Level depth must be a positive whole number", 400);
    if (isActive) {
      const [duplicate] = await sql`
        SELECT rule_id FROM commission_rules
        WHERE rule_id <> ${req.params.id}
          AND commission_type = ${commissionType}
          AND level_depth = ${levelDepth}
          AND plot_area_unit = ${plotAreaUnit}
          AND is_active = TRUE`;
      if (duplicate) return err(res, "An active commission rule already exists for this type, level and area unit.", 409);
    }
    const [rule] = await sql`
      UPDATE commission_rules SET
        commission_type = ${commissionType},
        level_depth = ${levelDepth},
        plot_area_unit = ${plotAreaUnit},
        amount_per_100_gaj = ${Number(req.body.amount_per_100_gaj || 0)},
        duration_months = ${Number(req.body.duration_months || 144)},
        is_active = ${isActive}
      WHERE rule_id = ${req.params.id}
      RETURNING *`;
    if (!rule) return err(res, "Rule not found", 404);
    return ok(res, rule, "Commission rule updated");
  } catch (e) {
    return err(res, e.message);
  }
});

app.get("/api/admin/ranks", verifyAdminToken, role("SuperAdmin","FinanceManager"), async (_req, res) => {
  try {
    await requireMlmSchema();
    return ok(res, await sql`SELECT * FROM associate_ranks ORDER BY min_total_network_sales_gaj, rank_id`);
  } catch (e) {
    return err(res, e.message);
  }
});

app.post("/api/admin/ranks", verifyAdminToken, role("SuperAdmin","FinanceManager"), async (req, res) => {
  try {
    await requireMlmSchema();
    const [rank] = await sql`
      INSERT INTO associate_ranks (rank_name, min_direct_sales_gaj, min_total_network_sales_gaj, commission_multiplier, is_active)
      VALUES (${req.body.rank_name}, ${Number(req.body.min_direct_sales_gaj || 0)}, ${Number(req.body.min_total_network_sales_gaj || 0)},
              ${Number(req.body.commission_multiplier || 1)}, ${parseBool(req.body.is_active, true)})
      RETURNING *`;
    return ok(res, rank, "Rank created", 201);
  } catch (e) {
    return err(res, e.message);
  }
});

app.put("/api/admin/ranks/:id", verifyAdminToken, role("SuperAdmin","FinanceManager"), async (req, res) => {
  try {
    await requireMlmSchema();
    const [rank] = await sql`
      UPDATE associate_ranks SET
        rank_name = ${req.body.rank_name},
        min_direct_sales_gaj = ${Number(req.body.min_direct_sales_gaj || 0)},
        min_total_network_sales_gaj = ${Number(req.body.min_total_network_sales_gaj || 0)},
        commission_multiplier = ${Number(req.body.commission_multiplier || 1)},
        is_active = ${parseBool(req.body.is_active, true)}
      WHERE rank_id = ${req.params.id}
      RETURNING *`;
    if (!rank) return err(res, "Rank not found", 404);
    return ok(res, rank, "Rank updated");
  } catch (e) {
    return err(res, e.message);
  }
});

app.post("/api/admin/associates/recalculate-ranks", verifyAdminToken, role("SuperAdmin","FinanceManager"), async (req, res) => {
  try {
    await requireMlmSchema();
    const associates = await sql`
      SELECT u.user_id, COALESCE(t.total_gaj_sold, 0) AS direct_sales,
             COALESCE(net.total_network_sales, 0) AS network_sales,
             t.current_rank_id
      FROM users u
      LEFT JOIN associate_sales_tracker t ON t.associate_user_id = u.user_id
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(t2.total_gaj_sold), 0) AS total_network_sales
        FROM mlm_tree_closure c
        LEFT JOIN associate_sales_tracker t2 ON t2.associate_user_id = c.descendant_user_id
        WHERE c.ancestor_user_id = u.user_id AND c.depth > 0
      ) net ON TRUE
      WHERE u.user_type = 'Associate'`;
    const ranks = await sql`
      SELECT * FROM associate_ranks WHERE is_active = TRUE
      ORDER BY min_total_network_sales_gaj DESC, min_direct_sales_gaj DESC`;
    let changed = 0;
    for (const associate of associates) {
      const rank = ranks.find(r =>
        Number(associate.direct_sales) >= Number(r.min_direct_sales_gaj) &&
        Number(associate.network_sales) >= Number(r.min_total_network_sales_gaj)
      );
      if (rank && Number(rank.rank_id) !== Number(associate.current_rank_id || 0)) {
        await sql`
          INSERT INTO associate_sales_tracker (associate_user_id, current_rank_id)
          VALUES (${associate.user_id}, ${rank.rank_id})
          ON CONFLICT (associate_user_id) DO UPDATE SET current_rank_id = ${rank.rank_id}`;
        await sql`
          INSERT INTO associate_rank_history (associate_user_id, old_rank_id, new_rank_id, changed_reason)
          VALUES (${associate.user_id}, ${associate.current_rank_id || null}, ${rank.rank_id}, 'Auto recalculation')`;
        changed++;
      }
    }
    return ok(res, { checked: associates.length, changed }, "Ranks recalculated");
  } catch (e) {
    return err(res, e.message);
  }
});

app.get("/api/admin/mlm/reports", verifyAdminToken, role("SuperAdmin","FinanceManager"), async (_req, res) => {
  try {
    await requireMlmSchema();
    const [topAssociates, commissionSummary, payoutSummary, growth] = await Promise.all([
      sql`
        SELECT u.user_id, u.member_id, u.full_name, COALESCE(t.total_gaj_sold,0) AS total_gaj_sold,
               COALESCE(t.total_commission_earned,0) AS total_commission_earned
        FROM users u LEFT JOIN associate_sales_tracker t ON t.associate_user_id = u.user_id
        WHERE u.user_type = 'Associate'
        ORDER BY COALESCE(t.total_gaj_sold,0) DESC LIMIT 10`,
      sql`SELECT commission_status, COALESCE(SUM(net_amount),0) AS amount, COUNT(*) AS count FROM commission_transactions GROUP BY commission_status`,
      sql`SELECT status, COALESCE(SUM(requested_amount),0) AS amount, COUNT(*) AS count FROM associate_payout_requests GROUP BY status`,
      sql`SELECT date_trunc('month', created_at)::date AS month, COUNT(*) AS registrations FROM referral_registrations GROUP BY 1 ORDER BY 1 DESC LIMIT 12`,
    ]);
    return ok(res, { top_associates: topAssociates, commission_summary: commissionSummary, payout_summary: payoutSummary, network_growth: growth });
  } catch (e) {
    return err(res, e.message);
  }
});

app.get("/api/admin/mlm/network/export", verifyAdminToken, role("SuperAdmin","FinanceManager"), async (req, res) => {
  try {
    await requireMlmSchema();
    const rows = await sql`
      SELECT u.member_id, u.full_name, u.user_type, u.account_status,
             sp.member_id AS sponsor_member_id, sp.full_name AS sponsor_name,
             COALESCE(t.total_gaj_sold,0) AS total_gaj_sold,
             COALESCE(t.total_commission_earned,0) AS total_commission_earned
      FROM users u
      LEFT JOIN users sp ON sp.user_id = u.sponsor_user_id
      LEFT JOIN associate_sales_tracker t ON t.associate_user_id = u.user_id
      WHERE u.user_type = 'Associate'
      ORDER BY sp.member_id NULLS FIRST, u.member_id`;
    const header = ["Member ID","Name","Type","Status","Sponsor ID","Sponsor Name","Gaj Sold","Commission Earned"];
    const csv = [header.join(","), ...rows.map(r => [
      r.member_id, r.full_name, r.user_type, r.account_status, r.sponsor_member_id || "", r.sponsor_name || "",
      r.total_gaj_sold, r.total_commission_earned
    ].map(value => `"${String(value ?? "").replace(/"/g, '""')}"`).join(","))].join("\n");
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=mlm-network.csv");
    return res.send(csv);
  } catch (e) {
    return err(res, e.message);
  }
});

app.get("/api/admin/payout-requests", verifyAdminToken, role("SuperAdmin","FinanceManager"), async (req, res) => {
  try {
    await requireMlmSchema();
    const statusFilter = String(req.query.status || "");
    const rows = await sql`
      SELECT p.*, u.full_name, u.member_id, u.mobile_no
      FROM associate_payout_requests p
      JOIN users u ON u.user_id = p.associate_user_id
      WHERE (${statusFilter} = '' OR p.status = ${statusFilter})
      ORDER BY p.requested_at DESC`;
    return ok(res, rows);
  } catch (e) {
    return err(res, e.message);
  }
});

app.post("/api/admin/payout-requests/:id/:action", verifyAdminToken, role("SuperAdmin","FinanceManager"), async (req, res) => {
  try {
    await requireMlmSchema();
    const actionMap = { approve: "Approved", reject: "Rejected", pay: "Paid" };
    const nextStatus = actionMap[req.params.action];
    if (!nextStatus) return err(res, "Invalid payout action", 400);
    const [payout] = await sql`
      UPDATE associate_payout_requests SET
        status = ${nextStatus},
        approved_amount = COALESCE(${req.body.approved_amount ? Number(req.body.approved_amount) : null}, approved_amount, requested_amount),
        payment_reference = COALESCE(${req.body.payment_reference || null}, payment_reference),
        admin_note = COALESCE(${req.body.admin_note || null}, admin_note),
        reviewed_by_admin_id = ${req.admin.admin_id},
        reviewed_at = COALESCE(reviewed_at, NOW()),
        paid_at = CASE WHEN ${nextStatus} = 'Paid' THEN NOW() ELSE paid_at END
      WHERE payout_id = ${req.params.id}
      RETURNING *`;
    if (!payout) return err(res, "Payout request not found", 404);
    return ok(res, payout, `Payout ${nextStatus}`);
  } catch (e) {
    return err(res, e.message);
  }
});

app.get("/api/admin/commissions/pending",
  verifyAdminToken,
  role("SuperAdmin","FinanceManager"),
  async (req, res) => {
    try {
      const pending = await sql`
        SELECT c.commission_id, c.commission_type, c.gaj_sold,
               c.gross_amount, c.deduction_amount, c.net_amount,
               c.commission_month, c.created_at,
               c.commission_model, c.commission_level, c.commission_percentage,
               c.calculation_base, c.source_type, c.source_reference, c.engine_version,
               u.full_name AS associate_name, u.member_id,
               b.booking_serial, p.plot_number, s.site_name
        FROM commission_transactions c
        JOIN users u ON c.associate_user_id = u.user_id
        LEFT JOIN bookings b ON c.related_booking_id = b.booking_id
        LEFT JOIN plots    p ON b.plot_id = p.plot_id
        LEFT JOIN sites    s ON p.site_id = s.site_id
        WHERE c.commission_status = 'Pending'
        ORDER BY c.created_at ASC`;
      return ok(res, pending);
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.post("/api/admin/commissions/:id/approve",
  verifyAdminToken,
  role("SuperAdmin","FinanceManager"),
  async (req, res) => {
    try {
      const { payment_reference } = req.body;
      await sql`
        UPDATE commission_transactions SET
          commission_status = 'Paid', approved_by_admin_id = ${req.admin.admin_id},
          approved_at = NOW(), paid_at = NOW(),
          payment_reference = ${payment_reference || null}
        WHERE commission_id = ${req.params.id}`;
      await requireMlmSchema();
      await sql`
        UPDATE commission_monthly_schedule SET
          status = 'Paid',
          paid_at = NOW(),
          payment_reference = ${payment_reference || null}
        WHERE commission_id = ${req.params.id} AND status IN ('Pending','Approved')`;
      return ok(res, {}, "Commission approved and marked as paid");
    } catch (e) {
      return err(res, e.message);
    }
  }
);

/* ==========================
   ─────────────────────────
   ADMIN — NOTIFICATIONS
   POST /api/admin/notifications/send
   POST /api/admin/notifications/bulk
   ─────────────────────────
========================== */

app.post("/api/admin/notifications/send",
  verifyAdminToken,
  role("SuperAdmin","SupportStaff"),
  async (req, res) => {
    try {
      const { user_id, title, message, channel = "Push" } = req.body;
      if (!user_id || !message) return err(res, "user_id & message required", 400);

      await sql`
        INSERT INTO notification_log (user_id, sent_by_admin_id, channel, title, message)
        VALUES (${user_id}, ${req.admin.admin_id}, ${channel}, ${title || null}, ${message})`;
      return ok(res, {}, "Notification sent");
    } catch (e) {
      return err(res, e.message);
    }
  }
);

app.post("/api/admin/notifications/bulk",
  verifyAdminToken,
  role("SuperAdmin","SupportStaff"),
  async (req, res) => {
    try {
      const { target, title, message, channel = "All" } = req.body;
      // target: 'All' | 'Customer' | 'Associate'
      if (!message) return err(res, "message required", 400);
      const targetFilter = target ? String(target) : null;

      const users = await sql`
        SELECT user_id FROM users
        WHERE account_status = 'Active'
          AND (${targetFilter}::text IS NULL OR ${targetFilter}::text = 'All' OR user_type = ${targetFilter})`;

      for (const u of users) {
        await sql`
          INSERT INTO notification_log (user_id, sent_by_admin_id, channel, title, message)
          VALUES (${u.user_id}, ${req.admin.admin_id}, ${channel}, ${title || null}, ${message})`;
      }
      return ok(res, { sent_to: users.length }, `Bulk notification sent to ${users.length} users`);
    } catch (e) {
      return err(res, e.message);
    }
  }
);

/* ==========================
   ─────────────────────────
   ADMIN — DASHBOARD STATS
   GET /api/admin/dashboard
   GET /api/admin/audit-log
   ─────────────────────────
========================== */

const DASHBOARD_QUERY_TIMEOUT_MS = 10000;

function withDashboardTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    if (timer.unref) timer.unref();
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

async function timedDashboardQuery(label, queryFactory, fallback) {
  const startedAt = Date.now();
  console.log(`[Dashboard API Start] ${label}`);
  try {
    const data = await withDashboardTimeout(queryFactory(), DASHBOARD_QUERY_TIMEOUT_MS, label);
    const size = Buffer.byteLength(JSON.stringify(data || []));
    console.log(`[Dashboard API Success] ${label} - ${Date.now() - startedAt}ms - ${size} bytes`);
    return {
      data,
      error: null,
      elapsed_ms: Date.now() - startedAt,
      size_bytes: size
    };
  } catch (e) {
    console.error(`[Dashboard API Error] ${label} - ${Date.now() - startedAt}ms - ${e.message}`);
    return {
      data: fallback,
      error: e.message,
      elapsed_ms: Date.now() - startedAt,
      size_bytes: 0
    };
  }
}

app.get("/api/admin/dashboard",
  verifyAdminToken,
  role("SuperAdmin","FinanceManager","SiteManager"),
  async (req, res) => {
    const startedAt = Date.now();
    console.log("[Dashboard API Start] /api/admin/dashboard");
    try {
      await ensureInquirySchema();
      const [statsResult, sitesResult, recentBookingsResult, monthlySalesResult] = await Promise.all([
        timedDashboardQuery(
          "/api/admin/dashboard stats",
          () => sql`
            SELECT
              COALESCE((SELECT COUNT(*) FROM users WHERE user_type = 'Customer' AND account_status = 'Active'), 0)::int AS total_customers,
              COALESCE((SELECT COUNT(*) FROM users WHERE user_type = 'Associate' AND account_status = 'Active'), 0)::int AS total_associates,
              COALESCE((SELECT COUNT(DISTINCT plot_id) FROM bookings WHERE booking_status = 'Confirmed'), 0)::int AS total_plots_sold,
              COALESCE((
                SELECT SUM(COALESCE(total_due, emi_amount, 0))
                FROM emi_schedules
                WHERE emi_status IN ('Pending', 'Overdue', 'ProofSubmitted')
                  AND date_trunc('month', due_date) = date_trunc('month', CURRENT_DATE)
              ), 0)::numeric AS monthly_emi_due,
              COALESCE((
                SELECT COUNT(*) FROM users
                WHERE account_status IN ('Pending', 'InfoRequested', 'InfoSubmitted')
              ), 0)::int AS pending_approvals,
              COALESCE((
                SELECT COUNT(*) FROM inquiries
                WHERE status IN ('New', 'Contacted', 'FollowUp')
              ), 0)::int AS open_enquiries,
              COALESCE((
                SELECT SUM(net_amount) FROM commission_transactions
                WHERE commission_status = 'Pending'
              ), 0)::numeric AS commission_due,
              (
                COALESCE((SELECT SUM(advance_amount) FROM bookings WHERE booking_status <> 'Cancelled'), 0)
                + COALESCE((SELECT SUM(paid_amount) FROM emi_schedules WHERE emi_status = 'Paid'), 0)
              )::numeric AS total_revenue`,
          [{}]
        ),
        timedDashboardQuery(
          "/api/admin/dashboard sites",
          () => sql`
            SELECT
              s.site_id,
              s.site_name,
              COUNT(DISTINCT p.plot_id)::int AS total_plots,
              COUNT(DISTINCT p.plot_id) FILTER (
                WHERE b.booking_status IN ('Confirmed', 'PaymentPending', 'InProcess')
              )::int AS booked,
              COUNT(DISTINCT p.plot_id) FILTER (
                WHERE b.booking_status = 'Confirmed'
              )::int AS sold,
              COUNT(DISTINCT p.plot_id) FILTER (
                WHERE b.booking_id IS NULL OR b.booking_status = 'Cancelled'
              )::int AS vacant
            FROM sites s
            LEFT JOIN plots p ON p.site_id = s.site_id AND p.is_active = TRUE
            LEFT JOIN bookings b ON b.plot_id = p.plot_id
            WHERE s.is_active = TRUE
            GROUP BY s.site_id, s.site_name
            ORDER BY s.site_name
            LIMIT 25`,
          []
        ),
        timedDashboardQuery(
          "/api/admin/dashboard recent-bookings",
          () => sql`
            SELECT b.booking_id, b.booking_serial, b.booking_status, b.booking_date,
                   u.full_name, p.plot_number, s.site_name
            FROM bookings b
            JOIN users u ON b.user_id = u.user_id
            JOIN plots p ON b.plot_id = p.plot_id
            JOIN sites s ON p.site_id = s.site_id
            ORDER BY b.created_at DESC LIMIT 5`,
          []
        ),
        timedDashboardQuery(
          "/api/admin/dashboard monthly-sales",
          () => sql`
            WITH months AS (
              SELECT generate_series(
                date_trunc('month', CURRENT_DATE) - INTERVAL '11 months',
                date_trunc('month', CURRENT_DATE),
                INTERVAL '1 month'
              ) AS month_start
            ),
            sales AS (
              SELECT
                date_trunc('month', COALESCE(b.confirmed_at, b.booking_date, b.created_at)) AS month_start,
                COUNT(DISTINCT b.booking_id)::int AS sales_count,
                COALESCE(SUM(COALESCE(p.base_price, b.advance_amount, 0)), 0)::numeric AS total_sales
              FROM bookings b
              JOIN plots p ON p.plot_id = b.plot_id
              WHERE b.booking_status = 'Confirmed'
                AND COALESCE(b.confirmed_at, b.booking_date, b.created_at)
                    >= date_trunc('month', CURRENT_DATE) - INTERVAL '11 months'
              GROUP BY 1
            )
            SELECT
              to_char(m.month_start, 'Mon YYYY') AS month,
              COALESCE(s.sales_count, 0)::int AS sales_count,
              COALESCE(s.total_sales, 0)::numeric AS total_sales
            FROM months m
            LEFT JOIN sales s ON s.month_start = m.month_start
            ORDER BY m.month_start`,
          []
        )
      ]);

      const diagnostics = {
        stats: {
          elapsed_ms: statsResult.elapsed_ms,
          size_bytes: statsResult.size_bytes,
          error: statsResult.error
        },
        sites: {
          elapsed_ms: sitesResult.elapsed_ms,
          size_bytes: sitesResult.size_bytes,
          error: sitesResult.error
        },
        recent_bookings: {
          elapsed_ms: recentBookingsResult.elapsed_ms,
          size_bytes: recentBookingsResult.size_bytes,
          error: recentBookingsResult.error
        },
        monthly_sales: {
          elapsed_ms: monthlySalesResult.elapsed_ms,
          size_bytes: monthlySalesResult.size_bytes,
          error: monthlySalesResult.error
        }
      };

      const rawStats = Array.isArray(statsResult.data) ? (statsResult.data[0] || {}) : (statsResult.data || {});
      const stats = {
        total_customers: Number(rawStats.total_customers || 0),
        total_associates: Number(rawStats.total_associates || 0),
        total_plots_sold: Number(rawStats.total_plots_sold || 0),
        monthly_emi_due: Number(rawStats.monthly_emi_due || 0),
        pending_approvals: Number(rawStats.pending_approvals || 0),
        open_enquiries: Number(rawStats.open_enquiries || 0),
        commission_due: Number(rawStats.commission_due || 0),
        total_revenue: Number(rawStats.total_revenue || 0),
      };
      const responseData = {
        totalCustomers: stats.total_customers,
        activeAssociates: stats.total_associates,
        plotsSold: stats.total_plots_sold,
        monthlyEmiDue: stats.monthly_emi_due,
        pendingApprovals: stats.pending_approvals,
        monthlySalesChartData: Array.isArray(monthlySalesResult.data) ? monthlySalesResult.data : [],
        stats,
        sites: Array.isArray(sitesResult.data) ? sitesResult.data : [],
        recent_bookings: Array.isArray(recentBookingsResult.data) ? recentBookingsResult.data : [],
        diagnostics
      };

      const size = Buffer.byteLength(JSON.stringify(responseData));
      console.log(`[Dashboard API Success] /api/admin/dashboard - ${Date.now() - startedAt}ms - ${size} bytes`);
      return ok(res, responseData);
    } catch (e) {
      console.error(`[Dashboard API Error] /api/admin/dashboard - ${Date.now() - startedAt}ms - ${e.message}`);
      return ok(res, {
        totalCustomers: 0,
        activeAssociates: 0,
        plotsSold: 0,
        monthlyEmiDue: 0,
        pendingApprovals: 0,
        monthlySalesChartData: [],
        stats: {
          total_customers: 0,
          total_associates: 0,
          total_plots_sold: 0,
          monthly_emi_due: 0,
          pending_approvals: 0,
          open_enquiries: 0,
          commission_due: 0,
          total_revenue: 0,
        },
        sites: [],
        recent_bookings: [],
        diagnostics: { error: e.message }
      }, "Dashboard loaded with fallback data.");
    }
  }
);

app.get("/api/admin/dashboard/turnover",
  verifyAdminToken,
  role("SuperAdmin", "FinanceManager", "SiteManager"),
  async (req, res) => {
    try {
      const period = String(req.query.period || "monthly").toLowerCase();

      // 1. Customer Collections
      const customerBookingAdvances = await sql`
        SELECT b.booking_id AS id, b.advance_amount AS amount, b.booking_date AS tx_date,
               b.booking_serial, u.full_name AS payer_name, u.email AS payer_email,
               'Customer' AS category, 'Plot Downpayment' AS tx_type, 'Booking' AS payment_mode
        FROM bookings b
        JOIN users u ON b.user_id = u.user_id
        WHERE b.booking_status <> 'Cancelled' AND u.user_type = 'Customer'
        ${period === 'monthly' ? sql`AND b.booking_date >= date_trunc('month', CURRENT_DATE)` :
          period === 'quarterly' ? sql`AND b.booking_date >= date_trunc('quarter', CURRENT_DATE)` :
          period === 'yearly' ? sql`AND b.booking_date >= date_trunc('year', CURRENT_DATE)` : sql``}
      `.catch(() => []);

      const customerEmis = await sql`
        SELECT e.emi_id AS id, e.paid_amount AS amount, COALESCE(e.payment_date, e.updated_at, e.created_at) AS tx_date,
               b.booking_serial, u.full_name AS payer_name, u.email AS payer_email,
               'Customer' AS category, 'EMI Payment' AS tx_type, COALESCE(e.payment_mode, 'Online/Bank') AS payment_mode
        FROM emi_schedules e
        JOIN bookings b ON e.booking_id = b.booking_id
        JOIN users u ON b.user_id = u.user_id
        WHERE e.emi_status = 'Paid' AND u.user_type = 'Customer'
        ${period === 'monthly' ? sql`AND COALESCE(e.payment_date, e.updated_at, e.created_at) >= date_trunc('month', CURRENT_DATE)` :
          period === 'quarterly' ? sql`AND COALESCE(e.payment_date, e.updated_at, e.created_at) >= date_trunc('quarter', CURRENT_DATE)` :
          period === 'yearly' ? sql`AND COALESCE(e.payment_date, e.updated_at, e.created_at) >= date_trunc('year', CURRENT_DATE)` : sql``}
      `.catch(() => []);

      const customerWallet = await sql`
        SELECT w.id AS id, w.amount, w.created_at AS tx_date,
               '' AS booking_serial, u.full_name AS payer_name, u.email AS payer_email,
               'Customer' AS category, 'Wallet Topup' AS tx_type, COALESCE(w.payment_gateway, 'Wallet/Gateway') AS payment_mode
        FROM wallet_transactions w
        JOIN users u ON w.user_id = u.user_id
        WHERE w.transaction_type = 'credit' AND w.source IN ('Add Fund', 'Deposit') AND w.status = 'success' AND u.user_type = 'Customer'
        ${period === 'monthly' ? sql`AND w.created_at >= date_trunc('month', CURRENT_DATE)` :
          period === 'quarterly' ? sql`AND w.created_at >= date_trunc('quarter', CURRENT_DATE)` :
          period === 'yearly' ? sql`AND w.created_at >= date_trunc('year', CURRENT_DATE)` : sql``}
      `.catch((e) => { console.error("[customerWallet error]", e); return []; });

      // 2. Associate Collections
      const associateBookingAdvances = await sql`
        SELECT b.booking_id AS id, b.advance_amount AS amount, b.booking_date AS tx_date,
               b.booking_serial, u.full_name AS payer_name, u.email AS payer_email,
               'Associate' AS category, 'Associate Plot Booking' AS tx_type, 'Booking' AS payment_mode
        FROM bookings b
        JOIN users u ON b.user_id = u.user_id
        WHERE b.booking_status <> 'Cancelled' AND u.user_type = 'Associate'
        ${period === 'monthly' ? sql`AND b.booking_date >= date_trunc('month', CURRENT_DATE)` :
          period === 'quarterly' ? sql`AND b.booking_date >= date_trunc('quarter', CURRENT_DATE)` :
          period === 'yearly' ? sql`AND b.booking_date >= date_trunc('year', CURRENT_DATE)` : sql``}
      `.catch(() => []);

      const associateEmis = await sql`
        SELECT e.emi_id AS id, e.paid_amount AS amount, COALESCE(e.payment_date, e.updated_at, e.created_at) AS tx_date,
               b.booking_serial, u.full_name AS payer_name, u.email AS payer_email,
               'Associate' AS category, 'EMI Payment' AS tx_type, COALESCE(e.payment_mode, 'Online/Bank') AS payment_mode
        FROM emi_schedules e
        JOIN bookings b ON e.booking_id = b.booking_id
        JOIN users u ON b.user_id = u.user_id
        WHERE e.emi_status = 'Paid' AND u.user_type = 'Associate'
        ${period === 'monthly' ? sql`AND COALESCE(e.payment_date, e.updated_at, e.created_at) >= date_trunc('month', CURRENT_DATE)` :
          period === 'quarterly' ? sql`AND COALESCE(e.payment_date, e.updated_at, e.created_at) >= date_trunc('quarter', CURRENT_DATE)` :
          period === 'yearly' ? sql`AND COALESCE(e.payment_date, e.updated_at, e.created_at) >= date_trunc('year', CURRENT_DATE)` : sql``}
      `.catch(() => []);

      const associateWallet = await sql`
        SELECT w.id AS id, w.amount, w.created_at AS tx_date,
               '' AS booking_serial, u.full_name AS payer_name, u.email AS payer_email,
               'Associate' AS category, 'Wallet Topup' AS tx_type, COALESCE(w.payment_gateway, 'Wallet/Gateway') AS payment_mode
        FROM wallet_transactions w
        JOIN users u ON w.user_id = u.user_id
        WHERE w.transaction_type = 'credit' AND w.source IN ('Add Fund', 'Deposit') AND w.status = 'success' AND u.user_type = 'Associate'
        ${period === 'monthly' ? sql`AND w.created_at >= date_trunc('month', CURRENT_DATE)` :
          period === 'quarterly' ? sql`AND w.created_at >= date_trunc('quarter', CURRENT_DATE)` :
          period === 'yearly' ? sql`AND w.created_at >= date_trunc('year', CURRENT_DATE)` : sql``}
      `.catch((e) => { console.error("[associateWallet error]", e); return []; });

      // 3. Investor Collections
      const investorDeposits = await sql`
        SELECT d.id, d.amount, COALESCE(d.approved_at, d.created_at) AS tx_date,
               '' AS booking_serial, iu.full_name AS payer_name, iu.email AS payer_email,
               'Investor' AS category, 'Capital Deposit' AS tx_type, COALESCE(d.payment_method, 'Bank Transfer') AS payment_mode
        FROM investor_deposits d
        JOIN investor_users iu ON d.investor_id = iu.id
        WHERE d.status IN ('approved', 'Approved') AND (d.deleted_at IS NULL)
        ${period === 'monthly' ? sql`AND COALESCE(d.approved_at, d.created_at) >= date_trunc('month', CURRENT_DATE)` :
          period === 'quarterly' ? sql`AND COALESCE(d.approved_at, d.created_at) >= date_trunc('quarter', CURRENT_DATE)` :
          period === 'yearly' ? sql`AND COALESCE(d.approved_at, d.created_at) >= date_trunc('year', CURRENT_DATE)` : sql``}
      `.catch(() => []);

      const customerHistory = [...customerBookingAdvances, ...customerEmis, ...customerWallet]
        .map(i => ({ ...i, amount: Number(i.amount || 0) }))
        .sort((a, b) => new Date(b.tx_date).getTime() - new Date(a.tx_date).getTime());

      const associateHistory = [...associateBookingAdvances, ...associateEmis, ...associateWallet]
        .map(i => ({ ...i, amount: Number(i.amount || 0) }))
        .sort((a, b) => new Date(b.tx_date).getTime() - new Date(a.tx_date).getTime());

      const investorHistory = [...investorDeposits]
        .map(i => ({ ...i, amount: Number(i.amount || 0) }))
        .sort((a, b) => new Date(b.tx_date).getTime() - new Date(a.tx_date).getTime());

      const allHistory = [...customerHistory, ...associateHistory, ...investorHistory]
        .sort((a, b) => new Date(b.tx_date).getTime() - new Date(a.tx_date).getTime());

      const customerTotal = customerHistory.reduce((sum, item) => sum + item.amount, 0);
      const associateTotal = associateHistory.reduce((sum, item) => sum + item.amount, 0);
      const investorTotal = investorHistory.reduce((sum, item) => sum + item.amount, 0);
      const grandTotal = customerTotal + associateTotal + investorTotal;

      return ok(res, {
        period,
        totals: {
          grand_total: grandTotal,
          customer_total: customerTotal,
          associate_total: associateTotal,
          investor_total: investorTotal
        },
        counts: {
          customer_count: customerHistory.length,
          associate_count: associateHistory.length,
          investor_count: investorHistory.length,
          total_count: allHistory.length
        },
        history: {
          customer: customerHistory,
          associate: associateHistory,
          investor: investorHistory,
          all: allHistory
        }
      });
    } catch (e) {
      console.error("[Turnover API Error]", e);
      return err(res, "Failed to load turnover analytics");
    }
  }
);

app.get("/api/admin/audit-log",
  verifyAdminToken,
  role("SuperAdmin"),
  async (req, res) => {
    try {
      const { module, page = 1, limit = 30 } = req.query;
      const offset = (page - 1) * limit;
      const moduleFilter = module ? String(module) : null;
      const logs = await sql`
        SELECT * FROM audit_log
        WHERE (${moduleFilter}::text IS NULL OR module = ${moduleFilter})
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}`;
      return ok(res, logs);
    } catch (e) {
      return err(res, e.message);
    }
  }
);

/* ==========================
   PLOT DETECTOR 2
   Independent generated plot layout module
========================== */
app.get("/api/admin/plot-detector-2/projects",
  verifyAdminToken,
  role("SuperAdmin", "SiteManager", "SupportStaff", "FinanceManager"),
  async (req, res) => {
    try {
      const projects = await sql`
        SELECT
          s.site_id AS project_id,
          s.site_id,
          s.site_name AS project_name,
          s.site_name,
          s.total_plots,
          s.map_image_url AS site_map_url,
          s.map_image_url,
          COUNT(p.plot_id)::int AS generated_plots,
          COUNT(p.plot_id) FILTER (WHERE p.plot_status = 'Vacant')::int AS available_plots,
          COUNT(p.plot_id) FILTER (WHERE p.plot_status = 'Booked')::int AS booked_plots,
          COUNT(p.plot_id) FILTER (WHERE p.plot_status = 'InProcess')::int AS processing_plots,
          COUNT(p.plot_id) FILTER (WHERE p.plot_status = 'Sold')::int AS sold_plots
        FROM sites s
        LEFT JOIN plots p ON p.site_id = s.site_id AND p.is_active = TRUE
        GROUP BY s.site_id
        ORDER BY s.site_name`;
      return ok(res, projects);
    } catch (e) {
      console.error("[Plot Detector 2 Projects Error]", e);
      return err(res, e.message || "Failed to load Plot Detector 2 projects");
    }
  }
);

app.post("/api/admin/plot-detector-2/projects",
  verifyAdminToken,
  role("SuperAdmin", "SiteManager", "SupportStaff", "FinanceManager"),
  async (req, res) => {
    try {
      const siteId = Number(req.body?.site_id || req.body?.project_id);
      const totalPlots = Number(req.body?.total_plots);

      if (!Number.isInteger(siteId)) return err(res, "Select Project is required", 400);
      if (!Number.isInteger(totalPlots) || totalPlots <= 0) return err(res, "Total Plots must be a positive number", 400);

      const [site] = await sql`SELECT site_id, site_name FROM sites WHERE site_id = ${siteId}`;
      if (!site) return err(res, "Selected project not found", 404);

      await sql`
        INSERT INTO plots (
          site_id, plot_number, plot_area, plot_category, base_price,
          down_payment, monthly_emi, emi_tenure_months, file_charge,
          plot_status, created_by_admin_id
        )
        SELECT ${siteId}, generated_no::text, 0, '100gaj'::plot_category_enum, 0,
               0, 0, 60, 0, 'Vacant'::plot_status_enum, ${req.admin?.admin_id || null}
        FROM generate_series(1, ${totalPlots}) AS generated_no
        WHERE NOT EXISTS (
          SELECT 1 FROM plots p
          WHERE p.site_id = ${siteId}
            AND p.is_active = TRUE
            AND p.plot_number = generated_no::text
        )`;

      await sql`UPDATE sites SET total_plots = GREATEST(COALESCE(total_plots, 0), ${totalPlots}), updated_at = NOW() WHERE site_id = ${siteId}`;

      await logAdminAudit(req, "PlotDetector2", "GeneratePlots", "sites", siteId, sql.json({
        site_name: site.site_name,
        total_plots: totalPlots,
      }));

      return ok(res, { project_id: siteId, site_id: siteId }, "Plot boxes generated for selected project.", 201);
    } catch (e) {
      console.error("[Plot Detector 2 Generate Error]", e);
      return err(res, e.message || "Failed to generate plot boxes");
    }
  }
);

app.get("/api/admin/plot-detector-2/projects/:projectId",
  verifyAdminToken,
  role("SuperAdmin", "SiteManager", "SupportStaff", "FinanceManager"),
  async (req, res) => {
    try {
      const projectId = Number(req.params.projectId);
      if (!Number.isInteger(projectId)) return err(res, "Invalid project id", 400);

      const [project] = await sql`
        SELECT
          site_id AS project_id,
          site_id,
          site_name AS project_name,
          site_name,
          total_plots,
          map_image_url AS site_map_url,
          map_image_url
        FROM sites
        WHERE site_id = ${projectId}`;
      if (!project) return err(res, "Plot Detector 2 project not found", 404);

      const plots = await sql`
        SELECT
          p.plot_id,
          p.site_id AS project_id,
          p.site_id,
          p.plot_number AS plot_no,
          p.plot_number,
          p.plot_area AS area,
          p.plot_area,
          p.plot_status,
          CASE p.plot_status
            WHEN 'Vacant' THEN 'Available'
            WHEN 'InProcess' THEN 'Processing'
            ELSE p.plot_status::text
          END AS status,
          b.booking_id,
          b.booking_date,
          b.confirmed_at AS purchase_date,
          u.user_id AS customer_id,
          u.full_name AS customer_name,
          u.mobile_no AS customer_mobile,
          CASE
            WHEN b.booking_id IS NULL THEN 'Not Started'
            WHEN b.booking_status = 'Confirmed' THEN 'Paid'
            WHEN b.booking_status = 'Cancelled' THEN 'Cancelled'
            WHEN b.advance_amount > 0 THEN 'Partial'
            ELSE 'Pending'
          END AS payment_status
        FROM plots p
        LEFT JOIN LATERAL (
          SELECT *
          FROM bookings b
          WHERE b.plot_id = p.plot_id
          ORDER BY CASE WHEN b.booking_status = 'Cancelled' THEN 1 ELSE 0 END, b.created_at DESC
          LIMIT 1
        ) b ON TRUE
        LEFT JOIN users u ON u.user_id = b.user_id
        WHERE p.site_id = ${projectId} AND p.is_active = TRUE
        ORDER BY NULLIF(regexp_replace(p.plot_number, '\\D', '', 'g'), '')::int NULLS LAST, p.plot_number`;

      return ok(res, { project, plots });
    } catch (e) {
      console.error("[Plot Detector 2 Detail Error]", e);
      return err(res, e.message || "Failed to load Plot Detector 2 project");
    }
  }
);

app.put("/api/admin/plot-detector-2/plots/:plotId",
  verifyAdminToken,
  role("SuperAdmin", "SiteManager", "SupportStaff", "FinanceManager"),
  async (req, res) => {
    try {
      const plotId = Number(req.params.plotId);
      if (!Number.isInteger(plotId)) return err(res, "Invalid plot id", 400);

      const status = String(req.body?.status || "Available").trim();
      if (!plotDetector2Statuses.includes(status)) return err(res, "Invalid plot status", 400);
      const plotStatus = status === "Available"
        ? "Vacant"
        : status === "Processing" || status === "Reserved"
          ? "InProcess"
          : status === "Cancelled"
            ? "Vacant"
            : status;

      const [oldPlot] = await sql`SELECT plot_status FROM plots WHERE plot_id = ${plotId}`;
      if (!oldPlot) return err(res, "Plot not found", 404);
      const [plot] = await sql`
        UPDATE plots SET
          plot_area = COALESCE(${asNumberOrNull(req.body?.area)}, plot_area),
          plot_status = ${plotStatus}::plot_status_enum,
          updated_at = NOW()
        WHERE plot_id = ${plotId}
        RETURNING plot_id, site_id, plot_number, plot_number AS plot_no, plot_area AS area, plot_area, plot_status`;

      if (String(oldPlot.plot_status) !== plotStatus) {
        await sql`
          INSERT INTO plot_status_history (plot_id, old_status, new_status, changed_by_admin_id, reason)
          VALUES (${plotId}, ${oldPlot.plot_status}::plot_status_enum, ${plotStatus}::plot_status_enum,
                  ${req.admin?.admin_id || null}, 'Plot Detector 2 status update')`;
      }

      await logAdminAudit(req, "PlotDetector2", "UpdatePlot", "plots", plotId, sql.json({
        plot_no: plot.plot_number,
        status,
      }));

      const [detail] = await sql`
        SELECT
          p.plot_id,
          p.site_id AS project_id,
          p.site_id,
          p.plot_number AS plot_no,
          p.plot_number,
          p.plot_area AS area,
          p.plot_area,
          p.plot_status,
          CASE p.plot_status
            WHEN 'Vacant' THEN 'Available'
            WHEN 'InProcess' THEN 'Processing'
            ELSE p.plot_status::text
          END AS status,
          b.booking_id,
          b.booking_date,
          b.confirmed_at AS purchase_date,
          u.user_id AS customer_id,
          u.full_name AS customer_name,
          u.mobile_no AS customer_mobile,
          CASE
            WHEN b.booking_id IS NULL THEN 'Not Started'
            WHEN b.booking_status = 'Confirmed' THEN 'Paid'
            WHEN b.booking_status = 'Cancelled' THEN 'Cancelled'
            WHEN b.advance_amount > 0 THEN 'Partial'
            ELSE 'Pending'
          END AS payment_status
        FROM plots p
        LEFT JOIN LATERAL (
          SELECT *
          FROM bookings b
          WHERE b.plot_id = p.plot_id
          ORDER BY CASE WHEN b.booking_status = 'Cancelled' THEN 1 ELSE 0 END, b.created_at DESC
          LIMIT 1
        ) b ON TRUE
        LEFT JOIN users u ON u.user_id = b.user_id
        WHERE p.plot_id = ${plotId}`;

      return ok(res, detail, "Plot details updated.");
    } catch (e) {
      console.error("[Plot Detector 2 Plot Update Error]", e);
    }
  }
);

/* ==========================
   HEALTH CHECK
========================== */
app.get("/health", async (req, res) => {
  try {
    await sql`SELECT 1`;
    res.json({ status: "ok", db: "connected", time: new Date().toISOString() });
  } catch (e) {
    res.status(503).json({ status: "error", db: "disconnected" });
  }
});

/* ==========================================================================
   ANALYTICS & REPORTING SYSTEM
   ========================================================================== */
let analyticsSchemaReady;
const ensureAnalyticsSchema = () => {
  if (!analyticsSchemaReady) {
    analyticsSchemaReady = (async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS analytics_events (
          event_id BIGSERIAL PRIMARY KEY,
          event_name VARCHAR(60) NOT NULL,
          page_url TEXT,
          page_title VARCHAR(255),
          site_id INTEGER,
          plot_id INTEGER,
          user_id INTEGER,
          visitor_id VARCHAR(100),
          session_id VARCHAR(100),
          device_type VARCHAR(30),
          browser VARCHAR(60),
          os VARCHAR(60),
          city VARCHAR(100),
          state VARCHAR(100),
          country VARCHAR(100),
          referrer TEXT,
          utm_source VARCHAR(100),
          search_term VARCHAR(255),
          response_time_ms INTEGER,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`;
      await sql`CREATE INDEX IF NOT EXISTS idx_analytics_events_created ON analytics_events (created_at DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS idx_analytics_events_name ON analytics_events (event_name)`;
      await sql`CREATE INDEX IF NOT EXISTS idx_analytics_events_site ON analytics_events (site_id)`;
      await sql`CREATE INDEX IF NOT EXISTS idx_analytics_events_visitor ON analytics_events (visitor_id)`;
    })();
  }
  return analyticsSchemaReady;
};

// Public tracking API endpoint
app.post("/api/analytics/track", async (req, res) => {
  try {
    await ensureAnalyticsSchema();
    const eventName = safeNullableText(req.body?.event_name || 'page_view', 60);
    const pageUrl = safeNullableText(req.body?.page_url, 1000);
    const pageTitle = safeNullableText(req.body?.page_title, 255);
    const siteId = req.body?.site_id ? Number(req.body.site_id) : null;
    const plotId = req.body?.plot_id ? Number(req.body.plot_id) : null;
    const userId = req.body?.user_id ? Number(req.body.user_id) : null;
    const visitorId = safeNullableText(req.body?.visitor_id, 100) || 'anon';
    const sessionId = safeNullableText(req.body?.session_id, 100);
    const deviceType = safeNullableText(req.body?.device_type, 30) || 'Desktop';
    const browser = safeNullableText(req.body?.browser, 60);
    const os = safeNullableText(req.body?.os, 60);
    const city = safeNullableText(req.body?.city, 100);
    const state = safeNullableText(req.body?.state, 100);
    const country = safeNullableText(req.body?.country, 100) || 'India';
    const referrer = safeNullableText(req.body?.referrer, 1000);
    const utmSource = safeNullableText(req.body?.utm_source, 100) || (referrer ? (referrer.includes('google') ? 'Google Search' : referrer.includes('facebook') ? 'Facebook' : referrer.includes('instagram') ? 'Instagram' : 'Direct/Referral') : 'Direct');
    const searchTerm = safeNullableText(req.body?.search_term, 255);

    await sql`
      INSERT INTO analytics_events (
        event_name, page_url, page_title, site_id, plot_id, user_id, visitor_id, session_id,
        device_type, browser, os, city, state, country, referrer, utm_source, search_term
      ) VALUES (
        ${eventName}, ${pageUrl}, ${pageTitle}, ${siteId}, ${plotId}, ${userId}, ${visitorId}, ${sessionId},
        ${deviceType}, ${browser}, ${os}, ${city}, ${state}, ${country}, ${referrer}, ${utmSource}, ${searchTerm}
      )`;

    return ok(res, {}, "Tracked");
  } catch (e) {
    return res.status(200).json({ success: true, tracked: false });
  }
});

// Admin Analytics Multi-Dimensional Data API
app.get("/api/admin/analytics",
  verifyAdminToken,
  role("SuperAdmin", "FinanceManager", "SiteManager"),
  async (req, res) => {
    try {
      await ensureAnalyticsSchema();
      await ensureInquirySchema();

      const preset = req.query.preset || '30d';
      const siteIdFilter = req.query.site_id ? Number(req.query.site_id) : null;
      let startDateStr, endDateStr, prevStartDateStr, prevEndDateStr;

      const now = new Date();
      if (preset === 'today') {
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
        startDateStr = today.toISOString();
        endDateStr = now.toISOString();
        prevStartDateStr = yesterday.toISOString();
        prevEndDateStr = today.toISOString();
      } else if (preset === 'yesterday') {
        const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const dayBefore = new Date(yesterday); dayBefore.setDate(yesterday.getDate() - 1);
        startDateStr = yesterday.toISOString();
        endDateStr = today.toISOString();
        prevStartDateStr = dayBefore.toISOString();
        prevEndDateStr = yesterday.toISOString();
      } else if (preset === '7d') {
        const d7 = new Date(now.getTime() - 7 * 86400000);
        const d14 = new Date(now.getTime() - 14 * 86400000);
        startDateStr = d7.toISOString();
        endDateStr = now.toISOString();
        prevStartDateStr = d14.toISOString();
        prevEndDateStr = d7.toISOString();
      } else if (preset === 'this_month') {
        const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
        const prevMonthFirst = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        startDateStr = firstDay.toISOString();
        endDateStr = now.toISOString();
        prevStartDateStr = prevMonthFirst.toISOString();
        prevEndDateStr = firstDay.toISOString();
      } else if (preset === 'last_month') {
        const firstDay = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const lastDay = new Date(now.getFullYear(), now.getMonth(), 1);
        const prevMonthFirst = new Date(now.getFullYear(), now.getMonth() - 2, 1);
        startDateStr = firstDay.toISOString();
        endDateStr = lastDay.toISOString();
        prevStartDateStr = prevMonthFirst.toISOString();
        prevEndDateStr = firstDay.toISOString();
      } else if (preset === 'this_year') {
        const firstDay = new Date(now.getFullYear(), 0, 1);
        const prevYearFirst = new Date(now.getFullYear() - 1, 0, 1);
        startDateStr = firstDay.toISOString();
        endDateStr = now.toISOString();
        prevStartDateStr = prevYearFirst.toISOString();
        prevEndDateStr = firstDay.toISOString();
      } else if (preset === 'custom' && req.query.startDate && req.query.endDate) {
        startDateStr = new Date(req.query.startDate).toISOString();
        endDateStr = new Date(req.query.endDate).toISOString();
        const diff = new Date(endDateStr).getTime() - new Date(startDateStr).getTime();
        prevStartDateStr = new Date(new Date(startDateStr).getTime() - diff).toISOString();
        prevEndDateStr = startDateStr;
      } else { // default 30d
        const d30 = new Date(now.getTime() - 30 * 86400000);
        const d60 = new Date(now.getTime() - 60 * 86400000);
        startDateStr = d30.toISOString();
        endDateStr = now.toISOString();
        prevStartDateStr = d60.toISOString();
        prevEndDateStr = d30.toISOString();
      }

      // Overview KPIs
      const [
        totalUsersRow, newUsersRow, prevNewUsersRow,
        totalInvestorsRow, newInvestorsRow, prevNewInvestorsRow,
        enquiriesRow, prevEnquiriesRow, newEnquiriesRow,
        bookingsRow, prevBookingsRow, pendingBookingsRow, confirmedBookingsRow, cancelledBookingsRow,
        revenueRow, prevRevenueRow, pendingPaymentsRow, successfulPaymentsRow,
        visitorsRow, prevVisitorsRow, uniqueVisitorsRow,
        liveVisitorsRow
      ] = await Promise.all([
        sql`SELECT COUNT(*)::int AS count FROM users WHERE account_status = 'Active'`,
        sql`SELECT COUNT(*)::int AS count FROM users WHERE COALESCE(registered_at, updated_at) >= ${startDateStr} AND COALESCE(registered_at, updated_at) <= ${endDateStr}`,
        sql`SELECT COUNT(*)::int AS count FROM users WHERE COALESCE(registered_at, updated_at) >= ${prevStartDateStr} AND COALESCE(registered_at, updated_at) < ${startDateStr}`,
        sql`SELECT COUNT(*)::int AS count FROM investors WHERE is_deleted = FALSE`,
        sql`SELECT COUNT(*)::int AS count FROM investors WHERE is_deleted = FALSE AND created_at >= ${startDateStr} AND created_at <= ${endDateStr}`,
        sql`SELECT COUNT(*)::int AS count FROM investors WHERE is_deleted = FALSE AND created_at >= ${prevStartDateStr} AND created_at < ${startDateStr}`,
        sql`SELECT COUNT(*)::int AS count FROM inquiries WHERE created_at >= ${startDateStr} AND created_at <= ${endDateStr} ${siteIdFilter ? sql`AND site_id = ${siteIdFilter}` : sql``}`,
        sql`SELECT COUNT(*)::int AS count FROM inquiries WHERE created_at >= ${prevStartDateStr} AND created_at < ${startDateStr} ${siteIdFilter ? sql`AND site_id = ${siteIdFilter}` : sql``}`,
        sql`SELECT COUNT(*)::int AS count FROM inquiries WHERE status = 'New' AND created_at >= ${startDateStr} AND created_at <= ${endDateStr} ${siteIdFilter ? sql`AND site_id = ${siteIdFilter}` : sql``}`,
        sql`SELECT COUNT(*)::int AS count FROM bookings WHERE created_at >= ${startDateStr} AND created_at <= ${endDateStr}`,
        sql`SELECT COUNT(*)::int AS count FROM bookings WHERE created_at >= ${prevStartDateStr} AND created_at < ${startDateStr}`,
        sql`SELECT COUNT(*)::int AS count FROM bookings WHERE booking_status::text IN ('Submitted', 'Pending', 'PaymentPending', 'InProcess') AND created_at >= ${startDateStr} AND created_at <= ${endDateStr}`,
        sql`SELECT COUNT(*)::int AS count FROM bookings WHERE booking_status = 'Confirmed' AND created_at >= ${startDateStr} AND created_at <= ${endDateStr}`,
        sql`SELECT COUNT(*)::int AS count FROM bookings WHERE booking_status = 'Cancelled' AND created_at >= ${startDateStr} AND created_at <= ${endDateStr}`,
        sql`SELECT COALESCE(SUM(COALESCE(advance_amount, 0)), 0)::numeric AS sum FROM bookings WHERE booking_status = 'Confirmed' AND created_at >= ${startDateStr} AND created_at <= ${endDateStr}`,
        sql`SELECT COALESCE(SUM(COALESCE(advance_amount, 0)), 0)::numeric AS sum FROM bookings WHERE booking_status = 'Confirmed' AND created_at >= ${prevStartDateStr} AND created_at < ${startDateStr}`,
        sql`SELECT COALESCE(SUM(COALESCE(total_due, emi_amount, 0)), 0)::numeric AS sum FROM emi_schedules WHERE emi_status IN ('Pending', 'Overdue', 'ProofSubmitted') AND created_at >= ${startDateStr} AND created_at <= ${endDateStr}`,
        sql`SELECT COUNT(*)::int AS count, COALESCE(SUM(COALESCE(paid_amount, 0)), 0)::numeric AS sum FROM emi_schedules WHERE emi_status = 'Paid' AND COALESCE(paid_date, confirmed_at, updated_at) >= ${startDateStr} AND COALESCE(paid_date, confirmed_at, updated_at) <= ${endDateStr}`,
        sql`SELECT COUNT(*)::int AS count FROM analytics_events WHERE created_at >= ${startDateStr} AND created_at <= ${endDateStr}`,
        sql`SELECT COUNT(*)::int AS count FROM analytics_events WHERE created_at >= ${prevStartDateStr} AND created_at < ${startDateStr}`,
        sql`SELECT COUNT(DISTINCT visitor_id)::int AS count FROM analytics_events WHERE created_at >= ${startDateStr} AND created_at <= ${endDateStr}`,
        sql`SELECT COUNT(DISTINCT visitor_id)::int AS count FROM analytics_events WHERE created_at >= NOW() - INTERVAL '5 minutes'`
      ]);

      // Traffic Trends
      const trafficTrend = await sql`
        SELECT
          to_char(created_at, 'YYYY-MM-DD') AS date,
          COUNT(*)::int AS page_views,
          COUNT(DISTINCT visitor_id)::int AS visitors,
          COUNT(DISTINCT session_id)::int AS sessions
        FROM analytics_events
        WHERE created_at >= ${startDateStr} AND created_at <= ${endDateStr}
        GROUP BY 1
        ORDER BY 1 ASC
        LIMIT 90`;

      // Top Pages
      const topPages = await sql`
        SELECT
          page_url,
          COALESCE(page_title, page_url) AS page_title,
          COUNT(*)::int AS page_views,
          COUNT(DISTINCT visitor_id)::int AS unique_visitors
        FROM analytics_events
        WHERE created_at >= ${startDateStr} AND created_at <= ${endDateStr} AND page_url IS NOT NULL
        GROUP BY page_url, page_title
        ORDER BY page_views DESC
        LIMIT 15`;

      // Property Performance
      const projectPerformance = await sql`
        SELECT
          s.site_id,
          s.site_name,
          COALESCE(s.city, s.full_address) AS location,
          COUNT(DISTINCT p.plot_id)::int AS total_plots,
          COUNT(DISTINCT p.plot_id) FILTER (WHERE b.booking_id IS NULL OR b.booking_status = 'Cancelled')::int AS available_plots,
          COUNT(DISTINCT p.plot_id) FILTER (WHERE b.booking_status::text IN ('Submitted', 'Pending', 'PaymentPending', 'InProcess'))::int AS in_process_plots,
          COUNT(DISTINCT p.plot_id) FILTER (WHERE b.booking_status = 'Confirmed')::int AS sold_plots,
          COALESCE(inq.enquiry_count, 0)::int AS enquiries,
          COALESCE(ae.view_count, 0)::int AS views,
          COALESCE(SUM(b.advance_amount) FILTER (WHERE b.booking_status = 'Confirmed'), 0)::numeric AS revenue
        FROM sites s
        LEFT JOIN plots p ON p.site_id = s.site_id AND p.is_active = TRUE
        LEFT JOIN bookings b ON b.plot_id = p.plot_id
        LEFT JOIN (
          SELECT site_id, COUNT(*)::int AS enquiry_count
          FROM inquiries
          WHERE created_at >= ${startDateStr} AND created_at <= ${endDateStr}
          GROUP BY site_id
        ) inq ON inq.site_id = s.site_id
        LEFT JOIN (
          SELECT site_id, COUNT(*)::int AS view_count
          FROM analytics_events
          WHERE created_at >= ${startDateStr} AND created_at <= ${endDateStr} AND site_id IS NOT NULL
          GROUP BY site_id
        ) ae ON ae.site_id = s.site_id
        WHERE 1=1 ${siteIdFilter ? sql`AND s.site_id = ${siteIdFilter}` : sql``}
        GROUP BY s.site_id, s.site_name, s.city, s.full_address, inq.enquiry_count, ae.view_count
        ORDER BY sold_plots DESC, revenue DESC`;

      // Top Viewed Plots
      const topPlots = await sql`
        SELECT
          p.plot_id,
          p.plot_number,
          s.site_name,
          p.plot_status,
          p.base_price,
          COALESCE(ae.views, 0)::int AS views,
          COALESCE(b.booking_count, 0)::int AS bookings
        FROM plots p
        JOIN sites s ON s.site_id = p.site_id
        LEFT JOIN (
          SELECT plot_id, COUNT(*)::int AS views
          FROM analytics_events
          WHERE created_at >= ${startDateStr} AND created_at <= ${endDateStr} AND plot_id IS NOT NULL
          GROUP BY plot_id
        ) ae ON ae.plot_id = p.plot_id
        LEFT JOIN (
          SELECT plot_id, COUNT(*)::int AS booking_count
          FROM bookings
          WHERE created_at >= ${startDateStr} AND created_at <= ${endDateStr}
          GROUP BY plot_id
        ) b ON b.plot_id = p.plot_id
        WHERE p.is_active = TRUE ${siteIdFilter ? sql`AND p.site_id = ${siteIdFilter}` : sql``}
        ORDER BY views DESC, bookings DESC
        LIMIT 20`;

      // Enquiry Sources & Status Breakdown
      const enquiryStatusList = await sql`
        SELECT status, COUNT(*)::int AS count
        FROM inquiries
        WHERE created_at >= ${startDateStr} AND created_at <= ${endDateStr} ${siteIdFilter ? sql`AND site_id = ${siteIdFilter}` : sql``}
        GROUP BY status`;

      const enquirySources = await sql`
        SELECT COALESCE(utm_source, 'Direct') AS source, COUNT(*)::int AS count
        FROM analytics_events
        WHERE created_at >= ${startDateStr} AND created_at <= ${endDateStr}
        GROUP BY 1
        ORDER BY count DESC
        LIMIT 10`;

      // Device & Location Analytics
      const devicesList = await sql`
        SELECT COALESCE(device_type, 'Desktop') AS device, COUNT(*)::int AS count
        FROM analytics_events
        WHERE created_at >= ${startDateStr} AND created_at <= ${endDateStr}
        GROUP BY 1`;

      const topLocations = await sql`
        SELECT COALESCE(city, 'Lucknow') AS city, COALESCE(state, 'Uttar Pradesh') AS state, COUNT(*)::int AS count
        FROM analytics_events
        WHERE created_at >= ${startDateStr} AND created_at <= ${endDateStr}
        GROUP BY 1, 2
        ORDER BY count DESC
        LIMIT 10`;

      // Document & KYC Counts Summary
      const kycSummary = await sql`
        SELECT
          COUNT(*)::int AS total_documents,
          COUNT(*) FILTER (WHERE COALESCE(review_status, 'Pending') = 'Pending')::int AS pending_kyc,
          COUNT(*) FILTER (WHERE COALESCE(review_status, 'Pending') = 'Approved' OR is_verified = TRUE)::int AS approved_kyc,
          COUNT(*) FILTER (WHERE COALESCE(review_status, 'Pending') = 'Rejected')::int AS rejected_kyc
        FROM user_documents`;

      const pctChange = (cur, prev) => {
        const c = Number(cur || 0);
        const p = Number(prev || 0);
        if (p === 0) return c > 0 ? 100 : 0;
        return Number((((c - p) / p) * 100).toFixed(1));
      };

      const overview = {
        totalVisitors: { current: Number(visitorsRow[0]?.count || 0), change: pctChange(visitorsRow[0]?.count, prevVisitorsRow[0]?.count) },
        uniqueVisitors: { current: Number(uniqueVisitorsRow[0]?.count || 0), change: 0 },
        newUsers: { current: Number(newUsersRow[0]?.count || 0), change: pctChange(newUsersRow[0]?.count, prevNewUsersRow[0]?.count) },
        totalRegisteredUsers: { current: Number(totalUsersRow[0]?.count || 0), change: 0 },
        totalInvestors: { current: Number(totalInvestorsRow[0]?.count || 0), change: 0 },
        newInvestors: { current: Number(newInvestorsRow[0]?.count || 0), change: pctChange(newInvestorsRow[0]?.count, prevNewInvestorsRow[0]?.count) },
        totalEnquiries: { current: Number(enquiriesRow[0]?.count || 0), change: pctChange(enquiriesRow[0]?.count, prevEnquiriesRow[0]?.count) },
        newEnquiries: { current: Number(newEnquiriesRow[0]?.count || 0), change: 0 },
        totalBookings: { current: Number(bookingsRow[0]?.count || 0), change: pctChange(bookingsRow[0]?.count, prevBookingsRow[0]?.count) },
        pendingBookings: { current: Number(pendingBookingsRow[0]?.count || 0), change: 0 },
        confirmedBookings: { current: Number(confirmedBookingsRow[0]?.count || 0), change: 0 },
        cancelledBookings: { current: Number(cancelledBookingsRow[0]?.count || 0), change: 0 },
        totalRevenue: { current: Number(revenueRow[0]?.sum || 0), change: pctChange(revenueRow[0]?.sum, prevRevenueRow[0]?.sum) },
        pendingPayments: { current: Number(pendingPaymentsRow[0]?.sum || 0), change: 0 },
        successfulPayments: { current: Number(successfulPaymentsRow[0]?.sum || 0), count: Number(successfulPaymentsRow[0]?.count || 0), change: 0 }
      };

      return ok(res, {
        preset,
        startDate: startDateStr,
        endDate: endDateStr,
        lastUpdated: new Date().toISOString(),
        liveVisitors: Number(liveVisitorsRow[0]?.count || 0),
        overview,
        trafficTrend,
        topPages,
        projectPerformance,
        topPlots,
        enquiryStatusList,
        enquirySources,
        devicesList,
        topLocations,
        kycSummary: kycSummary[0] || {},
        seoStatus: {
          integrated: false,
          message: "Google Search Console integration required to display search rankings, impressions, and CTR."
        }
      }, "Analytics loaded successfully.");

    } catch (e) {
      console.error("[Admin Analytics Error]", e);
      return err(res, "Failed to load analytics data", 500);
    }
  }
);

// Export Analytics CSV
app.get("/api/admin/analytics/export",
  verifyAdminToken,
  role("SuperAdmin", "FinanceManager", "SiteManager"),
  async (req, res) => {
    try {
      const preset = req.query.preset || '30d';
      const sites = await sql`
        SELECT s.site_name, COUNT(DISTINCT p.plot_id)::int AS plots,
               COUNT(DISTINCT b.booking_id) FILTER (WHERE b.booking_status = 'Confirmed')::int AS confirmed_bookings,
               COALESCE(SUM(b.advance_amount) FILTER (WHERE b.booking_status = 'Confirmed'), 0)::numeric AS revenue
        FROM sites s
        LEFT JOIN plots p ON p.site_id = s.site_id
        LEFT JOIN bookings b ON b.plot_id = p.plot_id
        WHERE s.is_active = TRUE
        GROUP BY s.site_name
        ORDER BY revenue DESC`;

      let csv = "Site Name,Total Plots,Confirmed Bookings,Revenue (INR)\n";
      sites.forEach(s => {
        csv += `"${s.site_name}",${s.plots},${s.confirmed_bookings},${s.revenue}\n`;
      });

      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="mmr-analytics-${preset}-${new Date().toISOString().slice(0,10)}.csv"`);
      return res.status(200).send(csv);
    } catch (e) {
      console.error("[Admin Analytics Export Error]", e);
      return err(res, "Failed to export analytics CSV", 500);
    }
  }
);

/* ==========================
   404 + Error Handler
========================== */
app.use((req, res) => res.status(404).json({ success: false, message: "Route not found" }));

app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    const message = error.code === "LIMIT_FILE_SIZE"
      ? "Uploaded file is too large."
      : publicErrorMessage(error.message, 400);
    return res.status(400).json({ success: false, message });
  }
  if (/Only (HTML files|PDF, JPG, JPEG, and PNG files) are allowed\./.test(error.message || ""))
    return res.status(400).json({ success: false, message: error.message });
  if (error?.type === "entity.too.large") {
    return res.status(413).json({ success: false, message: "Request is too large." });
  }
  console.error("[Unhandled API Error]", {
    method: req.method,
    path: req.originalUrl,
    message: error?.message,
    stack: isProduction ? undefined : error?.stack,
  });
  res.status(500).json({ success: false, message: error?.message || "Unable to process request right now." });
});

const PORT = Number(process.env.PORT) || 5000;
const shouldStartServer =
  !process.env.FUNCTION_TARGET &&
process.on("uncaughtException", (err) => {
  console.error("[MMR API Global Uncaught Exception]", err?.message || err);
});

process.on("unhandledRejection", (reason) => {
  console.error("[MMR API Global Unhandled Rejection]", reason?.message || reason);
});

if (shouldStartServer) {
  try {
    startBackupScheduler({
      logAudit: async (action, backup) => {
        try {
          await sql`
            INSERT INTO audit_log (actor_type, actor_id, actor_name, module, action, target_table, target_record_id, new_value)
            VALUES ('System', null, 'Automatic Backup Scheduler', 'DatabaseBackup', ${action},
                    'database_backup_files', ${backup?.id || null}, ${JSON.stringify(backup || {})})`;
        } catch {}
      },
    });
  } catch (schedErr) {
    console.warn("[MMR API] Backup scheduler init warning:", schedErr.message);
  }

  const server = app.listen(PORT, "0.0.0.0", async () => {
    try {
      await sql`SELECT 1`;
      const dbConfig = getDatabaseConfig();
      console.log("PostgreSQL connection successful (Primary VPS)");
      console.log(`Database: ${dbConfig.database}`);
      console.log(`Host: ${dbConfig.host}`);
      console.log(`Port: ${dbConfig.port}`);
    } catch (dbErr) {
      console.error("[MMR API] VPS Database connection test failed:", dbErr.message);
    }

    try {
      if (typeof requirePlotManagementSchema === "function") {
        await requirePlotManagementSchema().catch((e) => console.warn("[MMR API] Plot schema warning:", e.message));
      }
      await Promise.all([
        ensureHomeExperienceSchema().catch(() => {}),
        ensureHomeSlidersSchema().catch(() => {}),
        ensureSiteHtmlMapSchema().catch(() => {}),
        ensureAnalyticsSchema().catch(() => {}),
      ]).catch(() => {});
    } catch (error) {
      console.warn("[MMR API] Schema initialization warning:", error.message);
    }

    console.log(`[MMR API] Server running on port ${PORT}`);
  });

  server.on("error", (error) => {
    console.error("[MMR API] Server startup failed", {
      code: error.code,
      message: error.message,
    });
    process.exitCode = 1;
  });

  globalThis.__mmrApiServer = server;
}

export default app;
