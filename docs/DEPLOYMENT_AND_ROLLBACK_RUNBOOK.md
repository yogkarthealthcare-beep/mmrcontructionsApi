# MMR Construction & Developers Pvt. Ltd.
# Phase 2 & 2B Production Deployment & Rollback Runbook

This runbook guides DevOps and Engineering through deploying and, if necessary, rolling back Phase 2 / Phase 2B backend migrations and application code on the VPS production environment.

---

## 1. Pre-Deployment Readiness Checklist

- [ ] Confirm no running long migrations or blocking schema locks (`SELECT * FROM pg_stat_activity WHERE state = 'active'`).
- [ ] Confirm active environment variables in VPS PM2 or `.env`:
  ```bash
  BOOKING_APPROVAL_ENABLED=true
  REFERRAL_INVALID_CODE_MODE=reject
  ```
- [ ] Confirm Node.js version >= 18.x and PostgreSQL version >= 15.x on production host.
- [ ] Ensure local integration verification passed 100% (`node scripts/test_phase2b_integration.js`).

---

## 2. Production Deployment Steps

### Step 1: Transfer / Pull Code
Navigate to application repository on the server:
```bash
cd /var/www/mmrconstructionsApi
git fetch origin
git checkout main
git pull origin main
```

### Step 2: Install Node Dependencies
```bash
npm install --omit=dev
```

### Step 3: Run Knex Database Migrations
Execute Phase 1 and Phase 2 migrations idempotently:
```bash
# Verify current migration status
npx knex migrate:status

# Run forward migrations
npx knex migrate:latest
```
*Note: The migration script enforces `SET LOCAL lock_timeout = '5s'` to prevent lock waits from impacting concurrent production user queries.*

### Step 4: Verify Migration Success
Verify that columns, constraints, and views are present:
```sql
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'bookings' AND column_name IN ('associate_approval_status', 'associate_approval_overridden', 'sold_by_user_id', 'associate_user_id');

-- Verify view has confirmed_at and site_name
SELECT confirmed_at, site_name FROM vw_sales_attribution LIMIT 1;
```

### Step 5: Graceful Reload Express Application
```bash
pm2 reload ecosystem.config.js --update-env
pm2 status
```

### Step 6: Post-Deployment Smoke Test
Run HTTP health check and verify directories:
```bash
curl -f http://127.0.0.1:5000/api/health
```

---

## 3. Rollback Runbook

If any critical regression occurs post-deployment, follow this exact procedure:

### Step 1: Revert Migration (Down)
Run Knex migrate down:
```bash
# Roll back Phase 2 migration
npx knex migrate:rollback
```
*The `down()` function cleanly reverts `vw_sales_attribution`, drops `associate_approval_overridden`, and restores original `chk_users_referred_by_source` constraints.*

### Step 2: Revert Application Code
```bash
git checkout HEAD~1
npm install --omit=dev
pm2 reload ecosystem.config.js --update-env
```

### Step 3: Verify Reverted State
Check PM2 logs:
```bash
pm2 logs mmr-api --lines 100
```
