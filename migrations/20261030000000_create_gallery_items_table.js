/**
 * Migration: Create gallery_items table for Images, YouTube, Videos, and Advertisement Banner
 * Backward-compatible, idempotent Knex migration.
 * 
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function up(knex) {
  await knex.schema.raw(`
    CREATE TABLE IF NOT EXISTS gallery_items (
      id SERIAL PRIMARY KEY,
      type VARCHAR(20) NOT NULL,
      title VARCHAR(255),
      url TEXT NOT NULL,
      storage_path TEXT,
      thumbnail_url TEXT,
      thumbnail_storage_path TEXT,
      youtube_id VARCHAR(50),
      show_in_advertisement BOOLEAN DEFAULT FALSE,
      is_active BOOLEAN DEFAULT TRUE,
      sort_order INT DEFAULT 0,
      start_date TIMESTAMP WITH TIME ZONE NULL,
      end_date TIMESTAMP WITH TIME ZONE NULL,
      cta_link TEXT NULL,
      cta_label VARCHAR(100) NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_gallery_items_type ON gallery_items (type);
    CREATE INDEX IF NOT EXISTS idx_gallery_items_active ON gallery_items (is_active);
    CREATE INDEX IF NOT EXISTS idx_gallery_items_ad ON gallery_items (show_in_advertisement);
    CREATE INDEX IF NOT EXISTS idx_gallery_items_sort ON gallery_items (sort_order ASC, created_at DESC);
  `);
}

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function down(knex) {
  await knex.schema.raw(`
    DROP TABLE IF EXISTS gallery_items CASCADE;
  `);
}

