const fs = require('fs');
const path = require('path');

function getFiles(dir, exts, fileList = []) {
  if (!fs.existsSync(dir)) return fileList;
  const files = fs.readdirSync(dir);
  for (const file of files) {
    if (file === 'node_modules' || file === '.git' || file === 'dist' || file.startsWith('.')) continue;
    const filePath = path.join(dir, file);
    if (fs.statSync(filePath).isDirectory()) {
      getFiles(filePath, exts, fileList);
    } else {
      if (exts.some(ext => filePath.endsWith(ext))) {
        fileList.push(filePath);
      }
    }
  }
  return fileList;
}

const tablesToScan = [
"admin_roles","admin_sessions","admin_users","analytics_events","app_auth_settings","associate_payout_requests",
"associate_rank_history","associate_ranks","associate_referral_links","associate_sales_tracker","associate_status_history",
"audit_log","blacklist_registry","book_plot_background_images","book_plot_leads","booking_appointments","booking_invoices",
"booking_payment_proofs","booking_payment_records","booking_workflow_settings","bookings","buyback_applications",
"buyback_terms","categories","cms_content","cms_content_history","commission_engine_audit","commission_engine_levels",
"commission_engine_settings","commission_monthly_schedule","commission_rules","commission_source_events",
"commission_transactions","company_documents","company_settings","customer_enrollment_submissions","customer_nominees",
"database_backup_files","database_backup_settings","database_restore_history","database_restore_uploads","duplicate_alerts",
"email_otp_log","emi_calculator_master","emi_payment_proofs","emi_schedules","home_page_settings","home_sliders",
"inquiries","investor_deposits","investor_documents","investor_enrollments","investor_notifications",
"investor_settlement_preferences","investor_transactions","investor_users","investor_withdrawals","investors",
"invoice_audit_log","invoice_number_sequence","invoice_settings","invoices","mlm_network","mlm_tree_closure",
"mobile_app_settings","notification_log","notification_queue","notification_templates","otp_history","otp_log",
"otp_master","otp_store","payment_gateway_audit_logs","payment_gateway_configs","payment_logs","payment_transactions",
"payment_vouchers","pending_registrations","plot_booking_history","plot_booking_locks","plot_bulk_import_log",
"plot_details_extended","plot_images","plot_polygon_coordinates","plot_polygon_history","plot_status_history",
"plots","products","referral_clicks","referral_registrations","registry_records","report_schedules",
"settlement_change_requests","site_documents","site_landmarks","site_layout_maps","site_photos","sites",
"user_addresses","user_bank_details","user_device_tokens","user_documents","user_kyc_profiles","user_nominees",
"user_wallets","users","wallet_audit_logs","wallet_transactions","whatsapp_message_logs","whatsapp_settings",
"whatsapp_templates","whatsapp_webhook_logs","withdrawal_requests"
];

const backendDir = path.join(__dirname);
const frontendDir = path.join(__dirname, '..', 'mmrconstructions-main');

const backendFiles = getFiles(backendDir, ['.js', '.cjs']);
const frontendFiles = getFiles(frontendDir, ['.ts', '.html']);

let usage = {};
for (const table of tablesToScan) {
  usage[table] = {
    backend: [],
    frontend: [],
    unused: true
  };
}

for (const file of backendFiles) {
  const content = fs.readFileSync(file, 'utf8');
  for (const table of tablesToScan) {
    if (content.includes(table)) {
      usage[table].backend.push(file);
      usage[table].unused = false;
    }
  }
}

for (const file of frontendFiles) {
  const content = fs.readFileSync(file, 'utf8');
  for (const table of tablesToScan) {
    // Some tables might match substring, e.g. "users" matches "investor_users", so regex is safer for exact match
    // But table names in frontend might be used as URL or variable names.
    // Let's do simple include for now to be safe.
    if (content.includes(table)) {
      usage[table].frontend.push(file);
      usage[table].unused = false;
    }
  }
}

fs.writeFileSync('usage_extract.json', JSON.stringify(usage, null, 2));
console.log('Done mapping usages.');
