import fs from "fs/promises";
import path from "path";
import { spawn } from "child_process";
import sql, { getDatabaseUrl } from "../db.js";

const DEFAULT_RETENTION = 30;
const SCHEDULER_INTERVAL_MS = 60 * 1000;
const SUPPORTED_RESTORE_EXTENSIONS = new Set([".sql", ".backup", ".dump", ".tar"]);

let schemaReadyPromise;
let schedulerStarted = false;
let lastSchedulerRunKey = "";

const parseBool = (value, fallback = false) => {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return ["true", "1", "yes", "on"].includes(String(value).toLowerCase());
};

const defaultBackupRoot = () => {
  if (process.env.DB_BACKUP_DIR) return process.env.DB_BACKUP_DIR;
  return path.join(process.cwd(), "backups", "postgresql");
};

const backupRoot = () => path.resolve(defaultBackupRoot());

export const restoreUploadRoot = () => path.join(backupRoot(), "restore-uploads");

export const restoreUploadMaxBytes = () =>
  Math.max(Number(process.env.DB_RESTORE_MAX_UPLOAD_MB || 512), 1) * 1024 * 1024;

const safeBasename = (fileName) => {
  const base = path.basename(String(fileName || ""));
  if (!/^[a-zA-Z0-9._-]+\.sql$/.test(base)) {
    throw new Error("Invalid backup file name.");
  }
  return base;
};

const safeRestoreBasename = (fileName) => {
  const base = path.basename(String(fileName || ""));
  if (!/^[a-zA-Z0-9._-]+\.(sql|backup|dump|tar)$/i.test(base)) {
    throw new Error("Invalid restore file name.");
  }
  return base;
};

const cleanRestoreOriginalName = (fileName) => {
  const base = path.basename(String(fileName || "restore.sql")).replace(/[^a-zA-Z0-9._-]/g, "_");
  return safeRestoreBasename(base);
};

const backupPathFor = (fileName) => path.join(backupRoot(), safeBasename(fileName));
const restoreUploadPathFor = (fileName) => path.join(restoreUploadRoot(), safeRestoreBasename(fileName));

const toFileUrl = (filePath) => filePath.replace(/\\/g, "/");

const formatBytes = (bytes = 0) => {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
};

const readDatabaseInfo = () => {
  const databaseUrl = getDatabaseUrl();
  const parsed = new URL(databaseUrl);
  const explicitProvider = String(process.env.DB_PROVIDER || process.env.DATABASE_PROVIDER || "").toLowerCase();
  const host = parsed.hostname;
  const databaseName = parsed.pathname.replace(/^\//, "") || process.env.PGDATABASE || process.env.DB_NAME || "";
  const supabaseHost = /supabase\.(co|com)|pooler\.supabase\.com/i.test(host);
  const type = explicitProvider.includes("supabase") || supabaseHost ? "Supabase" : "VPS";

  return {
    type,
    label: type === "Supabase" ? "Supabase PostgreSQL" : "VPS PostgreSQL",
    host,
    port: parsed.port || "5432",
    databaseName,
    username: decodeURIComponent(parsed.username || ""),
    connectionUrl: databaseUrl,
  };
};

const commandEnv = (dbInfo) => {
  const parsed = new URL(dbInfo.connectionUrl);
  return {
    ...process.env,
    PGHOST: parsed.hostname,
    PGPORT: parsed.port || "5432",
    PGDATABASE: parsed.pathname.replace(/^\//, ""),
    PGUSER: decodeURIComponent(parsed.username || ""),
    PGPASSWORD: decodeURIComponent(parsed.password || ""),
    PGSSLMODE: dbInfo.type === "Supabase" || parseBool(process.env.DB_SSL, false) ? "require" : (process.env.PGSSLMODE || "prefer"),
  };
};

const runCommand = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: options.env || process.env,
      cwd: process.cwd(),
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      if (error.code === "ENOENT") {
        reject(new Error(`${command} is not installed or not available in PATH.`));
      } else {
        reject(error);
      }
    });
    child.on("close", (code) => {
      if (code === 0) return resolve({ stdout, stderr });
      reject(new Error(stderr.trim() || `${command} exited with code ${code}.`));
    });
  });

const quoteIdent = (value) => `"${String(value).replace(/"/g, '""')}"`;
const qualifiedName = (schema, name) => `${quoteIdent(schema)}.${quoteIdent(name)}`;

const sqlLiteral = (value) => {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  if (typeof value === "bigint") return String(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (value instanceof Date) return `'${value.toISOString().replace(/'/g, "''")}'`;
  if (Buffer.isBuffer(value)) return `decode('${value.toString("hex")}', 'hex')`;
  if (typeof value === "object") return `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`;
  return `'${String(value).replace(/'/g, "''")}'`;
};

const appendBackupSql = async (filePath, content = "") => {
  await fs.appendFile(filePath, content, "utf8");
};

async function createJavaScriptSqlBackup(filePath, dbInfo) {
  await fs.writeFile(filePath, [
    "-- MMR Constructions PostgreSQL backup",
    "-- Generated by application fallback exporter",
    `-- Database: ${dbInfo.databaseName}`,
    `-- Host: ${dbInfo.host}`,
    `-- Generated at: ${new Date().toISOString()}`,
    "",
    "SET statement_timeout = 0;",
    "SET lock_timeout = 0;",
    "SET client_encoding = 'UTF8';",
    "SET standard_conforming_strings = on;",
    "SET check_function_bodies = false;",
    "",
  ].join("\n"), "utf8");

  const schemas = await sql`
    SELECT DISTINCT n.nspname AS schema_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p', 'S', 'v', 'm')
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg_toast%'
      AND n.nspname NOT LIKE 'pg_temp_%'
    ORDER BY n.nspname`;

  for (const schema of schemas) {
    await appendBackupSql(filePath, `CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schema.schema_name)};\n`);
  }
  await appendBackupSql(filePath, "\n");

  const extensions = await sql`
    SELECT extname FROM pg_extension
    WHERE extname <> 'plpgsql'
    ORDER BY extname`;
  for (const extension of extensions) {
    await appendBackupSql(filePath, `CREATE EXTENSION IF NOT EXISTS ${quoteIdent(extension.extname)};\n`);
  }
  if (extensions.length) await appendBackupSql(filePath, "\n");

  const enums = await sql`
    SELECT n.nspname AS schema_name, t.typname AS type_name,
           array_agg(e.enumlabel ORDER BY e.enumsortorder) AS labels
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    JOIN pg_enum e ON e.enumtypid = t.oid
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
    GROUP BY n.nspname, t.typname
    ORDER BY n.nspname, t.typname`;
  for (const enumType of enums) {
    const labels = enumType.labels.map((label) => sqlLiteral(label)).join(", ");
    await appendBackupSql(filePath, `DO $$ BEGIN\n`);
    await appendBackupSql(filePath, `  CREATE TYPE ${qualifiedName(enumType.schema_name, enumType.type_name)} AS ENUM (${labels});\n`);
    await appendBackupSql(filePath, `EXCEPTION WHEN duplicate_object THEN NULL; END $$;\n`);
  }
  if (enums.length) await appendBackupSql(filePath, "\n");

  const sequences = await sql`
    SELECT schemaname AS schema_name, sequencename AS sequence_name
    FROM pg_sequences
    WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
    ORDER BY schemaname, sequencename`;
  for (const sequence of sequences) {
    await appendBackupSql(filePath, `CREATE SEQUENCE IF NOT EXISTS ${qualifiedName(sequence.schema_name, sequence.sequence_name)};\n`);
  }
  if (sequences.length) await appendBackupSql(filePath, "\n");

  const tables = await sql`
    SELECT n.nspname AS schema_name, c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p')
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg_toast%'
      AND n.nspname NOT LIKE 'pg_temp_%'
    ORDER BY n.nspname, c.relname`;

  for (const table of tables) {
    const columns = await sql`
      SELECT a.attname AS column_name,
             pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
             pg_get_expr(d.adbin, d.adrelid) AS column_default,
             a.attnotnull AS not_null,
             a.attidentity AS identity_type,
             a.attgenerated AS generated_type
      FROM pg_attribute a
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ${table.schema_name}
        AND c.relname = ${table.table_name}
        AND a.attnum > 0
        AND NOT a.attisdropped
      ORDER BY a.attnum`;

    const columnDefs = columns.map((column) => {
      const parts = [quoteIdent(column.column_name), column.data_type];
      if (column.identity_type === "a") parts.push("GENERATED ALWAYS AS IDENTITY");
      if (column.identity_type === "d") parts.push("GENERATED BY DEFAULT AS IDENTITY");
      if (column.generated_type === "s" && column.column_default) parts.push(`GENERATED ALWAYS AS (${column.column_default}) STORED`);
      if (!column.identity_type && !column.generated_type && column.column_default) parts.push(`DEFAULT ${column.column_default}`);
      if (column.not_null) parts.push("NOT NULL");
      return `  ${parts.join(" ")}`;
    });

    await appendBackupSql(filePath, `CREATE TABLE IF NOT EXISTS ${qualifiedName(table.schema_name, table.table_name)} (\n${columnDefs.join(",\n")}\n);\n\n`);
  }

  await appendBackupSql(filePath, "BEGIN;\n\n");
  const pageSize = Math.min(Math.max(Number(process.env.DB_BACKUP_EXPORT_PAGE_SIZE || 500), 50), 5000);
  for (const table of tables) {
    const columns = await sql`
      SELECT a.attname AS column_name
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ${table.schema_name}
        AND c.relname = ${table.table_name}
        AND a.attnum > 0
        AND NOT a.attisdropped
        AND a.attgenerated = ''
      ORDER BY a.attnum`;
    if (!columns.length) continue;

    const columnList = columns.map((column) => quoteIdent(column.column_name)).join(", ");
    const selectList = columns.map((column) => quoteIdent(column.column_name)).join(", ");
    let offset = 0;
    for (;;) {
      const rows = await sql.unsafe(
        `SELECT ${selectList} FROM ${qualifiedName(table.schema_name, table.table_name)} LIMIT ${pageSize} OFFSET ${offset}`
      );
      if (!rows.length) break;
      const values = rows.map((row) => `(${columns.map((column) => sqlLiteral(row[column.column_name])).join(", ")})`);
      await appendBackupSql(
        filePath,
        `INSERT INTO ${qualifiedName(table.schema_name, table.table_name)} (${columnList}) VALUES\n${values.join(",\n")}\nON CONFLICT DO NOTHING;\n\n`
      );
      offset += rows.length;
      if (rows.length < pageSize) break;
    }
  }
  await appendBackupSql(filePath, "COMMIT;\n\n");

  const constraints = await sql`
    SELECT n.nspname AS schema_name, c.relname AS table_name, con.conname AS constraint_name,
           pg_get_constraintdef(con.oid, true) AS definition
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND con.contype IN ('p', 'u', 'c', 'f')
    ORDER BY CASE con.contype WHEN 'p' THEN 1 WHEN 'u' THEN 2 WHEN 'c' THEN 3 WHEN 'f' THEN 4 ELSE 5 END,
             n.nspname, c.relname, con.conname`;
  for (const constraint of constraints) {
    await appendBackupSql(filePath, `ALTER TABLE ${qualifiedName(constraint.schema_name, constraint.table_name)} ADD CONSTRAINT ${quoteIdent(constraint.constraint_name)} ${constraint.definition};\n`);
  }
  if (constraints.length) await appendBackupSql(filePath, "\n");

  const indexes = await sql`
    SELECT schemaname AS schema_name, tablename AS table_name, indexname AS index_name, indexdef
    FROM pg_indexes
    WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
      AND indexname NOT IN (
        SELECT conname FROM pg_constraint
      )
    ORDER BY schemaname, tablename, indexname`;
  for (const index of indexes) {
    await appendBackupSql(filePath, `${index.indexdef};\n`);
  }
  if (indexes.length) await appendBackupSql(filePath, "\n");

  for (const sequence of sequences) {
    const [state] = await sql.unsafe(
      `SELECT last_value, is_called FROM ${qualifiedName(sequence.schema_name, sequence.sequence_name)}`
    );
    if (state) {
      await appendBackupSql(
        filePath,
        `SELECT setval('${sequence.schema_name.replace(/'/g, "''")}.${sequence.sequence_name.replace(/'/g, "''")}', ${Number(state.last_value || 1)}, ${state.is_called ? "true" : "false"});\n`
      );
    }
  }

  const views = await sql`
    SELECT n.nspname AS schema_name, c.relname AS view_name, c.relkind,
           pg_get_viewdef(c.oid, true) AS definition
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('v', 'm')
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
    ORDER BY n.nspname, c.relname`;
  for (const view of views) {
    const keyword = view.relkind === "m" ? "MATERIALIZED VIEW" : "VIEW";
    await appendBackupSql(filePath, `CREATE ${keyword} IF NOT EXISTS ${qualifiedName(view.schema_name, view.view_name)} AS\n${view.definition};\n`);
  }
}

export async function ensureBackupSchema() {
  if (!schemaReadyPromise) {
    schemaReadyPromise = (async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS database_backup_files (
          id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
          file_name TEXT NOT NULL UNIQUE,
          file_path TEXT NOT NULL,
          database_type TEXT NOT NULL,
          database_host TEXT,
          database_name TEXT,
          file_data BYTEA,
          file_size_bytes BIGINT NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'Completed',
          error_message TEXT,
          created_by_admin_id INTEGER,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          restored_at TIMESTAMPTZ,
          restored_by_admin_id INTEGER,
          deleted_at TIMESTAMPTZ,
          deleted_by_admin_id INTEGER
        )`;
      await sql`
        CREATE INDEX IF NOT EXISTS idx_database_backup_files_created_at
        ON database_backup_files (created_at DESC)`;
      await sql`ALTER TABLE database_backup_files ADD COLUMN IF NOT EXISTS file_data BYTEA`;
      await sql`
        CREATE TABLE IF NOT EXISTS database_backup_settings (
          id INTEGER PRIMARY KEY DEFAULT 1,
          daily_backup_enabled BOOLEAN NOT NULL DEFAULT FALSE,
          backup_time TIME NOT NULL DEFAULT '02:00',
          keep_last_backups INTEGER NOT NULL DEFAULT 30,
          auto_delete_older BOOLEAN NOT NULL DEFAULT TRUE,
          updated_by_admin_id INTEGER,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT database_backup_settings_singleton CHECK (id = 1)
        )`;
      await sql`
        INSERT INTO database_backup_settings (id)
        VALUES (1)
        ON CONFLICT (id) DO NOTHING`;
      await sql`
        CREATE TABLE IF NOT EXISTS database_restore_uploads (
          id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
          file_name TEXT NOT NULL,
          original_file_name TEXT NOT NULL,
          file_path TEXT NOT NULL,
          file_size_bytes BIGINT NOT NULL DEFAULT 0,
          file_format TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'Uploaded',
          validation_message TEXT,
          uploaded_by_admin_id INTEGER,
          uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          deleted_at TIMESTAMPTZ
        )`;
      await sql`
        CREATE INDEX IF NOT EXISTS idx_database_restore_uploads_uploaded_at
        ON database_restore_uploads (uploaded_at DESC)`;
      await sql`
        CREATE TABLE IF NOT EXISTS database_restore_history (
          id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
          restore_upload_id BIGINT REFERENCES database_restore_uploads(id),
          backup_file_name TEXT NOT NULL,
          restore_mode TEXT NOT NULL,
          admin_id INTEGER,
          admin_name TEXT,
          status TEXT NOT NULL,
          started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          ended_at TIMESTAMPTZ,
          duration_ms INTEGER,
          message TEXT,
          error_details TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`;
      await sql`
        CREATE INDEX IF NOT EXISTS idx_database_restore_history_created_at
        ON database_restore_history (created_at DESC)`;
    })().catch((error) => {
      schemaReadyPromise = null;
      throw error;
    });
  }
  return schemaReadyPromise;
}

const mapBackupRow = (row = {}) => ({
  id: Number(row.id),
  file_name: row.file_name,
  database_type: row.database_type,
  database_host: row.database_host,
  database_name: row.database_name,
  file_size_bytes: Number(row.file_size_bytes || 0),
  file_size: formatBytes(row.file_size_bytes),
  status: row.status,
  error_message: row.error_message,
  created_at: row.created_at,
  restored_at: row.restored_at,
});

const mapRestoreUploadRow = (row = {}) => ({
  id: Number(row.id),
  file_name: row.file_name,
  original_file_name: row.original_file_name,
  file_size_bytes: Number(row.file_size_bytes || 0),
  file_size: formatBytes(row.file_size_bytes),
  file_format: row.file_format,
  status: row.status,
  validation_message: row.validation_message,
  uploaded_by_admin_id: row.uploaded_by_admin_id,
  uploaded_at: row.uploaded_at,
});

const mapRestoreHistoryRow = (row = {}) => ({
  id: Number(row.id),
  restore_upload_id: row.restore_upload_id ? Number(row.restore_upload_id) : null,
  backup_file_name: row.backup_file_name,
  restore_mode: row.restore_mode,
  admin_id: row.admin_id,
  admin_name: row.admin_name,
  status: row.status,
  started_at: row.started_at,
  ended_at: row.ended_at,
  duration_ms: Number(row.duration_ms || 0),
  duration: row.duration_ms == null ? "-" : `${(Number(row.duration_ms) / 1000).toFixed(1)}s`,
  message: row.message,
  error_details: row.error_details,
});

const restoreFormatFor = (fileName) => {
  const ext = path.extname(fileName || "").toLowerCase();
  if (!SUPPORTED_RESTORE_EXTENSIONS.has(ext)) {
    throw new Error("Unsupported restore file type. Upload .sql, .backup, .dump, or .tar files only.");
  }
  return ext === ".sql" ? "plain_sql" : "pg_restore";
};

export async function getBackupSettings() {
  await ensureBackupSchema();
  const [settings] = await sql`SELECT * FROM database_backup_settings WHERE id = 1`;
  return {
    daily_backup_enabled: Boolean(settings?.daily_backup_enabled),
    backup_time: String(settings?.backup_time || "02:00").slice(0, 5),
    keep_last_backups: Number(settings?.keep_last_backups || DEFAULT_RETENTION),
    auto_delete_older: settings?.auto_delete_older !== false,
  };
}

export async function updateBackupSettings(payload, adminId = null) {
  await ensureBackupSchema();
  const keepLast = Math.min(Math.max(Number(payload.keep_last_backups || DEFAULT_RETENTION), 1), 365);
  const backupTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(payload.backup_time || ""))
    ? String(payload.backup_time)
    : "02:00";
  const [settings] = await sql`
    UPDATE database_backup_settings SET
      daily_backup_enabled = ${Boolean(payload.daily_backup_enabled)},
      backup_time = ${backupTime},
      keep_last_backups = ${keepLast},
      auto_delete_older = ${payload.auto_delete_older !== false},
      updated_by_admin_id = ${adminId},
      updated_at = NOW()
    WHERE id = 1
    RETURNING *`;
  return settings;
}

export async function getBackupStatus() {
  await ensureBackupSchema();
  const dbInfo = readDatabaseInfo();
  const settings = await getBackupSettings();
  const [lastBackup] = await sql`
    SELECT * FROM database_backup_files
    WHERE deleted_at IS NULL
    ORDER BY created_at DESC
    LIMIT 1`;

  return {
    active_database: dbInfo.label,
    database_type: dbInfo.type,
    database_host: dbInfo.host,
    database_name: dbInfo.databaseName,
    last_backup_time: lastBackup?.created_at || null,
    automatic_backup_status: settings.daily_backup_enabled ? "Enabled" : "Disabled",
    storage_location: toFileUrl(backupRoot()),
    backup_size_bytes: Number(lastBackup?.file_size_bytes || 0),
    backup_size: lastBackup ? formatBytes(lastBackup.file_size_bytes) : "0 B",
    settings,
  };
}

export async function listBackups() {
  await ensureBackupSchema();
  const rows = await sql`
    SELECT * FROM database_backup_files
    WHERE deleted_at IS NULL
    ORDER BY created_at DESC`;
  return rows.map(mapBackupRow);
}

export async function createBackup(adminId = null) {
  await ensureBackupSchema();
  const dbInfo = readDatabaseInfo();
  await fs.mkdir(backupRoot(), { recursive: true, mode: 0o700 });

  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const safeDb = dbInfo.databaseName.replace(/[^a-zA-Z0-9_-]/g, "_") || "database";
  const fileName = `${dbInfo.type.toLowerCase()}_${safeDb}_${stamp}.sql`;
  const filePath = backupPathFor(fileName);

  let inserted;
  try {
    [inserted] = await sql`
      INSERT INTO database_backup_files (
        file_name, file_path, database_type, database_host, database_name,
        status, created_by_admin_id
      ) VALUES (
        ${fileName}, ${filePath}, ${dbInfo.type}, ${dbInfo.host}, ${dbInfo.databaseName},
        'Running', ${adminId}
      )
      RETURNING *`;

    try {
      await runCommand("pg_dump", [
        "--format=p",
        "--no-owner",
        "--no-privileges",
        "--clean",
        "--if-exists",
        "--file", filePath,
        dbInfo.databaseName,
      ], { env: commandEnv(dbInfo) });
    } catch (dumpError) {
      if (!/pg_dump is not installed|not available in PATH|ENOENT/i.test(dumpError.message || "")) {
        throw dumpError;
      }
      console.warn("[Database Backup] pg_dump unavailable. Using JavaScript SQL exporter fallback.");
      await createJavaScriptSqlBackup(filePath, dbInfo);
    }

    const fileData = await fs.readFile(filePath);
    const stat = await fs.stat(filePath);
    const [updated] = await sql`
      UPDATE database_backup_files SET
        file_size_bytes = ${stat.size},
        file_data = ${fileData},
        status = 'Completed',
        error_message = NULL
      WHERE id = ${inserted.id}
      RETURNING *`;

    await pruneOldBackups();
    return mapBackupRow(updated);
  } catch (error) {
    await fs.unlink(filePath).catch(() => {});
    if (inserted?.id) {
      await sql`
        UPDATE database_backup_files SET
          status = 'Failed',
          error_message = ${error.message}
        WHERE id = ${inserted.id}`.catch(() => {});
    }
    throw error;
  }
}

export async function getBackupFile(fileName) {
  await ensureBackupSchema();
  const safeName = safeBasename(fileName);
  const [backup] = await sql`
    SELECT * FROM database_backup_files
    WHERE file_name = ${safeName} AND deleted_at IS NULL
    LIMIT 1`;
  if (!backup) throw new Error("Backup file not found.");

  const filePath = backupPathFor(backup.file_name);
  try {
    await fs.access(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    if (!backup.file_data) {
      throw new Error("Backup file is no longer available. Create a new backup and download it immediately.");
    }
    await fs.mkdir(backupRoot(), { recursive: true, mode: 0o700 });
    await fs.writeFile(filePath, backup.file_data);
  }
  return { filePath, fileName: backup.file_name, backup: mapBackupRow(backup) };
}

export async function deleteBackup(fileName, adminId = null) {
  await ensureBackupSchema();
  const safeName = safeBasename(fileName);
  const [backupRow] = await sql`
    SELECT * FROM database_backup_files
    WHERE file_name = ${safeName} AND deleted_at IS NULL
    LIMIT 1`;
  if (!backupRow) throw new Error("Backup file not found.");

  await fs.unlink(backupPathFor(backupRow.file_name)).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });

  const [deleted] = await sql`
    UPDATE database_backup_files SET
      deleted_at = NOW(),
      deleted_by_admin_id = ${adminId},
      status = 'Deleted'
    WHERE id = ${backupRow.id}
    RETURNING *`;
  return mapBackupRow(deleted);
}

export async function restoreBackup(fileName, adminId = null) {
  await ensureBackupSchema();
  const dbInfo = readDatabaseInfo();
  const { filePath, backup } = await getBackupFile(fileName);

  await runCommand("psql", [
    "--single-transaction",
    "--set", "ON_ERROR_STOP=on",
    "--file", filePath,
    dbInfo.databaseName,
  ], { env: commandEnv(dbInfo) });

  await sql`
    UPDATE database_backup_files SET
      restored_at = NOW(),
      restored_by_admin_id = ${adminId}
    WHERE id = ${backup.id}`;

  return backup;
}

export async function validateRestoreFile(filePath, fileName) {
  const stat = await fs.stat(filePath);
  if (!stat.isFile() || stat.size <= 0) throw new Error("Uploaded backup file is empty.");
  if (stat.size > restoreUploadMaxBytes()) throw new Error("Uploaded backup file exceeds the configured size limit.");

  const format = restoreFormatFor(fileName);
  if (format === "plain_sql") {
    const handle = await fs.open(filePath, "r");
    try {
      const length = Math.min(stat.size, 8192);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, 0);
      const head = buffer.toString("utf8").replace(/\0/g, "").trim();
      if (!head) throw new Error("Uploaded SQL backup appears to be empty or invalid.");
      if (!/(CREATE|INSERT|COPY|ALTER|DROP|SET|SELECT|COMMENT|BEGIN|START TRANSACTION)\b/i.test(head)) {
        throw new Error("Uploaded SQL backup does not look like a valid PostgreSQL script.");
      }
    } finally {
      await handle.close();
    }
  } else {
    await runCommand("pg_restore", ["--list", filePath]);
  }

  return { format, size: stat.size };
}

export async function registerRestoreUpload(file, adminId = null) {
  await ensureBackupSchema();
  if (!file?.path || !file?.filename) throw new Error("No restore file uploaded.");

  const originalName = cleanRestoreOriginalName(file.originalname);
  const storedName = safeRestoreBasename(file.filename);
  const filePath = restoreUploadPathFor(storedName);
  const validation = await validateRestoreFile(filePath, originalName);

  const [upload] = await sql`
    INSERT INTO database_restore_uploads (
      file_name, original_file_name, file_path, file_size_bytes, file_format,
      status, validation_message, uploaded_by_admin_id
    ) VALUES (
      ${storedName}, ${originalName}, ${filePath}, ${validation.size}, ${validation.format},
      'Validated', 'Backup file validated successfully.', ${adminId}
    )
    RETURNING *`;
  return mapRestoreUploadRow(upload);
}

export async function listRestoreUploads() {
  await ensureBackupSchema();
  const rows = await sql`
    SELECT * FROM database_restore_uploads
    WHERE deleted_at IS NULL
    ORDER BY uploaded_at DESC`;
  return rows.map(mapRestoreUploadRow);
}

export async function listRestoreHistory() {
  await ensureBackupSchema();
  const rows = await sql`
    SELECT * FROM database_restore_history
    ORDER BY created_at DESC
    LIMIT 100`;
  return rows.map(mapRestoreHistoryRow);
}

export async function restoreUploadedBackup(uploadId, options = {}) {
  await ensureBackupSchema();
  const startedAt = new Date();
  const mode = options.mode === "without_drop" ? "without_drop" : "replace";
  const adminId = options.adminId || null;
  const adminName = options.adminName || null;

  const [upload] = await sql`
    SELECT * FROM database_restore_uploads
    WHERE id = ${Number(uploadId)} AND deleted_at IS NULL
    LIMIT 1`;
  if (!upload) throw new Error("Uploaded restore file not found.");

  const filePath = restoreUploadPathFor(upload.file_name);
  const dbInfo = readDatabaseInfo();
  let history;

  [history] = await sql`
    INSERT INTO database_restore_history (
      restore_upload_id, backup_file_name, restore_mode, admin_id, admin_name, status, started_at, message
    ) VALUES (
      ${upload.id}, ${upload.original_file_name}, ${mode}, ${adminId}, ${adminName},
      'Running', ${startedAt}, 'Restore started.'
    )
    RETURNING *`;

  try {
    await validateRestoreFile(filePath, upload.original_file_name);

    if (upload.file_format === "plain_sql") {
      const args = [
        "--single-transaction",
        "--set", "ON_ERROR_STOP=on",
      ];
      if (mode === "replace") {
        args.push(
          "--command",
          "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO public;"
        );
      }
      args.push("--file", filePath, dbInfo.databaseName);
      await runCommand("psql", args, { env: commandEnv(dbInfo) });
    } else {
      const args = [
        "--single-transaction",
        "--no-owner",
        "--no-privileges",
        "--dbname", dbInfo.databaseName,
      ];
      if (mode === "replace") args.unshift("--if-exists", "--clean");
      args.push(filePath);
      await runCommand("pg_restore", args, { env: commandEnv(dbInfo) });
    }

    const endedAt = new Date();
    const [updated] = await sql`
      UPDATE database_restore_history SET
        status = 'Success',
        ended_at = ${endedAt},
        duration_ms = ${endedAt.getTime() - startedAt.getTime()},
        message = 'Database restored successfully.',
        error_details = NULL
      WHERE id = ${history.id}
      RETURNING *`;

    await sql`
      UPDATE database_restore_uploads SET status = 'Restored'
      WHERE id = ${upload.id}`;

    return mapRestoreHistoryRow(updated);
  } catch (error) {
    const endedAt = new Date();
    const [failed] = await sql`
      UPDATE database_restore_history SET
        status = 'Failed',
        ended_at = ${endedAt},
        duration_ms = ${endedAt.getTime() - startedAt.getTime()},
        message = 'Database restore failed.',
        error_details = ${error.message}
      WHERE id = ${history.id}
      RETURNING *`;
    await sql`
      UPDATE database_restore_uploads SET
        status = 'Failed',
        validation_message = ${error.message}
      WHERE id = ${upload.id}`.catch(() => {});
    const restoreError = new Error(error.message || "Database restore failed.");
    restoreError.restore = mapRestoreHistoryRow(failed);
    throw restoreError;
  }
}

export async function pruneOldBackups() {
  const settings = await getBackupSettings();
  if (!settings.auto_delete_older) return;

  const keepLast = Math.max(Number(settings.keep_last_backups || DEFAULT_RETENTION), 1);
  const oldRows = await sql`
    SELECT * FROM database_backup_files
    WHERE deleted_at IS NULL AND status = 'Completed'
    ORDER BY created_at DESC
    OFFSET ${keepLast}`;

  for (const row of oldRows) {
    await fs.unlink(backupPathFor(row.file_name)).catch(() => {});
    await sql`
      UPDATE database_backup_files SET
        deleted_at = NOW(),
        status = 'Deleted'
      WHERE id = ${row.id}`;
  }
}

export function startBackupScheduler({ logAudit } = {}) {
  if (schedulerStarted || parseBool(process.env.DB_BACKUP_SCHEDULER_DISABLED, false)) return;
  schedulerStarted = true;

  setInterval(async () => {
    try {
      const settings = await getBackupSettings();
      if (!settings.daily_backup_enabled) return;

      const now = new Date();
      const runKey = `${now.toISOString().slice(0, 10)}T${settings.backup_time}`;
      const currentTime = now.toTimeString().slice(0, 5);
      if (currentTime !== settings.backup_time || lastSchedulerRunKey === runKey) return;

      lastSchedulerRunKey = runKey;
      const backup = await createBackup(null);
      if (typeof logAudit === "function") {
        await logAudit("CreateAutomaticBackup", backup);
      }
    } catch (error) {
      console.error("[Database Backup Scheduler Error]", error.message);
    }
  }, SCHEDULER_INTERVAL_MS).unref?.();
}
