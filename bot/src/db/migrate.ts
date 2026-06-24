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
`;

export async function runMigrations(): Promise<void> {
  await pool.query(SQL);
  console.log("[db] migraciones OK");
}
