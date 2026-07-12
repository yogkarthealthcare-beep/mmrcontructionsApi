import sql from "../db.js";

try {
  const [settings] = await sql`
    SELECT commission_model, maximum_levels, direct_percentage,
           upline_percentage, seller_percentage, equal_distribution_percentage,
           equal_distribution_enabled, distribution_scope, payment_mode_rules,
           is_active, version
    FROM commission_engine_settings
    WHERE id = 1`;
  const levels = await sql`
    SELECT level_no, percentage, is_active
    FROM commission_engine_levels
    WHERE settings_id = 1 AND commission_model = 'LevelWise'
    ORDER BY level_no`;
  const [trigger] = await sql`
    SELECT tgname
    FROM pg_trigger
    WHERE tgrelid = 'commission_engine_audit'::regclass
      AND tgname = 'trg_commission_engine_audit_immutable'
      AND NOT tgisinternal`;
  const [events] = await sql`SELECT COUNT(event_id)::int AS count FROM commission_source_events`;
  const [legacy] = await sql`
    SELECT COUNT(commission_id)::int AS count
    FROM commission_transactions
    WHERE commission_event_id IS NULL`;

  console.log(JSON.stringify({
    settings,
    levels,
    immutableAuditTrigger: trigger?.tgname || null,
    paymentEvents: events.count,
    preservedLegacyCommissions: legacy.count,
  }, null, 2));
} finally {
  await sql.end();
}
