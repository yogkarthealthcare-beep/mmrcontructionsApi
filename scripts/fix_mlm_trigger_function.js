import sql from "../db.js";

async function fixTriggerFunction() {
  console.log("==========================================");
  console.log("   FIXING DB TRIGGER FUNCTION fn_on_user_approved   ");
  console.log("==========================================");

  try {
    await sql`
      CREATE OR REPLACE FUNCTION fn_on_user_approved()
      RETURNS TRIGGER AS $$
      BEGIN
          IF NEW.account_status = 'Active' AND (OLD.account_status IS NULL OR OLD.account_status <> 'Active') THEN

              -- Assign Member ID
              IF NEW.member_id IS NULL THEN
                  NEW.member_id := fn_generate_member_id(NEW.user_type);
              END IF;

              -- Assign Invitation Code for Associates
              IF NEW.user_type = 'Associate' AND NEW.invitation_code IS NULL THEN
                  NEW.invitation_code := fn_generate_invite_code();
              END IF;

              -- Insert into associate_sales_tracker
              IF NEW.user_type = 'Associate' THEN
                  INSERT INTO associate_sales_tracker (associate_user_id)
                  VALUES (NEW.user_id)
                  ON CONFLICT (associate_user_id) DO NOTHING;
              END IF;

              -- Insert into MLM network
              IF NEW.user_type = 'Associate' THEN
                  INSERT INTO mlm_network (associate_user_id, sponsor_user_id, level)
                  VALUES (
                      NEW.user_id,
                      NEW.sponsor_user_id,
                      CASE WHEN NEW.sponsor_user_id IS NULL THEN 1
                           ELSE COALESCE((SELECT level FROM mlm_network WHERE associate_user_id = NEW.sponsor_user_id), 0) + 1
                      END
                  )
                  ON CONFLICT (associate_user_id) DO NOTHING;
              END IF;

          END IF;
          RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `;

    console.log("   [SUCCESS] PostgreSQL function `fn_on_user_approved()` successfully updated in database!");
  } catch (err) {
    console.error("   [ERROR FIXING TRIGGER FUNCTION]:", err);
  } finally {
    process.exit(0);
  }
}

fixTriggerFunction();
