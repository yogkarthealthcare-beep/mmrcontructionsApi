import sql from '../db.js';

/**
 * Standardized Plot Status Update Helper
 * Updates plot_status, manages sold_price/sold_at timestamps, and records an audit trail in plot_status_history.
 * 
 * @param {number|string} plotId 
 * @param {'Vacant'|'InProcess'|'Booked'|'Sold'} newStatus 
 * @param {object} options
 * @param {number} [options.adminId]
 * @param {string} [options.adminName]
 * @param {string} [options.reason]
 * @param {number} [options.soldPrice]
 * @param {string|Date} [options.soldAt]
 * @param {object} [options.db] - Optional Postgres/Knex transaction client
 */
export async function setPlotStatus(plotId, newStatus, options = {}) {
  const db = options.db || sql;
  const adminId = options.adminId || null;
  const adminName = options.adminName || null;
  const reason = options.reason || `Plot status updated to ${newStatus}`;
  const soldPrice = options.soldPrice !== undefined ? options.soldPrice : null;
  const soldAt = options.soldAt || (newStatus === 'Sold' ? new Date().toISOString() : null);

  // 1. Fetch current plot state
  const [current] = await db`SELECT plot_id, plot_status, base_price, sold_price FROM plots WHERE plot_id = ${plotId}`;
  if (!current) {
    throw new Error(`Plot with ID ${plotId} not found.`);
  }

  const oldStatus = current.plot_status;

  // 2. Perform atomic update based on newStatus
  if (newStatus === 'Sold') {
    const finalPrice = soldPrice !== null ? soldPrice : (current.sold_price || current.base_price || 0);
    await db`
      UPDATE plots
      SET plot_status = 'Sold',
          sold_price = ${finalPrice},
          sold_at = ${soldAt ? new Date(soldAt) : db`NOW()`},
          updated_at = NOW()
      WHERE plot_id = ${plotId}
    `;
  } else if (newStatus === 'Vacant') {
    await db`
      UPDATE plots
      SET plot_status = 'Vacant',
          sold_price = NULL,
          sold_at = NULL,
          updated_at = NOW()
      WHERE plot_id = ${plotId}
    `;
  } else {
    // InProcess or Booked
    await db`
      UPDATE plots
      SET plot_status = ${newStatus},
          updated_at = NOW()
      WHERE plot_id = ${plotId}
    `;
  }

  // 3. Log into plot_status_history
  try {
    await db`
      INSERT INTO plot_status_history (
        plot_id,
        old_status,
        new_status,
        changed_by_admin_id,
        reason,
        changed_at
      ) VALUES (
        ${plotId},
        ${oldStatus}::plot_status_enum,
        ${newStatus}::plot_status_enum,
        ${adminId},
        ${reason},
        NOW()
      )
    `;
  } catch (historyErr) {
    // Fallback if enum cast or columns differ
    try {
      await db`
        INSERT INTO plot_status_history (
          plot_id,
          old_status,
          new_status,
          changed_by_admin_id,
          reason,
          changed_at
        ) VALUES (
          ${plotId},
          ${oldStatus},
          ${newStatus},
          ${adminId},
          ${reason},
          NOW()
        )
      `;
    } catch (e) {
      console.warn(`[PlotStatusService] Status history log warning for plot ${plotId}:`, e.message);
    }
  }

  return {
    success: true,
    plotId: Number(plotId),
    oldStatus,
    newStatus,
    soldPrice: newStatus === 'Sold' ? soldPrice : null,
    soldAt: newStatus === 'Sold' ? soldAt : null
  };
}

export default {
  setPlotStatus
};
