import sql from "../db.js";

try {
  const removed = await sql`
    DELETE FROM commission_rules duplicate
    USING commission_rules keeper
    WHERE duplicate.rule_id > keeper.rule_id
      AND duplicate.is_active = TRUE
      AND keeper.is_active = TRUE
      AND duplicate.commission_type = keeper.commission_type
      AND duplicate.level_depth = keeper.level_depth
      AND duplicate.plot_area_unit = keeper.plot_area_unit
    RETURNING duplicate.rule_id`;

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_commission_rules_active_level
    ON commission_rules (commission_type, level_depth, plot_area_unit)
    WHERE is_active = TRUE`;

  const rules = await sql`
    SELECT rule_id, commission_type, level_depth, plot_area_unit,
           amount_per_100_gaj, duration_months, is_active
    FROM commission_rules
    ORDER BY level_depth, rule_id`;

  console.log(JSON.stringify({ removed: removed.length, rules }, null, 2));
} finally {
  await sql.end();
}
