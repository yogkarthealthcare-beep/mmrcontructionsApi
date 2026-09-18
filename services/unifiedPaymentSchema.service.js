import sql from "../db.js";

/**
 * Unified Payment Schema Service
 * Ensures all unified payment ledger, allocation, cheque, cash collection,
 * and dispute tables exist with appropriate indexes and constraints without disturbing legacy tables.
 */
export async function ensureUnifiedPaymentSchema() {
  try {
    console.log("[UnifiedPaymentSchema] Initializing schema...");

    // 1. Payment Ledger (Master financial record)
    await sql`
      CREATE TABLE IF NOT EXISTS payment_ledger (
        payment_id BIGSERIAL PRIMARY KEY,
        payment_serial VARCHAR(64) UNIQUE NOT NULL,
        user_id BIGINT NOT NULL,
        booking_id BIGINT NOT NULL,
        plot_id BIGINT NOT NULL,
        site_id BIGINT NOT NULL,
        payment_mode VARCHAR(32) NOT NULL, -- 'Online', 'Cash', 'Cheque', 'BankTransfer', 'UPI', 'Wallet'
        payment_purpose VARCHAR(32) NOT NULL DEFAULT 'EmiPayment', -- 'BookingAdvance', 'EmiPayment', 'PartialEmi', 'MultipleEmi', 'LateFee', 'ExcessAdvance', 'FullPayment'
        gross_amount NUMERIC(14,2) NOT NULL,
        late_fee_amount NUMERIC(14,2) NOT NULL DEFAULT 0.00,
        net_allocated_amount NUMERIC(14,2) NOT NULL DEFAULT 0.00,
        excess_unallocated_amount NUMERIC(14,2) NOT NULL DEFAULT 0.00,
        payment_date DATE NOT NULL DEFAULT CURRENT_DATE,
        payment_status VARCHAR(32) NOT NULL DEFAULT 'Submitted', -- 'Initiated','Submitted','UnderVerification','Approved','Rejected','Failed','Cancelled','Reversed','Bounced'
        verification_status VARCHAR(32) NOT NULL DEFAULT 'Pending', -- 'Pending','Verified','Rejected','UnderReview'
        gateway_name VARCHAR(64),
        gateway_order_id VARCHAR(128),
        gateway_payment_id VARCHAR(128),
        gateway_signature VARCHAR(256),
        utr_number VARCHAR(128),
        cheque_id BIGINT,
        cash_collection_id BIGINT,
        proof_document_url TEXT,
        receipt_id BIGINT,
        voucher_id BIGINT,
        submitted_by_user_id BIGINT,
        submitted_by_role VARCHAR(32) DEFAULT 'Customer',
        collector_user_id BIGINT,
        verified_by_admin_id BIGINT,
        approved_by_admin_id BIGINT,
        rejection_reason TEXT,
        admin_notes TEXT,
        legacy_reference VARCHAR(128),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `;

    // Indexes for payment_ledger
    await sql`CREATE INDEX IF NOT EXISTS idx_payment_ledger_booking_id ON payment_ledger(booking_id);`;
    await sql`CREATE INDEX IF NOT EXISTS idx_payment_ledger_plot_id ON payment_ledger(plot_id);`;
    await sql`CREATE INDEX IF NOT EXISTS idx_payment_ledger_user_id ON payment_ledger(user_id);`;
    await sql`CREATE INDEX IF NOT EXISTS idx_payment_ledger_status ON payment_ledger(payment_status);`;
    await sql`CREATE INDEX IF NOT EXISTS idx_payment_ledger_verif_status ON payment_ledger(verification_status);`;
    await sql`CREATE INDEX IF NOT EXISTS idx_payment_ledger_payment_date ON payment_ledger(payment_date);`;
    await sql`CREATE INDEX IF NOT EXISTS idx_payment_ledger_utr ON payment_ledger(utr_number);`;

    // 2. Payment Allocations (Multi-split engine)
    await sql`
      CREATE TABLE IF NOT EXISTS payment_allocations (
        allocation_id BIGSERIAL PRIMARY KEY,
        payment_id BIGINT NOT NULL REFERENCES payment_ledger(payment_id) ON DELETE CASCADE,
        booking_id BIGINT NOT NULL,
        allocation_type VARCHAR(32) NOT NULL, -- 'BookingAdvance', 'EmiInstallment', 'LateFee', 'ExcessAdvance'
        emi_id BIGINT,
        installment_no INTEGER,
        allocated_amount NUMERIC(14,2) NOT NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'Allocated', -- 'Allocated', 'Reversed'
        notes TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `;

    await sql`CREATE INDEX IF NOT EXISTS idx_payment_alloc_payment_id ON payment_allocations(payment_id);`;
    await sql`CREATE INDEX IF NOT EXISTS idx_payment_alloc_emi_id ON payment_allocations(emi_id);`;
    await sql`CREATE INDEX IF NOT EXISTS idx_payment_alloc_booking_id ON payment_allocations(booking_id);`;

    // 3. Cheque Registry (Cheque lifecycle tracking)
    await sql`
      CREATE TABLE IF NOT EXISTS cheque_registry (
        cheque_id BIGSERIAL PRIMARY KEY,
        cheque_number VARCHAR(64) NOT NULL,
        bank_name VARCHAR(128) NOT NULL,
        branch_name VARCHAR(128),
        cheque_date DATE NOT NULL,
        cheque_amount NUMERIC(14,2) NOT NULL,
        customer_id BIGINT NOT NULL,
        booking_id BIGINT NOT NULL,
        plot_id BIGINT,
        cheque_image_url TEXT,
        cheque_status VARCHAR(32) NOT NULL DEFAULT 'ChequeReceived', -- 'ChequeReceived','Deposited','UnderClearing','Cleared','Bounced','Cancelled'
        deposited_date DATE,
        cleared_date DATE,
        bounced_date DATE,
        bounce_reason TEXT,
        bounce_penalty_amount NUMERIC(14,2) NOT NULL DEFAULT 0.00,
        deposited_bank_account VARCHAR(128),
        received_by_user_id BIGINT,
        verified_by_admin_id BIGINT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `;

    await sql`CREATE INDEX IF NOT EXISTS idx_cheque_reg_booking_id ON cheque_registry(booking_id);`;
    await sql`CREATE INDEX IF NOT EXISTS idx_cheque_reg_customer_id ON cheque_registry(customer_id);`;
    await sql`CREATE INDEX IF NOT EXISTS idx_cheque_reg_status ON cheque_registry(cheque_status);`;
    await sql`CREATE INDEX IF NOT EXISTS idx_cheque_reg_number ON cheque_registry(cheque_number);`;

    // 4. Cash Collections Register (Field/Office collection audit with segregation of duties)
    await sql`
      CREATE TABLE IF NOT EXISTS cash_collections (
        collection_id BIGSERIAL PRIMARY KEY,
        collection_serial VARCHAR(64) UNIQUE NOT NULL,
        collector_user_id BIGINT NOT NULL,
        customer_id BIGINT NOT NULL,
        booking_id BIGINT NOT NULL,
        plot_id BIGINT NOT NULL,
        amount NUMERIC(14,2) NOT NULL,
        collection_date DATE NOT NULL DEFAULT CURRENT_DATE,
        site_location VARCHAR(255),
        cash_denomination JSONB,
        deposit_to_bank_date DATE,
        deposit_slip_url TEXT,
        verification_status VARCHAR(32) NOT NULL DEFAULT 'PendingVerification', -- 'PendingVerification','Verified','Rejected'
        approved_by_admin_id BIGINT,
        rejection_reason TEXT,
        remarks TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `;

    await sql`CREATE INDEX IF NOT EXISTS idx_cash_coll_collector ON cash_collections(collector_user_id);`;
    await sql`CREATE INDEX IF NOT EXISTS idx_cash_coll_customer ON cash_collections(customer_id);`;
    await sql`CREATE INDEX IF NOT EXISTS idx_cash_coll_booking ON cash_collections(booking_id);`;
    await sql`CREATE INDEX IF NOT EXISTS idx_cash_coll_status ON cash_collections(verification_status);`;

    // 5. Missing Payment Complaints (Dispute resolution desk)
    await sql`
      CREATE TABLE IF NOT EXISTS missing_payment_complaints (
        complaint_id BIGSERIAL PRIMARY KEY,
        complaint_serial VARCHAR(64) UNIQUE NOT NULL,
        user_id BIGINT NOT NULL,
        booking_id BIGINT NOT NULL,
        plot_id BIGINT NOT NULL,
        claimed_amount NUMERIC(14,2) NOT NULL,
        claimed_payment_date DATE NOT NULL,
        claimed_payment_mode VARCHAR(32) NOT NULL,
        claimed_utr_number VARCHAR(128),
        claimed_cheque_number VARCHAR(64),
        claimed_receipt_no VARCHAR(100),
        claimed_collector_name VARCHAR(128),
        proof_document_url TEXT,
        complaint_status VARCHAR(32) NOT NULL DEFAULT 'Submitted', -- 'Submitted','UnderInvestigation','ApprovedAndLinked','Rejected','DuplicateClaim'
        investigation_notes TEXT,
        resolved_by_admin_id BIGINT,
        resolved_at TIMESTAMPTZ,
        linked_payment_id BIGINT REFERENCES payment_ledger(payment_id),
        remarks TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `;

    await sql`CREATE INDEX IF NOT EXISTS idx_missing_pay_user ON missing_payment_complaints(user_id);`;
    await sql`CREATE INDEX IF NOT EXISTS idx_missing_pay_booking ON missing_payment_complaints(booking_id);`;
    await sql`CREATE INDEX IF NOT EXISTS idx_missing_pay_status ON missing_payment_complaints(complaint_status);`;

    // 6. Payment Reconciliation Logs
    await sql`
      CREATE TABLE IF NOT EXISTS payment_reconciliation_logs (
        reconciliation_id BIGSERIAL PRIMARY KEY,
        reconciliation_date DATE NOT NULL DEFAULT CURRENT_DATE,
        reconciled_by_admin_id BIGINT,
        total_gateway_amount NUMERIC(14,2) DEFAULT 0.00,
        total_ledger_amount NUMERIC(14,2) DEFAULT 0.00,
        discrepancy_count INTEGER DEFAULT 0,
        discrepancy_details JSONB,
        status VARCHAR(32) DEFAULT 'Completed',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `;

    // 7. Non-destructive alterations to existing tables
    // Add partially_paid_amount to emi_schedules
    try {
      await sql`
        ALTER TABLE emi_schedules 
        ADD COLUMN IF NOT EXISTS partially_paid_amount NUMERIC(14,2) DEFAULT 0.00;
      `;
    } catch (e) {
      console.log("[UnifiedPaymentSchema] emi_schedules column partially_paid_amount check:", e.message);
    }

    // Add unallocated_advance_balance to bookings
    try {
      await sql`
        ALTER TABLE bookings 
        ADD COLUMN IF NOT EXISTS unallocated_advance_balance NUMERIC(14,2) DEFAULT 0.00;
      `;
    } catch (e) {
      console.log("[UnifiedPaymentSchema] bookings column unallocated_advance_balance check:", e.message);
    }

    // Add payment_ledger_id to receipts
    try {
      await sql`
        ALTER TABLE receipts 
        ADD COLUMN IF NOT EXISTS payment_ledger_id BIGINT;
      `;
    } catch (e) {
      console.log("[UnifiedPaymentSchema] receipts column payment_ledger_id check:", e.message);
    }

    // Add payment_ledger_id to payment_vouchers
    try {
      await sql`
        ALTER TABLE payment_vouchers 
        ADD COLUMN IF NOT EXISTS payment_ledger_id BIGINT;
      `;
    } catch (e) {
      console.log("[UnifiedPaymentSchema] payment_vouchers column payment_ledger_id check:", e.message);
    }

    console.log("[UnifiedPaymentSchema] Schema verification completed successfully.");
    return true;
  } catch (err) {
    console.error("[UnifiedPaymentSchema] Error during schema verification:", err);
    throw err;
  }
}
