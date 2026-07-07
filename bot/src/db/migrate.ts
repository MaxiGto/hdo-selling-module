import pool from "./pool.js";

// Corre en el arranque del bot. Todas las sentencias usan IF NOT EXISTS
// para ser idempotentes: seguro correr en cada deploy.
const SQL = `
CREATE TABLE IF NOT EXISTS contacts (
  id                  SERIAL PRIMARY KEY,
  tango_id            TEXT UNIQUE NOT NULL,
  name                TEXT NOT NULL,
  phone_normalized    TEXT NOT NULL,
  province_code       TEXT,
  seller_code         TEXT,
  -- Días de entrega leídos desde Tango (ShippingAddresses de la dirección principal).
  -- La difusión se envía 2 días hábiles antes: delivers_wednesday → difusión el lunes.
  delivers_monday     BOOLEAN NOT NULL DEFAULT FALSE,
  delivers_tuesday    BOOLEAN NOT NULL DEFAULT FALSE,
  delivers_wednesday  BOOLEAN NOT NULL DEFAULT FALSE,
  delivers_thursday   BOOLEAN NOT NULL DEFAULT FALSE,
  delivers_friday     BOOLEAN NOT NULL DEFAULT FALSE,
  delivers_saturday   BOOLEAN NOT NULL DEFAULT FALSE,
  delivers_sunday     BOOLEAN NOT NULL DEFAULT FALSE,
  chatwoot_contact_id INTEGER,
  opt_out             BOOLEAN NOT NULL DEFAULT FALSE,
  synced_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS campaign_runs (
  id             SERIAL PRIMARY KEY,
  campaign_name  TEXT NOT NULL,
  contacts_count INTEGER NOT NULL DEFAULT 0,
  started_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at    TIMESTAMPTZ,
  status         TEXT NOT NULL DEFAULT 'running'
);

CREATE TABLE IF NOT EXISTS campaign_contacts (
  campaign_run_id  INTEGER NOT NULL REFERENCES campaign_runs(id),
  contact_id       INTEGER NOT NULL REFERENCES contacts(id),
  sent_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status           TEXT NOT NULL DEFAULT 'sent',
  PRIMARY KEY (campaign_run_id, contact_id)
);

-- Conversaciones derivadas a un asesor humano. El bot ignora mensajes entrantes
-- de estas conversaciones hasta que el cliente abra una nueva (Opción A del diseño).
CREATE TABLE IF NOT EXISTS handoffs (
  conversation_id  INTEGER PRIMARY KEY,
  motivo           TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Caché de productos y stock de Tango, actualizada cada 30 minutos por cron.
-- El bot consulta esta tabla (en lugar de llamar a Tango directamente) para
-- responder consultas de stock sin latencia ni carga sobre la API externa.
CREATE TABLE IF NOT EXISTS product_stock_cache (
  sku_code               TEXT PRIMARY KEY,
  tango_id               INTEGER,
  description            TEXT NOT NULL,
  additional_description TEXT,
  bar_code               TEXT,
  quantity               NUMERIC NOT NULL DEFAULT 0,
  engaged_quantity       NUMERIC NOT NULL DEFAULT 0,
  last_synced_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

// Migraciones incrementales (ALTER): seguras de correr en cada deploy.
const MIGRATIONS = `
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS no_response_streak INTEGER NOT NULL DEFAULT 0;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS price_list_number TEXT;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
`;

export async function runMigrations(): Promise<void> {
  await pool.query(SQL);
  await pool.query(MIGRATIONS);
  console.log("[db] migraciones OK");
}
