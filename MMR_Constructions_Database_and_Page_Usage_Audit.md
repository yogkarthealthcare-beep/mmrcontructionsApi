# MMR Constructions – Complete Database Table & Page Usage Audit

## 1. Executive Summary & Database Overview

| Metric | Count |
|--------|-------|
| Total Tables | 113 |
| Confirmed Used | 113 |
| No Reference Found | 0 |

> [!NOTE]
> Row counts are unavailable as the local database connection was refused. Table schemas were extracted directly from the backend node scripts and SQL statements.

## Table Structure Details & Usage (Parts 1, 2, & 4)

### `admin_roles`
**Columns:**
```sql
role_id SERIAL PRIMARY KEY
role_name TEXT UNIQUE NOT NULL
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`
role_id SERIAL PRIMARY KEY
role_name TEXT UNIQUE NOT NULL
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `
role_id SERIAL PRIMARY KEY
role_name TEXT UNIQUE NOT NULL
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `
```

**Usage:**
* **Backend References:** Confirmed in 8 files.
  * *Examples:* createAdmin.js, diagnose_cashfree_config.js, set_custom_admin_password.js, smoke_test_live_dashboards.js, test_impersonation.js, ...

---
### `admin_sessions`
**Columns:**
```sql
session_id SERIAL PRIMARY KEY
admin_id INTEGER NOT NULL REFERENCES admin_users(admin_id)
session_token TEXT NOT NULL
ip_address TEXT
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`
session_id SERIAL PRIMARY KEY
admin_id INTEGER NOT NULL REFERENCES admin_users(admin_id)
session_token TEXT NOT NULL
ip_address TEXT
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `
```

**Usage:**
* **Backend References:** Confirmed in 4 files.
  * *Examples:* createAdmin.js, verify_or_create_admin_tables.js, server.js, usage_scanner.cjs

---
### `admin_users`
**Columns:**
```sql
admin_id SERIAL PRIMARY KEY
role_id INTEGER NOT NULL REFERENCES admin_roles(role_id)
full_name TEXT NOT NULL
email TEXT UNIQUE NOT NULL
password_hash TEXT NOT NULL
is_active BOOLEAN NOT NULL DEFAULT TRUE
is_locked BOOLEAN NOT NULL DEFAULT FALSE
failed_login_attempts INTEGER NOT NULL DEFAULT 0
last_login_at TIMESTAMPTZ
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`
admin_id SERIAL PRIMARY KEY
role_id INTEGER NOT NULL REFERENCES admin_roles(role_id)
full_name TEXT NOT NULL
email TEXT UNIQUE NOT NULL
password_hash TEXT NOT NULL
is_active BOOLEAN NOT NULL DEFAULT TRUE
is_locked BOOLEAN NOT NULL DEFAULT FALSE
failed_login_attempts INTEGER NOT NULL DEFAULT 0
last_login_at TIMESTAMPTZ
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `
admin_id SERIAL PRIMARY KEY
role_id INTEGER NOT NULL REFERENCES admin_roles(role_id)
full_name TEXT NOT NULL
email TEXT UNIQUE NOT NULL
password_hash TEXT NOT NULL
is_active BOOLEAN NOT NULL DEFAULT TRUE
is_locked BOOLEAN NOT NULL DEFAULT FALSE
failed_login_attempts INTEGER NOT NULL DEFAULT 0
last_login_at TIMESTAMPTZ
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `
```

**Usage:**
* **Backend References:** Confirmed in 17 files.
  * *Examples:* newRoutes.js, payment.routes.js, check_admin_accounts.js, createAdmin.js, createMlmTables.js, ...

---
### `analytics_events`
**Columns:**
```sql
event_id BIGSERIAL PRIMARY KEY
event_name VARCHAR(60) NOT NULL
page_url TEXT
page_title VARCHAR(255)
site_id INTEGER
plot_id INTEGER
user_id INTEGER
visitor_id VARCHAR(100)
session_id VARCHAR(100)
device_type VARCHAR(30)
browser VARCHAR(60)
os VARCHAR(60)
city VARCHAR(100)
state VARCHAR(100)
country VARCHAR(100)
referrer TEXT
utm_source VARCHAR(100)
search_term VARCHAR(255)
response_time_ms INTEGER
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

**Usage:**
* **Backend References:** Confirmed in 2 files.
  * *Examples:* server.js, usage_scanner.cjs

---
### `app_auth_settings`
**Columns:**
```sql
id SERIAL PRIMARY KEY
email_otp_enabled BOOLEAN NOT NULL DEFAULT TRUE
whatsapp_otp_enabled BOOLEAN NOT NULL DEFAULT FALSE
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

**Usage:**
* **Backend References:** Confirmed in 2 files.
  * *Examples:* server.js, usage_scanner.cjs

---
### `associate_payout_requests`
**Columns:**
```sql
payout_id SERIAL PRIMARY KEY
associate_user_id INTEGER NOT NULL
requested_amount NUMERIC(14,2) NOT NULL DEFAULT 0
approved_amount NUMERIC(14,2)
status VARCHAR(30) NOT NULL DEFAULT 'Requested'
payment_reference TEXT
admin_note TEXT
reviewed_by_admin_id INTEGER
requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
reviewed_at TIMESTAMPTZ
paid_at TIMESTAMPTZ
payout_id SERIAL PRIMARY KEY
associate_user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE
requested_amount NUMERIC(14,2) NOT NULL DEFAULT 0
approved_amount NUMERIC(14,2)
status VARCHAR(30) NOT NULL DEFAULT 'Requested'
payment_reference TEXT
admin_note TEXT
reviewed_by_admin_id INTEGER
requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
reviewed_at TIMESTAMPTZ
paid_at TIMESTAMPTZ
```

**Usage:**
* **Backend References:** Confirmed in 3 files.
  * *Examples:* createMlmTables.js, server.js, usage_scanner.cjs

---
### `associate_rank_history`
**Columns:**
```sql
id SERIAL PRIMARY KEY
associate_user_id INTEGER NOT NULL
old_rank_id INTEGER
new_rank_id INTEGER
changed_reason TEXT
changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
id SERIAL PRIMARY KEY
associate_user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE
old_rank_id INTEGER REFERENCES associate_ranks(rank_id)
new_rank_id INTEGER REFERENCES associate_ranks(rank_id)
changed_reason TEXT
changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

**Usage:**
* **Backend References:** Confirmed in 4 files.
  * *Examples:* createMlmTables.js, wipe_database_test_data.js, server.js, usage_scanner.cjs

---
### `associate_ranks`
**Columns:**
```sql
rank_id SERIAL PRIMARY KEY
rank_name VARCHAR(80) NOT NULL UNIQUE
min_direct_sales_gaj NUMERIC(12,2) NOT NULL DEFAULT 0
min_total_network_sales_gaj NUMERIC(12,2) NOT NULL DEFAULT 0
commission_multiplier NUMERIC(8,2) NOT NULL DEFAULT 1
is_active BOOLEAN NOT NULL DEFAULT TRUE
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
rank_id SERIAL PRIMARY KEY
rank_name VARCHAR(80) NOT NULL UNIQUE
min_direct_sales_gaj NUMERIC(12,2) NOT NULL DEFAULT 0
min_total_network_sales_gaj NUMERIC(12,2) NOT NULL DEFAULT 0
commission_multiplier NUMERIC(8,2) NOT NULL DEFAULT 1
is_active BOOLEAN NOT NULL DEFAULT TRUE
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

**Usage:**
* **Backend References:** Confirmed in 3 files.
  * *Examples:* createMlmTables.js, server.js, usage_scanner.cjs

---
### `associate_referral_links`
**Columns:**
```sql
id SERIAL PRIMARY KEY
associate_user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE
invite_code VARCHAR(80) NOT NULL UNIQUE
referral_url TEXT
total_clicks INTEGER NOT NULL DEFAULT 0
total_registrations INTEGER NOT NULL DEFAULT 0
is_active BOOLEAN NOT NULL DEFAULT TRUE
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
id SERIAL PRIMARY KEY
associate_user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE
invite_code VARCHAR(80) NOT NULL UNIQUE
referral_url TEXT
total_clicks INTEGER NOT NULL DEFAULT 0
total_registrations INTEGER NOT NULL DEFAULT 0
is_active BOOLEAN NOT NULL DEFAULT TRUE
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
id SERIAL PRIMARY KEY
associate_user_id INTEGER NOT NULL
invite_code VARCHAR(80) NOT NULL UNIQUE
referral_url TEXT
total_clicks INTEGER NOT NULL DEFAULT 0
total_registrations INTEGER NOT NULL DEFAULT 0
is_active BOOLEAN NOT NULL DEFAULT TRUE
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
id SERIAL PRIMARY KEY
associate_user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE
invite_code VARCHAR(80) NOT NULL UNIQUE
referral_url TEXT
total_clicks INTEGER NOT NULL DEFAULT 0
total_registrations INTEGER NOT NULL DEFAULT 0
is_active BOOLEAN NOT NULL DEFAULT TRUE
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

**Usage:**
* **Backend References:** Confirmed in 5 files.
  * *Examples:* authEmailRoutes.js, createMlmTables.js, seed_default_associate.js, server.js, usage_scanner.cjs

---
### `associate_sales_tracker`
**Columns:**
```sql
[ALTER] current_rank_id INTEGER
[ALTER] updated_at TIMESTAMPTZ DEFAULT NOW()
```

**Usage:**
* **Backend References:** Confirmed in 6 files.
  * *Examples:* createMlmTables.js, fix_mlm_trigger_function.js, test_queries.js, wipe_database_test_data.js, server.js, ...

---
### `associate_status_history`
**Columns:**
```sql
id SERIAL PRIMARY KEY
associate_user_id INTEGER NOT NULL
old_status VARCHAR(40)
new_status VARCHAR(40) NOT NULL
reason TEXT
duration_days INTEGER
changed_by_admin_id INTEGER
changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
id SERIAL PRIMARY KEY
associate_user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE
old_status VARCHAR(40)
new_status VARCHAR(40) NOT NULL
reason TEXT
duration_days INTEGER
changed_by_admin_id INTEGER
changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

**Usage:**
* **Backend References:** Confirmed in 3 files.
  * *Examples:* createMlmTables.js, server.js, usage_scanner.cjs

---
### `audit_log`
**Columns:**
```sql
id SERIAL PRIMARY KEY
actor_type VARCHAR(50)
actor_id INTEGER
actor_name VARCHAR(150)
module VARCHAR(50)
action VARCHAR(100)
target_table VARCHAR(50)
target_record_id INTEGER
created_at TIMESTAMPTZ DEFAULT NOW()
```

**Usage:**
* **Backend References:** Confirmed in 16 files.
  * *Examples:* authEmailRoutes.js, database-backup.routes.js, invoice-module.routes.js, payment.routes.js, wallet.routes.js, ...

---
### `blacklist_registry`
*Schema definition not found in code.* (Possibly created externally or via dynamic ORM not captured in text search).

**Usage:**
* **Backend References:** Confirmed in 2 files.
  * *Examples:* server.js, usage_scanner.cjs

---
### `book_plot_background_images`
**Columns:**
```sql
id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY
image_url TEXT NOT NULL
image_public_id TEXT
alt_text VARCHAR(180)
display_order INTEGER NOT NULL DEFAULT 0
is_active BOOLEAN NOT NULL DEFAULT TRUE
is_deleted BOOLEAN NOT NULL DEFAULT FALSE
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

**Usage:**
* **Backend References:** Confirmed in 2 files.
  * *Examples:* server.js, usage_scanner.cjs

---
### `book_plot_leads`
**Columns:**
```sql
id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY
inquiry_number VARCHAR(32) UNIQUE
full_name VARCHAR(160) NOT NULL
contact_number VARCHAR(15) NOT NULL
site_id INTEGER REFERENCES sites(site_id) ON DELETE SET NULL
custom_site_name VARCHAR(180)
user_id INTEGER REFERENCES users(user_id) ON DELETE SET NULL
status VARCHAR(20) NOT NULL DEFAULT 'New'
            CHECK (status IN ('New', 'Contacted', 'Follow Up', 'Converted', 'Closed'))
is_active BOOLEAN NOT NULL DEFAULT TRUE
is_deleted BOOLEAN NOT NULL DEFAULT FALSE
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

**Usage:**
* **Backend References:** Confirmed in 3 files.
  * *Examples:* wipe_database_test_data.js, server.js, usage_scanner.cjs

---
### `booking_appointments`
**Columns:**
```sql
appointment_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY
booking_id INTEGER NOT NULL UNIQUE REFERENCES bookings(booking_id) ON DELETE CASCADE
user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE
appointment_date DATE NOT NULL
start_time TIME NOT NULL
end_time TIME NOT NULL
status VARCHAR(30) NOT NULL DEFAULT 'Scheduled'
        CHECK (status IN ('Scheduled','Rescheduled','Completed','Cancelled','Rejected'))
payment_mode VARCHAR(30) NOT NULL DEFAULT 'Office Visit'
reference_no VARCHAR(180)
admin_remarks TEXT
rescheduled_by_admin_id INTEGER REFERENCES admin_users(admin_id)
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

**Usage:**
* **Backend References:** Confirmed in 5 files.
  * *Examples:* booking-workflow.routes.js, create_booking_workflow_tables.js, test_booking_workflow_schema.js, server.js, usage_scanner.cjs

---
### `booking_invoices`
**Columns:**
```sql
invoice_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY
invoice_number VARCHAR(80) NOT NULL UNIQUE
booking_id INTEGER NOT NULL UNIQUE REFERENCES bookings(booking_id) ON DELETE CASCADE
user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE
payment_id BIGINT REFERENCES booking_payment_records(payment_id)
invoice_data JSONB NOT NULL DEFAULT '{}'::jsonb
generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

**Usage:**
* **Backend References:** Confirmed in 6 files.
  * *Examples:* booking-workflow.routes.js, invoice-module.routes.js, create_booking_workflow_tables.js, test_booking_workflow_schema.js, wipe_database_test_data.js, ...

---
### `booking_payment_proofs`
*Schema definition not found in code.* (Possibly created externally or via dynamic ORM not captured in text search).

**Usage:**
* **Backend References:** Confirmed in 2 files.
  * *Examples:* server.js, usage_scanner.cjs

---
### `booking_payment_records`
**Columns:**
```sql
payment_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY
booking_id INTEGER NOT NULL REFERENCES bookings(booking_id) ON DELETE CASCADE
user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE
payment_method VARCHAR(20) NOT NULL CHECK (payment_method IN ('Online','Offline'))
gateway_name VARCHAR(40)
amount NUMERIC(14,2) NOT NULL CHECK (amount > 0)
status VARCHAR(30) NOT NULL DEFAULT 'Pending'
        CHECK (status IN ('Pending','Verification Pending','Paid','Rejected','Refunded'))
order_id VARCHAR(180)
gateway_order_id VARCHAR(180)
gateway_payment_id VARCHAR(180)
gateway_signature TEXT
reference_no VARCHAR(180)
remarks TEXT
raw_response JSONB NOT NULL DEFAULT '{}'::jsonb
verified_by_admin_id INTEGER REFERENCES admin_users(admin_id)
verified_at TIMESTAMPTZ
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

**Usage:**
* **Backend References:** Confirmed in 8 files.
  * *Examples:* booking-workflow.routes.js, invoice-module.routes.js, create_booking_workflow_tables.js, create_invoice_module_tables.js, test_booking_workflow_schema.js, ...

---
### `booking_workflow_settings`
**Columns:**
```sql
id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1)
minimum_booking_amount NUMERIC(14,2) NOT NULL DEFAULT 50000
first_emi_amount NUMERIC(14,2) NOT NULL DEFAULT 10000
booking_formula VARCHAR(80) NOT NULL DEFAULT 'minimum_booking_amount + first_emi_amount'
plot_lock_minutes INTEGER NOT NULL DEFAULT 20 CHECK (plot_lock_minutes BETWEEN 5 AND 1440)
appointment_days_ahead INTEGER NOT NULL DEFAULT 14 CHECK (appointment_days_ahead BETWEEN 1 AND 90)
appointment_slot_minutes INTEGER NOT NULL DEFAULT 30 CHECK (appointment_slot_minutes BETWEEN 15 AND 240)
office_open_time TIME NOT NULL DEFAULT '10:00'
office_close_time TIME NOT NULL DEFAULT '17:00'
company_name VARCHAR(180) NOT NULL DEFAULT 'MMR Constructions & Developers Pvt. Ltd.'
company_address TEXT
company_phone VARCHAR(30)
company_email VARCHAR(180)
updated_by_admin_id INTEGER REFERENCES admin_users(admin_id)
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

**Usage:**
* **Backend References:** Confirmed in 4 files.
  * *Examples:* booking-workflow.routes.js, create_booking_workflow_tables.js, test_booking_workflow_schema.js, usage_scanner.cjs

---
### `bookings`
**Columns:**
```sql
[ALTER] workflow_status VARCHAR(50) NOT NULL DEFAULT 'Booking Initiated'
[ALTER] payment_method VARCHAR(20)
[ALTER] required_booking_amount NUMERIC(14,2)
[ALTER] minimum_booking_amount NUMERIC(14,2)
[ALTER] first_emi_amount NUMERIC(14,2)
[ALTER] remaining_balance NUMERIC(14,2)
[ALTER] payment_order_id VARCHAR(180)
[ALTER] payment_reference_id VARCHAR(180)
[ALTER] payment_received_at TIMESTAMPTZ
```

**Usage:**
* **Backend References:** Confirmed in 14 files.
  * *Examples:* booking-workflow.routes.js, invoice-module.routes.js, createMlmTables.js, create_booking_workflow_tables.js, create_commission_engine_tables.js, ...
* **Frontend References:** Confirmed in 18 files.
  * *Examples:* booking-management.component.ts, booking-report.component.html, booking-report.component.ts, booking-workflow.component.html, dashboard.component.html, ...

---
### `buyback_applications`
*Schema definition not found in code.* (Possibly created externally or via dynamic ORM not captured in text search).

**Usage:**
* **Backend References:** Confirmed in 4 files.
  * *Examples:* invoice-module.routes.js, wipe_database_test_data.js, server.js, usage_scanner.cjs

---
### `buyback_terms`
**Columns:**
```sql
id SERIAL PRIMARY KEY
title TEXT NOT NULL
summary TEXT
content TEXT NOT NULL
updated_by_admin_id INTEGER
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
id SERIAL PRIMARY KEY
title TEXT NOT NULL
summary TEXT
content TEXT NOT NULL
updated_by_admin_id INTEGER
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

**Usage:**
* **Backend References:** Confirmed in 3 files.
  * *Examples:* update_buyback_terms_from_offer.js, server.js, usage_scanner.cjs

---
### `categories`
*Schema definition not found in code.* (Possibly created externally or via dynamic ORM not captured in text search).

**Usage:**
* **Backend References:** Confirmed in 1 files.
  * *Examples:* usage_scanner.cjs

---
### `cms_content`
*Schema definition not found in code.* (Possibly created externally or via dynamic ORM not captured in text search).

**Usage:**
* **Backend References:** Confirmed in 1 files.
  * *Examples:* usage_scanner.cjs

---
### `cms_content_history`
*Schema definition not found in code.* (Possibly created externally or via dynamic ORM not captured in text search).

**Usage:**
* **Backend References:** Confirmed in 1 files.
  * *Examples:* usage_scanner.cjs

---
### `commission_engine_audit`
**Columns:**
```sql
audit_id BIGSERIAL PRIMARY KEY
settings_id SMALLINT NOT NULL
old_value JSONB NOT NULL
new_value JSONB NOT NULL
changed_by_admin_id INTEGER
reason TEXT NOT NULL
changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
audit_id BIGSERIAL PRIMARY KEY
settings_id SMALLINT NOT NULL
old_value JSONB NOT NULL
new_value JSONB NOT NULL
changed_by_admin_id INTEGER
reason TEXT NOT NULL
changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

**Usage:**
* **Backend References:** Confirmed in 4 files.
  * *Examples:* create_commission_engine_tables.js, verify_commission_engine.js, server.js, usage_scanner.cjs

---
### `commission_engine_levels`
**Columns:**
```sql
id BIGSERIAL PRIMARY KEY
settings_id SMALLINT NOT NULL DEFAULT 1 REFERENCES commission_engine_settings(id) ON DELETE CASCADE
commission_model TEXT NOT NULL CHECK (commission_model IN ('Upline', 'LevelWise', 'EqualDistribution'))
level_no INTEGER NOT NULL CHECK (level_no BETWEEN 1 AND 50)
percentage NUMERIC(8,4) NOT NULL CHECK (percentage BETWEEN 0 AND 100)
is_active BOOLEAN NOT NULL DEFAULT TRUE
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
UNIQUE (settings_id, commission_model, level_no)
id BIGSERIAL PRIMARY KEY
settings_id SMALLINT NOT NULL DEFAULT 1 REFERENCES commission_engine_settings(id) ON DELETE CASCADE
commission_model TEXT NOT NULL CHECK (commission_model IN ('Upline', 'LevelWise', 'EqualDistribution'))
level_no INTEGER NOT NULL CHECK (level_no BETWEEN 1 AND 50)
percentage NUMERIC(8,4) NOT NULL CHECK (percentage BETWEEN 0 AND 100)
is_active BOOLEAN NOT NULL DEFAULT TRUE
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
UNIQUE (settings_id, commission_model, level_no)
```

**Usage:**
* **Backend References:** Confirmed in 5 files.
  * *Examples:* booking-workflow.routes.js, create_commission_engine_tables.js, verify_commission_engine.js, server.js, usage_scanner.cjs

---
### `commission_engine_settings`
**Columns:**
```sql
id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1)
commission_model TEXT NOT NULL DEFAULT 'Upline'
        CHECK (commission_model IN ('Upline', 'LevelWise', 'EqualDistribution'))
maximum_levels INTEGER NOT NULL DEFAULT 3 CHECK (maximum_levels BETWEEN 1 AND 50)
direct_percentage NUMERIC(8,4) NOT NULL DEFAULT 10 CHECK (direct_percentage BETWEEN 0 AND 100)
upline_percentage NUMERIC(8,4) NOT NULL DEFAULT 2 CHECK (upline_percentage BETWEEN 0 AND 100)
seller_percentage NUMERIC(8,4) NOT NULL DEFAULT 50 CHECK (seller_percentage BETWEEN 0 AND 100)
equal_distribution_percentage NUMERIC(8,4) NOT NULL DEFAULT 50 CHECK (equal_distribution_percentage BETWEEN 0 AND 100)
equal_distribution_enabled BOOLEAN NOT NULL DEFAULT TRUE
distribution_scope TEXT NOT NULL DEFAULT 'TopAssociateNetwork'
payment_mode_rules JSONB NOT NULL DEFAULT '{"full_payment":"instant","emi":"installment_wise"}'::jsonb
eligibility_rules JSONB NOT NULL DEFAULT '{"require_active_associate":true,"exclude_blacklisted":true,"minimum_plot_amount":0,"minimum_payment_amount":0}'::jsonb
bonus_rules JSONB NOT NULL DEFAULT '{}'::jsonb
is_active BOOLEAN NOT NULL DEFAULT TRUE
version INTEGER NOT NULL DEFAULT 1
created_by_admin_id INTEGER
updated_by_admin_id INTEGER
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
[ALTER] seller_percentage NUMERIC(8,4) NOT NULL DEFAULT 50
[ALTER] equal_distribution_percentage NUMERIC(8,4) NOT NULL DEFAULT 50
[ALTER] equal_distribution_enabled BOOLEAN NOT NULL DEFAULT TRUE
[ALTER] distribution_scope TEXT NOT NULL DEFAULT 'TopAssociateNetwork'
[ALTER] payment_mode_rules JSONB NOT NULL DEFAULT '{"full_payment":"instant","emi":"installment_wise"}'::jsonb
id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1)
commission_model TEXT NOT NULL DEFAULT 'Upline'
              CHECK (commission_model IN ('Upline', 'LevelWise', 'EqualDistribution'))
maximum_levels INTEGER NOT NULL DEFAULT 3 CHECK (maximum_levels BETWEEN 1 AND 50)
direct_percentage NUMERIC(8,4) NOT NULL DEFAULT 10 CHECK (direct_percentage BETWEEN 0 AND 100)
upline_percentage NUMERIC(8,4) NOT NULL DEFAULT 2 CHECK (upline_percentage BETWEEN 0 AND 100)
seller_percentage NUMERIC(8,4) NOT NULL DEFAULT 50 CHECK (seller_percentage BETWEEN 0 AND 100)
equal_distribution_percentage NUMERIC(8,4) NOT NULL DEFAULT 50 CHECK (equal_distribution_percentage BETWEEN 0 AND 100)
equal_distribution_enabled BOOLEAN NOT NULL DEFAULT TRUE
distribution_scope TEXT NOT NULL DEFAULT 'TopAssociateNetwork'
payment_mode_rules JSONB NOT NULL DEFAULT '{"full_payment":"instant","emi":"installment_wise"}'::jsonb
eligibility_rules JSONB NOT NULL DEFAULT '{"require_active_associate":true,"exclude_blacklisted":true,"minimum_plot_amount":0,"minimum_payment_amount":0}'::jsonb
bonus_rules JSONB NOT NULL DEFAULT '{}'::jsonb
is_active BOOLEAN NOT NULL DEFAULT TRUE
version INTEGER NOT NULL DEFAULT 1
created_by_admin_id INTEGER
updated_by_admin_id INTEGER
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
[ALTER] seller_percentage NUMERIC(8,4) NOT NULL DEFAULT 50
[ALTER] equal_distribution_percentage NUMERIC(8,4) NOT NULL DEFAULT 50
[ALTER] equal_distribution_enabled BOOLEAN NOT NULL DEFAULT TRUE
[ALTER] distribution_scope TEXT NOT NULL DEFAULT 'TopAssociateNetwork'
[ALTER] payment_mode_rules JSONB NOT NULL DEFAULT '{"full_payment":"instant","emi":"installment_wise"}'::jsonb
```

**Usage:**
* **Backend References:** Confirmed in 5 files.
  * *Examples:* booking-workflow.routes.js, create_commission_engine_tables.js, verify_commission_engine.js, server.js, usage_scanner.cjs

---
### `commission_monthly_schedule`
**Columns:**
```sql
schedule_id SERIAL PRIMARY KEY
commission_id INTEGER
associate_user_id INTEGER NOT NULL
booking_id INTEGER
month_no INTEGER NOT NULL
due_month DATE NOT NULL
amount NUMERIC(14,2) NOT NULL DEFAULT 0
status VARCHAR(30) NOT NULL DEFAULT 'Pending'
paid_at TIMESTAMPTZ
payment_reference TEXT
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
UNIQUE (commission_id, month_no)
schedule_id SERIAL PRIMARY KEY
commission_id INTEGER REFERENCES commission_transactions(commission_id) ON DELETE CASCADE
associate_user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE
booking_id INTEGER REFERENCES bookings(booking_id) ON DELETE CASCADE
month_no INTEGER NOT NULL
due_month DATE NOT NULL
amount NUMERIC(14,2) NOT NULL DEFAULT 0
status VARCHAR(30) NOT NULL DEFAULT 'Pending'
paid_at TIMESTAMPTZ
payment_reference TEXT
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
UNIQUE (commission_id, month_no)
```

**Usage:**
* **Backend References:** Confirmed in 3 files.
  * *Examples:* createMlmTables.js, server.js, usage_scanner.cjs

---
### `commission_rules`
**Columns:**
```sql
rule_id SERIAL PRIMARY KEY
commission_type VARCHAR(30) NOT NULL
level_depth INTEGER NOT NULL DEFAULT 1
plot_area_unit VARCHAR(30) NOT NULL DEFAULT 'gaj'
amount_per_100_gaj NUMERIC(14,2) NOT NULL DEFAULT 0
duration_months INTEGER NOT NULL DEFAULT 144
is_active BOOLEAN NOT NULL DEFAULT TRUE
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
rule_id SERIAL PRIMARY KEY
commission_type VARCHAR(30) NOT NULL
level_depth INTEGER NOT NULL DEFAULT 1
plot_area_unit VARCHAR(30) NOT NULL DEFAULT 'gaj'
amount_per_100_gaj NUMERIC(14,2) NOT NULL DEFAULT 0
duration_months INTEGER NOT NULL DEFAULT 144
is_active BOOLEAN NOT NULL DEFAULT TRUE
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

**Usage:**
* **Backend References:** Confirmed in 4 files.
  * *Examples:* cleanup_commission_rules.js, createMlmTables.js, server.js, usage_scanner.cjs

---
### `commission_source_events`
**Columns:**
```sql
event_id BIGSERIAL PRIMARY KEY
booking_id INTEGER NOT NULL REFERENCES bookings(booking_id) ON DELETE RESTRICT
source_type TEXT NOT NULL CHECK (source_type IN ('FullPayment','InitialPayment','EmiPayment','PartialPayment','Manual'))
source_id TEXT NOT NULL
payment_type TEXT NOT NULL
received_amount NUMERIC(14,2) NOT NULL CHECK (received_amount > 0)
plot_amount NUMERIC(14,2) NOT NULL DEFAULT 0
plot_area_gaj NUMERIC(14,2) NOT NULL DEFAULT 0
commission_model TEXT NOT NULL
engine_version INTEGER NOT NULL
generated_by_admin_id INTEGER
generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
UNIQUE (booking_id, source_type, source_id)
event_id BIGSERIAL PRIMARY KEY
booking_id INTEGER NOT NULL REFERENCES bookings(booking_id) ON DELETE RESTRICT
source_type TEXT NOT NULL CHECK (source_type IN ('FullPayment','InitialPayment','EmiPayment','PartialPayment','Manual'))
source_id TEXT NOT NULL
payment_type TEXT NOT NULL
received_amount NUMERIC(14,2) NOT NULL CHECK (received_amount > 0)
plot_amount NUMERIC(14,2) NOT NULL DEFAULT 0
plot_area_gaj NUMERIC(14,2) NOT NULL DEFAULT 0
commission_model TEXT NOT NULL
engine_version INTEGER NOT NULL
generated_by_admin_id INTEGER
generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
UNIQUE (booking_id, source_type, source_id)
```

**Usage:**
* **Backend References:** Confirmed in 5 files.
  * *Examples:* booking-workflow.routes.js, create_commission_engine_tables.js, verify_commission_engine.js, server.js, usage_scanner.cjs

---
### `commission_transactions`
**Columns:**
```sql
[ALTER] commission_event_id BIGINT
[ALTER] commission_model TEXT
[ALTER] commission_level INTEGER
[ALTER] commission_percentage NUMERIC(8,4)
[ALTER] calculation_base NUMERIC(14,2)
[ALTER] source_type TEXT
[ALTER] source_reference TEXT
[ALTER] engine_version INTEGER
[ALTER] distribution_role TEXT
[ALTER] distribution_participants INTEGER
[ALTER] seller_user_id INTEGER
[ALTER] commission_event_id BIGINT
[ALTER] commission_model TEXT
[ALTER] commission_level INTEGER
[ALTER] commission_percentage NUMERIC(8,4)
[ALTER] calculation_base NUMERIC(14,2)
[ALTER] source_type TEXT
[ALTER] source_reference TEXT
[ALTER] engine_version INTEGER
[ALTER] distribution_role TEXT
[ALTER] distribution_participants INTEGER
[ALTER] seller_user_id INTEGER
```

**Usage:**
* **Backend References:** Confirmed in 10 files.
  * *Examples:* booking-workflow.routes.js, invoice-module.routes.js, createMlmTables.js, create_commission_engine_tables.js, test_queries.js, ...

---
### `company_documents`
**Columns:**
```sql
id SERIAL PRIMARY KEY
document_name VARCHAR(180) NOT NULL
document_name_hi VARCHAR(180)
document_description TEXT
document_description_hi TEXT
document_type VARCHAR(100)
document_type_hi VARCHAR(100)
file_url TEXT NOT NULL
file_public_id TEXT
file_data BYTEA
file_type VARCHAR(20) NOT NULL
mime_type VARCHAR(120)
original_file_name VARCHAR(255)
file_size_bytes BIGINT
display_order INTEGER NOT NULL DEFAULT 0
is_active BOOLEAN NOT NULL DEFAULT TRUE
created_by_admin_id INTEGER
updated_by_admin_id INTEGER
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
[ALTER] file_data BYTEA
[ALTER] document_name_hi VARCHAR(180)
[ALTER] document_description_hi TEXT
[ALTER] document_type_hi VARCHAR(100)
[ALTER] file_data BYTEA
id SERIAL PRIMARY KEY
document_name VARCHAR(180) NOT NULL
document_name_hi VARCHAR(180)
document_description TEXT
document_description_hi TEXT
document_type VARCHAR(100)
document_type_hi VARCHAR(100)
file_url TEXT NOT NULL
file_public_id TEXT
file_data BYTEA
file_type VARCHAR(20) NOT NULL
mime_type VARCHAR(120)
original_file_name VARCHAR(255)
file_size_bytes BIGINT
display_order INTEGER NOT NULL DEFAULT 0
is_active BOOLEAN NOT NULL DEFAULT TRUE
created_by_admin_id INTEGER
updated_by_admin_id INTEGER
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
[ALTER] file_data BYTEA
[ALTER] document_name_hi VARCHAR(180)
[ALTER] document_description_hi TEXT
[ALTER] document_type_hi VARCHAR(100)
```

**Usage:**
* **Backend References:** Confirmed in 5 files.
  * *Examples:* create_company_documents_table.js, migrate_company_documents_to_database.js, update_company_documents_hindi.js, server.js, usage_scanner.cjs

---
### `company_settings`
**Columns:**
```sql
id SERIAL PRIMARY KEY
company_name TEXT
company_logo_url TEXT
company_address TEXT
company_email TEXT
company_phone TEXT
company_whatsapp TEXT
company_website TEXT
company_description TEXT
support_email TEXT
support_phone TEXT
facebook_url TEXT
instagram_url TEXT
twitter_url TEXT
youtube_url TEXT
linkedin_url TEXT
favicon_url TEXT
gst_number TEXT
pan_number TEXT
copyright_text TEXT
is_active BOOLEAN NOT NULL DEFAULT TRUE
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

**Usage:**
* **Backend References:** Confirmed in 2 files.
  * *Examples:* server.js, usage_scanner.cjs

---
### `customer_enrollment_submissions`
**Columns:**
```sql
id                          UUID PRIMARY KEY DEFAULT gen_random_uuid()
user_id                     INTEGER
form_date                   DATE
application_no              VARCHAR(50) UNIQUE
project_name                VARCHAR(150)
property_type               VARCHAR(30)
property_type_other         VARCHAR(100)
plot_flat_no                VARCHAR(50)
block_tower                 VARCHAR(50)
size_area                   VARCHAR(50)
rate_per_unit               NUMERIC(14,2)
basic_sale_price            NUMERIC(14,2)
plc_dev_charges             NUMERIC(14,2)
total_property_value        NUMERIC(14,2)
applicant_name              VARCHAR(150) NOT NULL
fh_name                     VARCHAR(150)
date_of_birth               DATE
age                         SMALLINT
gender                      VARCHAR(10)
marital_status              VARCHAR(10)
nationality                 VARCHAR(20)
nationality_other           VARCHAR(100)
pan_no                      VARCHAR(10)
aadhar_no                   VARCHAR(12)
occupation                  VARCHAR(100)
present_address             TEXT
present_city                VARCHAR(100)
present_state_pin           VARCHAR(100)
permanent_address           TEXT
permanent_city              VARCHAR(100)
permanent_state_pin         VARCHAR(100)
mobile_1                    VARCHAR(15) NOT NULL
mobile_2                    VARCHAR(15)
email_1                     VARCHAR(150)
photo_first_applicant_url   TEXT
co_applicant_name           VARCHAR(150)
co_fh_name                  VARCHAR(150)
co_relation                 VARCHAR(80)
co_date_of_birth            DATE
co_age                      SMALLINT
co_gender                   VARCHAR(10)
co_pan_no                   VARCHAR(10)
co_aadhar_no                VARCHAR(12)
co_present_address          TEXT
co_mobile                   VARCHAR(15)
co_email                    VARCHAR(150)
photo_co_applicant_url      TEXT
booking_amount              NUMERIC(14,2)
booking_amount_words        TEXT
payment_mode                VARCHAR(20)
txn_cheque_no               VARCHAR(50)
txn_date                    DATE
drawn_bank_branch           VARCHAR(150)
acc_holder_name             VARCHAR(150)
acc_bank_branch             VARCHAR(150)
acc_number                  VARCHAR(30)
ifsc_code                   VARCHAR(15)
associate_name              VARCHAR(150)
associate_id                VARCHAR(50)
associate_mobile            VARCHAR(15)
associate_signature_name    VARCHAR(150)
declaration_accepted        BOOLEAN NOT NULL DEFAULT FALSE
signature_sole_first_applicant_url TEXT
signature_co_applicant_url  TEXT
signature_authorized_signatory_url TEXT
terms_accepted              BOOLEAN NOT NULL DEFAULT FALSE
terms_accepted_at           TIMESTAMPTZ
application_status          VARCHAR(50) DEFAULT 'Pending'
verified_by                 VARCHAR(150)
payment_status              VARCHAR(15)
payment_status_date         DATE
submitted_at                TIMESTAMPTZ NOT NULL DEFAULT now()
created_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS customer_nominees (
          id                UUID PRIMARY KEY DEFAULT gen_random_uuid()
submission_id     UUID NOT NULL REFERENCES customer_enrollment_submissions(id) ON DELETE CASCADE
nominee_name      VARCHAR(150)
relation          VARCHAR(80)
age_dob           VARCHAR(50)
aadhar_no         VARCHAR(12)
created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;
    
    await sql`CREATE INDEX IF NOT EXISTS idx_ces_application_no ON customer_enrollment_submissions(application_no
```

**Usage:**
* **Backend References:** Confirmed in 2 files.
  * *Examples:* customer-enrollment.routes.js, usage_scanner.cjs

---
### `customer_nominees`
*Schema definition not found in code.* (Possibly created externally or via dynamic ORM not captured in text search).

**Usage:**
* **Backend References:** Confirmed in 2 files.
  * *Examples:* customer-enrollment.routes.js, usage_scanner.cjs

---
### `database_backup_files`
**Columns:**
```sql
id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY
file_name TEXT NOT NULL UNIQUE
file_path TEXT NOT NULL
database_type TEXT NOT NULL
database_host TEXT
database_name TEXT
file_data BYTEA
file_size_bytes BIGINT NOT NULL DEFAULT 0
status TEXT NOT NULL DEFAULT 'Completed'
error_message TEXT
created_by_admin_id INTEGER
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
restored_at TIMESTAMPTZ
restored_by_admin_id INTEGER
deleted_at TIMESTAMPTZ
deleted_by_admin_id INTEGER
[ALTER] file_data BYTEA
```

**Usage:**
* **Backend References:** Confirmed in 4 files.
  * *Examples:* database-backup.routes.js, server.js, databaseBackup.service.js, usage_scanner.cjs

---
### `database_backup_settings`
**Columns:**
```sql
id INTEGER PRIMARY KEY DEFAULT 1
daily_backup_enabled BOOLEAN NOT NULL DEFAULT FALSE
backup_time TIME NOT NULL DEFAULT '02:00'
keep_last_backups INTEGER NOT NULL DEFAULT 30
auto_delete_older BOOLEAN NOT NULL DEFAULT TRUE
updated_by_admin_id INTEGER
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
CONSTRAINT database_backup_settings_singleton CHECK (id = 1)
```

**Usage:**
* **Backend References:** Confirmed in 2 files.
  * *Examples:* databaseBackup.service.js, usage_scanner.cjs

---
### `database_restore_history`
**Columns:**
```sql
id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY
restore_upload_id BIGINT REFERENCES database_restore_uploads(id)
backup_file_name TEXT NOT NULL
restore_mode TEXT NOT NULL
admin_id INTEGER
admin_name TEXT
status TEXT NOT NULL
started_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
ended_at TIMESTAMPTZ
duration_ms INTEGER
message TEXT
error_details TEXT
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

**Usage:**
* **Backend References:** Confirmed in 2 files.
  * *Examples:* databaseBackup.service.js, usage_scanner.cjs

---
### `database_restore_uploads`
**Columns:**
```sql
id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY
file_name TEXT NOT NULL
original_file_name TEXT NOT NULL
file_path TEXT NOT NULL
file_size_bytes BIGINT NOT NULL DEFAULT 0
file_format TEXT NOT NULL
status TEXT NOT NULL DEFAULT 'Uploaded'
validation_message TEXT
uploaded_by_admin_id INTEGER
uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
deleted_at TIMESTAMPTZ
```

**Usage:**
* **Backend References:** Confirmed in 2 files.
  * *Examples:* databaseBackup.service.js, usage_scanner.cjs

---
### `duplicate_alerts`
*Schema definition not found in code.* (Possibly created externally or via dynamic ORM not captured in text search).

**Usage:**
* **Backend References:** Confirmed in 1 files.
  * *Examples:* usage_scanner.cjs

---
### `email_otp_log`
*Schema definition not found in code.* (Possibly created externally or via dynamic ORM not captured in text search).

**Usage:**
* **Backend References:** Confirmed in 1 files.
  * *Examples:* usage_scanner.cjs

---
### `emi_calculator_master`
**Columns:**
```sql
id SERIAL PRIMARY KEY
plot_size VARCHAR(120) NOT NULL
plot_price NUMERIC(14,2) NOT NULL DEFAULT 0
down_payment NUMERIC(14,2) NOT NULL DEFAULT 0
loan_amount NUMERIC(14,2) NOT NULL DEFAULT 0
interest_rate NUMERIC(8,2) NOT NULL DEFAULT 0
tenure_months INTEGER NOT NULL DEFAULT 0
monthly_emi NUMERIC(14,2) NOT NULL DEFAULT 0
processing_fee NUMERIC(14,2) NOT NULL DEFAULT 0
display_order INTEGER NOT NULL DEFAULT 0
is_active BOOLEAN NOT NULL DEFAULT TRUE
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
id SERIAL PRIMARY KEY
plot_size VARCHAR(120) NOT NULL
plot_price NUMERIC(14,2) NOT NULL DEFAULT 0
down_payment NUMERIC(14,2) NOT NULL DEFAULT 0
loan_amount NUMERIC(14,2) NOT NULL DEFAULT 0
interest_rate NUMERIC(8,2) NOT NULL DEFAULT 0
tenure_months INTEGER NOT NULL DEFAULT 0
monthly_emi NUMERIC(14,2) NOT NULL DEFAULT 0
processing_fee NUMERIC(14,2) NOT NULL DEFAULT 0
display_order INTEGER NOT NULL DEFAULT 0
is_active BOOLEAN NOT NULL DEFAULT TRUE
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

**Usage:**
* **Backend References:** Confirmed in 3 files.
  * *Examples:* createEmiCalculatorTable.js, server.js, usage_scanner.cjs

---
### `emi_payment_proofs`
*Schema definition not found in code.* (Possibly created externally or via dynamic ORM not captured in text search).

**Usage:**
* **Backend References:** Confirmed in 2 files.
  * *Examples:* server.js, usage_scanner.cjs

---
### `emi_schedules`
*Schema definition not found in code.* (Possibly created externally or via dynamic ORM not captured in text search).

**Usage:**
* **Backend References:** Confirmed in 8 files.
  * *Examples:* booking-workflow.routes.js, invoice-module.routes.js, test_dashboard_queries.js, test_queries.js, test_subqueries.js, ...

---
### `home_page_settings`
**Columns:**
```sql
id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1)
display_type VARCHAR(20) NOT NULL DEFAULT 'hero_slider'
            CHECK (display_type IN ('hero_slider'))
show_hero_slider BOOLEAN NOT NULL DEFAULT TRUE
show_information_section BOOLEAN NOT NULL DEFAULT TRUE
section_visibility JSONB NOT NULL DEFAULT '{"investors":true,"sites":true,"why_choose":true,"emi_calculator":true,"buyback":true,"earn":true,"facilities":true,"cta":true,"contact":true}'::jsonb
is_active BOOLEAN NOT NULL DEFAULT TRUE
is_deleted BOOLEAN NOT NULL DEFAULT FALSE
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
[ALTER] show_hero_slider BOOLEAN NOT NULL DEFAULT TRUE
[ALTER] section_visibility JSONB NOT NULL DEFAULT '{"investors":true,"sites":true,"why_choose":true,"emi_calculator":true,"buyback":true,"earn":true,"facilities":true,"cta":true,"contact":true}'::jsonb
```

**Usage:**
* **Backend References:** Confirmed in 4 files.
  * *Examples:* drop_hero_book_now_columns.js, verify_hero_book_now_columns_removed.js, server.js, usage_scanner.cjs

---
### `home_sliders`
**Columns:**
```sql
id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY
title TEXT NOT NULL
subtitle TEXT
description TEXT
image_url TEXT NOT NULL
image_public_id TEXT
button_text TEXT
button_link TEXT
button_icon TEXT
button2_text TEXT
button2_link TEXT
button2_icon TEXT
tag_text TEXT
tag_icon TEXT
thumbnail_url TEXT
thumbnail_title TEXT
thumbnail_subtitle TEXT
stats_json JSONB NOT NULL DEFAULT '[]'::jsonb
show_image BOOLEAN NOT NULL DEFAULT TRUE
show_tag BOOLEAN NOT NULL DEFAULT TRUE
show_title BOOLEAN NOT NULL DEFAULT TRUE
show_subtitle BOOLEAN NOT NULL DEFAULT TRUE
show_description BOOLEAN NOT NULL DEFAULT TRUE
show_button1 BOOLEAN NOT NULL DEFAULT TRUE
show_button2 BOOLEAN NOT NULL DEFAULT TRUE
show_stats BOOLEAN NOT NULL DEFAULT TRUE
show_thumbnail BOOLEAN NOT NULL DEFAULT TRUE
display_order INTEGER NOT NULL DEFAULT 0
is_active BOOLEAN NOT NULL DEFAULT TRUE
created_by_admin_id INTEGER
updated_by_admin_id INTEGER
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
[ALTER] button_icon TEXT
[ALTER] button2_text TEXT
[ALTER] button2_link TEXT
[ALTER] button2_icon TEXT
[ALTER] tag_text TEXT
[ALTER] tag_icon TEXT
[ALTER] thumbnail_url TEXT
[ALTER] thumbnail_title TEXT
[ALTER] thumbnail_subtitle TEXT
[ALTER] stats_json JSONB NOT NULL DEFAULT '[]'::jsonb
[ALTER] show_image BOOLEAN NOT NULL DEFAULT TRUE
[ALTER] show_tag BOOLEAN NOT NULL DEFAULT TRUE
[ALTER] show_title BOOLEAN NOT NULL DEFAULT TRUE
[ALTER] show_subtitle BOOLEAN NOT NULL DEFAULT TRUE
[ALTER] show_description BOOLEAN NOT NULL DEFAULT TRUE
[ALTER] show_button1 BOOLEAN NOT NULL DEFAULT TRUE
[ALTER] show_button2 BOOLEAN NOT NULL DEFAULT TRUE
[ALTER] show_stats BOOLEAN NOT NULL DEFAULT TRUE
[ALTER] show_thumbnail BOOLEAN NOT NULL DEFAULT TRUE
id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY
title TEXT NOT NULL
subtitle TEXT
description TEXT
image_url TEXT NOT NULL
image_public_id TEXT
button_text TEXT
button_link TEXT
button_icon TEXT
button2_text TEXT
button2_link TEXT
button2_icon TEXT
tag_text TEXT
tag_icon TEXT
thumbnail_url TEXT
thumbnail_title TEXT
thumbnail_subtitle TEXT
stats_json JSONB NOT NULL DEFAULT '[]'::jsonb
show_image BOOLEAN NOT NULL DEFAULT TRUE
show_tag BOOLEAN NOT NULL DEFAULT TRUE
show_title BOOLEAN NOT NULL DEFAULT TRUE
show_subtitle BOOLEAN NOT NULL DEFAULT TRUE
show_description BOOLEAN NOT NULL DEFAULT TRUE
show_button1 BOOLEAN NOT NULL DEFAULT TRUE
show_button2 BOOLEAN NOT NULL DEFAULT TRUE
show_stats BOOLEAN NOT NULL DEFAULT TRUE
show_thumbnail BOOLEAN NOT NULL DEFAULT TRUE
display_order INTEGER NOT NULL DEFAULT 0
is_active BOOLEAN NOT NULL DEFAULT TRUE
created_by_admin_id INTEGER
updated_by_admin_id INTEGER
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
[ALTER] button_icon TEXT
[ALTER] button2_text TEXT
[ALTER] button2_link TEXT
[ALTER] button2_icon TEXT
[ALTER] tag_text TEXT
[ALTER] tag_icon TEXT
[ALTER] thumbnail_url TEXT
[ALTER] thumbnail_title TEXT
[ALTER] thumbnail_subtitle TEXT
[ALTER] stats_json JSONB NOT NULL DEFAULT '[]'::jsonb
[ALTER] show_image BOOLEAN NOT NULL DEFAULT TRUE
[ALTER] show_tag BOOLEAN NOT NULL DEFAULT TRUE
[ALTER] show_title BOOLEAN NOT NULL DEFAULT TRUE
[ALTER] show_subtitle BOOLEAN NOT NULL DEFAULT TRUE
[ALTER] show_description BOOLEAN NOT NULL DEFAULT TRUE
[ALTER] show_button1 BOOLEAN NOT NULL DEFAULT TRUE
[ALTER] show_button2 BOOLEAN NOT NULL DEFAULT TRUE
[ALTER] show_stats BOOLEAN NOT NULL DEFAULT TRUE
[ALTER] show_thumbnail BOOLEAN NOT NULL DEFAULT TRUE
```

**Usage:**
* **Backend References:** Confirmed in 4 files.
  * *Examples:* create_home_sliders_table.js, verify_vps_database_backup.js, server.js, usage_scanner.cjs

---
### `inquiries`
**Columns:**
```sql
inquiry_id SERIAL PRIMARY KEY
full_name VARCHAR(150) NOT NULL
mobile_no VARCHAR(20) NOT NULL
email VARCHAR(150)
site_id INTEGER REFERENCES sites(site_id) ON DELETE SET NULL
site_name VARCHAR(180)
plot_number VARCHAR(80)
inquiry_message TEXT
inquiry_type VARCHAR(80) DEFAULT 'General Enquiry'
source_page VARCHAR(180) DEFAULT 'Website'
status VARCHAR(30) NOT NULL DEFAULT 'New'
remarks TEXT
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
[ALTER] email VARCHAR(150)
[ALTER] site_id INTEGER REFERENCES sites(site_id) ON DELETE SET NULL
[ALTER] site_name VARCHAR(180)
[ALTER] plot_number VARCHAR(80)
[ALTER] inquiry_message TEXT
[ALTER] inquiry_type VARCHAR(80) DEFAULT 'General Enquiry'
[ALTER] source_page VARCHAR(180) DEFAULT 'Website'
[ALTER] status VARCHAR(30) NOT NULL DEFAULT 'New'
[ALTER] remarks TEXT
[ALTER] created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
[ALTER] updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

**Usage:**
* **Backend References:** Confirmed in 2 files.
  * *Examples:* server.js, usage_scanner.cjs
* **Frontend References:** Confirmed in 2 files.
  * *Examples:* book-plot-leads.component.html, api.service.ts

---
### `investor_deposits`
**Columns:**
```sql
id UUID PRIMARY KEY DEFAULT gen_random_uuid()
investor_id INTEGER NOT NULL REFERENCES investor_users(id) ON DELETE CASCADE
amount NUMERIC(12,2) NOT NULL
payment_method VARCHAR(100) NOT NULL
gateway VARCHAR(50)
transaction_reference VARCHAR(255)
payment_screenshot_url TEXT
payment_screenshot_data BYTEA
payment_screenshot_mime_type VARCHAR(120)
status VARCHAR(50) DEFAULT 'pending'
admin_remarks TEXT
approved_by INTEGER
approved_at TIMESTAMPTZ
created_at TIMESTAMPTZ DEFAULT NOW()
updated_at TIMESTAMPTZ DEFAULT NOW()
deleted_at TIMESTAMPTZ
[ALTER] gateway VARCHAR(50)
[ALTER] payment_screenshot_data BYTEA
[ALTER] payment_screenshot_mime_type VARCHAR(120)
[ALTER] deleted_at TIMESTAMPTZ
id UUID PRIMARY KEY DEFAULT gen_random_uuid()
investor_id INTEGER NOT NULL REFERENCES investor_users(id) ON DELETE CASCADE
amount NUMERIC(12,2) NOT NULL
payment_method VARCHAR(100) NOT NULL
transaction_reference VARCHAR(255) NOT NULL
payment_screenshot_url TEXT
status VARCHAR(50) DEFAULT 'pending'
admin_remarks TEXT
approved_by INTEGER
approved_at TIMESTAMPTZ
created_at TIMESTAMPTZ DEFAULT NOW()
updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;

    console.log("[DB] Creating investor_withdrawals table..."
```

**Usage:**
* **Backend References:** Confirmed in 6 files.
  * *Examples:* investor.routes.js, create_investor_module_tables.js, wipe_database_test_data.js, wipe_investor_data.js, server.js, ...

---
### `investor_documents`
**Columns:**
```sql
id UUID PRIMARY KEY DEFAULT gen_random_uuid()
investor_id INTEGER NOT NULL REFERENCES investor_users(id) ON DELETE CASCADE
document_type VARCHAR(80) NOT NULL
original_file_name VARCHAR(255) NOT NULL
mime_type VARCHAR(120) NOT NULL
file_size_bytes BIGINT NOT NULL
file_data BYTEA NOT NULL
status VARCHAR(50) DEFAULT 'pending'
admin_remarks TEXT
reviewed_by INTEGER
reviewed_at TIMESTAMPTZ
created_at TIMESTAMPTZ DEFAULT NOW()
updated_at TIMESTAMPTZ DEFAULT NOW()
deleted_at TIMESTAMPTZ
```

**Usage:**
* **Backend References:** Confirmed in 4 files.
  * *Examples:* investor.routes.js, wipe_database_test_data.js, wipe_investor_data.js, usage_scanner.cjs

---
### `investor_enrollments`
**Columns:**
```sql
id UUID PRIMARY KEY DEFAULT gen_random_uuid()
investor_id INTEGER REFERENCES investor_users(id) ON DELETE SET NULL
form_no VARCHAR(100)
form_date DATE
branch_code VARCHAR(100)
branch_name VARCHAR(255)
investor_enrollment_id VARCHAR(100)
project_name VARCHAR(255)
inv_first_name VARCHAR(100) NOT NULL
inv_middle_name VARCHAR(100)
inv_surname VARCHAR(100)
fh_first_name VARCHAR(100)
fh_middle_name VARCHAR(100)
fh_surname VARCHAR(100)
dob DATE
age INTEGER
gender VARCHAR(20)
occupation VARCHAR(100)
occupation_other VARCHAR(255)
address TEXT
city VARCHAR(100)
state VARCHAR(100)
pin_code VARCHAR(20)
mobile VARCHAR(50) NOT NULL
alt_tel VARCHAR(50)
email VARCHAR(255)
pan VARCHAR(50)
aadhar VARCHAR(50)
amount NUMERIC(12,2)
amount_words VARCHAR(255)
payment_mode VARCHAR(100)
txn_no VARCHAR(100)
txn_date DATE
bank_branch VARCHAR(255)
nominees JSONB
decl_date DATE
decl_place VARCHAR(100)
decl_signature_name VARCHAR(255)
first_applicant_name VARCHAR(255)
joint_applicant_name VARCHAR(255)
app_status VARCHAR(50) DEFAULT 'Pending'
verified_by VARCHAR(255)
payment_status VARCHAR(50)
payment_status_date DATE
authorized_signatory VARCHAR(255)
photo_url TEXT
signature_first_url TEXT
signature_joint_url TEXT
created_at TIMESTAMPTZ DEFAULT NOW()
updated_at TIMESTAMPTZ DEFAULT NOW()
```

**Usage:**
* **Backend References:** Confirmed in 2 files.
  * *Examples:* investor.routes.js, usage_scanner.cjs

---
### `investor_notifications`
**Columns:**
```sql
id UUID PRIMARY KEY DEFAULT gen_random_uuid()
investor_id INTEGER NOT NULL REFERENCES investor_users(id) ON DELETE CASCADE
title VARCHAR(180) NOT NULL
message TEXT NOT NULL
notification_type VARCHAR(50) DEFAULT 'info'
is_read BOOLEAN DEFAULT false
created_at TIMESTAMPTZ DEFAULT NOW()
```

**Usage:**
* **Backend References:** Confirmed in 3 files.
  * *Examples:* investor.routes.js, wipe_investor_data.js, usage_scanner.cjs

---
### `investor_settlement_preferences`
**Columns:**
```sql
id UUID PRIMARY KEY DEFAULT gen_random_uuid()
investor_id INTEGER NOT NULL UNIQUE REFERENCES investor_users(id) ON DELETE CASCADE
frequency VARCHAR(30) NOT NULL CHECK (frequency IN ('monthly','half_yearly','yearly'))
locked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
created_at TIMESTAMPTZ DEFAULT NOW()
updated_at TIMESTAMPTZ DEFAULT NOW()
```

**Usage:**
* **Backend References:** Confirmed in 3 files.
  * *Examples:* investor.routes.js, wipe_investor_data.js, usage_scanner.cjs

---
### `investor_transactions`
**Columns:**
```sql
id UUID PRIMARY KEY DEFAULT gen_random_uuid()
investor_id INTEGER NOT NULL REFERENCES investor_users(id) ON DELETE CASCADE
transaction_id VARCHAR(100) UNIQUE NOT NULL
type VARCHAR(50) NOT NULL
amount NUMERIC(12,2) NOT NULL
status VARCHAR(50) NOT NULL
payment_method VARCHAR(100)
gateway VARCHAR(50)
reference_number VARCHAR(255)
remarks TEXT
created_at TIMESTAMPTZ DEFAULT NOW()
updated_at TIMESTAMPTZ DEFAULT NOW()
[ALTER] gateway VARCHAR(50)
id UUID PRIMARY KEY DEFAULT gen_random_uuid()
investor_id INTEGER NOT NULL REFERENCES investor_users(id) ON DELETE CASCADE
transaction_id VARCHAR(100) UNIQUE NOT NULL
type VARCHAR(50) NOT NULL
amount NUMERIC(12,2) NOT NULL
status VARCHAR(50) NOT NULL
payment_method VARCHAR(100)
reference_number VARCHAR(255)
remarks TEXT
created_at TIMESTAMPTZ DEFAULT NOW()
updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;

    console.log("[DB] Creating indexes for investor module..."
```

**Usage:**
* **Backend References:** Confirmed in 6 files.
  * *Examples:* investor.routes.js, create_investor_module_tables.js, test_investor_module.js, wipe_database_test_data.js, wipe_investor_data.js, ...

---
### `investor_users`
**Columns:**
```sql
id SERIAL PRIMARY KEY
full_name VARCHAR(255) NOT NULL
mobile_number VARCHAR(50) NOT NULL
email VARCHAR(255) UNIQUE NOT NULL
password_hash VARCHAR(255) NOT NULL
address TEXT
city VARCHAR(100)
state VARCHAR(100)
country VARCHAR(100) DEFAULT 'India'
pincode VARCHAR(20)
pan_number VARCHAR(50)
aadhaar_number VARCHAR(50)
bank_name VARCHAR(255)
account_number VARCHAR(100)
ifsc_code VARCHAR(50)
nominee_name VARCHAR(255)
available_balance NUMERIC(12,2) DEFAULT 0
total_investment NUMERIC(12,2) DEFAULT 0
total_deposits NUMERIC(12,2) DEFAULT 0
total_settlements NUMERIC(12,2) DEFAULT 0
total_earnings NUMERIC(12,2) DEFAULT 0
total_withdrawals NUMERIC(12,2) DEFAULT 0
status VARCHAR(50) DEFAULT 'pending_verification'
is_verified BOOLEAN DEFAULT false
profile_picture_url TEXT
email_verification_token TEXT
email_verification_expires TIMESTAMPTZ
reset_otp VARCHAR(10)
reset_otp_expires TIMESTAMPTZ
created_at TIMESTAMPTZ DEFAULT NOW()
updated_at TIMESTAMPTZ DEFAULT NOW()
deleted_at TIMESTAMPTZ
[ALTER] total_settlements NUMERIC(12,2) DEFAULT 0
[ALTER] total_earnings NUMERIC(12,2) DEFAULT 0
[ALTER] email_verification_token TEXT
[ALTER] email_verification_expires TIMESTAMPTZ
[ALTER] deleted_at TIMESTAMPTZ
id SERIAL PRIMARY KEY
full_name VARCHAR(255) NOT NULL
mobile_number VARCHAR(50) NOT NULL
email VARCHAR(255) UNIQUE NOT NULL
password_hash VARCHAR(255) NOT NULL
address TEXT
city VARCHAR(100)
state VARCHAR(100)
country VARCHAR(100) DEFAULT 'India'
pincode VARCHAR(20)
pan_number VARCHAR(50)
aadhaar_number VARCHAR(50)
bank_name VARCHAR(255)
account_number VARCHAR(100)
ifsc_code VARCHAR(50)
nominee_name VARCHAR(255)
available_balance NUMERIC(12,2) DEFAULT 0.00
total_investment NUMERIC(12,2) DEFAULT 0.00
total_deposits NUMERIC(12,2) DEFAULT 0.00
total_withdrawals NUMERIC(12,2) DEFAULT 0.00
status VARCHAR(50) DEFAULT 'pending'
is_verified BOOLEAN DEFAULT false
profile_picture_url TEXT
reset_otp VARCHAR(10)
reset_otp_expires TIMESTAMPTZ
created_at TIMESTAMPTZ DEFAULT NOW()
updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;

    console.log("[DB] Creating investor_deposits table..."
id SERIAL PRIMARY KEY
full_name VARCHAR(255) NOT NULL
mobile_number VARCHAR(50) NOT NULL
email VARCHAR(255) UNIQUE NOT NULL
password_hash VARCHAR(255) NOT NULL
address TEXT
city VARCHAR(100)
state VARCHAR(100)
country VARCHAR(100) DEFAULT 'India'
pincode VARCHAR(20)
pan_number VARCHAR(50)
aadhaar_number VARCHAR(50)
bank_name VARCHAR(255)
account_number VARCHAR(100)
ifsc_code VARCHAR(50)
nominee_name VARCHAR(255)
available_balance NUMERIC(12,2) DEFAULT 0
total_investment NUMERIC(12,2) DEFAULT 0
total_deposits NUMERIC(12,2) DEFAULT 0
total_settlements NUMERIC(12,2) DEFAULT 0
total_earnings NUMERIC(12,2) DEFAULT 0
total_withdrawals NUMERIC(12,2) DEFAULT 0
status VARCHAR(50) DEFAULT 'pending_verification'
is_verified BOOLEAN DEFAULT false
profile_picture_url TEXT
email_verification_token TEXT
email_verification_expires TIMESTAMPTZ
reset_otp VARCHAR(10)
reset_otp_expires TIMESTAMPTZ
created_at TIMESTAMPTZ DEFAULT NOW()
updated_at TIMESTAMPTZ DEFAULT NOW()
deleted_at TIMESTAMPTZ
[ALTER] total_settlements NUMERIC(12,2) DEFAULT 0
[ALTER] total_earnings NUMERIC(12,2) DEFAULT 0
[ALTER] email_verification_token TEXT
[ALTER] email_verification_expires TIMESTAMPTZ
[ALTER] deleted_at TIMESTAMPTZ
```

**Usage:**
* **Backend References:** Confirmed in 18 files.
  * *Examples:* authEmailRoutes.js, investor.routes.js, newRoutes.js, check_investors.js, check_user.js, ...

---
### `investor_withdrawals`
**Columns:**
```sql
id UUID PRIMARY KEY DEFAULT gen_random_uuid()
investor_id INTEGER NOT NULL REFERENCES investor_users(id) ON DELETE CASCADE
amount NUMERIC(12,2) NOT NULL
bank_name VARCHAR(255) NOT NULL
account_number VARCHAR(100) NOT NULL
ifsc_code VARCHAR(50) NOT NULL
remarks TEXT
status VARCHAR(50) DEFAULT 'pending'
admin_remarks TEXT
approved_by INTEGER
approved_at TIMESTAMPTZ
created_at TIMESTAMPTZ DEFAULT NOW()
updated_at TIMESTAMPTZ DEFAULT NOW()
id UUID PRIMARY KEY DEFAULT gen_random_uuid()
investor_id INTEGER NOT NULL REFERENCES investor_users(id) ON DELETE CASCADE
amount NUMERIC(12,2) NOT NULL
bank_name VARCHAR(255) NOT NULL
account_number VARCHAR(100) NOT NULL
ifsc_code VARCHAR(50) NOT NULL
remarks TEXT
status VARCHAR(50) DEFAULT 'pending'
admin_remarks TEXT
approved_by INTEGER
approved_at TIMESTAMPTZ
created_at TIMESTAMPTZ DEFAULT NOW()
updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;

    console.log("[DB] Creating investor_transactions table..."
```

**Usage:**
* **Backend References:** Confirmed in 5 files.
  * *Examples:* investor.routes.js, create_investor_module_tables.js, wipe_database_test_data.js, wipe_investor_data.js, usage_scanner.cjs

---
### `investors`
**Columns:**
```sql
id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY
name VARCHAR(160) NOT NULL
profile_image_url TEXT NOT NULL
profile_image_public_id TEXT
designation VARCHAR(160)
short_description TEXT
investment_amount NUMERIC(15, 2) DEFAULT 0
display_order INTEGER NOT NULL DEFAULT 0
is_active BOOLEAN NOT NULL DEFAULT TRUE
is_deleted BOOLEAN NOT NULL DEFAULT FALSE
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
[ALTER] investment_amount NUMERIC(15, 2) DEFAULT 0
```

**Usage:**
* **Backend References:** Confirmed in 7 files.
  * *Examples:* investor.routes.js, check_investors.js, seed_investor.js, wipe_investor_data.js, server.js, ...
* **Frontend References:** Confirmed in 23 files.
  * *Examples:* approvals.component.html, home-slider.component.ts, admin-investor-enrollment-detail.component.html, admin-investor-enrollments-list.component.html, admin-investor-enrollments-list.component.ts, ...

---
### `invoice_audit_log`
**Columns:**
```sql
log_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY
invoice_id BIGINT REFERENCES invoices(invoice_id) ON DELETE CASCADE
invoice_number VARCHAR(100) NOT NULL
action VARCHAR(50) NOT NULL CHECK (action IN ('GENERATED', 'VIEWED', 'PRINTED', 'DOWNLOADED'))
performed_by_id INTEGER
performed_by_role VARCHAR(30)
ip_address VARCHAR(100) DEFAULT ''
user_agent TEXT DEFAULT ''
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

**Usage:**
* **Backend References:** Confirmed in 4 files.
  * *Examples:* invoice-module.routes.js, create_invoice_module_tables.js, wipe_database_test_data.js, usage_scanner.cjs

---
### `invoice_number_sequence`
**Columns:**
```sql
year INTEGER PRIMARY KEY
last_sequence INTEGER NOT NULL DEFAULT 0
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

**Usage:**
* **Backend References:** Confirmed in 4 files.
  * *Examples:* booking-workflow.routes.js, create_invoice_module_tables.js, wipe_database_test_data.js, usage_scanner.cjs

---
### `invoice_settings`
**Columns:**
```sql
id INTEGER PRIMARY KEY DEFAULT 1
company_name VARCHAR(255) NOT NULL DEFAULT 'MMR Constructions & Developers'
company_logo TEXT DEFAULT ''
address TEXT DEFAULT 'Head Office: Main Road, Lucknow, Uttar Pradesh - 226001'
phone VARCHAR(100) DEFAULT '+91 98765 43210 / +91 91234 56789'
email VARCHAR(100) DEFAULT 'info@mmrconstructions.com'
website VARCHAR(100) DEFAULT 'www.mmrconstructions.com'
gst_number VARCHAR(50) DEFAULT '09AAAAA0000A1Z5'
terms_and_conditions TEXT DEFAULT '1. All payments are subject to clearance.\n2. Plot allocation is subject to company guidelines and approval.\n3. Taxes and statutory charges are as per government norms.\n4. This is a system-generated invoice.'
notes TEXT DEFAULT 'Thank you for choosing MMR Constructions & Developers.'
bank_name VARCHAR(150) DEFAULT 'State Bank of India'
account_no VARCHAR(100) DEFAULT '123456789012'
ifsc_code VARCHAR(50) DEFAULT 'SBIN0001234'
branch VARCHAR(100) DEFAULT 'Main Branch, Lucknow'
upi_qr_url TEXT DEFAULT ''
signature_url TEXT DEFAULT ''
stamp_url TEXT DEFAULT ''
invoice_prefix VARCHAR(20) DEFAULT 'MMR'
invoice_starting_number INTEGER DEFAULT 1
invoice_footer TEXT DEFAULT 'System Generated Invoice - MMR Constructions & Developers'
theme_color VARCHAR(30) DEFAULT '#14532d'
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

**Usage:**
* **Backend References:** Confirmed in 3 files.
  * *Examples:* invoice-module.routes.js, create_invoice_module_tables.js, usage_scanner.cjs

---
### `invoices`
**Columns:**
```sql
invoice_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY
invoice_number VARCHAR(100) NOT NULL UNIQUE
booking_id INTEGER UNIQUE REFERENCES bookings(booking_id) ON DELETE CASCADE
user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE
associate_id INTEGER REFERENCES users(user_id) ON DELETE SET NULL
payment_id BIGINT REFERENCES booking_payment_records(payment_id) ON DELETE SET NULL
order_id VARCHAR(180)
invoice_date TIMESTAMPTZ NOT NULL DEFAULT NOW()
subtotal NUMERIC(14,2) DEFAULT 0
discount NUMERIC(14,2) DEFAULT 0
registration_charges NUMERIC(14,2) DEFAULT 0
development_charges NUMERIC(14,2) DEFAULT 0
other_charges NUMERIC(14,2) DEFAULT 0
grand_total NUMERIC(14,2) DEFAULT 0
paid_amount NUMERIC(14,2) DEFAULT 0
balance_amount NUMERIC(14,2) DEFAULT 0
payment_method VARCHAR(50) DEFAULT 'Online'
payment_status VARCHAR(50) DEFAULT 'Paid'
order_status VARCHAR(50) DEFAULT 'Completed'
invoice_data JSONB NOT NULL DEFAULT '{}'::jsonb
verification_token VARCHAR(100) DEFAULT ''
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

**Usage:**
* **Backend References:** Confirmed in 7 files.
  * *Examples:* booking-workflow.routes.js, invoice-module.routes.js, create_booking_workflow_tables.js, create_invoice_module_tables.js, test_booking_workflow_schema.js, ...
* **Frontend References:** Confirmed in 2 files.
  * *Examples:* invoice-settings.component.html, verify-invoice.component.html

---
### `mlm_network`
**Columns:**
```sql
id SERIAL PRIMARY KEY
associate_user_id INTEGER UNIQUE REFERENCES users(user_id) ON DELETE CASCADE
sponsor_user_id INTEGER REFERENCES users(user_id) ON DELETE SET NULL
level INTEGER NOT NULL DEFAULT 1
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

**Usage:**
* **Backend References:** Confirmed in 7 files.
  * *Examples:* authEmailRoutes.js, diagnose_mlm_error.js, fix_mlm_trigger_function.js, test_queries.js, wipe_database_test_data.js, ...

---
### `mlm_tree_closure`
**Columns:**
```sql
ancestor_user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE
descendant_user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE
depth INTEGER NOT NULL
PRIMARY KEY (ancestor_user_id, descendant_user_id)
ancestor_user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE
descendant_user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE
depth INTEGER NOT NULL
PRIMARY KEY (ancestor_user_id, descendant_user_id)
id SERIAL PRIMARY KEY
ancestor_user_id INTEGER NOT NULL
descendant_user_id INTEGER NOT NULL
depth INTEGER NOT NULL
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
UNIQUE (ancestor_user_id, descendant_user_id)
id SERIAL PRIMARY KEY
ancestor_user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE
descendant_user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE
depth INTEGER NOT NULL
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
UNIQUE (ancestor_user_id, descendant_user_id)
```

**Usage:**
* **Backend References:** Confirmed in 6 files.
  * *Examples:* authEmailRoutes.js, booking-workflow.routes.js, createMlmTables.js, wipe_database_test_data.js, server.js, ...

---
### `mobile_app_settings`
**Columns:**
```sql
id SERIAL PRIMARY KEY
platform TEXT NOT NULL DEFAULT 'google_play'
app_name TEXT NOT NULL DEFAULT 'MMR Constructions'
app_logo_url TEXT
app_logo_public_id TEXT
play_store_url TEXT
package_name TEXT
current_version TEXT
latest_version TEXT
version_code TEXT
release_notes TEXT
download_mode TEXT NOT NULL DEFAULT 'apk'
apk_url TEXT
apk_public_id TEXT
apk_file_name TEXT
apk_file_size_bytes BIGINT
apk_uploaded_at TIMESTAMPTZ
release_date DATE
description TEXT
button_text TEXT NOT NULL DEFAULT 'Download App'
badge_text TEXT NOT NULL DEFAULT 'Google Play'
is_enabled BOOLEAN NOT NULL DEFAULT FALSE
is_coming_soon BOOLEAN NOT NULL DEFAULT TRUE
force_download BOOLEAN NOT NULL DEFAULT TRUE
open_target TEXT NOT NULL DEFAULT '_blank'
display_order INTEGER NOT NULL DEFAULT 1
updated_by_admin_id INTEGER
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
[ALTER] platform TEXT NOT NULL DEFAULT 'google_play'
[ALTER] app_logo_public_id TEXT
[ALTER] current_version TEXT
[ALTER] latest_version TEXT
[ALTER] version_code TEXT
[ALTER] release_notes TEXT
[ALTER] download_mode TEXT NOT NULL DEFAULT 'apk'
[ALTER] apk_url TEXT
[ALTER] apk_public_id TEXT
[ALTER] apk_file_name TEXT
[ALTER] apk_file_size_bytes BIGINT
[ALTER] apk_uploaded_at TIMESTAMPTZ
[ALTER] release_date DATE
[ALTER] badge_text TEXT NOT NULL DEFAULT 'Google Play'
[ALTER] is_coming_soon BOOLEAN NOT NULL DEFAULT TRUE
[ALTER] force_download BOOLEAN NOT NULL DEFAULT TRUE
[ALTER] open_target TEXT NOT NULL DEFAULT '_blank'
[ALTER] display_order INTEGER NOT NULL DEFAULT 1
[ALTER] updated_by_admin_id INTEGER
```

**Usage:**
* **Backend References:** Confirmed in 2 files.
  * *Examples:* server.js, usage_scanner.cjs

---
### `notification_log`
*Schema definition not found in code.* (Possibly created externally or via dynamic ORM not captured in text search).

**Usage:**
* **Backend References:** Confirmed in 3 files.
  * *Examples:* test_dashboard_queries.js, server.js, usage_scanner.cjs

---
### `notification_queue`
**Columns:**
```sql
queue_id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY
channel VARCHAR(30) NOT NULL DEFAULT 'whatsapp'
provider_name VARCHAR(40) NOT NULL DEFAULT 'meta_cloud'
template_key VARCHAR(80)
recipient_mobile VARCHAR(20) NOT NULL
user_id INTEGER
payload JSONB NOT NULL DEFAULT '{}'::jsonb
priority INTEGER NOT NULL DEFAULT 5
status VARCHAR(30) NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','Processing','Sent','Failed'))
attempts INTEGER NOT NULL DEFAULT 0
max_attempts INTEGER NOT NULL DEFAULT 3
scheduled_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
processed_at TIMESTAMPTZ
last_error TEXT
created_by_admin_id INTEGER
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

**Usage:**
* **Backend References:** Confirmed in 4 files.
  * *Examples:* whatsapp.repository.js, whatsapp.routes.js, create_whatsapp_tables.js, usage_scanner.cjs

---
### `notification_templates`
*Schema definition not found in code.* (Possibly created externally or via dynamic ORM not captured in text search).

**Usage:**
* **Backend References:** Confirmed in 1 files.
  * *Examples:* usage_scanner.cjs

---
### `otp_history`
**Columns:**
```sql
history_id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY
otp_id BIGINT REFERENCES otp_master(otp_id) ON DELETE SET NULL
mobile_no VARCHAR(20) NOT NULL
purpose VARCHAR(80) NOT NULL
action VARCHAR(40) NOT NULL
success BOOLEAN NOT NULL DEFAULT FALSE
failure_reason TEXT
ip_address TEXT
user_agent TEXT
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

**Usage:**
* **Backend References:** Confirmed in 4 files.
  * *Examples:* whatsapp.repository.js, create_whatsapp_tables.js, whatsapp.service.js, usage_scanner.cjs

---
### `otp_log`
*Schema definition not found in code.* (Possibly created externally or via dynamic ORM not captured in text search).

**Usage:**
* **Backend References:** Confirmed in 5 files.
  * *Examples:* authEmailRoutes.js, clear_otp_log.js, fix_otp_log_sequence.js, server.js, usage_scanner.cjs

---
### `otp_master`
**Columns:**
```sql
otp_id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY
mobile_no VARCHAR(20) NOT NULL
user_id INTEGER
purpose VARCHAR(80) NOT NULL
otp_hash TEXT NOT NULL
otp_length SMALLINT NOT NULL
expires_at TIMESTAMPTZ NOT NULL
attempts INTEGER NOT NULL DEFAULT 0
resend_count INTEGER NOT NULL DEFAULT 0
max_attempts INTEGER NOT NULL DEFAULT 5
status VARCHAR(30) NOT NULL DEFAULT 'Active' CHECK (status IN ('Active','Verified','Expired','Blocked','Used'))
verified_at TIMESTAMPTZ
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

**Usage:**
* **Backend References:** Confirmed in 3 files.
  * *Examples:* create_whatsapp_tables.js, whatsapp.service.js, usage_scanner.cjs

---
### `otp_store`
*Schema definition not found in code.* (Possibly created externally or via dynamic ORM not captured in text search).

**Usage:**
* **Backend References:** Confirmed in 1 files.
  * *Examples:* usage_scanner.cjs

---
### `payment_gateway_audit_logs`
**Columns:**
```sql
id UUID PRIMARY KEY DEFAULT gen_random_uuid()
admin_id UUID
gateway_name VARCHAR(50)
action_type VARCHAR(100)
old_value JSONB DEFAULT '{}'::jsonb
new_value JSONB DEFAULT '{}'::jsonb
ip_address VARCHAR(100)
user_agent TEXT
created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;

    console.log("Creating indexes for performance..."
```

**Usage:**
* **Backend References:** Confirmed in 3 files.
  * *Examples:* payment.routes.js, create_payment_tables.js, usage_scanner.cjs

---
### `payment_gateway_configs`
**Columns:**
```sql
id UUID PRIMARY KEY DEFAULT gen_random_uuid()
gateway_name VARCHAR(50) UNIQUE NOT NULL
display_name VARCHAR(100)
is_enabled BOOLEAN DEFAULT false
is_default BOOLEAN DEFAULT false
allow_user_selection BOOLEAN DEFAULT true
fallback_enabled BOOLEAN DEFAULT false
priority INTEGER DEFAULT 1
status VARCHAR(50) DEFAULT 'inactive'
environment_mode VARCHAR(50)
public_key TEXT
encrypted_secret_key TEXT
encrypted_client_secret TEXT
encrypted_webhook_secret TEXT
callback_url TEXT
webhook_url TEXT
success_url TEXT
failure_url TEXT
cancel_url TEXT
min_customer_fund_amount NUMERIC(12,2) DEFAULT 100.00
min_associate_fund_amount NUMERIC(12,2) DEFAULT 100.00
extra_config JSONB DEFAULT '{}'::jsonb
created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;

    console.log("Ensuring fund minimum columns exist..."
[ALTER] callback_url TEXT
[ALTER] webhook_url TEXT
[ALTER] success_url TEXT
[ALTER] failure_url TEXT
[ALTER] cancel_url TEXT
[ALTER] min_customer_fund_amount NUMERIC(12,2) DEFAULT 100.00
[ALTER] min_associate_fund_amount NUMERIC(12,2) DEFAULT 100.00
```

**Usage:**
* **Backend References:** Confirmed in 9 files.
  * *Examples:* GatewayFactory.js, payment.routes.js, create_payment_tables.js, diagnose_cashfree_config.js, test_api_endpoints.js, ...

---
### `payment_logs`
**Columns:**
```sql
id UUID PRIMARY KEY DEFAULT gen_random_uuid()
order_id VARCHAR(255)
gateway_name VARCHAR(50)
log_type VARCHAR(50)
request_payload JSONB DEFAULT '{}'::jsonb
response_payload JSONB DEFAULT '{}'::jsonb
ip_address VARCHAR(100)
user_agent TEXT
created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;

    console.log("Creating payment_gateway_audit_logs table..."
```

**Usage:**
* **Backend References:** Confirmed in 3 files.
  * *Examples:* payment.routes.js, create_payment_tables.js, usage_scanner.cjs

---
### `payment_transactions`
**Columns:**
```sql
id UUID PRIMARY KEY DEFAULT gen_random_uuid()
order_id VARCHAR(255) UNIQUE NOT NULL
gateway_name VARCHAR(50) NOT NULL
transaction_id VARCHAR(255)
amount NUMERIC(10,2) NOT NULL
currency VARCHAR(10) DEFAULT 'INR'
customer_name VARCHAR(255)
customer_email VARCHAR(255)
customer_mobile VARCHAR(20)
payment_status VARCHAR(50) DEFAULT 'pending'
gateway_order_id VARCHAR(255)
gateway_payment_id VARCHAR(255)
gateway_signature TEXT
gateway_response JSONB DEFAULT '{}'::jsonb
failure_reason TEXT
created_by UUID
created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;

    console.log("Creating payment_logs table..."
```

**Usage:**
* **Backend References:** Confirmed in 5 files.
  * *Examples:* payment.routes.js, create_payment_tables.js, inspect_booking_workflow_schema.js, test_api_endpoints.js, usage_scanner.cjs

---
### `payment_vouchers`
*Schema definition not found in code.* (Possibly created externally or via dynamic ORM not captured in text search).

**Usage:**
* **Backend References:** Confirmed in 2 files.
  * *Examples:* server.js, usage_scanner.cjs

---
### `pending_registrations`
**Columns:**
```sql
email TEXT PRIMARY KEY
mobile_no TEXT NOT NULL
user_type TEXT NOT NULL
full_name TEXT NOT NULL
password_hash TEXT NOT NULL
sponsor_user_id INTEGER
sponsor_invite_code TEXT
optional_data JSONB NOT NULL DEFAULT '{}'::jsonb
otp_code TEXT NOT NULL
attempts INTEGER NOT NULL DEFAULT 0
expires_at TIMESTAMPTZ NOT NULL
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
[ALTER] optional_data JSONB NOT NULL DEFAULT '{}'::jsonb
email TEXT PRIMARY KEY
mobile_no TEXT NOT NULL
user_type TEXT NOT NULL
full_name TEXT NOT NULL
password_hash TEXT NOT NULL
sponsor_user_id INTEGER
sponsor_invite_code TEXT
optional_data JSONB NOT NULL DEFAULT '{}'::jsonb
otp_code TEXT NOT NULL
attempts INTEGER NOT NULL DEFAULT 0
expires_at TIMESTAMPTZ NOT NULL
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
email TEXT PRIMARY KEY
mobile_no TEXT NOT NULL
user_type TEXT NOT NULL
full_name TEXT NOT NULL
password_hash TEXT NOT NULL
sponsor_user_id INTEGER
sponsor_invite_code TEXT
optional_data JSONB NOT NULL DEFAULT '{}'::jsonb
otp_code TEXT NOT NULL
attempts INTEGER NOT NULL DEFAULT 0
expires_at TIMESTAMPTZ NOT NULL
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
email TEXT PRIMARY KEY
mobile_no TEXT NOT NULL
user_type TEXT NOT NULL
full_name TEXT NOT NULL
password_hash TEXT NOT NULL
sponsor_user_id INTEGER
sponsor_invite_code TEXT
optional_data JSONB NOT NULL DEFAULT '{}'::jsonb
otp_code TEXT NOT NULL
attempts INTEGER NOT NULL DEFAULT 0
expires_at TIMESTAMPTZ NOT NULL
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

**Usage:**
* **Backend References:** Confirmed in 7 files.
  * *Examples:* authEmailRoutes.js, investor.routes.js, check_user.js, test_investor_module.js, server.js, ...

---
### `plot_booking_history`
**Columns:**
```sql
id SERIAL PRIMARY KEY
plot_id INTEGER NOT NULL REFERENCES plots(plot_id) ON DELETE CASCADE
booking_id INTEGER
user_id INTEGER
event_type VARCHAR(80) NOT NULL
event_note TEXT
triggered_by_admin INTEGER
triggered_by_user INTEGER
plot_status_at_time VARCHAR(40)
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

**Usage:**
* **Backend References:** Confirmed in 2 files.
  * *Examples:* server.js, usage_scanner.cjs

---
### `plot_booking_locks`
**Columns:**
```sql
lock_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY
plot_id INTEGER NOT NULL REFERENCES plots(plot_id) ON DELETE CASCADE
user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE
booking_id INTEGER REFERENCES bookings(booking_id) ON DELETE CASCADE
lock_token UUID NOT NULL DEFAULT gen_random_uuid()
status VARCHAR(20) NOT NULL DEFAULT 'Active'
        CHECK (status IN ('Active','Converted','Expired','Released'))
expires_at TIMESTAMPTZ NOT NULL
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

**Usage:**
* **Backend References:** Confirmed in 4 files.
  * *Examples:* booking-workflow.routes.js, create_booking_workflow_tables.js, test_booking_workflow_schema.js, usage_scanner.cjs

---
### `plot_bulk_import_log`
**Columns:**
```sql
id SERIAL PRIMARY KEY
site_id INTEGER NOT NULL REFERENCES sites(site_id) ON DELETE CASCADE
imported_by_id INTEGER
original_filename TEXT
total_rows INTEGER NOT NULL DEFAULT 0
success_count INTEGER NOT NULL DEFAULT 0
failed_count INTEGER NOT NULL DEFAULT 0
error_details JSONB NOT NULL DEFAULT '[]'::jsonb
status VARCHAR(30) NOT NULL DEFAULT 'Processing'
started_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
completed_at TIMESTAMPTZ
```

**Usage:**
* **Backend References:** Confirmed in 2 files.
  * *Examples:* server.js, usage_scanner.cjs

---
### `plot_details_extended`
**Columns:**
```sql
plot_id INTEGER PRIMARY KEY REFERENCES plots(plot_id) ON DELETE CASCADE
size_label VARCHAR(120)
width_ft NUMERIC
length_ft NUMERIC
facing_direction VARCHAR(80)
is_corner_plot BOOLEAN DEFAULT FALSE
road_width_ft NUMERIC
features JSONB NOT NULL DEFAULT '[]'::jsonb
description TEXT
block_name VARCHAR(120)
sector_name VARCHAR(120)
updated_by_admin_id INTEGER
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

**Usage:**
* **Backend References:** Confirmed in 2 files.
  * *Examples:* server.js, usage_scanner.cjs

---
### `plot_images`
**Columns:**
```sql
id SERIAL PRIMARY KEY
plot_id INTEGER NOT NULL REFERENCES plots(plot_id) ON DELETE CASCADE
image_url TEXT NOT NULL
image_path TEXT NOT NULL
caption TEXT
image_order INTEGER NOT NULL DEFAULT 0
uploaded_by_id INTEGER
uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

**Usage:**
* **Backend References:** Confirmed in 2 files.
  * *Examples:* server.js, usage_scanner.cjs
* **Frontend References:** Confirmed in 1 files.
  * *Examples:* site-map.component.ts

---
### `plot_polygon_coordinates`
**Columns:**
```sql
plot_id INTEGER PRIMARY KEY REFERENCES plots(plot_id) ON DELETE CASCADE
coordinates JSONB NOT NULL DEFAULT '[]'::jsonb
label_x NUMERIC
label_y NUMERIC
updated_by_admin_id INTEGER
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

**Usage:**
* **Backend References:** Confirmed in 2 files.
  * *Examples:* server.js, usage_scanner.cjs

---
### `plot_polygon_history`
**Columns:**
```sql
id SERIAL PRIMARY KEY
plot_id INTEGER NOT NULL REFERENCES plots(plot_id) ON DELETE CASCADE
old_coordinates JSONB NOT NULL DEFAULT '[]'::jsonb
new_coordinates JSONB NOT NULL DEFAULT '[]'::jsonb
changed_by_admin_id INTEGER
change_reason TEXT
changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

**Usage:**
* **Backend References:** Confirmed in 2 files.
  * *Examples:* server.js, usage_scanner.cjs

---
### `plot_status_history`
*Schema definition not found in code.* (Possibly created externally or via dynamic ORM not captured in text search).

**Usage:**
* **Backend References:** Confirmed in 2 files.
  * *Examples:* server.js, usage_scanner.cjs

---
### `plots`
*Schema definition not found in code.* (Possibly created externally or via dynamic ORM not captured in text search).

**Usage:**
* **Backend References:** Confirmed in 16 files.
  * *Examples:* booking-workflow.routes.js, invoice-module.routes.js, audit_and_fix_all_primary_keys.js, create_booking_workflow_tables.js, create_home_sliders_table.js, ...
* **Frontend References:** Confirmed in 67 files.
  * *Examples:* customers.component.html, customers.component.ts, sites-mgmt.component.html, app.routes.ts, home.component.ts, ...

---
### `products`
*Schema definition not found in code.* (Possibly created externally or via dynamic ORM not captured in text search).

**Usage:**
* **Backend References:** Confirmed in 1 files.
  * *Examples:* usage_scanner.cjs

---
### `referral_clicks`
**Columns:**
```sql
id SERIAL PRIMARY KEY
associate_user_id INTEGER
invite_code VARCHAR(80)
ip_address TEXT
user_agent TEXT
clicked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
id SERIAL PRIMARY KEY
associate_user_id INTEGER REFERENCES users(user_id) ON DELETE CASCADE
invite_code VARCHAR(80)
ip_address TEXT
user_agent TEXT
clicked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

**Usage:**
* **Backend References:** Confirmed in 3 files.
  * *Examples:* createMlmTables.js, server.js, usage_scanner.cjs

---
### `referral_registrations`
**Columns:**
```sql
id SERIAL PRIMARY KEY
sponsor_user_id INTEGER REFERENCES users(user_id)
referred_user_id INTEGER UNIQUE REFERENCES users(user_id) ON DELETE CASCADE
sponsor_invite_code VARCHAR(80)
registration_source VARCHAR(80) DEFAULT 'ReferralLink'
referral_level INTEGER NOT NULL DEFAULT 1
status VARCHAR(30) NOT NULL DEFAULT 'Pending'
approved_at TIMESTAMPTZ
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
id SERIAL PRIMARY KEY
sponsor_user_id INTEGER
referred_user_id INTEGER UNIQUE
sponsor_invite_code VARCHAR(80)
registration_source VARCHAR(80) DEFAULT 'ReferralLink'
referral_level INTEGER NOT NULL DEFAULT 1
status VARCHAR(30) NOT NULL DEFAULT 'Pending'
approved_at TIMESTAMPTZ
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
id SERIAL PRIMARY KEY
sponsor_user_id INTEGER REFERENCES users(user_id)
referred_user_id INTEGER UNIQUE REFERENCES users(user_id) ON DELETE CASCADE
sponsor_invite_code VARCHAR(80)
registration_source VARCHAR(80) DEFAULT 'ReferralLink'
referral_level INTEGER NOT NULL DEFAULT 1
status VARCHAR(30) NOT NULL DEFAULT 'Pending'
approved_at TIMESTAMPTZ
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

**Usage:**
* **Backend References:** Confirmed in 9 files.
  * *Examples:* authEmailRoutes.js, booking-workflow.routes.js, invoice-module.routes.js, createMlmTables.js, create_invoice_module_tables.js, ...

---
### `registry_records`
*Schema definition not found in code.* (Possibly created externally or via dynamic ORM not captured in text search).

**Usage:**
* **Backend References:** Confirmed in 1 files.
  * *Examples:* usage_scanner.cjs

---
### `report_schedules`
*Schema definition not found in code.* (Possibly created externally or via dynamic ORM not captured in text search).

**Usage:**
* **Backend References:** Confirmed in 1 files.
  * *Examples:* usage_scanner.cjs

---
### `settlement_change_requests`
**Columns:**
```sql
id UUID PRIMARY KEY DEFAULT gen_random_uuid()
investor_id INTEGER NOT NULL REFERENCES investor_users(id) ON DELETE CASCADE
current_frequency VARCHAR(30)
requested_frequency VARCHAR(30) NOT NULL CHECK (requested_frequency IN ('monthly','half_yearly','yearly'))
reason TEXT
status VARCHAR(50) DEFAULT 'pending'
admin_remarks TEXT
reviewed_by INTEGER
reviewed_at TIMESTAMPTZ
created_at TIMESTAMPTZ DEFAULT NOW()
updated_at TIMESTAMPTZ DEFAULT NOW()
```

**Usage:**
* **Backend References:** Confirmed in 2 files.
  * *Examples:* investor.routes.js, usage_scanner.cjs

---
### `site_documents`
**Columns:**
```sql
document_id SERIAL PRIMARY KEY
site_id INTEGER NOT NULL REFERENCES sites(site_id) ON DELETE CASCADE
document_name VARCHAR(180) NOT NULL
document_type VARCHAR(100)
description TEXT
file_url TEXT NOT NULL
file_public_id TEXT NOT NULL
file_name TEXT NOT NULL
file_mime_type VARCHAR(100) NOT NULL
file_size_bytes INTEGER NOT NULL
created_by_admin_id INTEGER
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
document_id SERIAL PRIMARY KEY
site_id INTEGER NOT NULL REFERENCES sites(site_id) ON DELETE CASCADE
document_name VARCHAR(180) NOT NULL
document_type VARCHAR(100)
description TEXT
file_url TEXT NOT NULL
file_public_id TEXT NOT NULL
file_name TEXT NOT NULL
file_mime_type VARCHAR(100) NOT NULL
file_size_bytes INTEGER NOT NULL
created_by_admin_id INTEGER
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

**Usage:**
* **Backend References:** Confirmed in 3 files.
  * *Examples:* create_site_documents_table.js, server.js, usage_scanner.cjs

---
### `site_landmarks`
*Schema definition not found in code.* (Possibly created externally or via dynamic ORM not captured in text search).

**Usage:**
* **Backend References:** Confirmed in 2 files.
  * *Examples:* server.js, usage_scanner.cjs

---
### `site_layout_maps`
*Schema definition not found in code.* (Possibly created externally or via dynamic ORM not captured in text search).

**Usage:**
* **Backend References:** Confirmed in 1 files.
  * *Examples:* usage_scanner.cjs

---
### `site_photos`
*Schema definition not found in code.* (Possibly created externally or via dynamic ORM not captured in text search).

**Usage:**
* **Backend References:** Confirmed in 2 files.
  * *Examples:* server.js, usage_scanner.cjs

---
### `sites`
**Columns:**
```sql
[ALTER] html_map_code TEXT
[ALTER] html_map_file_url TEXT
[ALTER] html_map_updated_at TIMESTAMPTZ
[ALTER] site_prefix VARCHAR(12)
[ALTER] nearest_place TEXT
[ALTER] landmark TEXT
[ALTER] highway_distance TEXT
[ALTER] airport_distance TEXT
[ALTER] is_booking_enabled BOOLEAN DEFAULT TRUE
```

**Usage:**
* **Backend References:** Confirmed in 9 files.
  * *Examples:* booking-workflow.routes.js, audit_and_fix_all_primary_keys.js, create_home_sliders_table.js, create_invoice_module_tables.js, create_site_documents_table.js, ...
* **Frontend References:** Confirmed in 46 files.
  * *Examples:* layout.component.ts, sites-mgmt.component.html, sites-mgmt.component.ts, app.routes.ts, home.component.html, ...

---
### `user_addresses`
**Columns:**
```sql
address_id SERIAL PRIMARY KEY
user_id INTEGER REFERENCES users(user_id) ON DELETE CASCADE
address_type VARCHAR(50) DEFAULT 'Permanent'
address_line1 TEXT
city VARCHAR(100)
state VARCHAR(100)
pin_code VARCHAR(20)
created_at TIMESTAMPTZ DEFAULT NOW()
```

**Usage:**
* **Backend References:** Confirmed in 3 files.
  * *Examples:* authEmailRoutes.js, server.js, usage_scanner.cjs

---
### `user_bank_details`
*Schema definition not found in code.* (Possibly created externally or via dynamic ORM not captured in text search).

**Usage:**
* **Backend References:** Confirmed in 2 files.
  * *Examples:* server.js, usage_scanner.cjs

---
### `user_device_tokens`
*Schema definition not found in code.* (Possibly created externally or via dynamic ORM not captured in text search).

**Usage:**
* **Backend References:** Confirmed in 1 files.
  * *Examples:* usage_scanner.cjs

---
### `user_documents`
**Columns:**
```sql
[ALTER] review_status VARCHAR(30) NOT NULL DEFAULT 'Submitted'
[ALTER] admin_remarks TEXT
[ALTER] reupload_requested BOOLEAN NOT NULL DEFAULT FALSE
```

**Usage:**
* **Backend References:** Confirmed in 7 files.
  * *Examples:* booking-workflow.routes.js, invoice-module.routes.js, create_booking_workflow_tables.js, inspect_booking_workflow_schema.js, wipe_database_test_data.js, ...

---
### `user_kyc_profiles`
**Columns:**
```sql
user_id INTEGER PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE
status VARCHAR(30) NOT NULL DEFAULT 'Not Submitted'
        CHECK (status IN ('Not Submitted','Submitted','Under Review','Approved','Rejected'))
admin_remarks TEXT
submitted_at TIMESTAMPTZ
reviewed_at TIMESTAMPTZ
reviewed_by_admin_id INTEGER REFERENCES admin_users(admin_id)
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

**Usage:**
* **Backend References:** Confirmed in 5 files.
  * *Examples:* booking-workflow.routes.js, create_booking_workflow_tables.js, test_booking_workflow_schema.js, server.js, usage_scanner.cjs

---
### `user_nominees`
*Schema definition not found in code.* (Possibly created externally or via dynamic ORM not captured in text search).

**Usage:**
* **Backend References:** Confirmed in 2 files.
  * *Examples:* server.js, usage_scanner.cjs

---
### `user_wallets`
**Columns:**
```sql
id UUID PRIMARY KEY DEFAULT gen_random_uuid()
user_id INTEGER NOT NULL UNIQUE
user_role VARCHAR(50) NOT NULL
available_balance NUMERIC(12,2) DEFAULT 0.00
pending_withdrawal_balance NUMERIC(12,2) DEFAULT 0.00
total_added_fund NUMERIC(12,2) DEFAULT 0.00
total_withdrawn NUMERIC(12,2) DEFAULT 0.00
total_commission NUMERIC(12,2) DEFAULT 0.00
currency VARCHAR(10) DEFAULT 'INR'
is_active BOOLEAN DEFAULT true
created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;

    console.log("Creating withdrawal_requests table..."
```

**Usage:**
* **Backend References:** Confirmed in 6 files.
  * *Examples:* payment.routes.js, wallet.routes.js, create_wallet_tables.js, test_wallet_logic.js, server.js, ...

---
### `users`
*Schema definition not found in code.* (Possibly created externally or via dynamic ORM not captured in text search).

**Usage:**
* **Backend References:** Confirmed in 48 files.
  * *Examples:* authEmailRoutes.js, booking-workflow.routes.js, investor.routes.js, invoice-module.routes.js, newRoutes.js, ...
* **Frontend References:** Confirmed in 28 files.
  * *Examples:* dashboard.component.ts, layout.component.ts, admin-users-response.ts, approvals.component.html, approvals.component.ts, ...

---
### `wallet_audit_logs`
**Columns:**
```sql
id UUID PRIMARY KEY DEFAULT gen_random_uuid()
user_id INTEGER
admin_id INTEGER
action_type VARCHAR(100) NOT NULL
old_value JSONB DEFAULT '{}'::jsonb
new_value JSONB DEFAULT '{}'::jsonb
ip_address VARCHAR(100)
user_agent TEXT
created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;

    console.log("Adding relationships / foreign keys..."
```

**Usage:**
* **Backend References:** Confirmed in 5 files.
  * *Examples:* payment.routes.js, wallet.routes.js, create_wallet_tables.js, test_wallet_logic.js, usage_scanner.cjs

---
### `wallet_transactions`
**Columns:**
```sql
id UUID PRIMARY KEY DEFAULT gen_random_uuid()
wallet_id UUID NOT NULL
user_id INTEGER NOT NULL
user_role VARCHAR(50) NOT NULL
transaction_type VARCHAR(50) NOT NULL
source VARCHAR(100) NOT NULL
amount NUMERIC(12,2) NOT NULL
balance_before NUMERIC(12,2) NOT NULL
balance_after NUMERIC(12,2) NOT NULL
payment_gateway VARCHAR(50)
payment_order_id VARCHAR(255)
payment_transaction_id VARCHAR(255)
withdrawal_request_id UUID
status VARCHAR(50) NOT NULL
remarks TEXT
gateway_response JSONB DEFAULT '{}'::jsonb
created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;

    console.log("Creating wallet_audit_logs table..."
```

**Usage:**
* **Backend References:** Confirmed in 6 files.
  * *Examples:* payment.routes.js, wallet.routes.js, create_wallet_tables.js, test_wallet_logic.js, server.js, ...

---
### `whatsapp_message_logs`
**Columns:**
```sql
message_log_id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY
queue_id BIGINT
user_id INTEGER
mobile_no VARCHAR(20) NOT NULL
provider_name VARCHAR(40) NOT NULL DEFAULT 'meta_cloud'
template_key VARCHAR(80)
meta_message_id VARCHAR(160)
message_type VARCHAR(40) NOT NULL DEFAULT 'template'
request_payload JSONB
response_payload JSONB
status VARCHAR(30) NOT NULL DEFAULT 'Pending'
delivery_status VARCHAR(30)
error_code VARCHAR(80)
error_message TEXT
sent_at TIMESTAMPTZ
delivered_at TIMESTAMPTZ
read_at TIMESTAMPTZ
failed_at TIMESTAMPTZ
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

**Usage:**
* **Backend References:** Confirmed in 4 files.
  * *Examples:* whatsapp.repository.js, whatsapp.routes.js, create_whatsapp_tables.js, usage_scanner.cjs

---
### `whatsapp_settings`
**Columns:**
```sql
id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1)
is_enabled BOOLEAN NOT NULL DEFAULT FALSE
provider_name VARCHAR(40) NOT NULL DEFAULT 'meta_cloud'
phone_number_id VARCHAR(120)
whatsapp_business_account_id VARCHAR(120)
encrypted_access_token TEXT
encrypted_api_secret TEXT
encrypted_verify_token TEXT
webhook_callback_url TEXT
api_version VARCHAR(20) NOT NULL DEFAULT 'v20.0'
default_country_code VARCHAR(5) NOT NULL DEFAULT '91'
otp_length SMALLINT NOT NULL DEFAULT 6 CHECK (otp_length IN (4, 6))
otp_expiry_minutes INTEGER NOT NULL DEFAULT 10 CHECK (otp_expiry_minutes BETWEEN 1 AND 1440)
resend_limit INTEGER NOT NULL DEFAULT 3 CHECK (resend_limit BETWEEN 0 AND 20)
max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20)
queue_max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (queue_max_attempts BETWEEN 1 AND 10)
created_by_admin_id INTEGER
updated_by_admin_id INTEGER
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

**Usage:**
* **Backend References:** Confirmed in 3 files.
  * *Examples:* whatsapp.repository.js, create_whatsapp_tables.js, usage_scanner.cjs

---
### `whatsapp_templates`
**Columns:**
```sql
template_id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY
template_key VARCHAR(80) NOT NULL UNIQUE
template_name VARCHAR(160) NOT NULL
template_category VARCHAR(80) NOT NULL
language VARCHAR(20) NOT NULL DEFAULT 'en_US'
template_variables JSONB NOT NULL DEFAULT '[]'::jsonb
template_body TEXT NOT NULL
meta_template_name VARCHAR(160)
status VARCHAR(30) NOT NULL DEFAULT 'Active' CHECK (status IN ('Active','Inactive','Pending','Approved','Rejected'))
is_active BOOLEAN NOT NULL DEFAULT TRUE
created_by_admin_id INTEGER
updated_by_admin_id INTEGER
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

**Usage:**
* **Backend References:** Confirmed in 3 files.
  * *Examples:* whatsapp.repository.js, create_whatsapp_tables.js, usage_scanner.cjs

---
### `whatsapp_webhook_logs`
**Columns:**
```sql
webhook_log_id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY
event_type VARCHAR(80)
meta_message_id VARCHAR(160)
payload JSONB NOT NULL
processed BOOLEAN NOT NULL DEFAULT FALSE
processing_error TEXT
received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

**Usage:**
* **Backend References:** Confirmed in 3 files.
  * *Examples:* whatsapp.repository.js, create_whatsapp_tables.js, usage_scanner.cjs

---
### `withdrawal_requests`
**Columns:**
```sql
id UUID PRIMARY KEY DEFAULT gen_random_uuid()
user_id INTEGER NOT NULL
user_role VARCHAR(50) NOT NULL
wallet_id UUID NOT NULL
amount NUMERIC(12,2) NOT NULL
bank_account_holder_name VARCHAR(255) NOT NULL
bank_account_number VARCHAR(100) NOT NULL
ifsc_code VARCHAR(50) NOT NULL
bank_name VARCHAR(255) NOT NULL
upi_id VARCHAR(255)
status VARCHAR(50) DEFAULT 'pending'
admin_remarks TEXT
rejection_reason TEXT
approved_by INTEGER
approved_at TIMESTAMP
released_by INTEGER
released_at TIMESTAMP
payout_reference_id VARCHAR(255)
created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;

    console.log("Creating wallet_transactions table..."
```

**Usage:**
* **Backend References:** Confirmed in 5 files.
  * *Examples:* wallet.routes.js, create_wallet_tables.js, test_wallet_logic.js, wipe_database_test_data.js, usage_scanner.cjs

---
## Column Duplication Analysis (Part 5)

**`email` is found in:**
* `pending_registrations`
* `pending_registrations`
* `pending_registrations`
* `pending_registrations`
* `investor_users`
* `investor_users`
* `investor_users`
* `investor_enrollments`
* `admin_users`
* `admin_users`
* `admin_users`
* `invoice_settings`
* `inquiries`

**`mobile` is found in:**
* `investor_enrollments`

**`phone` is found in:**
* `invoice_settings`

**`user_id` is found in:**
* `user_addresses`
* `customer_enrollment_submissions`
* `user_kyc_profiles`
* `plot_booking_locks`
* `booking_appointments`
* `booking_payment_records`
* `booking_invoices`
* `invoices`
* `user_wallets`
* `withdrawal_requests`
* `wallet_transactions`
* `wallet_audit_logs`
* `whatsapp_message_logs`
* `otp_master`
* `notification_queue`
* `book_plot_leads`
* `plot_booking_history`
* `analytics_events`

**`investor_id` is found in:**
* `investor_deposits`
* `investor_deposits`
* `investor_withdrawals`
* `investor_withdrawals`
* `investor_transactions`
* `investor_transactions`
* `investor_documents`
* `investor_settlement_preferences`
* `settlement_change_requests`
* `investor_notifications`
* `investor_enrollments`

**`status` is found in:**
* `referral_registrations`
* `referral_registrations`
* `referral_registrations`
* `investor_users`
* `investor_users`
* `investor_users`
* `investor_deposits`
* `investor_deposits`
* `investor_withdrawals`
* `investor_withdrawals`
* `investor_transactions`
* `investor_transactions`
* `investor_documents`
* `settlement_change_requests`
* `commission_monthly_schedule`
* `commission_monthly_schedule`
* `associate_payout_requests`
* `associate_payout_requests`
* `user_kyc_profiles`
* `plot_booking_locks`
* `booking_appointments`
* `booking_payment_records`
* `payment_gateway_configs`
* `withdrawal_requests`
* `wallet_transactions`
* `whatsapp_templates`
* `whatsapp_message_logs`
* `otp_master`
* `notification_queue`
* `book_plot_leads`
* `plot_bulk_import_log`
* `inquiries`
* `database_backup_files`
* `database_restore_uploads`
* `database_restore_history`

**`created_at` is found in:**
* `pending_registrations`
* `pending_registrations`
* `pending_registrations`
* `pending_registrations`
* `associate_referral_links`
* `associate_referral_links`
* `associate_referral_links`
* `associate_referral_links`
* `user_addresses`
* `referral_registrations`
* `referral_registrations`
* `referral_registrations`
* `mlm_network`
* `mlm_tree_closure`
* `mlm_tree_closure`
* `audit_log`
* `customer_enrollment_submissions`
* `customer_enrollment_submissions`
* `investor_users`
* `investor_users`
* `investor_users`
* `investor_deposits`
* `investor_deposits`
* `investor_withdrawals`
* `investor_withdrawals`
* `investor_transactions`
* `investor_transactions`
* `investor_documents`
* `investor_settlement_preferences`
* `settlement_change_requests`
* `investor_notifications`
* `investor_enrollments`
* `admin_roles`
* `admin_roles`
* `admin_roles`
* `admin_users`
* `admin_users`
* `admin_users`
* `admin_sessions`
* `admin_sessions`
* `emi_calculator_master`
* `emi_calculator_master`
* `associate_ranks`
* `associate_ranks`
* `commission_rules`
* `commission_rules`
* `commission_monthly_schedule`
* `commission_monthly_schedule`
* `booking_workflow_settings`
* `user_kyc_profiles`
* `plot_booking_locks`
* `booking_appointments`
* `booking_payment_records`
* `commission_engine_settings`
* `commission_engine_settings`
* `commission_engine_levels`
* `commission_engine_levels`
* `company_documents`
* `company_documents`
* `home_sliders`
* `home_sliders`
* `invoice_settings`
* `invoices`
* `invoice_audit_log`
* `payment_gateway_configs`
* `payment_transactions`
* `payment_logs`
* `payment_gateway_audit_logs`
* `site_documents`
* `site_documents`
* `user_wallets`
* `withdrawal_requests`
* `wallet_transactions`
* `wallet_audit_logs`
* `whatsapp_settings`
* `whatsapp_templates`
* `whatsapp_message_logs`
* `otp_master`
* `otp_history`
* `notification_queue`
* `buyback_terms`
* `buyback_terms`
* `home_page_settings`
* `investors`
* `book_plot_background_images`
* `book_plot_leads`
* `company_settings`
* `mobile_app_settings`
* `plot_booking_history`
* `inquiries`
* `analytics_events`
* `database_backup_files`
* `database_restore_history`

**`full_name` is found in:**
* `pending_registrations`
* `pending_registrations`
* `pending_registrations`
* `pending_registrations`
* `investor_users`
* `investor_users`
* `investor_users`
* `admin_users`
* `admin_users`
* `admin_users`
* `book_plot_leads`
* `inquiries`

**`name` is found in:**
* `investors`

## Potentially Unused / Legacy Tables (Part 9)

All tables have at least one reference in the codebase.
