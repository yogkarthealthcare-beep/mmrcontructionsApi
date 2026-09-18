import express from "express";
import jwt from "jsonwebtoken";
import PDFDocument from "pdfkit";
import sql from "../db.js";
import GatewayFactory from "../payment/GatewayFactory.js";

const router = express.Router();
const ok = (res, data, message = "Success", status = 200) =>
  res.status(status).json({ success: true, message, data });
const fail = (res, message, status = 500, code = undefined) =>
  res.status(status).json({ success: false, message, ...(code ? { code } : {}) });

const userAuth = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return fail(res, "Login required", 401, "LOGIN_REQUIRED");
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return fail(res, "Invalid or expired token", 401, "LOGIN_REQUIRED");
  }
};

const adminAuth = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return fail(res, "Admin login required", 401);
  try {
    req.admin = jwt.verify(token, process.env.JWT_ADMIN_SECRET || process.env.JWT_SECRET);
    next();
  } catch {
    return fail(res, "Invalid or expired admin token", 401);
  }
};

async function settings() {
  const [row] = await sql`SELECT * FROM booking_workflow_settings WHERE id = 1`;
  if (!row) throw new Error("Booking workflow settings are not initialized.");
  return row;
}

async function compliance(userId) {
  const [row] = await sql`
    SELECT
      u.user_id, u.full_name, u.email, u.mobile_no, u.account_status, u.is_active,
      (COALESCE(u.email_verified, FALSE) OR COALESCE(u.is_otp_verified, FALSE)) AS email_verified,
      COALESCE(k.status, 'Not Submitted') AS kyc_status,
      k.admin_remarks AS kyc_remarks,
      (SELECT COUNT(*)::int FROM user_documents d WHERE d.user_id = u.user_id AND d.is_active) AS document_count
    FROM users u
    LEFT JOIN user_kyc_profiles k ON k.user_id = u.user_id
    WHERE u.user_id = ${userId}`;
  if (!row) return null;
  return {
    ...row,
    account_active: ["Active", "Approved"].includes(String(row.account_status)) && row.is_active !== false,
    kyc_approved: row.kyc_status === "Approved",
    can_book:
      ["Active", "Approved"].includes(String(row.account_status)) &&
      row.is_active !== false &&
      row.email_verified === true &&
      row.kyc_status === "Approved",
  };
}

function complianceFailure(result) {
  if (!result?.account_active) return ["Your account must be active before booking a plot.", "ACCOUNT_INACTIVE"];
  if (!result.email_verified) return ["Please verify your email address before booking a plot.", "EMAIL_NOT_VERIFIED"];
  if (result.kyc_status !== "Approved") {
    return [
      "Your KYC documents are not approved yet. Please upload the required documents and wait for admin approval before booking any plot.",
      "KYC_NOT_APPROVED",
    ];
  }
  return null;
}

async function releaseExpiredLocks(db = sql) {
  const expired = await db`
    UPDATE plot_booking_locks
    SET status = 'Expired', updated_at = NOW()
    WHERE status = 'Active' AND expires_at <= NOW()
    RETURNING plot_id`;
  for (const lock of expired) {
    await db`
      UPDATE plots p SET plot_status = 'Vacant', updated_at = NOW()
      WHERE p.plot_id = ${lock.plot_id}
        AND p.plot_status = 'InProcess'
        AND NOT EXISTS (
          SELECT 1 FROM bookings b
          WHERE b.plot_id = p.plot_id AND b.booking_status IN ('PaymentPending','Confirmed')
        )`;
  }
}

const money = (value) => Number(value || 0);
const invoiceNumber = (bookingId) =>
  `MMR-INV-${new Date().getFullYear()}-${String(bookingId).padStart(6, "0")}`;

async function generateCommissionForPayment(req, bookingId, sourceType, sourceId, receivedAmount, paymentType) {
  const amountReceived = money(receivedAmount);
  if (!(amountReceived > 0)) return { generated: 0, reason: "No received amount" };
  return sql.begin(async (db) => {
    await db`SELECT pg_advisory_xact_lock(${Number(bookingId)})`;
    const [booking] = await db`
      SELECT b.booking_id, p.plot_area, p.base_price, buyer.sponsor_user_id
      FROM bookings b
      JOIN users buyer ON buyer.user_id = b.user_id
      JOIN plots p ON p.plot_id = b.plot_id
      WHERE b.booking_id = ${bookingId}`;
    if (!booking?.sponsor_user_id) return { generated: 0, reason: "No sponsor" };
    const [engine] = await db`SELECT * FROM commission_engine_settings WHERE id = 1`;
    if (!engine?.is_active) return { generated: 0, reason: "Commission engine inactive" };
    const eligibility = engine.eligibility_rules || {};
    if (money(booking.base_price) < money(eligibility.minimum_plot_amount)) return { generated: 0, reason: "Plot amount below eligibility minimum" };
    if (amountReceived < money(eligibility.minimum_payment_amount)) return { generated: 0, reason: "Payment amount below eligibility minimum" };
    const levels = engine.commission_model === "LevelWise"
      ? await db`SELECT level_no, percentage, is_active FROM commission_engine_levels WHERE settings_id = 1 AND commission_model = 'LevelWise' ORDER BY level_no`
      : [];
    const [event] = await db`
      INSERT INTO commission_source_events (
        booking_id, source_type, source_id, payment_type, received_amount,
        plot_amount, plot_area_gaj, commission_model, engine_version, generated_by_admin_id
      ) VALUES (
        ${bookingId}, ${sourceType}, ${String(sourceId)}, ${paymentType}, ${amountReceived},
        ${money(booking.base_price)}, ${money(booking.plot_area)}, ${engine.commission_model},
        ${engine.version}, ${req?.admin?.admin_id || null}
      )
      ON CONFLICT (booking_id, source_type, source_id) DO NOTHING
      RETURNING event_id`;
    if (!event) return { generated: 0, reason: "Payment event already processed" };
    const ancestors = await db`
      SELECT ancestor_user_id, depth FROM mlm_tree_closure
      WHERE descendant_user_id = ${booking.sponsor_user_id}
      UNION ALL SELECT ${booking.sponsor_user_id}::int, 0`;
    const candidates = new Map();
    for (const row of ancestors) {
      const level = Number(row.ancestor_user_id) === Number(booking.sponsor_user_id) ? 1 : Number(row.depth) + 1;
      if (level <= Number(engine.maximum_levels) && !candidates.has(row.ancestor_user_id)) candidates.set(row.ancestor_user_id, level);
    }
    let generated = 0;
    for (const [associateUserId, level] of candidates.entries()) {
      const [associate] = await db`SELECT account_status FROM users WHERE user_id = ${associateUserId} AND user_type = 'Associate'`;
      if (!associate) continue;
      if (eligibility.require_active_associate !== false && associate.account_status !== "Active") continue;
      if (eligibility.exclude_blacklisted !== false && associate.account_status === "Blacklisted") continue;
      const percentage = engine.commission_model === "Upline"
        ? (level === 1 ? money(engine.direct_percentage) : money(engine.upline_percentage))
        : money(levels.find(item => Number(item.level_no) === level && item.is_active)?.percentage);
      const commissionAmount = Math.round(amountReceived * percentage) / 100;
      if (!(commissionAmount > 0)) continue;
      const [created] = await db`
        INSERT INTO commission_transactions (
          associate_user_id, related_booking_id, commission_type, gaj_sold,
          gross_amount, deduction_amount, net_amount, commission_month, commission_status,
          commission_event_id, commission_model, commission_level, commission_percentage,
          calculation_base, source_type, source_reference, engine_version
        ) VALUES (
          ${associateUserId}, ${bookingId}, ${level === 1 ? "Direct" : "Upline"}, ${money(booking.plot_area)},
          ${commissionAmount}, 0, ${commissionAmount}, ${new Date().toISOString().slice(0, 7)}, 'Pending',
          ${event.event_id}, ${engine.commission_model}, ${level}, ${percentage},
          ${amountReceived}, ${sourceType}, ${String(sourceId)}, ${engine.version}
        )
        ON CONFLICT DO NOTHING RETURNING commission_id`;
      if (created) generated++;
    }
    return { generated, model: engine.commission_model, version: engine.version, event_id: event.event_id };
  });
}

async function bookingDetails(bookingId, userId = null) {
  const [row] = await sql`
    SELECT
      b.*, u.full_name, u.mobile_no, u.email,
      p.plot_number, p.plot_area, p.plot_category, p.base_price, p.monthly_emi,
      p.emi_tenure_months, s.site_name, s.city, s.full_address,
      a.appointment_id, a.appointment_date, a.start_time, a.end_time,
      a.status AS appointment_status, a.payment_mode AS appointment_payment_mode,
      i.invoice_id, i.invoice_number
    FROM bookings b
    JOIN users u ON u.user_id = b.user_id
    JOIN plots p ON p.plot_id = b.plot_id
    JOIN sites s ON s.site_id = p.site_id
    LEFT JOIN booking_appointments a ON a.booking_id = b.booking_id
    LEFT JOIN booking_invoices i ON i.booking_id = b.booking_id
    WHERE b.booking_id = ${bookingId}
      AND (${userId}::int IS NULL OR b.user_id = ${userId})`;
  return row || null;
}

async function ensureInvoice(db, booking, paymentId = null) {
  const currentYear = new Date().getFullYear();
  let [inv] = await db`SELECT * FROM invoices WHERE booking_id = ${booking.booking_id}`;
  let number = inv ? inv.invoice_number : null;

  if (!number) {
    const [seqRow] = await db`
      INSERT INTO invoice_number_sequence (year, last_sequence)
      VALUES (${currentYear}, 1)
      ON CONFLICT (year) DO UPDATE SET last_sequence = invoice_number_sequence.last_sequence + 1, updated_at = NOW()
      RETURNING last_sequence`;
    const seq = seqRow ? seqRow.last_sequence : 1;
    number = `MMR-${currentYear}-${String(seq).padStart(6, "0")}`;
  }

  let associateId = null;
  let associateName = null;
  let associateMobile = null;
  const [ref] = await db`
    SELECT sponsor_user_id FROM referral_registrations WHERE referred_user_id = ${booking.user_id}`;
  if (ref) {
    const [assoc] = await db`SELECT user_id, full_name, mobile_no FROM users WHERE user_id = ${ref.sponsor_user_id}`;
    if (assoc) {
      associateId = assoc.user_id;
      associateName = assoc.full_name;
      associateMobile = assoc.mobile_no;
    }
  }

  const totalPlotPrice = money(booking.base_price || (booking.plot_area * 1000) || 0);
  const paidAmt = money(booking.required_booking_amount || booking.advance_amount || booking.booking_amount || 0);
  const remBalance = money(booking.remaining_balance || Math.max(0, totalPlotPrice - paidAmt));

  const invoiceData = {
    invoice_number: number,
    booking_id: booking.booking_id,
    booking_serial: booking.booking_serial || `BK-${booking.booking_id}`,
    customer_name: booking.full_name,
    mobile_no: booking.mobile_no,
    email: booking.email,
    site_name: booking.site_name,
    plot_number: booking.plot_number,
    plot_size: `${booking.plot_area} ${booking.plot_category || "Sq.Ft."}`.trim(),
    plot_area_sqft: Number(booking.plot_area || 0),
    rate_per_sqft: booking.plot_area ? Math.round(totalPlotPrice / booking.plot_area) : 0,
    total_plot_price: totalPlotPrice,
    discount: 0,
    registration_charges: 0,
    other_charges: 0,
    grand_total: totalPlotPrice,
    paid_amount: paidAmt,
    balance_amount: remBalance,
    payment_method: booking.payment_method || "Online",
    payment_status: "Paid",
    order_status: "Completed",
    booking_date: booking.booking_date,
    associate_id: associateId,
    associate_name: associateName,
    associate_mobile: associateMobile,
  };

  await db`
    INSERT INTO invoices (
      invoice_number, booking_id, user_id, associate_id, payment_id, order_id, invoice_date,
      subtotal, grand_total, paid_amount, balance_amount, payment_method,
      payment_status, order_status, invoice_data, verification_token
    ) VALUES (
      ${number}, ${booking.booking_id}, ${booking.user_id}, ${associateId}, ${paymentId}, ${booking.booking_serial || `ORDER-${booking.booking_id}`}, ${booking.booking_date || new Date()},
      ${totalPlotPrice}, ${totalPlotPrice}, ${paidAmt}, ${remBalance}, ${booking.payment_method || "Online"},
      'Paid', 'Completed', ${db.json(invoiceData)}, ${number}
    )
    ON CONFLICT (booking_id) DO UPDATE SET
      payment_id = COALESCE(EXCLUDED.payment_id, invoices.payment_id),
      invoice_data = EXCLUDED.invoice_data,
      paid_amount = EXCLUDED.paid_amount,
      balance_amount = EXCLUDED.balance_amount,
      updated_at = NOW()`;

  await db`
    INSERT INTO booking_invoices (invoice_number, booking_id, user_id, payment_id, invoice_data)
    VALUES (${number}, ${booking.booking_id}, ${booking.user_id}, ${paymentId}, ${db.json(invoiceData)})
    ON CONFLICT (booking_id) DO UPDATE SET
      payment_id = COALESCE(EXCLUDED.payment_id, booking_invoices.payment_id),
      invoice_data = EXCLUDED.invoice_data,
      updated_at = NOW()`;

  return invoiceData;
}

async function completeBooking(bookingId, payment, adminId = null) {
  return sql.begin(async (db) => {
    const [booking] = await db`
      SELECT b.*, u.full_name, u.mobile_no, u.email,
             p.plot_number, p.plot_area, p.plot_category, p.base_price, p.monthly_emi,
             p.emi_tenure_months, s.site_name
      FROM bookings b
      JOIN users u ON u.user_id = b.user_id
      JOIN plots p ON p.plot_id = b.plot_id
      JOIN sites s ON s.site_id = p.site_id
      WHERE b.booking_id = ${bookingId}
      FOR UPDATE OF b`;
    if (!booking) throw new Error("Booking not found.");
    if (booking.booking_status === "Confirmed") return booking;

    await db`
      UPDATE bookings SET
        booking_status = 'Confirmed',
        workflow_status = 'Booked',
        payment_reference_id = ${payment.gateway_payment_id || payment.reference_no || null},
        payment_received_at = NOW(),
        confirmed_by_admin_id = ${adminId},
        confirmed_at = NOW(),
        updated_at = NOW()
      WHERE booking_id = ${bookingId}`;
    await db`UPDATE plots SET plot_status = 'Booked', updated_at = NOW() WHERE plot_id = ${booking.plot_id}`;
    await db`
      UPDATE plot_booking_locks SET status = 'Converted', updated_at = NOW()
      WHERE booking_id = ${bookingId} AND status = 'Active'`;
    const [paymentRow] = await db`
      UPDATE booking_payment_records SET
        status = 'Paid',
        gateway_payment_id = COALESCE(${payment.gateway_payment_id || null}, gateway_payment_id),
        gateway_signature = COALESCE(${payment.gateway_signature || null}, gateway_signature),
        reference_no = COALESCE(${payment.reference_no || null}, reference_no),
        raw_response = ${db.json(payment.raw_response || payment)},
        verified_by_admin_id = ${adminId},
        verified_at = NOW(),
        updated_at = NOW()
      WHERE booking_id = ${bookingId}
      RETURNING payment_id`;

    if (booking.payment_type === "EMI") {
      const start = new Date();
      start.setMonth(start.getMonth() + 1);
      for (let i = 1; i <= Number(booking.emi_tenure_months || 60); i++) {
        const due = new Date(start);
        due.setMonth(due.getMonth() + i - 1);
        await db`
          INSERT INTO emi_schedules (booking_id, user_id, installment_no, due_date, emi_amount)
          VALUES (${bookingId}, ${booking.user_id}, ${i}, ${due.toISOString().slice(0, 10)}, ${booking.monthly_emi || 0})
          ON CONFLICT (booking_id, installment_no) DO NOTHING`;
      }
    }
    await ensureInvoice(db, booking, paymentRow?.payment_id || null);
    return booking;
  });
}

router.get("/booking/config", async (_req, res) => {
  try {
    const config = await settings();
    return ok(res, {
      minimum_booking_amount: money(config.minimum_booking_amount),
      first_emi_amount: money(config.first_emi_amount),
      required_booking_payment: money(config.minimum_booking_amount) + money(config.first_emi_amount),
      booking_formula: config.booking_formula,
      plot_lock_minutes: config.plot_lock_minutes,
    });
  } catch (error) {
    return fail(res, error.message);
  }
});

router.get("/booking/compliance", userAuth, async (req, res) => {
  try {
    return ok(res, await compliance(req.user.user_id));
  } catch (error) {
    return fail(res, error.message);
  }
});

router.get("/booking/appointment-slots", userAuth, async (req, res) => {
  try {
    const config = await settings();
    const dates = [];
    for (let day = 1; day <= Number(config.appointment_days_ahead); day++) {
      const date = new Date();
      date.setDate(date.getDate() + day);
      if (date.getDay() === 0) continue;
      const dateKey = date.toISOString().slice(0, 10);
      const slots = [];
      const [openHour, openMinute] = String(config.office_open_time).split(":").map(Number);
      const [closeHour, closeMinute] = String(config.office_close_time).split(":").map(Number);
      let cursor = openHour * 60 + openMinute;
      const close = closeHour * 60 + closeMinute;
      while (cursor + Number(config.appointment_slot_minutes) <= close) {
        const start = `${String(Math.floor(cursor / 60)).padStart(2, "0")}:${String(cursor % 60).padStart(2, "0")}`;
        const endMinutes = cursor + Number(config.appointment_slot_minutes);
        const end = `${String(Math.floor(endMinutes / 60)).padStart(2, "0")}:${String(endMinutes % 60).padStart(2, "0")}`;
        const [taken] = await sql`
          SELECT appointment_id FROM booking_appointments
          WHERE appointment_date = ${dateKey}
            AND start_time = ${start}
            AND status IN ('Scheduled','Rescheduled')`;
        if (!taken) slots.push({ start_time: start, end_time: end });
        cursor = endMinutes;
      }
      dates.push({ date: dateKey, slots });
    }
    return ok(res, dates);
  } catch (error) {
    return fail(res, error.message);
  }
});

router.post("/booking/initiate", userAuth, async (req, res) => {
  try {
    const plotId = Number(req.body.plot_id);
    const paymentMethod = String(req.body.payment_method || "");
    const appointment = req.body.appointment || null;
    if (!plotId || !["Online", "Offline"].includes(paymentMethod)) {
      return fail(res, "plot_id and valid payment_method are required.", 400);
    }
    const validation = await compliance(req.user.user_id);
    const blocked = complianceFailure(validation);
    if (blocked) return fail(res, blocked[0], 403, blocked[1]);
    const config = await settings();
    const required = money(config.minimum_booking_amount) + money(config.first_emi_amount);
    const lockMinutes = Number(config.plot_lock_minutes);

    const created = await sql.begin(async (db) => {
      await db`SELECT pg_advisory_xact_lock(${plotId})`;
      await releaseExpiredLocks(db);
      const [plot] = await db`
        SELECT p.*, s.site_name
        FROM plots p JOIN sites s ON s.site_id = p.site_id
        WHERE p.plot_id = ${plotId}
        FOR UPDATE`;
      if (!plot) throw Object.assign(new Error("Plot not found."), { status: 404 });
      if (plot.plot_status !== "Vacant") throw Object.assign(new Error("Plot is currently unavailable or locked."), { status: 409 });

      const [seq] = await db`SELECT nextval('bookings_booking_id_seq') AS booking_id`;
      const bookingId = Number(seq.booking_id);
      const serial = `MMR-${new Date().getFullYear()}-${String(bookingId).padStart(5, "0")}`;
      const paymentType = paymentMethod === "Online" ? "Online" : "Cheque";
      const [booking] = await db`
        INSERT INTO bookings (
          booking_id, booking_serial, user_id, plot_id, payment_type, advance_amount,
          booking_status, workflow_status, payment_method, required_booking_amount,
          minimum_booking_amount, first_emi_amount, remaining_balance
        ) VALUES (
          ${bookingId}, ${serial}, ${req.user.user_id}, ${plotId}, ${paymentType},
          ${required}, 'Submitted', ${paymentMethod === "Online" ? "Payment Pending" : "Appointment Scheduled"},
          ${paymentMethod}, ${required}, ${config.minimum_booking_amount}, ${config.first_emi_amount},
          ${Math.max(0, money(plot.base_price) - required)}
        ) RETURNING *`;
      const [lock] = await db`
        INSERT INTO plot_booking_locks (plot_id, user_id, booking_id, expires_at)
        VALUES (${plotId}, ${req.user.user_id}, ${bookingId}, NOW() + make_interval(mins => ${lockMinutes}))
        RETURNING lock_token, expires_at`;
      await db`UPDATE plots SET plot_status = 'InProcess', updated_at = NOW() WHERE plot_id = ${plotId}`;
      const orderId = `BOOKING-${bookingId}-${Date.now()}`;
      await db`
        INSERT INTO booking_payment_records (
          booking_id, user_id, payment_method, gateway_name, amount, status, order_id
        ) VALUES (
          ${bookingId}, ${req.user.user_id}, ${paymentMethod},
          ${paymentMethod === "Online" ? "razorpay" : null}, ${required},
          ${paymentMethod === "Online" ? "Pending" : "Verification Pending"}, ${orderId}
        )`;
      await db`UPDATE bookings SET payment_order_id = ${orderId} WHERE booking_id = ${bookingId}`;
      if (paymentMethod === "Offline") {
        if (!appointment?.date || !appointment?.start_time || !appointment?.end_time) {
          throw Object.assign(new Error("Appointment date and time slot are required for offline payment."), { status: 400 });
        }
        await db`
          INSERT INTO booking_appointments (
            booking_id, user_id, appointment_date, start_time, end_time, payment_mode
          ) VALUES (
            ${bookingId}, ${req.user.user_id}, ${appointment.date},
            ${appointment.start_time}, ${appointment.end_time}, ${appointment.payment_mode || "Office Visit"}
          )`;
        await db`UPDATE bookings SET booking_status = 'PaymentPending' WHERE booking_id = ${bookingId}`;
      }
      return { booking, plot, lock, orderId };
    });

    if (paymentMethod === "Offline") {
      return ok(res, {
        booking_id: created.booking.booking_id,
        booking_serial: created.booking.booking_serial,
        workflow_status: "Appointment Scheduled",
        lock_expires_at: created.lock.expires_at,
      }, "Appointment scheduled. Booking is pending payment verification.", 201);
    }

    const gateway = await GatewayFactory.getGatewayInstance("razorpay");
    const callbackUrl = gateway.config.callback_url || "";
    const gatewayOrder = await gateway.createOrder(
      created.orderId,
      required,
      {
        name: validation.full_name,
        email: validation.email,
        phone: validation.mobile_no,
        customer_id: String(req.user.user_id),
      },
      callbackUrl,
    );
    await sql`
      UPDATE booking_payment_records SET
        gateway_order_id = ${gatewayOrder.gateway_order_id},
        raw_response = ${sql.json(gatewayOrder)},
        updated_at = NOW()
      WHERE booking_id = ${created.booking.booking_id}`;
    return ok(res, {
      booking_id: created.booking.booking_id,
      booking_serial: created.booking.booking_serial,
      lock_expires_at: created.lock.expires_at,
      amount: required,
      gateway_name: "razorpay",
      checkout_details: gatewayOrder.checkout_details,
    }, "Plot locked. Complete online payment before the lock expires.", 201);
  } catch (error) {
    return fail(res, error.message, error.status || 500);
  }
});

router.post("/booking/:id/online/verify", userAuth, async (req, res) => {
  try {
    const bookingId = Number(req.params.id);
    const [booking] = await sql`
      SELECT b.*, pbl.expires_at
      FROM bookings b
      JOIN plot_booking_locks pbl ON pbl.booking_id = b.booking_id AND pbl.status = 'Active'
      WHERE b.booking_id = ${bookingId} AND b.user_id = ${req.user.user_id}`;
    if (!booking) return fail(res, "Active booking lock not found.", 404);
    if (new Date(booking.expires_at) <= new Date()) return fail(res, "Plot lock expired. Please start booking again.", 409);
    const gateway = await GatewayFactory.getGatewayInstance("razorpay");
    const result = await gateway.verifyPayment(booking.payment_order_id, {}, req.body);
    const completed = await completeBooking(bookingId, result);
    const amount = money(completed.required_booking_amount || completed.advance_amount);
    const sourceType = amount >= money(completed.base_price) ? "FullPayment" : "InitialPayment";
    const commission = await generateCommissionForPayment(req, bookingId, sourceType, `online-${booking.payment_order_id}`, amount, "Online");
    return ok(res, { booking_id: bookingId, invoice_url: `/api/booking/${bookingId}/invoice.pdf`, commission }, "Payment received and plot booked.");
  } catch (error) {
    return fail(res, error.message, 400);
  }
});

router.get("/booking/orders", userAuth, async (req, res) => {
  try {
    await releaseExpiredLocks();
    const rows = await sql`
      SELECT b.booking_id, b.booking_serial, b.booking_date, b.booking_status, b.workflow_status,
             b.payment_method, b.required_booking_amount, b.remaining_balance,
             p.plot_number, p.plot_area, p.base_price, p.monthly_emi, p.emi_tenure_months,
             s.site_name, a.appointment_date, a.start_time, a.status AS appointment_status,
             i.invoice_number,
             COALESCE((SELECT SUM(amount) FROM booking_payment_records pr WHERE pr.booking_id = b.booking_id AND pr.status = 'Paid'), 0) AS total_paid
      FROM bookings b
      JOIN plots p ON p.plot_id = b.plot_id
      JOIN sites s ON s.site_id = p.site_id
      LEFT JOIN booking_appointments a ON a.booking_id = b.booking_id
      LEFT JOIN booking_invoices i ON i.booking_id = b.booking_id
      WHERE b.user_id = ${req.user.user_id}
      ORDER BY b.created_at DESC`;
    return ok(res, rows);
  } catch (error) {
    return fail(res, error.message);
  }
});

router.get("/booking/:id/invoice", userAuth, async (req, res) => {
  try {
    const booking = await bookingDetails(Number(req.params.id), req.user.user_id);
    if (!booking || booking.booking_status !== "Confirmed") return fail(res, "Invoice is available after payment approval.", 404);
    const [invoice] = await sql`SELECT * FROM booking_invoices WHERE booking_id = ${booking.booking_id}`;
    return ok(res, invoice || { invoice_number: invoiceNumber(booking.booking_id), invoice_data: booking });
  } catch (error) {
    return fail(res, error.message);
  }
});

router.get("/booking/:id/invoice.pdf", userAuth, async (req, res) => {
  try {
    const booking = await bookingDetails(Number(req.params.id), req.user.user_id);
    if (!booking || booking.booking_status !== "Confirmed") return fail(res, "Invoice is available after payment approval.", 404);
    const config = await settings();
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${invoiceNumber(booking.booking_id)}.pdf"`);
    const doc = new PDFDocument({ margin: 48, size: "A4" });
    doc.pipe(res);
    doc.fontSize(20).fillColor("#14532d").text(config.company_name, { align: "center" });
    doc.fontSize(10).fillColor("#475569").text(config.company_address || "", { align: "center" });
    doc.moveDown().fontSize(18).fillColor("#111827").text("PLOT BOOKING INVOICE", { align: "center" });
    doc.moveDown();
    const lines = [
      ["Invoice Number", invoiceNumber(booking.booking_id)],
      ["Booking ID", booking.booking_serial],
      ["Customer", booking.full_name],
      ["Mobile", booking.mobile_no],
      ["Email", booking.email || "-"],
      ["Project", booking.site_name],
      ["Plot Number", booking.plot_number],
      ["Plot Size", `${booking.plot_area} ${booking.plot_category || ""}`],
      ["Plot Price", `INR ${money(booking.base_price).toLocaleString("en-IN")}`],
      ["Booking Amount Paid", `INR ${money(booking.required_booking_amount).toLocaleString("en-IN")}`],
      ["Remaining Balance", `INR ${money(booking.remaining_balance).toLocaleString("en-IN")}`],
      ["EMI", `INR ${money(booking.monthly_emi).toLocaleString("en-IN")} x ${booking.emi_tenure_months || 0} months`],
      ["Payment Method", booking.payment_method || "-"],
      ["Booking Date", new Date(booking.booking_date).toLocaleString("en-IN")],
    ];
    for (const [label, value] of lines) {
      doc.fontSize(10).fillColor("#64748b").text(label, 55, doc.y, { continued: true, width: 160 });
      doc.fillColor("#111827").text(String(value), { width: 320 });
      doc.moveDown(0.45);
    }
    doc.moveDown().fontSize(9).fillColor("#64748b").text("This is a system-generated invoice.", { align: "center" });
    doc.end();
  } catch (error) {
    if (!res.headersSent) return fail(res, error.message);
  }
});

router.get("/kyc/status", userAuth, async (req, res) => {
  try {
    const result = await compliance(req.user.user_id);
    const documents = await sql`
      SELECT document_id, document_type, file_path, file_name, uploaded_at,
             is_verified, review_status, admin_remarks, rejection_note, reupload_requested
      FROM user_documents
      WHERE user_id = ${req.user.user_id} AND is_active
      ORDER BY uploaded_at DESC`;
    return ok(res, { status: result.kyc_status, remarks: result.kyc_remarks, documents });
  } catch (error) {
    return fail(res, error.message);
  }
});

router.get("/admin/booking-workflow/settings", adminAuth, async (_req, res) => {
  try { return ok(res, await settings()); } catch (error) { return fail(res, error.message); }
});

router.put("/admin/booking-workflow/settings", adminAuth, async (req, res) => {
  try {
    const required = money(req.body.minimum_booking_amount) + money(req.body.first_emi_amount);
    if (required <= 0) return fail(res, "Booking amounts must be greater than zero.", 400);
    const [updated] = await sql`
      UPDATE booking_workflow_settings SET
        minimum_booking_amount = ${req.body.minimum_booking_amount},
        first_emi_amount = ${req.body.first_emi_amount},
        plot_lock_minutes = ${req.body.plot_lock_minutes},
        appointment_days_ahead = ${req.body.appointment_days_ahead},
        office_open_time = ${req.body.office_open_time},
        office_close_time = ${req.body.office_close_time},
        company_name = COALESCE(${req.body.company_name || null}, company_name),
        company_address = ${req.body.company_address || null},
        company_phone = ${req.body.company_phone || null},
        company_email = ${req.body.company_email || null},
        updated_by_admin_id = ${req.admin.admin_id},
        updated_at = NOW()
      WHERE id = 1 RETURNING *`;
    return ok(res, updated, "Booking workflow settings updated.");
  } catch (error) {
    return fail(res, error.message, 400);
  }
});

router.get("/admin/kyc", adminAuth, async (req, res) => {
  try {
    const status = req.query.status ? String(req.query.status) : null;
    const rows = await sql`
      SELECT k.*, u.full_name, u.email, u.mobile_no, u.member_id,
             COUNT(d.document_id) FILTER (WHERE d.is_active)::int AS document_count,
             COALESCE(json_agg(json_build_object(
               'document_id', d.document_id, 'document_type', d.document_type,
               'file_path', d.file_path, 'review_status', d.review_status,
               'uploaded_at', d.uploaded_at
             )) FILTER (WHERE d.document_id IS NOT NULL AND d.is_active), '[]') AS documents
      FROM user_kyc_profiles k
      JOIN users u ON u.user_id = k.user_id
      LEFT JOIN user_documents d ON d.user_id = k.user_id
      WHERE (${status}::text IS NULL OR k.status = ${status})
      GROUP BY k.user_id, u.user_id
      ORDER BY COALESCE(k.submitted_at, k.updated_at) DESC`;
    return ok(res, rows);
  } catch (error) {
    return fail(res, error.message);
  }
});

router.patch("/admin/kyc/:userId", adminAuth, async (req, res) => {
  try {
    const userId = Number(req.params.userId);
    const status = String(req.body.status || "");
    if (!["Under Review", "Approved", "Rejected", "Submitted"].includes(status)) return fail(res, "Invalid KYC status.", 400);
    const [profile] = await sql`
      INSERT INTO user_kyc_profiles (user_id, status, admin_remarks, reviewed_at, reviewed_by_admin_id, submitted_at)
      VALUES (${userId}, ${status}, ${req.body.remarks || null}, NOW(), ${req.admin.admin_id}, NOW())
      ON CONFLICT (user_id) DO UPDATE SET
        status = EXCLUDED.status, admin_remarks = EXCLUDED.admin_remarks,
        reviewed_at = NOW(), reviewed_by_admin_id = ${req.admin.admin_id}, updated_at = NOW()
      RETURNING *`;
    await sql`
      UPDATE user_documents SET
        is_verified = ${status === "Approved"},
        review_status = ${status === "Approved" ? "Approved" : status === "Rejected" ? "Rejected" : "Under Review"},
        rejection_note = ${status === "Rejected" ? req.body.remarks || "Please re-upload valid documents." : null},
        admin_remarks = ${req.body.remarks || null},
        reupload_requested = ${Boolean(req.body.request_reupload)},
        verified_by_admin_id = ${req.admin.admin_id},
        verified_at = ${status === "Approved" ? new Date() : null}
      WHERE user_id = ${userId} AND is_active`;
    return ok(res, profile, `KYC marked ${status}.`);
  } catch (error) {
    return fail(res, error.message);
  }
});

router.get("/admin/booking-workflow/alerts", adminAuth, async (_req, res) => {
  try {
    const [alerts] = await sql`
      SELECT
        (SELECT COUNT(*)::int FROM users WHERE email_verified = FALSE) AS pending_email_verifications,
        (SELECT COUNT(*)::int FROM user_kyc_profiles WHERE status IN ('Submitted','Under Review')) AS pending_kyc_reviews,
        (SELECT COUNT(*)::int FROM user_kyc_profiles WHERE status = 'Rejected') AS rejected_documents,
        (SELECT COUNT(*)::int FROM bookings WHERE payment_method = 'Offline' AND booking_status = 'PaymentPending') AS pending_offline_bookings,
        (SELECT COUNT(*)::int FROM booking_payment_records WHERE status = 'Verification Pending') AS pending_payment_approvals,
        (SELECT COUNT(*)::int FROM booking_appointments WHERE status IN ('Scheduled','Rescheduled')) AS pending_appointment_requests`;
    return ok(res, alerts);
  } catch (error) {
    return fail(res, error.message);
  }
});

router.post("/admin/bookings/:id/offline/approve", adminAuth, async (req, res) => {
  try {
    const bookingId = Number(req.params.id);
    const completed = await completeBooking(bookingId, {
      reference_no: req.body.reference_no || null,
      raw_response: { admin_remarks: req.body.remarks || null },
    }, req.admin.admin_id);
    const amount = money(req.body.received_amount || completed.required_booking_amount || completed.advance_amount);
    const sourceType = amount >= money(completed.base_price) ? "FullPayment" : "InitialPayment";
    const commission = await generateCommissionForPayment(
      req, bookingId, sourceType, `offline-${req.body.reference_no || bookingId}`, amount, "Offline"
    );
    return ok(res, { booking_id: bookingId, commission }, "Offline payment approved and booking confirmed.");
  } catch (error) {
    return fail(res, error.message, 400);
  }
});

router.post("/admin/bookings/:id/offline/reject", adminAuth, async (req, res) => {
  try {
    const bookingId = Number(req.params.id);
    const [booking] = await sql`SELECT * FROM bookings WHERE booking_id = ${bookingId}`;
    if (!booking) return fail(res, "Booking not found.", 404);
    await sql.begin(async (db) => {
      await db`
        UPDATE bookings SET booking_status = 'Cancelled', workflow_status = 'Offline Payment Rejected',
          cancellation_reason = ${req.body.reason || "Offline payment rejected"}, cancelled_by_admin_id = ${req.admin.admin_id},
          cancelled_at = NOW(), updated_at = NOW()
        WHERE booking_id = ${bookingId}`;
      await db`UPDATE plots SET plot_status = 'Vacant', updated_at = NOW() WHERE plot_id = ${booking.plot_id}`;
      await db`UPDATE plot_booking_locks SET status = 'Released', updated_at = NOW() WHERE booking_id = ${bookingId}`;
      await db`UPDATE booking_payment_records SET status = 'Rejected', remarks = ${req.body.reason || null}, updated_at = NOW() WHERE booking_id = ${bookingId}`;
    });
    return ok(res, {}, "Offline payment rejected and plot released.");
  } catch (error) {
    return fail(res, error.message);
  }
});

router.patch("/admin/bookings/:id/appointment", adminAuth, async (req, res) => {
  try {
    const [appointment] = await sql`
      UPDATE booking_appointments SET
        appointment_date = ${req.body.date}, start_time = ${req.body.start_time},
        end_time = ${req.body.end_time}, status = 'Rescheduled',
        admin_remarks = ${req.body.remarks || null},
        rescheduled_by_admin_id = ${req.admin.admin_id}, updated_at = NOW()
      WHERE booking_id = ${req.params.id}
      RETURNING *`;
    if (!appointment) return fail(res, "Appointment not found.", 404);
    return ok(res, appointment, "Appointment rescheduled.");
  } catch (error) {
    return fail(res, error.message, 400);
  }
});

router.get("/admin/plots/validate-availability", adminAuth, async (req, res) => {
  try {
    const siteId = Number(req.query.site_id);
    const plotNumber = String(req.query.plot_number || "").trim();
    if (!siteId || !plotNumber) {
      return fail(res, "site_id and plot_number are required.", 400);
    }
    const cleanNum = plotNumber.replace(/^plot\s*/i, "").trim();
    const [plot] = await sql`
      SELECT p.plot_id, p.plot_number, p.plot_area, p.plot_category, p.base_price,
             p.down_payment, p.monthly_emi, p.plot_status, s.site_name, s.city
      FROM plots p
      JOIN sites s ON s.site_id = p.site_id
      WHERE p.site_id = ${siteId}
        AND (
          LOWER(TRIM(p.plot_number)) = LOWER(TRIM(${plotNumber}))
          OR LOWER(TRIM(p.plot_number)) = LOWER(TRIM(${cleanNum}))
          OR LOWER(TRIM(p.plot_number)) = LOWER('plot ' || TRIM(${cleanNum}))
        )
      LIMIT 1`;

    if (!plot) {
      return ok(res, {
        exists: false,
        is_available: false,
        message: `Plot '${plotNumber}' was not found in the selected site. Please check the plot number or register it in Site Management first.`
      });
    }

async function ensureAllocationSchema() {
  try {
    await sql`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS plot_number VARCHAR(180)`;
    await sql`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS site_id INTEGER`;
    await sql`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS plot_area NUMERIC(12,2) DEFAULT 0`;
    await sql`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS base_price NUMERIC(14,2) DEFAULT 0`;
    await sql`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS notes TEXT`;
    await sql`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_type VARCHAR(50) DEFAULT 'Full'`;
    await sql`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_method VARCHAR(50)`;
    await sql`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS workflow_status VARCHAR(80) DEFAULT 'Booking Initiated'`;
    await sql`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS required_booking_amount NUMERIC(14,2) DEFAULT 0`;
    await sql`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS remaining_balance NUMERIC(14,2) DEFAULT 0`;
    await sql`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS booking_date TIMESTAMPTZ DEFAULT NOW()`;
    await sql`ALTER TABLE bookings ALTER COLUMN plot_id DROP NOT NULL`;

    await sql`ALTER TABLE payment_ledger ADD COLUMN IF NOT EXISTS plot_number VARCHAR(180)`;
    await sql`ALTER TABLE payment_ledger ADD COLUMN IF NOT EXISTS site_id INTEGER`;
    await sql`ALTER TABLE payment_ledger ALTER COLUMN plot_id DROP NOT NULL`;
  } catch (e) {
    // Non-blocking schema fallback
  }
}
ensureAllocationSchema();

router.get("/admin/plots/validate-availability", adminAuth, async (req, res) => {
  // Always allow manual plot numbers without blocking
  return ok(res, {
    exists: true,
    is_available: true,
    message: "Manual plot entry enabled."
  });
});

router.post("/admin/bookings/allocate-plot", adminAuth, async (req, res) => {
  try {
    const userId = Number(req.body.user_id);
    const siteId = Number(req.body.site_id);
    const plotNumber = String(req.body.plot_number || "").trim();
    const totalPrice = Number(req.body.total_price || 0);
    const initialPayment = Number(req.body.initial_payment_amount || 0);
    const paymentMode = String(req.body.payment_mode || "Cash").trim();
    const paymentRef = String(req.body.payment_reference || "").trim();
    const inquiryId = req.body.inquiry_id ? Number(req.body.inquiry_id) : null;
    const remarks = String(req.body.remarks || "Plot allocated by Admin").trim();

    if (!userId) return fail(res, "Customer selection is required.", 400);
    if (!siteId) return fail(res, "Site selection is required.", 400);
    if (!plotNumber) return fail(res, "Plot number / name is required.", 400);
    if (plotNumber.length > 150) return fail(res, "Plot number exceeds maximum allowed length of 150 characters.", 400);
    if (totalPrice <= 0) return fail(res, "Total plot price must be greater than 0.", 400);
    if (initialPayment < 0) return fail(res, "Initial payment cannot be negative.", 400);
    if (initialPayment > totalPrice) return fail(res, "Initial payment cannot exceed total plot price.", 400);

    const [user] = await sql`SELECT user_id, full_name, mobile_no, email, member_id FROM users WHERE user_id = ${userId}`;
    if (!user) return fail(res, "Selected customer was not found.", 404);

    const [site] = await sql`SELECT site_id, site_name FROM sites WHERE site_id = ${siteId}`;
    if (!site) return fail(res, "Selected site was not found.", 404);

    const result = await sql.begin(async (db) => {
      // Optional: check if matching plot exists in plots table to link plot_id if available
      const cleanNum = plotNumber.replace(/^plot\s*/i, "").trim();
      const [matchedPlot] = await db`
        SELECT plot_id, plot_number, plot_status
        FROM plots
        WHERE site_id = ${siteId}
          AND (
            LOWER(TRIM(plot_number)) = LOWER(TRIM(${plotNumber}))
            OR LOWER(TRIM(plot_number)) = LOWER(TRIM(${cleanNum}))
          )
        LIMIT 1`;

      const matchedPlotId = matchedPlot ? matchedPlot.plot_id : null;

      const [seq] = await db`SELECT nextval('bookings_booking_id_seq') AS booking_id`;
      const bookingId = Number(seq.booking_id);
      const serial = `MMR-${new Date().getFullYear()}-${String(bookingId).padStart(5, "0")}`;

      const isOnlineApproved = paymentMode === "Online" && Boolean(paymentRef);
      const paymentStatus = isOnlineApproved ? "Approved" : "UnderVerification";
      const verificationStatus = isOnlineApproved ? "Verified" : "Pending";
      const approvedPaid = isOnlineApproved ? initialPayment : 0;
      const remainingBalance = Math.max(0, totalPrice - approvedPaid);

      const [booking] = await db`
        INSERT INTO bookings (
          booking_id, booking_serial, user_id, site_id, plot_id, plot_number, payment_type, advance_amount,
          booking_status, workflow_status, payment_method, required_booking_amount,
          remaining_balance, notes, base_price, created_at, updated_at
        ) VALUES (
          ${bookingId}, ${serial}, ${userId}, ${siteId}, ${matchedPlotId}, ${plotNumber}, ${paymentMode}, ${initialPayment},
          ${(isOnlineApproved && remainingBalance === 0) ? 'Confirmed' : 'Allocated'},
          'Plot Allocated by Admin', ${paymentMode}, ${initialPayment},
          ${remainingBalance}, ${remarks}, ${totalPrice}, NOW(), NOW()
        ) RETURNING *`;

      let paymentRecord = null;
      if (initialPayment > 0) {
        const [pSeq] = await db`SELECT COALESCE(MAX(payment_id), 0) + 1 AS pid FROM payment_ledger`;
        const paymentSerial = `PL-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${String(pSeq.pid).padStart(6, '0')}`;

        const [createdPayment] = await db`
          INSERT INTO payment_ledger (
            payment_serial, user_id, booking_id, plot_id, plot_number, site_id,
            payment_mode, payment_purpose, gross_amount, net_allocated_amount,
            payment_date, payment_status, verification_status, utr_number,
            submitted_by_user_id, submitted_by_role, approved_by_admin_id,
            admin_notes, created_at, updated_at
          ) VALUES (
            ${paymentSerial}, ${userId}, ${bookingId}, ${matchedPlotId}, ${plotNumber}, ${siteId},
            ${paymentMode}, 'BookingAdvance', ${initialPayment}, ${initialPayment},
            CURRENT_DATE, ${paymentStatus}, ${verificationStatus}, ${paymentRef || null},
            ${userId}, 'Admin', ${isOnlineApproved ? req.admin.admin_id : null},
            ${remarks}, NOW(), NOW()
          ) RETURNING *`;
        paymentRecord = createdPayment;
      }

      if (matchedPlotId && matchedPlot.plot_status === 'Vacant') {
        await db`UPDATE plots SET plot_status = 'Booked', updated_at = NOW() WHERE plot_id = ${matchedPlotId}`;
      }

      if (inquiryId) {
        await db`
          UPDATE inquiries
          SET status = 'Converted', remarks = ${'Converted to Allocation ' + serial + ' by Admin'}, updated_at = NOW()
          WHERE inquiry_id = ${inquiryId}`;
      }

      if (remainingBalance > 0) {
        await db`
          INSERT INTO notification_log (user_id, title, message, channel, is_read, sent_at)
          VALUES (
            ${userId},
            'Plot Payment Reminder',
            ${'Your plot payment for ' + site.site_name + ', Plot No. ' + plotNumber + ' is pending. Total outstanding amount: ₹' + remainingBalance.toLocaleString('en-IN') + '. Please complete the remaining payment.'},
            'InApp',
            FALSE,
            NOW()
          )`;
      }

      return { booking, payment: paymentRecord, plot_number: plotNumber, site_name: site.site_name };
    });

    return ok(res, result, `Plot '${result.plot_number}' allocated successfully to ${user.full_name}.`, 201);
  } catch (error) {
    return fail(res, error.message, error.status || 400);
  }
});

router.post("/admin/bookings/:id/record-payment", adminAuth, async (req, res) => {
  try {
    const bookingId = Number(req.params.id);
    const receivedAmount = Number(req.body.received_amount || 0);
    const paymentMode = String(req.body.payment_mode || "Cash").trim();
    const paymentRef = String(req.body.payment_reference || "").trim();
    const paymentDate = req.body.payment_date || new Date().toISOString().slice(0, 10);
    const remarks = String(req.body.remarks || "Milestone installment payment").trim();
    const proofUrl = req.body.proof_url || null;

    if (!bookingId) return fail(res, "Booking ID is required.", 400);
    if (receivedAmount <= 0) return fail(res, "Received amount must be greater than 0.", 400);

    const [booking] = await sql`
      SELECT b.*,
             COALESCE(b.plot_number, p.plot_number, 'Plot') AS plot_number,
             COALESCE(b.base_price, p.base_price, 0) AS plot_base_price,
             COALESCE(b.site_id, p.site_id, 0) AS site_id,
             COALESCE(s.site_name, s2.site_name, 'Project Site') AS site_name,
             u.full_name, u.mobile_no
      FROM bookings b
      LEFT JOIN plots p ON p.plot_id = b.plot_id
      LEFT JOIN sites s ON s.site_id = p.site_id
      LEFT JOIN sites s2 ON s2.site_id = b.site_id
      JOIN users u ON u.user_id = b.user_id
      WHERE b.booking_id = ${bookingId}`;

    if (!booking) return fail(res, "Booking not found.", 404);

    const result = await sql.begin(async (db) => {
      const [pSeq] = await db`SELECT COALESCE(MAX(payment_id), 0) + 1 AS pid FROM payment_ledger`;
      const paymentSerial = `PL-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${String(pSeq.pid).padStart(6, '0')}`;

      const paymentStatus = "UnderVerification";
      const verificationStatus = "Pending";

      const [createdPayment] = await db`
        INSERT INTO payment_ledger (
          payment_serial, user_id, booking_id, plot_id, plot_number, site_id,
          payment_mode, payment_purpose, gross_amount, net_allocated_amount,
          payment_date, payment_status, verification_status, utr_number,
          proof_document_url, submitted_by_user_id, submitted_by_role,
          admin_notes, created_at, updated_at
        ) VALUES (
          ${paymentSerial}, ${booking.user_id}, ${bookingId}, ${booking.plot_id || null}, ${booking.plot_number}, ${booking.site_id || null},
          ${paymentMode}, 'PartPayment', ${receivedAmount}, ${receivedAmount},
          ${paymentDate}, ${paymentStatus}, ${verificationStatus}, ${paymentRef || null},
          ${proofUrl}, ${req.admin.admin_id}, 'Admin',
          ${remarks}, NOW(), NOW()
        ) RETURNING *`;

      return createdPayment;
    });

    return ok(res, result, "Milestone payment recorded successfully. Verification is pending.", 201);
  } catch (error) {
    return fail(res, error.message, 400);
  }
});

router.post("/admin/bookings/payments/:paymentId/verify", adminAuth, async (req, res) => {
  try {
    const paymentId = Number(req.params.paymentId);
    const [payment] = await sql`SELECT * FROM payment_ledger WHERE payment_id = ${paymentId}`;
    if (!payment) return fail(res, "Payment record not found.", 404);
    if (payment.payment_status === "Approved") return ok(res, payment, "Payment is already approved.");

    const [booking] = await sql`
      SELECT b.*,
             COALESCE(b.plot_number, p.plot_number, 'Plot') AS plot_number,
             COALESCE(b.base_price, p.base_price, 0) AS plot_base_price,
             COALESCE(s.site_name, s2.site_name, 'Project Site') AS site_name,
             u.full_name, u.mobile_no
      FROM bookings b
      LEFT JOIN plots p ON p.plot_id = b.plot_id
      LEFT JOIN sites s ON s.site_id = p.site_id
      LEFT JOIN sites s2 ON s2.site_id = b.site_id
      JOIN users u ON u.user_id = b.user_id
      WHERE b.booking_id = ${payment.booking_id}`;

    if (!booking) return fail(res, "Associated booking not found.", 404);

    const result = await sql.begin(async (db) => {
      await db`
        UPDATE payment_ledger SET
          payment_status = 'Approved',
          verification_status = 'Verified',
          verified_by_admin_id = ${req.admin.admin_id},
          approved_by_admin_id = ${req.admin.admin_id},
          updated_at = NOW()
        WHERE payment_id = ${paymentId}`;

      let receiptId = payment.receipt_id;
      if (!receiptId) {
        const [rSeq] = await db`SELECT COALESCE(MAX(serial_no), 0) + 1 AS max_seq FROM receipts`;
        const receiptNo = `MMR-REC-${new Date().getFullYear()}-${String(rSeq.max_seq).padStart(5, '0')}`;
        const [rcpt] = await db`
          INSERT INTO receipts (
            receipt_no, serial_no, customer_id, customer_name, mobile_no,
            plot_no, receipt_date, payment_mode, payment_type,
            receipt_amount, paid_amount, payment_ledger_id, created_by
          ) VALUES (
            ${receiptNo}, ${rSeq.max_seq}, ${booking.user_id}, ${booking.full_name}, ${booking.mobile_no},
            ${booking.plot_number}, CURRENT_DATE, ${payment.payment_mode}, ${payment.payment_purpose},
            ${payment.gross_amount}, ${payment.gross_amount}, ${paymentId}, ${req.admin.admin_id}
          ) RETURNING id`;
        receiptId = rcpt.id;
        await db`UPDATE payment_ledger SET receipt_id = ${receiptId} WHERE payment_id = ${paymentId}`;
      }

      const [sumRow] = await db`
        SELECT COALESCE(SUM(gross_amount), 0) AS total_approved
        FROM payment_ledger
        WHERE booking_id = ${booking.booking_id} AND payment_status = 'Approved'`;
      const totalApproved = Number(sumRow?.total_approved || 0);
      const totalPlotPrice = Number(booking.base_price || booking.plot_base_price || 0);
      const newRemainingBalance = Math.max(0, totalPlotPrice - totalApproved);

      const isFullyPaid = newRemainingBalance <= 0;
      await db`
        UPDATE bookings SET
          remaining_balance = ${newRemainingBalance},
          booking_status = ${isFullyPaid ? 'Confirmed' : 'Allocated'},
          workflow_status = ${isFullyPaid ? 'Fully Paid' : 'Partially Paid'},
          updated_at = NOW()
        WHERE booking_id = ${booking.booking_id}`;

      if (isFullyPaid) {
        await db`
          UPDATE notification_log
          SET is_read = TRUE, read_at = NOW()
          WHERE user_id = ${booking.user_id} AND title = 'Plot Payment Reminder' AND is_read = FALSE`;
        await db`
          INSERT INTO notification_log (user_id, title, message, channel, is_read, sent_at)
          VALUES (
            ${booking.user_id},
            'Plot Payment Completed',
            ${'Congratulations! Your plot payment for ' + booking.site_name + ', Plot No. ' + booking.plot_number + ' is now 100% completed.'},
            'InApp',
            FALSE,
            NOW()
          )`;
      } else {
        await db`
          INSERT INTO notification_log (user_id, title, message, channel, is_read, sent_at)
          VALUES (
            ${booking.user_id},
            'Plot Payment Reminder',
            ${'Your plot payment for ' + booking.site_name + ', Plot No. ' + booking.plot_number + ' is pending. Total outstanding amount: ₹' + newRemainingBalance.toLocaleString('en-IN') + '. Please complete the remaining payment.'},
            'InApp',
            FALSE,
            NOW()
          )`;
      }

      return { payment_id: paymentId, total_approved: totalApproved, remaining_balance: newRemainingBalance, is_fully_paid: isFullyPaid };
    });

    return ok(res, result, "Payment approved and verified successfully. Balance updated.");
  } catch (error) {
    return fail(res, error.message, 400);
  }
});

router.get("/admin/plot-inquiries", adminAuth, async (req, res) => {
  try {
    const { search = "", status = "", site_id = "", page = 1, limit = 20 } = req.query;
    const safeLimit = Math.min(Number(limit) || 20, 100);
    const offset = (Math.max(1, Number(page)) - 1) * safeLimit;

    const conds = [];
    if (status && status !== "all") conds.push(sql`i.status = ${String(status)}`);
    if (site_id) conds.push(sql`i.site_id = ${Number(site_id)}`);
    if (search) {
      const q = `%${String(search).trim()}%`;
      conds.push(sql`(
        i.full_name ILIKE ${q} OR
        i.mobile_no ILIKE ${q} OR
        COALESCE(i.email, '') ILIKE ${q} OR
        COALESCE(i.site_name, '') ILIKE ${q} OR
        COALESCE(i.plot_number, '') ILIKE ${q}
      )`);
    }

    let whereSql = sql`TRUE`;
    if (conds.length > 0) {
      whereSql = conds.reduce((acc, curr) => sql`${acc} AND ${curr}`);
    }

    const rows = await sql`
      SELECT i.inquiry_id, i.full_name, i.mobile_no, i.email, i.site_id, i.site_name,
             i.plot_number, i.inquiry_message, i.inquiry_type, i.source_page,
             i.status, i.remarks, i.created_at, i.updated_at,
             u.user_id AS matched_user_id, u.member_id AS matched_member_id,
             u.user_type AS matched_user_type, u.account_status AS matched_account_status
      FROM inquiries i
      LEFT JOIN LATERAL (
        SELECT user_id, member_id, user_type, account_status
        FROM users
        WHERE mobile_no = i.mobile_no OR (i.email IS NOT NULL AND LOWER(email) = LOWER(i.email))
        LIMIT 1
      ) u ON TRUE
      WHERE ${whereSql}
      ORDER BY i.created_at DESC
      LIMIT ${safeLimit} OFFSET ${offset}`;

    const [totalRow] = await sql`
      SELECT COUNT(*)::int AS count FROM inquiries i WHERE ${whereSql}`;

    return ok(res, {
      inquiries: rows,
      total: Number(totalRow?.count || 0),
      page: Number(page),
      limit: safeLimit
    });
  } catch (error) {
    return fail(res, error.message, 400);
  }
});

router.put("/admin/plot-inquiries/:id/status", adminAuth, async (req, res) => {
  try {
    const inquiryId = Number(req.params.id);
    const status = String(req.body.status || "").trim();
    const remarks = req.body.remarks ? String(req.body.remarks).trim() : null;

    const [updated] = await sql`
      UPDATE inquiries SET
        status = COALESCE(${status || null}, status),
        remarks = COALESCE(${remarks}, remarks),
        updated_at = NOW()
      WHERE inquiry_id = ${inquiryId}
      RETURNING *`;

    if (!updated) return fail(res, "Inquiry not found.", 404);
    return ok(res, updated, "Inquiry status updated successfully.");
  } catch (error) {
    return fail(res, error.message, 400);
  }
});

router.post("/admin/bookings/manual", adminAuth, async (req, res) => {
  try {
    const userId = Number(req.body.user_id);
    const plotId = Number(req.body.plot_id);
    if (!userId || !plotId) return fail(res, "user_id and plot_id are required.", 400);
    const validation = await compliance(userId);
    const blocked = complianceFailure(validation);
    if (blocked) return fail(res, blocked[0], 403, blocked[1]);
    const config = await settings();
    const required = money(config.minimum_booking_amount) + money(config.first_emi_amount);
    const result = await sql.begin(async (db) => {
      await db`SELECT pg_advisory_xact_lock(${plotId})`;
      await releaseExpiredLocks(db);
      const [plot] = await db`SELECT * FROM plots WHERE plot_id = ${plotId} FOR UPDATE`;
      if (!plot) throw Object.assign(new Error("Plot not found."), { status: 404 });
      if (plot.plot_status !== "Vacant") throw Object.assign(new Error("Plot is unavailable."), { status: 409 });
      const [seq] = await db`SELECT nextval('bookings_booking_id_seq') AS booking_id`;
      const bookingId = Number(seq.booking_id);
      const serial = `MMR-${new Date().getFullYear()}-${String(bookingId).padStart(5, "0")}`;
      const [booking] = await db`
        INSERT INTO bookings (
          booking_id, booking_serial, user_id, plot_id, payment_type, advance_amount,
          booking_status, workflow_status, payment_method, required_booking_amount,
          minimum_booking_amount, first_emi_amount, remaining_balance, notes
        ) VALUES (
          ${bookingId}, ${serial}, ${userId}, ${plotId}, 'Cheque', ${required},
          'Submitted', 'Manually Assigned - Payment Pending', 'Offline', ${required},
          ${config.minimum_booking_amount}, ${config.first_emi_amount},
          ${Math.max(0, money(plot.base_price) - required)}, ${req.body.notes || "Assigned manually by admin"}
        ) RETURNING *`;
      await db`
        INSERT INTO plot_booking_locks (plot_id, user_id, booking_id, expires_at)
        VALUES (${plotId}, ${userId}, ${bookingId}, NOW() + make_interval(mins => ${Number(config.plot_lock_minutes)}))`;
      await db`UPDATE plots SET plot_status = 'InProcess', updated_at = NOW() WHERE plot_id = ${plotId}`;
      return booking;
    });
    return ok(res, result, "Plot assigned. Payment verification is pending.", 201);
  } catch (error) {
    return fail(res, error.message, error.status || 400);
  }
});

export default router;
