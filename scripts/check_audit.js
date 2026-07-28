import sql from "../db.js";

async function check() {
  try {
    const res = await sql`
      INSERT INTO audit_log (actor_type, actor_id, actor_name, module, action, target_table, target_record_id, new_value)
      VALUES ('Admin', 1, 'MMR Admin', 'AdminImpersonation', 'LoginAsUser', 'users', 7, ${JSON.stringify({ test: true })})
      RETURNING audit_id`;
    console.log("Audit log insert SUCCESS:", res);
  } catch (e) {
    console.error("Audit log insert ERROR:", e);
  } finally {
    process.exit(0);
  }
}

check();
