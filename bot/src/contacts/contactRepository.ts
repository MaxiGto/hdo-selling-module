import pool from "../db/pool.js";

export interface Contact {
  id: number;
  tangoId: string;
  name: string;
  phoneNormalized: string;
  provinceCode: string | null;
  zone: string | null;
  chatwootContactId: number | null;
  optOut: boolean;
}

// Contactos aptos para una campaña: zona correcta, no opt-out, teléfono válido.
export async function getAudienceByZone(zone: string): Promise<Contact[]> {
  const { rows } = await pool.query<{
    id: number; tango_id: string; name: string; phone_normalized: string;
    province_code: string | null; zone: string | null;
    chatwoot_contact_id: number | null; opt_out: boolean;
  }>(
    `SELECT id, tango_id, name, phone_normalized, province_code, zone,
            chatwoot_contact_id, opt_out
     FROM contacts
     WHERE zone = $1
       AND opt_out = FALSE
       AND phone_normalized IS NOT NULL
       AND phone_normalized <> ''`,
    [zone],
  );
  return rows.map((r) => ({
    id: r.id,
    tangoId: r.tango_id,
    name: r.name,
    phoneNormalized: r.phone_normalized,
    provinceCode: r.province_code,
    zone: r.zone,
    chatwootContactId: r.chatwoot_contact_id,
    optOut: r.opt_out,
  }));
}

// Upsert desde el sync con Tango. Nunca pisa zone ni opt_out si ya existen.
export async function upsertContact(data: {
  tangoId: string;
  name: string;
  phoneNormalized: string;
  provinceCode: string | null;
  zone: string | null;
}): Promise<void> {
  await pool.query(
    `INSERT INTO contacts (tango_id, name, phone_normalized, province_code, zone, synced_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (tango_id) DO UPDATE SET
       name             = EXCLUDED.name,
       phone_normalized = EXCLUDED.phone_normalized,
       province_code    = EXCLUDED.province_code,
       -- zone solo se asigna si el registro aún no tiene zona
       zone             = COALESCE(contacts.zone, EXCLUDED.zone),
       synced_at        = NOW()`,
    [data.tangoId, data.name, data.phoneNormalized, data.provinceCode, data.zone],
  );
}

// Guarda el ID de Chatwoot una vez que se crea el contacto allá.
export async function setChatwootContactId(
  contactId: number,
  chatwootContactId: number,
): Promise<void> {
  await pool.query(
    `UPDATE contacts SET chatwoot_contact_id = $1 WHERE id = $2`,
    [chatwootContactId, contactId],
  );
}

// Devuelve cuántos contactos quedaron sin zona tras el sync (para el log).
export async function countUnzoned(): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM contacts WHERE zone IS NULL`,
  );
  return parseInt(rows[0].count, 10);
}
