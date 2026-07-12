import sql from "../db.js";

async function testSubquery(label, queryStr) {
  const started = Date.now();
  try {
    const res = await sql.unsafe(queryStr);
    console.log(`[Subquery] ${label}: ${Date.now() - started}ms (Result: ${JSON.stringify(res[0])})`);
  } catch (e) {
    console.error(`[Subquery Error] ${label}: ${Date.now() - started}ms (Error: ${e.message})`);
  }
}

async function run() {
  console.log("=== Testing vw_admin_dashboard_stats subqueries ===");

  await testSubquery("1. Pending approvals count", 
    `SELECT count(*) AS count FROM users WHERE users.account_status = 'Pending'::account_status_enum`
  );

  await testSubquery("2. Active users count", 
    `SELECT count(*) AS count FROM users WHERE users.account_status = 'Active'::account_status_enum`
  );

  await testSubquery("3. Rejected users count", 
    `SELECT count(*) AS count FROM users WHERE users.account_status = 'Rejected'::account_status_enum`
  );

  await testSubquery("4. New today count", 
    `SELECT count(*) AS count FROM users WHERE users.registered_at::date = CURRENT_DATE`
  );

  await testSubquery("5. Active customers count", 
    `SELECT count(*) AS count FROM users WHERE users.user_type = 'Customer'::user_type_enum AND users.account_status = 'Active'::account_status_enum`
  );

  await testSubquery("6. Active associates count", 
    `SELECT count(*) AS count FROM users WHERE users.user_type = 'Associate'::user_type_enum AND users.account_status = 'Active'::account_status_enum`
  );

  await testSubquery("7. Total plots count", 
    `SELECT count(*) AS count FROM plots WHERE plots.is_active = true`
  );

  await testSubquery("8. Vacant plots count", 
    `SELECT count(*) AS count FROM plots WHERE plots.plot_status = 'Vacant'::plot_status_enum`
  );

  await testSubquery("9. InProcess plots count", 
    `SELECT count(*) AS count FROM plots WHERE plots.plot_status = 'InProcess'::plot_status_enum`
  );

  await testSubquery("10. Booked plots count", 
    `SELECT count(*) AS count FROM plots WHERE plots.plot_status = 'Booked'::plot_status_enum`
  );

  await testSubquery("11. Sold plots count", 
    `SELECT count(*) AS count FROM plots WHERE plots.plot_status = 'Sold'::plot_status_enum`
  );

  await testSubquery("12. Total revenue", 
    `SELECT COALESCE(sum(emi_schedules.paid_amount + emi_schedules.late_fee_amount), 0::numeric) AS sum FROM emi_schedules WHERE emi_schedules.emi_status = 'Paid'::emi_status_enum`
  );

  await testSubquery("13. Revenue this month", 
    `SELECT COALESCE(sum(emi_schedules.paid_amount), 0::numeric) AS sum FROM emi_schedules WHERE emi_schedules.emi_status = 'Paid'::emi_status_enum AND date_trunc('month'::text, emi_schedules.paid_date::timestamp with time zone) = date_trunc('month'::text, now())`
  );

  await testSubquery("14. Overdue EMIs", 
    `SELECT count(*) AS count FROM emi_schedules WHERE emi_schedules.emi_status = 'Overdue'::emi_status_enum`
  );

  await testSubquery("15. Pending commissions", 
    `SELECT count(*) AS count FROM commission_transactions WHERE commission_transactions.commission_status = 'Pending'::commission_status_enum`
  );

  await sql.end();
}

run();
