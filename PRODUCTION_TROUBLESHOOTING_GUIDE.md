# Production Troubleshooting & Fix Guide — MMR Constructions API

Save this guide as reference for future maintenance, debugging, and production deployment workflows.

---

## 1. Golden Rule: Do NOT Confuse 502 Bad Gateway with CORS

If the browser console displays:
`Access to XMLHttpRequest at 'https://api.mmrconstructions.in/...' from origin 'https://mmrconstructions.in' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present`

### Step 1: Health Check First
Run:
```bash
curl -i https://api.mmrconstructions.in/api/health
```

- **If HTTP 502 Bad Gateway is returned**: The issue is **NOT CORS**. It means the Node.js backend process on port `5000` is stopped or crashing on startup.
- **Why it looks like CORS**: Nginx default 502 error page does not include `Access-Control-Allow-Origin` headers, causing the browser to block the response and report a fake CORS error.

---

## 2. Express 5 Compatibility Trap (`path-to-regexp`)

This backend uses **Express 5** (`express: ^5.2.1`).

### Critical Gotcha:
Express 5 uses `path-to-regexp` v6+, which **crashes on wildcard route definitions** such as:
```javascript
// ❌ WRONG (Crashes Express 5 on startup with TypeError: Missing parameter name at index 1: *)
app.options("*", (req, res) => ...);
```

### ✅ Correct Solution:
Handle CORS and preflight `OPTIONS` requests globally inside middleware:
```javascript
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
```

---

## 3. Node.js Process Resilience

To prevent background promise rejections from crashing the process:

```javascript
process.on("uncaughtException", (err) => {
  console.error("[MMR API Global Uncaught Exception]", err?.message || err);
});

process.on("unhandledRejection", (reason) => {
  console.error("[MMR API Global Unhandled Rejection]", reason?.message || reason);
});
```

---

## 4. PM2 & ES Modules (`"type": "module"`)

Because `package.json` contains `"type": "module"`:
- Standard `ecosystem.config.js` with `module.exports` will fail in PM2 (`ReferenceError: module is not defined`).
- **Solution**: Name the PM2 file **`ecosystem.config.cjs`** (with `.cjs` extension).

### File: `ecosystem.config.cjs`
```javascript
module.exports = {
  apps: [
    {
      name: "mmr-api",
      script: "./server.js",
      cwd: "/var/www/mmrcontructionsApi",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "500M",
      env: {
        NODE_ENV: "production",
        PORT: 5000
      }
    }
  ]
};
```

---

## 5. Idempotent Database Operations

Avoid relying solely on `ON CONFLICT (column_name)` if database indexes might vary between staging and production. Use explicit `SELECT` + `UPDATE` / `INSERT`:

```javascript
let [user] = await sql`SELECT admin_id FROM admin_users WHERE email = ${email}`;
if (!user) {
  await sql`INSERT INTO admin_users (...) VALUES (...)`;
} else {
  await sql`UPDATE admin_users SET ... WHERE email = ${email}`;
}
```

---

## 6. VPS Deployment Command

To restart or update backend on VPS (`root@yogteck:/var/www/mmrcontructionsApi#`):

```bash
cd /var/www/mmrcontructionsApi
git pull origin main
node scripts/verify_or_create_admin_tables.js
pm2 restart ecosystem.config.cjs --update-env
```

---

## 7. Direct Admin Credentials & Links

- **Main Website**: `https://mmrconstructions.in`
- **Admin Password Change Direct Page**: `https://mmrconstructions.in/admin/change_password`
- **Admin Email**: `admin@mmrconstructions.in`
- **Admin Password**: `MMR@Admin123`
