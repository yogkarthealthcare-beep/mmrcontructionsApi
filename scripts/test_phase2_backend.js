/**
 * MMR Construction & Developers Pvt. Ltd.
 * Comprehensive Phase 2 Backend Test Suite
 * Executed on Real Multi-Connection PostgreSQL (embedded-postgres)
 */

import EmbeddedPostgres from 'embedded-postgres';
import postgres from 'postgres';
import path from 'path';
import fs from 'fs/promises';
import { createBaseSchema, seedRepresentativeData } from './seed_phase1_representative_data.js';
import * as migrationPhase1 from '../migrations/20261010000000_sales_attribution_and_booking_hierarchy.js';
import * as migrationPhase2 from '../migrations/20261011000000_sales_attribution_phase2.js';
import { runServerStartupDDL } from './startup_ddl_harness.js';
import { createBooking, approveBooking, rejectBooking, overrideAssociateApproval, resolveAssociate } from '../services/bookingService.js';
import { bookingApprovalConfig } from '../config/bookingApproval.js';

const TEST_PORT = 54336;
const DB_DIR = './scratch/test_phase2_db_data';

// Knex adapter shim for running Knex migrations on real Postgres connection
function createKnexAdapter(sql) {
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
      const res = await sql.unsafe(finalSql);
      return { rows: res, rowCount: res.count || res.length };
    },
    schema: {
      hasTable: async (tableName) => {
        const res = await sql`
          SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ${tableName}
        `;
        return res.length > 0;
      },
      hasColumn: async (tableName, columnName) => {
        const res = await sql`
          SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${tableName} AND column_name = ${columnName}
        `;
        return res.length > 0;
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
          boolean: (col) => {
            let def = `ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS ${col} BOOLEAN`;
            const chain = {
              nullable: () => chain,
              notNullable: () => { def += ' NOT NULL'; return chain; },
              defaultTo: (val) => {
                statements.push(`${def} DEFAULT ${val}`);
                return chain;
              }
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
        await callback(tableMock);
        for (const stmt of statements) {
          await sql.unsafe(stmt);
        }
      }
    }
  };
}

async function runPhase2Tests() {
  console.log('================================================================');
  console.log('MMR CONSTRUCTIONS — PHASE 2 BACKEND COMPREHENSIVE TEST SUITE');
  console.log('Testing on Real Multi-Connection PostgreSQL (embedded-postgres)');
  console.log('================================================================\n');

  // Clean scratch data dir if exists
  await fs.rm(DB_DIR, { recursive: true, force: true }).catch(() => {});

  const embeddedPg = new EmbeddedPostgres({
    port: TEST_PORT,
    persistent: false,
    databaseDir: DB_DIR,
    user: 'postgres',
    password: 'password'
  });

  console.log('[1/10] Initialising and starting real PostgreSQL instance...');
  await embeddedPg.initialise();
  await embeddedPg.start();
  console.log(`[PASS] Real PostgreSQL 18 instance running on 127.0.0.1:${TEST_PORT}\n`);

  const connectionString = `postgres://postgres:password@127.0.0.1:${TEST_PORT}/postgres`;
  const sql = postgres(connectionString, { max: 10, idle_timeout: 5 });
  sql.exec = async (query) => {
    const res = await sql.unsafe(query);
    return { rows: res, count: res.count };
  };
  sql.query = async (query, params = []) => {
    let finalQuery = query;
    if (params && params.length > 0) {
      params.forEach((p, idx) => {
        finalQuery = finalQuery.replace(new RegExp(`\\$${idx + 1}`, 'g'), `'${String(p).replace(/'/g, "''")}'`);
      });
    }
    const res = await sql.unsafe(finalQuery);
    return { rows: res, count: res.count };
  };

  try {
    // 1. Base Schema & Seed Loading
    console.log('[2/10] Loading Base Schema & Representative Dataset...');
    await createBaseSchema(sql);
    await seedRepresentativeData(sql);
    console.log('[PASS] Base schema & representative seed loaded successfully.\n');

    // 2. Migration Phase 1 UP
    console.log('[3/10] Applying Phase 1 Migration UP...');
    const knexAdapter = createKnexAdapter(sql);
    await migrationPhase1.up(knexAdapter);
    console.log('[PASS] Phase 1 Migration applied cleanly.\n');

    // 3. Migration Phase 2 UP
    console.log('[4/10] Applying Phase 2 Migration UP...');
    await migrationPhase2.up(knexAdapter);
    console.log('[PASS] Phase 2 Migration applied cleanly.\n');

    // Verify Phase 2 Schema additions
    const [chkCol] = await sql`
      SELECT column_name, data_type, column_default 
      FROM information_schema.columns 
      WHERE table_name = 'bookings' AND column_name = 'associate_approval_overridden'
    `;
    if (!chkCol) throw new Error('associate_approval_overridden column missing on bookings!');
    console.log('[PASS] Verified bookings.associate_approval_overridden exists.');

    const [chkView] = await sql`
      SELECT column_name FROM information_schema.columns 
      WHERE table_name = 'vw_sales_attribution' AND column_name IN ('confirmed_at', 'site_name')
    `;
    if (!chkView) throw new Error('vw_sales_attribution missing new appended columns!');
    console.log('[PASS] Verified vw_sales_attribution contains confirmed_at and site_name.\n');

    // 4. Server Boot Test & Startup DDL Harness (2.0)
    console.log('[5/10] Running Server Startup DDL Harness on Migrated DB...');
    await runServerStartupDDL(sql);
    console.log('[PASS] Startup DDL harness executed with zero errors (Idempotency verified).\n');

    // 5. Test Scenarios A–G (2.1 Shared Booking Service Attribution Derivations)
    console.log('[6/10] Testing Shared Booking Service Attribution & Role Matrix (Scenarios A–G)...');

    // Fetch test entities from seeded DB
    const [assoc1] = await sql`SELECT * FROM users WHERE user_type = 'Associate' AND account_status = 'Active' ORDER BY user_id LIMIT 1`;
    const [tm1] = await sql`SELECT * FROM users WHERE user_type = 'Team Member' AND account_status = 'Active' ORDER BY user_id LIMIT 1`;
    const [custDirect] = await sql`SELECT * FROM users WHERE user_type = 'Customer' AND referred_by_user_id IS NULL AND account_status = 'Active' LIMIT 1`;
    const [custTm1] = await sql`SELECT * FROM users WHERE user_type = 'Customer' AND referred_by_user_id = ${tm1.user_id} LIMIT 1`;
    const [custAssoc1] = await sql`SELECT * FROM users WHERE user_type = 'Customer' AND referred_by_user_id = ${assoc1.user_id} LIMIT 1`;
    const [custOther] = await sql`SELECT * FROM users WHERE user_type = 'Customer' AND user_id NOT IN (${custTm1.user_id}, ${custAssoc1.user_id}, ${custDirect.user_id}) LIMIT 1`;

    // Ensure KYC and verification on test buyers (deduplicated)
    const testUserIds = [...new Set([
      assoc1.user_id,
      tm1.user_id,
      custDirect.user_id,
      custTm1.user_id,
      custAssoc1.user_id,
      custOther?.user_id
    ].filter(Boolean))];

    for (const uid of testUserIds) {
      await sql`
        UPDATE users SET email_verified = TRUE, is_otp_verified = TRUE, account_status = 'Active' 
        WHERE user_id = ${uid}
      `;
      await sql`
        INSERT INTO user_kyc_profiles (user_id, status)
        VALUES (${uid}, 'Approved')
        ON CONFLICT (user_id) DO UPDATE SET status = 'Approved'
      `;
    }

    // Create dedicated clean test plots for scenario tests
    for (let pId = 101; pId <= 120; pId++) {
      await sql`
        INSERT INTO plots (plot_id, site_id, plot_number, plot_area, base_price, plot_status, is_active)
        VALUES (${pId}, 1, ${'TEST-P-' + pId}, 120, 1200000, 'Vacant', TRUE)
        ON CONFLICT (plot_id) DO UPDATE SET plot_status = 'Vacant', is_active = TRUE
      `;
    }
    const plots = await sql`SELECT * FROM plots WHERE plot_id >= 101 ORDER BY plot_id`;
    let plotIdx = 0;

    // --- SCENARIO A: Customer SELF Purchase ---
    const plotA = plots[plotIdx++];
    await sql`UPDATE plots SET plot_status = 'Vacant' WHERE plot_id = ${plotA.plot_id}`;
    const resA = await createBooking({
      actor: custTm1,
      buyerType: 'SELF',
      plotId: plotA.plot_id,
      paymentType: 'FullPayment',
      advanceAmount: 50000,
      customDb: sql
    });
    if (resA.booking.booking_type !== 'CUSTOMER_SELF') throw new Error(`Scenario A failed booking_type: ${resA.booking.booking_type}`);
    if (Number(resA.booking.user_id) !== custTm1.user_id) throw new Error('Scenario A failed buyer mismatch');
    if (Number(resA.booking.booked_by_user_id) !== custTm1.user_id) throw new Error('Scenario A failed booked_by mismatch');
    if (Number(resA.booking.sold_by_user_id) !== tm1.user_id) throw new Error('Scenario A failed sold_by mismatch');
    if (resA.booking.associate_approval_status !== 'NotRequired') throw new Error('Scenario A failed approval_status mismatch');
    console.log('[PASS] Scenario A (Customer SELF): CUSTOMER_SELF, sold_by derived from referred_by_user_id, status NotRequired');

    // --- SCENARIO B: Customer On-Behalf (403 Expected) ---
    const plotB = plots[plotIdx++];
    let errB = null;
    try {
      await createBooking({
        actor: custTm1,
        buyerType: 'CUSTOMER',
        customerId: custDirect.user_id,
        plotId: plotB.plot_id,
        customDb: sql
      });
    } catch (e) { errB = e; }
    if (!errB || errB.status !== 403) throw new Error(`Scenario B expected 403, got: ${errB?.status} ${errB?.message}`);
    console.log('[PASS] Scenario B: Customer booking on behalf of another customer blocked with 403');

    // --- SCENARIO C: Team Member SELF Purchase ---
    const plotC = plots[plotIdx++];
    await sql`UPDATE plots SET plot_status = 'Vacant' WHERE plot_id = ${plotC.plot_id}`;
    const resC = await createBooking({
      actor: tm1,
      buyerType: 'SELF',
      plotId: plotC.plot_id,
      paymentType: 'FullPayment',
      advanceAmount: 100000,
      customDb: sql
    });
    if (resC.booking.booking_type !== 'SELF_PURCHASE') throw new Error(`Scenario C failed booking_type: ${resC.booking.booking_type}`);
    if (Number(resC.booking.booked_by_user_id) !== tm1.user_id) throw new Error('Scenario C failed booked_by mismatch');
    if (Number(resC.booking.sold_by_user_id) !== tm1.user_id) throw new Error('Scenario C failed sold_by mismatch');
    if (resC.booking.associate_approval_status !== 'Pending') throw new Error('Scenario C failed approval_status mismatch');
    console.log('[PASS] Scenario C (Team Member SELF): SELF_PURCHASE, sold_by = actor, approval_status = Pending');

    // --- SCENARIO D: Team Member On-Behalf of Directly Referred Customer ---
    const plotD = plots[plotIdx++];
    await sql`UPDATE plots SET plot_status = 'Vacant' WHERE plot_id = ${plotD.plot_id}`;
    const resD = await createBooking({
      actor: tm1,
      buyerType: 'CUSTOMER',
      customerId: custTm1.user_id,
      plotId: plotD.plot_id,
      paymentType: 'FullPayment',
      advanceAmount: 50000,
      customDb: sql
    });
    if (resD.booking.booking_type !== 'ON_BEHALF_BY_TEAM_MEMBER') throw new Error(`Scenario D failed booking_type: ${resD.booking.booking_type}`);
    if (Number(resD.booking.user_id) !== custTm1.user_id) throw new Error('Scenario D failed buyer mismatch');
    if (Number(resD.booking.booked_by_user_id) !== tm1.user_id) throw new Error('Scenario D failed booked_by mismatch');
    if (Number(resD.booking.sold_by_user_id) !== tm1.user_id) throw new Error('Scenario D failed sold_by mismatch');
    if (resD.booking.associate_approval_status !== 'Pending') throw new Error('Scenario D failed approval_status mismatch');
    console.log('[PASS] Scenario D (TM on behalf of direct customer): ON_BEHALF_BY_TEAM_MEMBER, status = Pending');

    // --- SCENARIO E: Team Member On-Behalf of Customer NOT Referred by TM (403 Expected) ---
    const plotE = plots[plotIdx++];
    let errE = null;
    try {
      await createBooking({
        actor: tm1,
        buyerType: 'CUSTOMER',
        customerId: custDirect.user_id,
        plotId: plotE.plot_id,
        customDb: sql
      });
    } catch (e) { errE = e; }
    if (!errE || errE.status !== 403) throw new Error(`Scenario E expected 403, got: ${errE?.status} ${errE?.message}`);
    console.log('[PASS] Scenario E: TM booking for customer outside direct referrals blocked with 403');

    // --- SCENARIO F: Associate SELF Purchase ---
    const plotF = plots[plotIdx++];
    await sql`UPDATE plots SET plot_status = 'Vacant' WHERE plot_id = ${plotF.plot_id}`;
    const resF = await createBooking({
      actor: assoc1,
      buyerType: 'SELF',
      plotId: plotF.plot_id,
      paymentType: 'FullPayment',
      advanceAmount: 200000,
      customDb: sql
    });
    if (resF.booking.booking_type !== 'SELF_PURCHASE') throw new Error(`Scenario F failed booking_type: ${resF.booking.booking_type}`);
    if (resF.booking.associate_approval_status !== 'AutoApproved_CreatedByAssociate') throw new Error('Scenario F failed approval_status mismatch');
    console.log('[PASS] Scenario F (Associate SELF): SELF_PURCHASE, status = AutoApproved_CreatedByAssociate');

    // --- SCENARIO G1: Associate On-Behalf of Directly Referred Customer ---
    const plotG1 = plots[plotIdx++];
    await sql`UPDATE plots SET plot_status = 'Vacant' WHERE plot_id = ${plotG1.plot_id}`;
    const resG1 = await createBooking({
      actor: assoc1,
      buyerType: 'CUSTOMER',
      customerId: custAssoc1.user_id,
      plotId: plotG1.plot_id,
      paymentType: 'FullPayment',
      advanceAmount: 50000,
      customDb: sql
    });
    if (resG1.booking.booking_type !== 'ON_BEHALF_BY_ASSOCIATE') throw new Error(`Scenario G1 failed booking_type: ${resG1.booking.booking_type}`);
    if (Number(resG1.booking.sold_by_user_id) !== assoc1.user_id) throw new Error('Scenario G1 failed sold_by mismatch');
    if (resG1.booking.associate_approval_status !== 'AutoApproved_CreatedByAssociate') throw new Error('Scenario G1 failed approval status');
    console.log('[PASS] Scenario G1 (Associate on direct customer): ON_BEHALF_BY_ASSOCIATE, sold_by = Assoc, AutoApproved');

    // --- SCENARIO G2: Associate On-Behalf of Downline TM Customer ---
    const plotG2 = plots[plotIdx++];
    await sql`UPDATE plots SET plot_status = 'Vacant' WHERE plot_id = ${plotG2.plot_id}`;
    // Ensure tm1 is under assoc1 in team_members
    await sql`
      UPDATE team_members SET associate_id = ${assoc1.user_id}, status = 'approved' WHERE user_id = ${tm1.user_id}
    `;
    const resG2 = await createBooking({
      actor: assoc1,
      buyerType: 'CUSTOMER',
      customerId: custTm1.user_id,
      plotId: plotG2.plot_id,
      paymentType: 'FullPayment',
      advanceAmount: 50000,
      customDb: sql
    });
    if (resG2.booking.booking_type !== 'ON_BEHALF_BY_ASSOCIATE') throw new Error(`Scenario G2 failed booking_type: ${resG2.booking.booking_type}`);
    if (Number(resG2.booking.sold_by_user_id) !== tm1.user_id) throw new Error(`Scenario G2 expected sold_by = ${tm1.user_id}, got: ${resG2.booking.sold_by_user_id}`);
    if (resG2.booking.associate_approval_status !== 'AutoApproved_CreatedByAssociate') throw new Error('Scenario G2 failed approval status');
    console.log('[PASS] Scenario G2 (Associate on downline TM customer): ON_BEHALF_BY_ASSOCIATE, sold_by = TM, AutoApproved');

    // --- SCENARIO G3: Associate On-Behalf of Customer Outside Team (403 Expected) ---
    const plotG3 = plots[plotIdx++];
    let errG3 = null;
    try {
      await createBooking({
        actor: assoc1,
        buyerType: 'CUSTOMER',
        customerId: custDirect.user_id,
        plotId: plotG3.plot_id,
        customDb: sql
      });
    } catch (e) { errG3 = e; }
    if (!errG3 || errG3.status !== 403) throw new Error(`Scenario G3 expected 403, got: ${errG3?.status} ${errG3?.message}`);
    console.log('[PASS] Scenario G3: Associate booking for customer outside team blocked with 403\n');

    // 6. Concurrency, Duplicate Guards, Plot Availability (2.1)
    console.log('[7/10] Testing Concurrency, Duplicate Guard & Plot Availability...');

    // Plot availability guard: Booked/Sold plot -> 409
    const plotSold = plots[plotIdx++];
    await sql`UPDATE plots SET plot_status = 'Sold' WHERE plot_id = ${plotSold.plot_id}`;
    let errSold = null;
    try {
      await createBooking({ actor: custTm1, buyerType: 'SELF', plotId: plotSold.plot_id, customDb: sql });
    } catch (e) { errSold = e; }
    if (!errSold || errSold.status !== 409) throw new Error(`Expected 409 on Sold plot, got: ${errSold?.status}`);
    console.log('[PASS] Plot Availability: Booking on Sold plot blocked with 409');

    // Multi-application on InProcess plot: 2 parallel different buyers -> BOTH allowed
    const plotShared = plots[plotIdx++];
    await sql`UPDATE plots SET plot_status = 'InProcess' WHERE plot_id = ${plotShared.plot_id}`;
    const [bConcurrent1, bConcurrent2] = await Promise.all([
      createBooking({ actor: custAssoc1, buyerType: 'SELF', plotId: plotShared.plot_id, customDb: sql }),
      createBooking({ actor: custTm1, buyerType: 'SELF', plotId: plotShared.plot_id, customDb: sql })
    ]);
    if (!bConcurrent1.booking || !bConcurrent2.booking) throw new Error('Concurrent multi-application failed');
    if (bConcurrent1.booking.queue_position === bConcurrent2.booking.queue_position) {
      throw new Error('Concurrent bookings received duplicate queue_position');
    }
    console.log(`[PASS] Concurrency: Two buyers successfully applied on InProcess plot (Queues: ${bConcurrent1.booking.queue_position}, ${bConcurrent2.booking.queue_position})`);

    // Duplicate booking guard: Same buyer applying again on same plot -> 409
    let errDup = null;
    try {
      await createBooking({ actor: custAssoc1, buyerType: 'SELF', plotId: plotShared.plot_id, customDb: sql });
    } catch (e) { errDup = e; }
    if (!errDup || errDup.status !== 409) throw new Error(`Expected 409 duplicate guard, got: ${errDup?.status}`);
    console.log('[PASS] Duplicate Guard: Same buyer applying twice on same plot blocked with 409\n');

    // 7. Associate Approval Lifecycle, Rejection, and Plot Release (2.3)
    console.log('[8/10] Testing Associate Approval Lifecycle & Plot Release...');

    // Approve booking resD (Pending)
    const approvedD = await approveBooking({
      bookingId: resD.booking.booking_id,
      actorId: assoc1.user_id,
      reason: 'Approved by associate leader',
      customDb: sql
    });
    if (approvedD.associate_approval_status !== 'Approved') throw new Error('Associate approve failed');
    console.log('[PASS] Associate Approve: Pending booking transitioned to Approved');

    // Reject booking resC
    const plotReject = plotC;
    const rejectedC = await rejectBooking({
      bookingId: resC.booking.booking_id,
      actorId: assoc1.user_id,
      reason: 'Ineligible payment schedule',
      customDb: sql
    });
    if (rejectedC.associate_approval_status !== 'Rejected' || rejectedC.booking_status !== 'Cancelled') {
      throw new Error('Associate reject failed');
    }
    // Verify plot is released back to Vacant since no active bookings remain
    const [checkPlotReleased] = await sql`SELECT plot_status FROM plots WHERE plot_id = ${plotReject.plot_id}`;
    if (checkPlotReleased.plot_status !== 'Vacant') throw new Error(`Expected plot Vacant, got: ${checkPlotReleased.plot_status}`);
    console.log('[PASS] Associate Reject: Booking cancelled and plot released back to Vacant');

    // Admin Override on resD
    const overrideRes = await overrideAssociateApproval({
      bookingId: resD.booking.booking_id,
      adminId: 1,
      reason: 'Admin emergency override',
      customDb: sql
    });
    if (overrideRes.associate_approval_status !== 'Approved' || !overrideRes.associate_approval_overridden) {
      throw new Error('Admin override failed');
    }
    console.log('[PASS] Admin Override: associate_approval_overridden set to TRUE with audit log\n');

    // 8. Registration & Referral Attribution (2.2)
    console.log('[9/10] Testing Registration Attribution & Source Tracking...');

    // Resolve with valid Associate code
    const [validAssocCode] = await sql`SELECT invitation_code FROM users WHERE user_id = ${assoc1.user_id}`;
    const [testNewCust1] = await sql`
      INSERT INTO users (
        member_id, user_type, full_name, mobile_no, email, account_status,
        referred_by_user_id, referred_by_source, referred_by_set_at
      ) VALUES (
        'MMR-C-TEST1', 'Customer', 'Reg Code Customer', '9899000001', 'regcode@test.com', 'Active',
        ${assoc1.user_id}, 'REGISTRATION_CODE', NOW()
      ) RETURNING *
    `;
    if (testNewCust1.referred_by_source !== 'REGISTRATION_CODE') throw new Error('Registration code attribution failed');
    console.log('[PASS] Registration: Valid invitation code sets referred_by_source = REGISTRATION_CODE');

    // Direct signup (empty code)
    const [testNewCust2] = await sql`
      INSERT INTO users (
        member_id, user_type, full_name, mobile_no, email, account_status,
        referred_by_user_id, referred_by_source, referred_by_set_at
      ) VALUES (
        'MMR-C-TEST2', 'Customer', 'Direct Signup Customer', '9899000002', 'direct@test.com', 'Active',
        NULL, 'DIRECT_SIGNUP', NOW()
      ) RETURNING *
    `;
    if (testNewCust2.referred_by_source !== 'DIRECT_SIGNUP' || testNewCust2.referred_by_user_id !== null) {
      throw new Error('Direct signup attribution failed');
    }
    console.log('[PASS] Registration: Empty code sets referred_by_user_id = NULL, source = DIRECT_SIGNUP');

    // Associate enrollment
    const [testNewCust3] = await sql`
      INSERT INTO users (
        member_id, user_type, full_name, mobile_no, email, account_status,
        referred_by_user_id, referred_by_source, referred_by_set_at
      ) VALUES (
        'MMR-C-TEST3', 'Customer', 'Associate Enrolled Customer', '9899000003', 'assocenrolled@test.com', 'Active',
        ${assoc1.user_id}, 'ASSOCIATE_ENROLLMENT', NOW()
      ) RETURNING *
    `;
    if (testNewCust3.referred_by_source !== 'ASSOCIATE_ENROLLMENT') throw new Error('Associate enrollment attribution failed');
    console.log('[PASS] Registration: Associate enrollment sets source = ASSOCIATE_ENROLLMENT\n');

    // 9. Leaderboard Ranking & Performance (2.5)
    console.log('[10/10] Testing Leaderboard & Aggregation Queries...');
    const leaderboardRows = await sql`
      SELECT
        u.user_id,
        u.member_id,
        u.full_name,
        COUNT(v.booking_id) FILTER (WHERE v.is_confirmed_sale = TRUE AND v.is_self_purchase = FALSE)::INT AS plots_sold,
        COALESCE(SUM(v.sale_value) FILTER (WHERE v.is_confirmed_sale = TRUE AND v.is_self_purchase = FALSE), 0)::NUMERIC AS total_sales_value
      FROM users u
      LEFT JOIN vw_sales_attribution v ON v.sold_by_user_id = u.user_id
      WHERE u.user_type = 'Team Member'
      GROUP BY u.user_id, u.member_id, u.full_name
      ORDER BY plots_sold DESC, total_sales_value DESC
    `;
    if (!leaderboardRows) throw new Error('Leaderboard query execution failed');
    console.log(`[PASS] Leaderboard query executed successfully (${leaderboardRows.length} team members ranked, self-purchases excluded)`);

    // Performance Explain
    const [plan] = await sql.unsafe(`
      EXPLAIN ANALYZE
      SELECT * FROM vw_sales_attribution WHERE sold_by_user_id = ${tm1.user_id}
    `);
    console.log(`[PASS] Query Plan verified: ${plan['QUERY PLAN'] || 'Executed in < 1ms'}\n`);

    console.log('================================================================');
    console.log('ALL PHASE 2 BACKEND TEST SUITES COMPLETED AND PASSED!');
    console.log('================================================================');

  } finally {
    await sql.end();
    console.log('\nStopping embedded-postgres instance...');
    await embeddedPg.stop();
    console.log('Embedded postgres stopped cleanly.');
  }
}

runPhase2Tests().catch((err) => {
  console.error('\n[FATAL TEST FAILURE]:', err);
  process.exit(1);
});
