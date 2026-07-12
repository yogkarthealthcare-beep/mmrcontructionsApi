import "../config/loadEnv.js";
import jwt from "jsonwebtoken";
import sql from "../db.js";

const baseUrl = process.env.PRODUCTION_API_URL || "https://mmrcontructions-api-self.vercel.app";

const requestDashboard = async (path, token) => {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await response.json();
  if (!response.ok || body.success !== true) {
    throw new Error(`${path} failed: ${response.status} ${body.message || "Unknown error"}`);
  }
  return body.data;
};

try {
  const [admin] = await sql`
    SELECT a.admin_id, a.email, a.full_name, r.role_name AS role
    FROM admin_users a
    JOIN admin_roles r ON r.role_id = a.role_id
    WHERE a.is_active = TRUE
      AND r.role_name IN ('SuperAdmin', 'FinanceManager', 'SiteManager')
    ORDER BY CASE r.role_name WHEN 'SuperAdmin' THEN 1 ELSE 2 END
    LIMIT 1`;
  const users = await sql`
    SELECT DISTINCT ON (user_type) user_id, user_type, member_id, mobile_no, email
    FROM users
    WHERE account_status = 'Active'
      AND user_type IN ('Customer', 'Associate')
    ORDER BY user_type, user_id`;

  if (!admin || users.length < 2) throw new Error("Required active test accounts were not found.");

  const adminToken = jwt.sign(
    { admin_id: admin.admin_id, email: admin.email, full_name: admin.full_name, role: admin.role },
    process.env.JWT_ADMIN_SECRET || process.env.JWT_SECRET,
    { expiresIn: "5m" },
  );
  const adminData = await requestDashboard("/api/admin/dashboard", adminToken);

  const roleResults = [];
  for (const user of users) {
    const userToken = jwt.sign(
      {
        user_id: user.user_id,
        user_type: user.user_type,
        member_id: user.member_id,
        mobile_no: user.mobile_no,
        email: user.email,
      },
      process.env.JWT_SECRET,
      { expiresIn: "5m" },
    );
    const data = await requestDashboard("/api/dashboard", userToken);
    roleResults.push({
      role: user.user_type,
      months: data.userMonthlySalesChartData?.length || 0,
      bookedPlots: data.userBookedPlots,
      hasAssociateStats: data.associateSalesStats != null,
    });
  }

  console.log(JSON.stringify({
    admin: {
      totalCustomers: adminData.totalCustomers,
      activeAssociates: adminData.activeAssociates,
      plotsSold: adminData.plotsSold,
      monthlyEmiDue: adminData.monthlyEmiDue,
      pendingApprovals: adminData.pendingApprovals,
      months: adminData.monthlySalesChartData?.length || 0,
    },
    users: roleResults,
  }, null, 2));
} finally {
  await sql.end();
}
