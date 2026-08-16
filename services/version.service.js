import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

let cachedVersionInfo = null;

export function getVersionInfo() {
  if (cachedVersionInfo) {
    return cachedVersionInfo;
  }

  const versionFilePath = path.join(rootDir, 'version.json');
  if (fs.existsSync(versionFilePath)) {
    try {
      const fileData = JSON.parse(fs.readFileSync(versionFilePath, 'utf8'));
      cachedVersionInfo = {
        version: fileData.version || '1.0.0',
        commit: fileData.commit || 'unknown',
        fullCommit: fileData.fullCommit || fileData.commit || 'unknown',
        branch: fileData.branch || 'main',
        environment: fileData.environment || process.env.NODE_ENV || 'production',
        buildDate: fileData.buildDate || new Date().toISOString(),
        status: 'running',
      };
      return cachedVersionInfo;
    } catch (e) {
      console.warn('[Version Service] Failed to parse version.json:', e.message);
    }
  }

  let commitCount = 1;
  let shortCommit = 'dev';
  let fullCommit = 'dev';
  let branch = 'main';

  try {
    commitCount = parseInt(execSync('git rev-list --count HEAD', { cwd: rootDir, encoding: 'utf8' }).trim(), 10) || 1;
    shortCommit = execSync('git rev-parse --short HEAD', { cwd: rootDir, encoding: 'utf8' }).trim() || 'dev';
    fullCommit = execSync('git rev-parse HEAD', { cwd: rootDir, encoding: 'utf8' }).trim() || 'dev';
    branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: rootDir, encoding: 'utf8' }).trim() || 'main';
  } catch (e) {
    // Git exec fallback for standalone production bundle
  }

  const version = `1.0.${commitCount}`;
  cachedVersionInfo = {
    version,
    commit: process.env.COMMIT_SHA_SHORT || shortCommit,
    fullCommit: process.env.COMMIT_SHA || fullCommit,
    branch: process.env.BRANCH_NAME || branch,
    environment: process.env.NODE_ENV || 'production',
    buildDate: process.env.BUILD_DATE || new Date().toISOString(),
    status: 'running',
  };

  return cachedVersionInfo;
}

export function clearVersionCache() {
  cachedVersionInfo = null;
}
