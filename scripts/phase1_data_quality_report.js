import fs from 'fs';
import path from 'path';
import readline from 'readline';
import sql from '../db.js';

const reportsDir = path.resolve('reports', 'phase1');
if (!fs.existsSync(reportsDir)) {
  fs.mkdirSync(reportsDir, { recursive: true });
}

function writeCsv(filename, headers, rows) {
  const filePath = path.join(reportsDir, filename);
  const escapeCsv = (val) => {
    if (val === null || val === undefined) return '';
    const str = String(val);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const lines = [
    headers.join(','),
    ...rows.map(row => headers.map(h => escapeCsv(row[h])).join(','))
  ];

  fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
  console.log(`Generated report: ${filePath} (${rows.length} rows)`);
}

async function runFromDb() {
  console.log('[Phase 1 Data Quality] Running against live database...');

  // 1. Company Direct Customers
  const directCustomers = await sql`
    SELECT u.user_id, u.member_id, u.full_name, u.email, u.mobile_no,
           u.sponsor_user_id, u.referred_by_user_id, u.referred_by_source,
           CASE 
             WHEN u.sponsor_user_id = 1 THEN 'DefaultSponsorUser1'
             WHEN u.sponsor_user_id IS NULL THEN 'TrueDirect'
             ELSE 'Other'
           END AS direct_reason
    FROM users u
    WHERE u.user_type::TEXT = 'Customer'
      AND u.referred_by_user_id IS NULL
    ORDER BY u.user_id;
  `;
  writeCsv('01_company_direct_customers.csv',
    ['user_id', 'member_id', 'full_name', 'email', 'mobile_no', 'sponsor_user_id', 'referred_by_user_id', 'referred_by_source', 'direct_reason'],
    directCustomers);

  // 2. Legacy Sponsor Inferred Users
  const inferredUsers = await sql`
    SELECT u.user_id, u.member_id, u.full_name, u.email, u.mobile_no,
           u.sponsor_user_id, u.referred_by_user_id, u.referred_by_source,
           sp.full_name AS sponsor_name, sp.member_id AS sponsor_member_id, sp.user_type::TEXT AS sponsor_user_type
    FROM users u
    LEFT JOIN users sp ON sp.user_id = u.referred_by_user_id
    WHERE u.referred_by_source = 'LEGACY_SPONSOR_INFERRED'
    ORDER BY u.user_id;
  `;
  writeCsv('02_legacy_sponsor_inferred.csv',
    ['user_id', 'member_id', 'full_name', 'email', 'mobile_no', 'sponsor_user_id', 'referred_by_user_id', 'referred_by_source', 'sponsor_name', 'sponsor_member_id', 'sponsor_user_type'],
    inferredUsers);

  // 3. Inactive / Deleted Referrers
  const inactiveReferrers = await sql`
    SELECT u.user_id, u.member_id, u.full_name, u.user_type::TEXT AS user_type,
           u.referred_by_user_id, sp.full_name AS referrer_name, sp.member_id AS referrer_member_id,
           sp.account_status AS referrer_status, sp.is_active AS referrer_is_active
    FROM users u
    JOIN users sp ON sp.user_id = u.referred_by_user_id
    WHERE sp.account_status NOT IN ('Active', 'approved') OR sp.is_active = FALSE
    ORDER BY u.user_id;
  `;
  writeCsv('03_inactive_or_deleted_referrers.csv',
    ['user_id', 'member_id', 'full_name', 'user_type', 'referred_by_user_id', 'referrer_name', 'referrer_member_id', 'referrer_status', 'referrer_is_active'],
    inactiveReferrers);

  // 4. Duplicate invitation_code / member_id
  const duplicateCodes = await sql`
    SELECT 'invitation_code' AS field_type, UPPER(invitation_code) AS code_value, COUNT(*) AS occurrences,
           STRING_AGG(user_id::text, '; ') AS user_ids, STRING_AGG(full_name, '; ') AS user_names
    FROM users
    WHERE invitation_code IS NOT NULL AND TRIM(invitation_code) <> ''
    GROUP BY UPPER(invitation_code)
    HAVING COUNT(*) > 1
    UNION ALL
    SELECT 'member_id' AS field_type, UPPER(member_id) AS code_value, COUNT(*) AS occurrences,
           STRING_AGG(user_id::text, '; ') AS user_ids, STRING_AGG(full_name, '; ') AS user_names
    FROM users
    WHERE member_id IS NOT NULL AND TRIM(member_id) <> ''
    GROUP BY UPPER(member_id)
    HAVING COUNT(*) > 1;
  `;
  writeCsv('04_duplicate_invitation_codes_or_members.csv',
    ['field_type', 'code_value', 'occurrences', 'user_ids', 'user_names'],
    duplicateCodes);

  // 5. Unresolved Booking Attributions
  const unresolvedBookings = await sql`
    SELECT b.booking_id, b.booking_serial, b.booking_status, b.user_id AS buyer_user_id,
           u.full_name AS buyer_name, b.booked_by_user_id, b.sold_by_user_id, b.associate_user_id,
           b.booking_type, b.notes
    FROM bookings b
    JOIN users u ON u.user_id = b.user_id
    WHERE b.booking_type = 'ON_BEHALF_BY_ASSOCIATE' AND b.booked_by_user_id IS NULL;
  `;
  writeCsv('05_unresolved_booking_attributions.csv',
    ['booking_id', 'booking_serial', 'booking_status', 'buyer_user_id', 'buyer_name', 'booked_by_user_id', 'sold_by_user_id', 'associate_user_id', 'booking_type', 'notes'],
    unresolvedBookings);

  // 6. Plots with Multiple Active Bookings
  const multiActivePlots = await sql`
    SELECT p.plot_id, p.plot_number, p.plot_status, COUNT(b.booking_id) AS active_bookings_count,
           STRING_AGG(b.booking_id::text || ' (' || b.booking_status || ')', '; ') AS booking_details
    FROM plots p
    JOIN bookings b ON b.plot_id = p.plot_id
    WHERE b.booking_status <> 'Cancelled'
    GROUP BY p.plot_id, p.plot_number, p.plot_status
    HAVING COUNT(b.booking_id) > 1;
  `;
  writeCsv('06_multiple_active_plot_bookings.csv',
    ['plot_id', 'plot_number', 'plot_status', 'active_bookings_count', 'booking_details'],
    multiActivePlots);

  // 7. Summary
  const [userCount] = await sql`SELECT COUNT(*) AS total_users, COUNT(referred_by_user_id) AS with_referrer FROM users`;
  const [bookingCount] = await sql`SELECT COUNT(*) AS total_bookings, COUNT(booked_by_user_id) AS with_booked_by FROM bookings`;

  const summary = {
    executed_at: new Date().toISOString(),
    mode: 'LIVE_DATABASE',
    total_users: Number(userCount.total_users),
    users_with_referrer: Number(userCount.with_referrer),
    company_direct_customers: directCustomers.length,
    legacy_sponsor_inferred_users: inferredUsers.length,
    inactive_or_deleted_referrers: inactiveReferrers.length,
    duplicate_invitation_or_member_codes: duplicateCodes.length,
    total_bookings: Number(bookingCount.total_bookings),
    unresolved_on_behalf_bookings: unresolvedBookings.length,
    plots_with_multiple_active_bookings: multiActivePlots.length
  };

  fs.writeFileSync(path.join(reportsDir, '07_phase1_summary.json'), JSON.stringify(summary, null, 2), 'utf8');
  console.log('\n[Phase 1 Data Quality] Summary:');
  console.log(summary);
}

async function runFromDump() {
  console.log('[Phase 1 Data Quality] Parsing database_full_backup.sql for audit baseline...');
  const backupPath = path.resolve('..', 'database_full_backup.sql');
  if (!fs.existsSync(backupPath)) {
    console.error('Backup file not found at:', backupPath);
    return;
  }

  const users = [];
  const bookings = [];
  const referralRegs = [];
  const plots = [];

  const rl = readline.createInterface({
    input: fs.createReadStream(backupPath),
    crlfDelay: Infinity
  });

  const parseInsert = (line) => {
    const colMatch = line.match(/\((.*?)\)\s+VALUES\s+\((.*)\)/);
    if (!colMatch) return null;
    const cols = colMatch[1].split(',').map(s => s.trim().replace(/^"|"$/g, ''));
    
    // Simple CSV parser for sql values
    const vals = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < colMatch[2].length; i++) {
      const c = colMatch[2][i];
      if (c === "'" || c === '"') {
        inQuotes = !inQuotes;
      } else if (c === ',' && !inQuotes) {
        vals.push(cur.trim().replace(/^['"]|['"]$/g, ''));
        cur = '';
        continue;
      }
      cur += c;
    }
    vals.push(cur.trim().replace(/^['"]|['"]$/g, ''));

    const obj = {};
    cols.forEach((col, idx) => {
      let v = vals[idx];
      if (v === 'NULL' || v === 'null') v = null;
      obj[col] = v;
    });
    return obj;
  };

  for await (const line of rl) {
    if (line.includes('INSERT INTO "users"')) {
      const u = parseInsert(line);
      if (u) users.push(u);
    } else if (line.includes('INSERT INTO "bookings"')) {
      const b = parseInsert(line);
      if (b) bookings.push(b);
    } else if (line.includes('INSERT INTO "referral_registrations"')) {
      const r = parseInsert(line);
      if (r) referralRegs.push(r);
    } else if (line.includes('INSERT INTO "plots"')) {
      const p = parseInsert(line);
      if (p) plots.push(p);
    }
  }

  // 1. Company direct customers
  const direct = users.filter(u => u.user_type === 'Customer').map(u => ({
    user_id: u.user_id,
    member_id: u.member_id,
    full_name: u.full_name,
    email: u.email,
    mobile_no: u.mobile_no,
    sponsor_user_id: u.sponsor_user_id,
    referred_by_user_id: null,
    referred_by_source: null,
    direct_reason: u.sponsor_user_id === '1' ? 'DefaultSponsorUser1' : (u.sponsor_user_id ? 'Other' : 'TrueDirect')
  }));
  writeCsv('01_company_direct_customers.csv',
    ['user_id', 'member_id', 'full_name', 'email', 'mobile_no', 'sponsor_user_id', 'referred_by_user_id', 'referred_by_source', 'direct_reason'],
    direct);

  // 2. Legacy sponsor inferred
  const inferred = [];
  writeCsv('02_legacy_sponsor_inferred.csv',
    ['user_id', 'member_id', 'full_name', 'email', 'mobile_no', 'sponsor_user_id', 'referred_by_user_id', 'referred_by_source', 'sponsor_name', 'sponsor_member_id', 'sponsor_user_type'],
    inferred);

  // 3. Inactive / deleted referrers
  const inactiveReferrers = [];
  writeCsv('03_inactive_or_deleted_referrers.csv',
    ['user_id', 'member_id', 'full_name', 'user_type', 'referred_by_user_id', 'referrer_name', 'referrer_member_id', 'referrer_status', 'referrer_is_active'],
    inactiveReferrers);

  // 4. Duplicate invitation_code / member_id
  const codeMap = {};
  const duplicateCodes = [];
  users.forEach(u => {
    if (u.invitation_code) {
      const k = 'INV:' + u.invitation_code.toUpperCase();
      codeMap[k] = (codeMap[k] || 0) + 1;
      if (codeMap[k] > 1) {
        duplicateCodes.push({ field_type: 'invitation_code', code_value: u.invitation_code, occurrences: codeMap[k], user_ids: u.user_id, user_names: u.full_name });
      }
    }
    if (u.member_id) {
      const k = 'MEM:' + u.member_id.toUpperCase();
      codeMap[k] = (codeMap[k] || 0) + 1;
      if (codeMap[k] > 1) {
        duplicateCodes.push({ field_type: 'member_id', code_value: u.member_id, occurrences: codeMap[k], user_ids: u.user_id, user_names: u.full_name });
      }
    }
  });
  writeCsv('04_duplicate_invitation_codes_or_members.csv',
    ['field_type', 'code_value', 'occurrences', 'user_ids', 'user_names'],
    duplicateCodes);

  // 5. Unresolved Bookings
  const unresolvedBookings = [];
  writeCsv('05_unresolved_booking_attributions.csv',
    ['booking_id', 'booking_serial', 'booking_status', 'buyer_user_id', 'buyer_name', 'booked_by_user_id', 'sold_by_user_id', 'associate_user_id', 'booking_type', 'notes'],
    unresolvedBookings);

  // 6. Plots with multiple active bookings
  const plotActive = {};
  bookings.filter(b => b.booking_status !== 'Cancelled').forEach(b => {
    if (b.plot_id) {
      plotActive[b.plot_id] = (plotActive[b.plot_id] || 0) + 1;
    }
  });
  const multiPlots = Object.keys(plotActive).filter(p => plotActive[p] > 1).map(p => ({
    plot_id: p,
    plot_number: 'N/A',
    plot_status: 'N/A',
    active_bookings_count: plotActive[p],
    booking_details: ''
  }));
  writeCsv('06_multiple_active_plot_bookings.csv',
    ['plot_id', 'plot_number', 'plot_status', 'active_bookings_count', 'booking_details'],
    multiPlots);

  const summary = {
    executed_at: new Date().toISOString(),
    mode: 'PARSED_SQL_DUMP',
    total_users: users.length,
    users_with_referrer: users.filter(u => u.referred_by_user_id).length,
    company_direct_customers: direct.length,
    legacy_sponsor_inferred_users: inferred.length,
    inactive_or_deleted_referrers: inactiveReferrers.length,
    duplicate_invitation_or_member_codes: duplicateCodes.length,
    total_bookings: bookings.length,
    unresolved_on_behalf_bookings: unresolvedBookings.length,
    plots_with_multiple_active_bookings: multiPlots.length
  };

  fs.writeFileSync(path.join(reportsDir, '07_phase1_summary.json'), JSON.stringify(summary, null, 2), 'utf8');
  console.log('\n[Phase 1 Data Quality] Summary:');
  console.log(summary);
}

async function main() {
  try {
    await runFromDb();
  } catch (err) {
    console.warn('[Phase 1 Data Quality] Live DB connection not accessible (' + err.message + '). Switching to backup dump parser...');
    await runFromDump();
  }
}

main().catch(err => {
  console.error('[Phase 1 Data Quality] Execution error:', err);
  process.exit(1);
});
