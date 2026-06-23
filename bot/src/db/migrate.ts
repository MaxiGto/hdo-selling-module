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
  seller_code         TEXT,   -- SellerCode de Tango → base para asignar zona
  zone                TEXT,
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
`;

export async function runMigrations(): Promise<void> {
  await pool.query(SQL);
  console.log("[db] migraciones OK");
}
