import sql from "../db.js";

const columns = [
  "hero_main_heading",
  "hero_company_name",
  "hero_tagline",
  "hero_director_name",
  "hero_contact_number",
  "hero_secondary_contact",
  "hero_whatsapp_number",
  "hero_field_visibility",
  "hero_background_url",
  "hero_background_public_id",
  "hero_slider_heading",
  "hero_slider_image_url",
  "hero_slider_image_public_id",
  "hero_slider_images",
  "hero_form_title",
  "hero_submit_button_text",
  "hero_site_slider_interval",
];

try {
  await sql`ALTER TABLE home_page_settings DROP CONSTRAINT IF EXISTS home_page_settings_display_type_check`;
  await sql`UPDATE home_page_settings SET display_type = 'hero_slider', show_hero_slider = TRUE`;
  await sql`
    UPDATE home_page_settings
    SET section_visibility = COALESCE(section_visibility, '{}'::jsonb) - 'hero_book_now' - 'hero_site_slider'`;
  for (const column of columns) {
    await sql.unsafe(`ALTER TABLE home_page_settings DROP COLUMN IF EXISTS ${column}`);
  }
  await sql`
    ALTER TABLE home_page_settings
    ADD CONSTRAINT home_page_settings_display_type_check CHECK (display_type IN ('hero_slider'))`;
  const remaining = await sql`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'home_page_settings'
      AND column_name = ANY(${columns})
    ORDER BY column_name`;
  console.log(JSON.stringify({ success: true, dropped_columns: columns, remaining }, null, 2));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await sql.end();
}
