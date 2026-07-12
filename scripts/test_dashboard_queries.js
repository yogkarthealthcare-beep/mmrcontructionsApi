import sql from "../db.js";

try {
  const [stats] = await sql`
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
      ), 0)::int AS pending_approvals`;

  const monthlySales = await sql`
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
      GROUP BY 1
    )
    SELECT
      to_char(m.month_start, 'Mon YYYY') AS month,
      COALESCE(s.sales_count, 0)::int AS sales_count,
      COALESCE(s.total_sales, 0)::numeric AS total_sales
    FROM months m
    LEFT JOIN sales s ON s.month_start = m.month_start
    ORDER BY m.month_start`;

  const sampleUsers = await sql`
    SELECT DISTINCT ON (user_type) user_id, user_type
    FROM users
    WHERE account_status = 'Active'
      AND user_type IN ('Customer', 'Associate')
    ORDER BY user_type, user_id`;

  const userResults = [];
  for (const user of sampleUsers) {
    const isAssociate = user.user_type === "Associate";
    const [summary] = await sql`
      SELECT
        (SELECT COUNT(*)::int FROM bookings WHERE user_id = ${user.user_id} AND booking_status <> 'Cancelled') AS user_booked_plots,
        (SELECT COALESCE(SUM(COALESCE(total_due, emi_amount, 0)), 0)::numeric
         FROM emi_schedules
         WHERE user_id = ${user.user_id}
           AND emi_status IN ('Pending', 'Overdue', 'ProofSubmitted')) AS user_emi_due,
        (SELECT COUNT(*)::int FROM emi_schedules WHERE user_id = ${user.user_id} AND emi_status = 'Paid') AS user_payments,
        (SELECT COUNT(*)::int FROM notification_log WHERE user_id = ${user.user_id} AND is_read = FALSE) AS user_notifications`;
    const chart = await sql`
      SELECT COUNT(DISTINCT b.booking_id)::int AS sales_count
      FROM bookings b
      JOIN users buyer ON buyer.user_id = b.user_id
      WHERE b.booking_status = 'Confirmed'
        AND (
          (${isAssociate} = TRUE AND buyer.sponsor_user_id = ${user.user_id})
          OR
          (${isAssociate} = FALSE AND b.user_id = ${user.user_id})
        )`;
    userResults.push({ role: user.user_type, summary, chart: chart[0] });
  }

  console.log(JSON.stringify({ stats, monthlySales, userResults }, null, 2));
} finally {
  await sql.end();
}
