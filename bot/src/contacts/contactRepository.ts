import pool from "../db/pool.js";

export type DeliveryDay =
  | "monday" | "tuesday" | "wednesday"
  | "thursday" | "friday" | "saturday" | "sunday";

export interface Contact {
  id: number;
  tangoId: string;
  name: string;
  phoneNormalized: string;
  sellerCode: string | null;
  chatwootContactId: number | null;
  optOut: boolean;
}

// Columna SQL para cada día (nombres controlados internamente, sin riesgo de inyección).
const DELIVERY_COL: Record<DeliveryDay, string> = {
  monday:    "delivers_monday",
  tuesday:   "delivers_tuesday",
  wednesday: "delivers_wednesday",
  thursday:  "delivers_thursday",
  friday:    "delivers_friday",
  saturday:  "delivers_saturday",
  sunday:    "delivers_sunday",
};

// Contactos que tienen delivery en el día indicado, aptos para recibir la difusión.
export async function getAudienceByDeliveryDay(day: DeliveryDay): Promise<Contact[]> {
  const col = DELIVERY_COL[day];
  const { rows } = await pool.query<{
    id: number; tango_id: string; name: string; phone_normalized: string;
    seller_code: string | null; chatwoot_contact_id: number | null; opt_out: boolean;
  }>(
    `SELECT id, tango_id, name, phone_normalized, seller_code,
            chatwoot_contact_id, opt_out
     FROM contacts
     WHERE ${col} = TRUE
       AND opt_out = FALSE
       AND phone_normalized IS NOT NULL
       AND phone_normalized <> ''`,
  );
  return rows.map((r) => ({
    id: r.id,
    tangoId: r.tango_id,
    name: r.name,
    phoneNormalized: r.phone_normalized,
    sellerCode: r.seller_code,
    chatwootContactId: r.chatwoot_contact_id,
    optOut: r.opt_out,
  }));
}

// Upsert desde el sync con Tango. Nunca pisa opt_out si ya existe.
export async function upsertContact(data: {
  tangoId: string;
  name: string;
  phoneNormalized: string;
  provinceCode: string | null;
  sellerCode: string | null;
  deliveryDays: {
    monday: boolean; tuesday: boolean; wednesday: boolean;
    thursday: boolean; friday: boolean; saturday: boolean; sunday: boolean;
  };
}): Promise<void> {
  const d = data.deliveryDays;
  await pool.query(
    `INSERT INTO contacts
       (tango_id, name, phone_normalized, province_code, seller_code,
        delivers_monday, delivers_tuesday, delivers_wednesday, delivers_thursday,
        delivers_friday, delivers_saturday, delivers_sunday, synced_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, NOW())
     ON CONFLICT (tango_id) DO UPDATE SET
       name               = EXCLUDED.name,
       phone_normalized   = EXCLUDED.phone_normalized,
       province_code      = EXCLUDED.province_code,
       seller_code        = EXCLUDED.seller_code,
       delivers_monday    = EXCLUDED.delivers_monday,
       delivers_tuesday   = EXCLUDED.delivers_tuesday,
       delivers_wednesday = EXCLUDED.delivers_wednesday,
       delivers_thursday  = EXCLUDED.delivers_thursday,
       delivers_friday    = EXCLUDED.delivers_friday,
       delivers_saturday  = EXCLUDED.delivers_saturday,
       delivers_sunday    = EXCLUDED.delivers_sunday,
       synced_at          = NOW()`,
    [
      data.tangoId, data.name, data.phoneNormalized, data.provinceCode, data.sellerCode,
      d.monday, d.tuesday, d.wednesday, d.thursday, d.friday, d.saturday, d.sunday,
    ],
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

// Cuántos contactos quedaron sin ningún día de entrega configurado.
export async function countWithoutDeliveryDays(): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM contacts
     WHERE delivers_monday = FALSE AND delivers_tuesday = FALSE
       AND delivers_wednesday = FALSE AND delivers_thursday = FALSE
       AND delivers_friday = FALSE AND delivers_saturday = FALSE
       AND delivers_sunday = FALSE`,
  );
  return parseInt(rows[0].count, 10);
}
