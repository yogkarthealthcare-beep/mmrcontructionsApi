import sql from "../db.js";

async function testQuery(label, promiseFn) {
  const started = Date.now();
  console.log(`[Test Start] ${label}`);
  try {
    const result = await promiseFn();
    console.log(`[Test Success] ${label} - ${Date.now() - started}ms - Rows: ${Array.isArray(result) ? result.length : '1'}`);
    if (Array.isArray(result) && result.length > 0) {
      console.log(`  Sample:`, result[0]);
    } else {
      console.log(`  Result:`, result);
    }
  } catch (e) {
    console.error(`[Test Error] ${label} - ${Date.now() - started}ms - Error: ${e.message}`);
  }
}

async function run() {
  const testUserId = 31; // A typical test user ID for associate / user testing

  console.log("=== ADMIN DASHBOARD QUERIES ===");
  
  await testQuery("Admin Dashboard Stats (vw_admin_dashboard_stats)", () => 
    sql`SELECT * FROM vw_admin_dashboard_stats`
  );

  await testQuery("Admin Dashboard Sites (vw_site_plot_summary)", () => 
    sql`SELECT * FROM vw_site_plot_summary LIMIT 25`
  );

  await testQuery("Admin Dashboard Recent Bookings", () => 
    sql`
      SELECT b.booking_id, b.booking_serial, b.booking_status, b.booking_date,
             u.full_name, p.plot_number, s.site_name
      FROM bookings b
      JOIN users u ON b.user_id = u.user_id
      JOIN plots p ON b.plot_id = p.plot_id
      JOIN sites s ON p.site_id = s.site_id
      ORDER BY b.created_at DESC LIMIT 5
    `
  );

  console.log("\n=== ASSOCIATE DASHBOARD QUERIES ===");

  await testQuery("Associate Sales Tracker", () => 
    sql`SELECT * FROM associate_sales_tracker WHERE associate_user_id = ${testUserId}`
  );

  await testQuery("Associate Pending Commission", () => 
    sql`
      SELECT COALESCE(SUM(net_amount),0) AS pending
      FROM commission_transactions
      WHERE associate_user_id = ${testUserId} AND commission_status = 'Pending'
    `
  );

  await testQuery("Associate Network Count", () => 
    sql`SELECT COUNT(*) AS count FROM mlm_network WHERE sponsor_user_id = ${testUserId}`
  );

  await testQuery("Associate Recent Commissions", () => 
    sql`
      SELECT commission_id, commission_type, net_amount, commission_month,
             commission_status, created_at
      FROM commission_transactions
      WHERE associate_user_id = ${testUserId}
      ORDER BY created_at DESC LIMIT 5
    `
  );

  console.log("\n=== USER (CUSTOMER) DASHBOARD DATA ===");

  await testQuery("Customer Bookings", () => 
    sql`
      SELECT b.booking_id, b.booking_serial, b.booking_date, b.booking_status,
             b.advance_amount, b.payment_type, b.created_at,
             CASE
               WHEN b.booking_status = 'Confirmed' THEN 'Paid'
               WHEN b.advance_amount > 0 THEN 'Partial'
               ELSE 'Unpaid'
             END AS payment_status,
             p.plot_number, p.plot_area, p.plot_category,
             s.site_name, s.city
      FROM bookings b
      JOIN plots p ON b.plot_id = p.plot_id
      JOIN sites  s ON p.site_id  = s.site_id
      WHERE b.user_id = ${testUserId}
      ORDER BY b.created_at DESC`
  );

  await testQuery("Customer EMIs", () => 
    sql`
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
      WHERE e.user_id = ${testUserId}
      ORDER BY e.due_date ASC`
  );

  await sql.end();
}

run();
