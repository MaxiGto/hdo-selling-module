import pool from "../db/pool.js";
import { findOrCreateContact } from "../chatwoot/chatwootClient.js";
import { setChatwootContactId } from "../contacts/contactRepository.js";

async function run() {
  const { rows } = await pool.query<{ id: number; name: string; phone_normalized: string; tango_id: string }>(
    `SELECT id, name, phone_normalized, tango_id
     FROM contacts
     WHERE chatwoot_contact_id IS NULL
       AND phone_normalized IS NOT NULL
       AND phone_normalized <> ''
     ORDER BY id`,
  );

  console.log(`[backfill] ${rows.length} contactos sin chatwoot_contact_id`);

  let ok = 0;
  let failed = 0;

  for (const c of rows) {
    try {
      const chatwootId = await findOrCreateContact(c.name, c.phone_normalized);
      await setChatwootContactId(c.id, chatwootId);
      console.log(`[backfill] ${c.tango_id} → chatwoot_contact_id=${chatwootId}`);
      ok++;
    } catch (err) {
      console.error(`[backfill] error con ${c.tango_id}:`, err);
      failed++;
    }
  }

  console.log(`[backfill] completado — ok: ${ok}, fallidos: ${failed}`);
}

import("../db/pool.js").then(({ default: p }) =>
  run()
    .then(() => p.end())
    .catch((err) => { console.error("[backfill] error fatal:", err); process.exit(1); }),
);
