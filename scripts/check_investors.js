import sql from "../db.js";

async function run() {
  try {
    const showcase = await sql`
      SELECT id, name, profile_image_url, display_order, created_at
      FROM investors
      WHERE is_active = TRUE AND is_deleted = FALSE`;

    const portalInvestors = await sql`
      SELECT ('portal_' || id::text) as id,
             full_name as name,
             COALESCE(profile_picture_url, '') as profile_image_url,
             0 as display_order,
             created_at
      FROM investor_users
      WHERE (status = 'active' OR status = 'approved')
        AND (deleted_at IS NULL)
        AND (is_verified = TRUE OR status = 'approved' OR status = 'active')`;

    const combined = [...showcase, ...portalInvestors];
    console.log("Combined Investors for Home Page:", JSON.stringify(combined, null, 2));
  } catch (err) {
    console.error("Error testing combined query:", err);
  } finally {
    process.exit(0);
  }
}

run();
