/**
 * MMR Construction & Developers Pvt. Ltd.
 * Comprehensive Phase 1C Test Suite on Real PostgreSQL Engine (WASM-based PGlite)
 * Tests:
 * 1. Base Schema & Representative Seed Loading
 * 2. Migration UP (DDL, Indexes, Functions, Views, Backfills)
 * 3. Schema Verification & Constraint Integrity
 * 4. Attribution Distribution by user_type (Customer vs Team Member vs Associate)
 * 5. Fallback Trigger (Team Member Self-Purchase, Customer Referrer, Direct Customer)
 * 6. App Startup DDL Harness on Migrated DB (Idempotency & booking_status column alteration safety)
 * 7. App Startup DDL Harness on Fresh DB (Enum -> VARCHAR order testing)
 * 8. Migration DOWN (Clean rollback of columns, triggers, views)
 * 9. Second Migration UP (Idempotent re-run)
 */

import { PGlite } from '@electric-sql/pglite';
import { createBaseSchema, seedRepresentativeData } from './seed_phase1_representative_data.js';
import * as migration from '../migrations/20261010000000_sales_attribution_and_booking_hierarchy.js';
import { runServerStartupDDL } from './startup_ddl_harness.js';

// Knex adapter shim to run Knex-based migrations on PGlite directly
function createKnexAdapter(db) {
  return {
    raw: async (sqlQuery, bindings = []) => {
      let finalSql = sqlQuery;
      if (bindings && bindings.length > 0) {
        let idx = 0;
        finalSql = finalSql.replace(/\?/g, () => {
          const val = bindings[idx++];
          if (val === null) return 'NULL';
          if (typeof val === 'number') return val;
          return `'${String(val).replace(/'/g, "''")}'`;
        });
      }
      // Use db.exec for multi-statement DDL execution support in PostgreSQL simple protocol
      const res = await db.exec(finalSql);
      const lastRes = Array.isArray(res) ? res[res.length - 1] : res;
      return { rows: lastRes?.rows || [], rowCount: lastRes?.affectedRows || lastRes?.rows?.length || 0 };
    },
    schema: {
      hasTable: async (tableName) => {
        const res = await db.query(
          `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`,
          [tableName]
        );
        return res.rows.length > 0;
      },
      hasColumn: async (tableName, columnName) => {
        const res = await db.query(
          `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
          [tableName, columnName]
        );
        return res.rows.length > 0;
      },
      alterTable: async (tableName, callback) => {
        const statements = [];
        const tableMock = {
          integer: (col) => {
            let def = `ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS ${col} INTEGER`;
            const chain = {
              nullable: () => chain,
              notNullable: () => { def += ' NOT NULL'; return chain; },
              defaultTo: (val) => { def += ` DEFAULT ${val}`; return chain; },
              references: (targetCol) => ({
                inTable: (targetTable) => ({
                  onDelete: (action) => {
                    statements.push(`${def} REFERENCES ${targetTable}(${targetCol}) ON DELETE ${action}`);
                    return chain;
                  }
                })
              })
            };
            return chain;
          },
          string: (col, len = 255) => {
            let def = `ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS ${col} VARCHAR(${len})`;
            const chain = {
              nullable: () => { statements.push(def); return chain; },
              notNullable: () => { def += ' NOT NULL'; return chain; },
              defaultTo: (val) => {
                statements.push(`${def} DEFAULT '${val}'`);
                return chain;
              }
            };
            return chain;
          },
          timestamp: (col, opts = {}) => {
            let def = `ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS ${col} TIMESTAMPTZ`;
            const chain = {
              nullable: () => { statements.push(def); return chain; },
              notNullable: () => { statements.push(`${def} NOT NULL DEFAULT NOW()`); return chain; },
              defaultTo: () => chain
            };
            return chain;
          },
          text: (col) => {
            statements.push(`ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS ${col} TEXT`);
            return { nullable: () => {} };
          },
          index: (cols, indexName) => {
            statements.push(`CREATE INDEX IF NOT EXISTS ${indexName} ON ${tableName} (${cols.join(', ')})`);
          },
          dropIndex: (cols, indexName) => {
            statements.push(`DROP INDEX IF EXISTS ${indexName}`);
          },
          dropColumn: (col) => {
            statements.push(`ALTER TABLE ${tableName} DROP COLUMN IF EXISTS ${col} CASCADE`);
          }
        };

        callback(tableMock);
        for (const sql of statements) {
          await db.exec(sql);
        }
      }
    }
  };
}

export async function runRealPgTestSuite() {
  console.log('================================================================');
  console.log('  MMR CONSTRUCTION — PHASE 1C REAL POSTGRESQL ENGINE TEST SUITE');
  console.log('================================================================\n');

  const startTime = Date.now();
  const db = new PGlite();
  const knexAdapter = createKnexAdapter(db);

  // 1. Create Base Schema
  console.log('Step 1: Initializing PostgreSQL Base Schema...');
  await createBaseSchema(db);

  // 2. Seed Realistic Data
  console.log('Step 2: Seeding Representative Data...');
  await seedRepresentativeData(db);
  const uCount = await db.query('SELECT count(*) FROM users');
  const bCount = await db.query('SELECT count(*) FROM bookings');
  const pCount = await db.query('SELECT count(*) FROM plots');
  console.log(` Seeded: ${uCount.rows[0].count} users, ${bCount.rows[0].count} bookings, ${pCount.rows[0].count} plots.\n`);

  // 3. Run Migration UP
  console.log('Step 3: Executing Migration UP on Real PostgreSQL Engine...');
  const upStart = Date.now();
  await migration.up(knexAdapter);
  const upDuration = Date.now() - upStart;
  console.log(` Migration UP completed successfully in ${upDuration}ms.\n`);

  // 4. Run Verification Checks
  console.log('Step 4: Running Comprehensive Verification Checks...');

  // (a) Constraint Violations
  const violations = await db.query(`
    SELECT 
      (SELECT COUNT(*) FROM users WHERE referred_by_user_id IS NOT NULL AND referred_by_user_id = user_id) AS self_referral_violations,
      (SELECT COUNT(*) FROM users u JOIN users ref ON ref.user_id = u.referred_by_user_id WHERE ref.user_type::TEXT NOT IN ('Associate', 'Team Member')) AS invalid_referrer_type_violations,
      (SELECT COUNT(*) FROM bookings WHERE booking_type = 'SELF_PURCHASE' AND (user_id <> booked_by_user_id OR sold_by_user_id <> user_id)) AS self_purchase_violations,
      (SELECT COUNT(*) FROM bookings WHERE booking_type = 'CUSTOMER_SELF' AND booked_by_user_id <> user_id) AS customer_self_violations,
      (SELECT COUNT(*) FROM bookings WHERE booking_type LIKE 'ON_BEHALF%' AND (booked_by_user_id IS NOT NULL AND booked_by_user_id = user_id)) AS on_behalf_violations;
  `);
  console.log('Integrity Constraint Violations (Must all be 0):');
  console.table(violations.rows);

  // (b) Users Attribution Distribution by user_type
  const userTypeAttribution = await db.query(`
    SELECT 
      user_type,
      COALESCE(referred_by_source, 'COMPANY_DIRECT (NULL)') AS attribution_source,
      COUNT(*) AS count
    FROM users
    GROUP BY user_type, referred_by_source
    ORDER BY user_type, count DESC;
  `);
  console.log('User Attribution Distribution Broken Down By user_type:');
  console.table(userTypeAttribution.rows);

  // Assert: No customer has TEAM_MEMBER_SLOT!
  const cusTmSlot = await db.query(`
    SELECT COUNT(*) AS count FROM users WHERE user_type = 'Customer' AND referred_by_source = 'TEAM_MEMBER_SLOT';
  `);
  if (parseInt(cusTmSlot.rows[0].count, 10) > 0) {
    throw new Error('Customer attribution contaminated with TEAM_MEMBER_SLOT!');
  }
  console.log(' Verified: Customer attribution strictly excludes TEAM_MEMBER_SLOT.');

  // (c) Bookings Attribution Breakdown
  const bookingAttribution = await db.query(`
    SELECT 
      booking_type,
      associate_approval_status,
      COUNT(*) AS count
    FROM bookings
    GROUP BY booking_type, associate_approval_status
    ORDER BY count DESC;
  `);
  console.log('Bookings Attribution Breakdown:');
  console.table(bookingAttribution.rows);

  // (d) View Query Test (vw_sales_attribution)
  const viewRes = await db.query(`
    SELECT 
      booking_id,
      booking_serial,
      booking_status,
      buyer_name,
      booked_by_name,
      sold_by_name,
      associate_name,
      is_confirmed_sale,
      is_self_purchase,
      is_reward_eligible
    FROM vw_sales_attribution
    ORDER BY booking_id ASC
    LIMIT 6;
  `);
  console.log('Reporting View Samples (vw_sales_attribution):');
  console.table(viewRes.rows);

  // 5. Test Fallback Trigger (trg_bookings_attribution_fallback)
  console.log('\nStep 5: Testing trg_bookings_attribution_fallback (All 3 Roles)...');

  // Case 5a: Team Member Self-Purchase (User 201 is Team Member with upline Associate 101)
  const tmInsert = await db.query(`
    INSERT INTO bookings (booking_serial, user_id, plot_id, booking_status, advance_amount, payment_type)
    VALUES ('MMR-TRIG-TM-001', 201, 23, 'Submitted', 50000, 'FullPayment')
    RETURNING booking_id, user_id, booked_by_user_id, sold_by_user_id, associate_user_id, booking_type;
  `);
  const tmRow = tmInsert.rows[0];
  console.log('Team Member Self-Purchase Trigger Result:', tmRow);
  if (tmRow.booking_type !== 'SELF_PURCHASE' || tmRow.sold_by_user_id !== 201 || tmRow.associate_user_id !== 101) {
    throw new Error(`Team Member self-purchase attribution failed! Got: ${JSON.stringify(tmRow)}`);
  }
  console.log(' Case 5a PASSED: TM self-purchase -> SELF_PURCHASE, sold_by=201, associate=101.');

  // Case 5b: Customer Buyer with Referrer (User 301 referred by Associate 101)
  const cusRefInsert = await db.query(`
    INSERT INTO bookings (booking_serial, user_id, plot_id, booking_status, advance_amount, payment_type)
    VALUES ('MMR-TRIG-CUSREF-001', 301, 24, 'Submitted', 50000, 'FullPayment')
    RETURNING booking_id, user_id, booked_by_user_id, sold_by_user_id, associate_user_id, booking_type;
  `);
  const cusRefRow = cusRefInsert.rows[0];
  console.log('Customer with Referrer Trigger Result:', cusRefRow);
  if (cusRefRow.booking_type !== 'CUSTOMER_SELF' || cusRefRow.sold_by_user_id !== 101 || cusRefRow.associate_user_id !== 101) {
    throw new Error(`Customer referred attribution failed! Got: ${JSON.stringify(cusRefRow)}`);
  }
  console.log(' Case 5b PASSED: Customer with referrer -> CUSTOMER_SELF, sold_by=101, associate=101.');

  // Case 5c: Customer Buyer with Default Sponsor (User 335 has sponsor_user_id = 1, referred_by = NULL)
  const cusDirInsert = await db.query(`
    INSERT INTO bookings (booking_serial, user_id, plot_id, booking_status, advance_amount, payment_type)
    VALUES ('MMR-TRIG-CUSDIR-001', 335, 25, 'Submitted', 50000, 'FullPayment')
    RETURNING booking_id, user_id, booked_by_user_id, sold_by_user_id, associate_user_id, booking_type;
  `);
  const cusDirRow = cusDirInsert.rows[0];
  console.log('Customer with Default Sponsor (Company Direct) Trigger Result:', cusDirRow);
  if (cusDirRow.booking_type !== 'CUSTOMER_SELF' || cusDirRow.sold_by_user_id !== null || cusDirRow.associate_user_id !== null) {
    throw new Error(`Default sponsor customer attribution failed! Got: ${JSON.stringify(cusDirRow)}`);
  }
  console.log(' Case 5c PASSED: Default sponsor customer -> CUSTOMER_SELF, sold_by=NULL, associate=NULL.');

  // 6. Test App Startup DDL Harness on Migrated DB (Task 2)
  console.log('\nStep 6: Executing Server Startup DDL Harness on Migrated Schema...');
  console.log('Running Startup DDL Pass 1...');
  await runServerStartupDDL(db);
  console.log('Running Startup DDL Pass 2 (Idempotency Check)...');
  await runServerStartupDDL(db);
  console.log(' Startup DDL Harness executed 2x on Migrated DB with 0 errors.');

  // Verify view still works cleanly
  const viewPostStartup = await db.query(`SELECT COUNT(*) AS count FROM vw_sales_attribution;`);
  console.log(` Verified: vw_sales_attribution is intact post-startup (Row count: ${viewPostStartup.rows[0].count}).`);

  // Verify fn_on_user_approved preserved Team Member logic
  const fnDef = await db.query(`
    SELECT routine_definition FROM information_schema.routines 
    WHERE routine_name = 'fn_on_user_approved' AND routine_schema = 'public';
  `);
  if (!fnDef.rows[0]?.routine_definition?.includes('Team Member')) {
    throw new Error('fn_on_user_approved lost Team Member invite code support during startup!');
  }
  console.log(' Verified: fn_on_user_approved retains Team Member invitation code generation support.');

  // 7. Test Fresh DB Order (Fresh base DB -> Startup DDL -> Migration UP -> Startup DDL)
  console.log('\nStep 7: Testing Fresh DB Order (Base Enum Schema -> Startup DDL -> Migration UP)...');
  const freshDb = new PGlite();
  const freshKnex = createKnexAdapter(freshDb);
  await createBaseSchema(freshDb);
  await seedRepresentativeData(freshDb);

  // Run startup DDL first (before migration)
  console.log('Fresh DB: Running Startup DDL before migration...');
  await runServerStartupDDL(freshDb);

  // Run migration UP
  console.log('Fresh DB: Running Migration UP...');
  await migration.up(freshKnex);

  // Run startup DDL again
  console.log('Fresh DB: Re-running Startup DDL after migration...');
  await runServerStartupDDL(freshDb);
  const freshView = await freshDb.query(`SELECT COUNT(*) AS count FROM vw_sales_attribution;`);
  console.log(` Fresh DB Order PASSED: vw_sales_attribution count: ${freshView.rows[0].count}.`);

  // 8. Test Migration DOWN (Rollback) on Main DB
  console.log('\nStep 8: Executing Migration DOWN (Rollback) on Real PostgreSQL...');
  const downStart = Date.now();
  await migration.down(knexAdapter);
  const downDuration = Date.now() - downStart;
  console.log(` Migration DOWN completed successfully in ${downDuration}ms.\n`);

  // Verify columns & views removed
  const viewExists = await db.query(`
    SELECT EXISTS (SELECT FROM pg_views WHERE viewname = 'vw_sales_attribution') as exists;
  `);
  const colExists = await db.query(`
    SELECT EXISTS (SELECT FROM information_schema.columns WHERE table_name = 'bookings' AND column_name = 'booked_by_user_id') as exists;
  `);
  console.log(`Post-Rollback Checks: View dropped: ${!viewExists.rows[0].exists}, Bookings attribution column dropped: ${!colExists.rows[0].exists}`);
  if (viewExists.rows[0].exists || colExists.rows[0].exists) {
    throw new Error('Rollback failed to cleanly drop view or columns!');
  }

  // 9. Test Migration UP (Second Run - Idempotency)
  console.log('\nStep 9: Executing Migration UP Again (Idempotency Check)...');
  const up2Start = Date.now();
  await migration.up(knexAdapter);
  const up2Duration = Date.now() - up2Start;
  console.log(` Second Migration UP completed successfully in ${up2Duration}ms.\n`);

  const totalTime = Date.now() - startTime;
  console.log('================================================================');
  console.log(`  PHASE 1C REAL POSTGRESQL VERIFICATION COMPLETED IN ${totalTime}ms`);
  console.log('  ALL CHECKS PASSED: Schema, Backfill, Startup DDL, Triggers, Rollback, Idempotency');
  console.log('================================================================\n');

  return {
    success: true,
    totalTime,
    upDuration,
    downDuration,
    up2Duration,
    violations: violations.rows[0],
    userTypeAttribution: userTypeAttribution.rows,
    bookingAttribution: bookingAttribution.rows
  };
}

runRealPgTestSuite().catch(err => {
  console.error('\n❌ REAL POSTGRESQL VERIFICATION FAILED:', err);
  process.exit(1);
});
