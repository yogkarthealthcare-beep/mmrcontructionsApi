import sql from "../db.js";

export class WhatsappRepository {
  async settings() {
    const [row] = await sql`SELECT * FROM whatsapp_settings WHERE id = 1`;
    return row || null;
  }

  async upsertSettings(values) {
    const [row] = await sql`
      INSERT INTO whatsapp_settings (id) VALUES (1)
      ON CONFLICT (id) DO UPDATE SET updated_at = NOW()
      RETURNING *`;
    const [updated] = await sql`
      UPDATE whatsapp_settings SET ${sql(values)}, updated_at = NOW()
      WHERE id = ${row.id}
      RETURNING *`;
    return updated;
  }

  async templates() {
    return sql`SELECT * FROM whatsapp_templates ORDER BY template_category, template_name`;
  }

  async templateByKey(templateKey) {
    const [row] = await sql`SELECT * FROM whatsapp_templates WHERE template_key = ${templateKey}`;
    return row || null;
  }

  async upsertTemplate(id, payload) {
    if (id) {
      const [row] = await sql`
        UPDATE whatsapp_templates SET ${sql(payload)}, updated_at = NOW()
        WHERE template_id = ${id}
        RETURNING *`;
      return row;
    }
    const [row] = await sql`
      INSERT INTO whatsapp_templates ${sql(payload)}
      RETURNING *`;
    return row;
  }

  async createMessageLog(payload) {
    const [row] = await sql`INSERT INTO whatsapp_message_logs ${sql(payload)} RETURNING *`;
    return row;
  }

  async updateMessageLog(id, payload) {
    const [row] = await sql`
      UPDATE whatsapp_message_logs SET ${sql(payload)}, updated_at = NOW()
      WHERE message_log_id = ${id}
      RETURNING *`;
    return row;
  }

  async updateMessageStatus(metaMessageId, payload) {
    const [row] = await sql`
      UPDATE whatsapp_message_logs SET ${sql(payload)}, updated_at = NOW()
      WHERE meta_message_id = ${metaMessageId}
      RETURNING *`;
    return row;
  }

  async createWebhookLog(payload) {
    const [row] = await sql`INSERT INTO whatsapp_webhook_logs ${sql(payload)} RETURNING *`;
    return row;
  }

  async enqueue(payload) {
    const [row] = await sql`INSERT INTO notification_queue ${sql(payload)} RETURNING *`;
    return row;
  }

  async nextQueue(limit = 10) {
    return sql`
      UPDATE notification_queue q
      SET status = 'Processing', attempts = attempts + 1, updated_at = NOW()
      WHERE queue_id IN (
        SELECT queue_id FROM notification_queue
        WHERE status = 'Pending' AND scheduled_at <= NOW()
        ORDER BY priority ASC, scheduled_at ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *`;
  }

  async updateQueue(id, payload) {
    const [row] = await sql`
      UPDATE notification_queue SET ${sql(payload)}, updated_at = NOW()
      WHERE queue_id = ${id}
      RETURNING *`;
    return row;
  }

  async dashboard() {
    const [row] = await sql`
      SELECT
        COUNT(*) FILTER (WHERE status = 'Sent')::int AS total_messages_sent,
        COUNT(*) FILTER (WHERE delivery_status = 'delivered')::int AS delivered_messages,
        COUNT(*) FILTER (WHERE status = 'Failed' OR delivery_status = 'failed')::int AS failed_messages,
        (SELECT COUNT(*)::int FROM otp_history WHERE action IN ('Generate','Resend') AND created_at::date = CURRENT_DATE) AS otp_sent_today,
        COALESCE(ROUND(
          100.0 * (SELECT COUNT(*) FROM otp_history WHERE action = 'Verify' AND success = TRUE)
          / NULLIF((SELECT COUNT(*) FROM otp_history WHERE action = 'Verify'), 0), 2
        ), 0)::numeric AS otp_verification_success_rate,
        (SELECT COUNT(*)::int FROM notification_queue WHERE status = 'Pending') AS pending_queue_count
      FROM whatsapp_message_logs`;
    return row;
  }
}

export default new WhatsappRepository();
