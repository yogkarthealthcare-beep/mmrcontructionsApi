import sql from "../db.js";

/**
 * Automatically ensures EMI schedule records exist for any booking with a remaining balance.
 * 
 * Rules:
 * - Total Plot Amount = base_price / total_price
 * - Down Payment = advance_amount (booking advance)
 * - Remaining Payable Amount = Total Plot Amount - Down Payment
 * - EMI schedule is generated ONLY for the remaining payable amount.
 * - Down payment is NOT duplicated as an EMI installment.
 */
export async function ensureEmiSchedulesForBooking(db, booking) {
  const bookingId = Number(booking.booking_id);
  const userId = Number(booking.user_id);
  if (!bookingId || !userId) return;

  const [existing] = await db`
    SELECT COUNT(*)::int AS count FROM emi_schedules WHERE booking_id = ${bookingId}
  `;
  if (existing && Number(existing.count) > 0) return;

  const totalPlotPrice = Number(
    booking.base_price || booking.total_price || (Number(booking.plot_area || 0) * 1000) || 0
  );
  const advancePaid = Number(booking.advance_amount || booking.required_booking_amount || 0);
  const remainingBalance = Math.max(0, totalPlotPrice - advancePaid);

  if (remainingBalance <= 0) return;

  const tenure = Number(booking.emi_tenure_months) > 0 ? Number(booking.emi_tenure_months) : 60;
  let monthlyEmi = Number(booking.monthly_emi || 0);
  if (monthlyEmi <= 0) {
    monthlyEmi = Math.round(remainingBalance / tenure);
  }

  const startDate = booking.created_at ? new Date(booking.created_at) : new Date();
  startDate.setMonth(startDate.getMonth() + 1);

  for (let i = 1; i <= tenure; i++) {
    const due = new Date(startDate);
    due.setMonth(due.getMonth() + (i - 1));
    const isLast = i === tenure;
    const emiAmount = isLast ? (remainingBalance - (monthlyEmi * (tenure - 1))) : monthlyEmi;

    await db`
      INSERT INTO emi_schedules (
        booking_id, user_id, installment_no, due_date, emi_amount,
        late_fee_amount, total_due, paid_amount, emi_status, created_at, updated_at
      ) VALUES (
        ${bookingId}, ${userId}, ${i}, ${due.toISOString().split("T")[0]}, ${Math.max(0, emiAmount)},
        0.00, ${Math.max(0, emiAmount)}, 0.00, 'Pending', NOW(), NOW()
      )
      ON CONFLICT (booking_id, installment_no) DO NOTHING
    `;
  }
}

/**
 * Creates or updates an official invoice record for an EMI payment in the `invoices` table.
 */
export async function ensureInvoiceForEmi(db, emi, booking, user, paymentDetails = {}) {
  const currentYear = new Date().getFullYear();
  const [seqRow] = await db`
    INSERT INTO invoice_number_sequence (year, last_sequence)
    VALUES (${currentYear}, 1)
    ON CONFLICT (year) DO UPDATE SET last_sequence = invoice_number_sequence.last_sequence + 1, updated_at = NOW()
    RETURNING last_sequence
  `;
  const seq = seqRow ? seqRow.last_sequence : 1;
  const invoiceNumber = `MMR-INV-${currentYear}-${String(seq).padStart(6, "0")}`;
  const orderId = `EMI-${emi.emi_id}-${Date.now()}`;

  const totalPlotPrice = Number(booking.base_price || booking.total_price || 0);
  const downPayment = Number(booking.advance_amount || 0);
  const emiAmount = Number(emi.paid_amount || emi.emi_amount || 0);

  const [paidEmisSumRow] = await db`
    SELECT COALESCE(SUM(paid_amount), 0)::numeric AS sum 
    FROM emi_schedules 
    WHERE booking_id = ${booking.booking_id} AND emi_status = 'Paid'
  `;
  const totalPaidTillDate = downPayment + Number(paidEmisSumRow?.sum || 0);
  const remainingBalance = Math.max(0, totalPlotPrice - totalPaidTillDate);

  const invoiceData = {
    invoice_number: invoiceNumber,
    invoice_type: "EMI Installment Payment",
    emi_id: emi.emi_id,
    installment_no: emi.installment_no,
    emi_number: emi.installment_no,
    booking_id: booking.booking_id,
    booking_serial: booking.booking_serial || `BK-${booking.booking_id}`,
    customer_name: user?.full_name || booking.full_name || "Valued Customer",
    mobile_no: user?.mobile_no || booking.mobile_no || "",
    email: user?.email || booking.email || "",
    site_name: booking.site_name || "MMR Project Site",
    plot_number: booking.plot_number || "Plot",
    plot_size: `${booking.plot_area || ''} Sq.Yd. / Sq.Ft.`.trim(),
    total_plot_price: totalPlotPrice,
    down_payment: downPayment,
    emi_amount: emiAmount,
    grand_total: emiAmount,
    paid_amount: emiAmount,
    total_paid_till_date: totalPaidTillDate,
    balance_amount: remainingBalance,
    payment_method: paymentDetails.payment_mode || emi.payment_mode || "Online",
    payment_date: paymentDetails.payment_date || new Date().toISOString().split("T")[0],
    transaction_id: paymentDetails.transaction_id || paymentDetails.reference_no || emi.transaction_reference || orderId,
    utr_number: paymentDetails.utr_number || paymentDetails.reference_no || "",
    payment_status: "Paid",
    order_status: "Completed",
  };

  try {
    const [inv] = await db`
      INSERT INTO invoices (
        invoice_number, order_id, user_id, invoice_date, subtotal, discount,
        registration_charges, development_charges, other_charges, grand_total,
        paid_amount, balance_amount, payment_method, payment_status, order_status,
        invoice_data, created_at, updated_at
      ) VALUES (
        ${invoiceNumber}, ${orderId}, ${user.user_id}, NOW(), ${emiAmount}, 0.00,
        0.00, 0.00, 0.00, ${emiAmount},
        ${emiAmount}, ${remainingBalance}, ${paymentDetails.payment_mode || 'Online'}, 'Paid', 'Completed',
        ${JSON.stringify(invoiceData)}::jsonb, NOW(), NOW()
      )
      RETURNING *
    `;
    return inv;
  } catch (err) {
    console.error("[Invoice Generation Warning]", err.message);
    return null;
  }
}

/**
 * Creates an official receipt record in the `receipts` table.
 */
export async function ensureReceiptForEmi(db, emi, booking, user, paymentDetails = {}) {
  const currentYear = new Date().getFullYear();
  const [seqRow] = await db`SELECT COALESCE(MAX(serial_no), 0)::int AS max_seq FROM receipts`;
  const nextSeq = (seqRow?.max_seq || 0) + 1;
  const receiptNo = `MMR/REC/${currentYear}/${String(nextSeq).padStart(4, "0")}`;
  const emiAmount = Number(emi.paid_amount || emi.emi_amount || 0);

  const [rec] = await db`
    INSERT INTO receipts (
      receipt_no, serial_no, plot_no, plot_area, customer_id, customer_name, mobile_no,
      payment_type, payment_mode, paid_amount, receipt_amount, receipt_date, notes,
      status, is_locked, created_at, updated_at
    ) VALUES (
      ${receiptNo}, ${nextSeq}, ${booking.plot_number || 'N/A'}, ${String(booking.plot_area || '')},
      ${user.user_id}, ${user.full_name || 'Valued Customer'}, ${user.mobile_no || ''},
      'EmiPayment', ${paymentDetails.payment_mode || 'Online'}, ${emiAmount}, ${emiAmount},
      ${paymentDetails.payment_date || new Date().toISOString().split('T')[0]},
      ${`EMI Installment #${emi.installment_no} for Plot ${booking.plot_number}`},
      'Active', TRUE, NOW(), NOW()
    )
    RETURNING *
  `;
  return rec;
}
