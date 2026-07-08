// Rellena price_list_number en los contactos EXISTENTES de la bot DB.
// NO importa contactos nuevos — solo actualiza los que ya están.
//
// Lógica:
//   1. Trae todos los clientes de Tango.
//   2. Para cada contacto existente en la DB, busca su PriceListNumber en Tango.
//   3. Si no lo encuentra, usa "100" como default.
//   4. Los tango_ids en FORCE_D_PLUS quedan en "400" (D+) sin importar lo que diga Tango.
//   5. Los INTERNAL_D_PLUS son cuentas internas (no Tango) que también van como D+.
//      Se buscan por teléfono en Chatwoot y se insertan en la bot DB si no están.
//
// Uso en el VPS:
//   docker compose exec bot node dist/sync/backfillPriceLists.js

import { fetchAllCustomers } from "./tangoClient.js";
import { normalizeArgentinePhone } from "./tangoClient.js";
import { config } from "../config.js";
import pool from "../db/pool.js";

// tango_ids que forzamos a D+ (existen en Tango y en la bot DB).
const FORCE_D_PLUS = new Set<string>([
  "CAN039",
]);

// Cuentas internas (no Tango) que deben recibir tratamiento D+.
// Se identifican por teléfono en Chatwoot y se insertan en la bot DB si no existen.
const INTERNAL_D_PLUS: { name: string; phone: string }[] = [
  { name: "Sabrina Barrionuevo", phone: "+5491134291284" },
  { name: "Maxi GT",             phone: "+5491123996330" },
];

function agentHeaders() {
  return { "Content-Type": "application/json", api_access_token: config.chatwoot.agentToken };
}

function accountUrl(path: string): string {
  return `${config.chatwoot.baseUrl}/api/v1/accounts/${config.chatwoot.accountId}${path}`;
}

// Busca un contacto en Chatwoot por teléfono y devuelve su id, o null si no existe.
async function findChatwootIdByPhone(phone: string): Promise<number | null> {
  const res = await fetch(
    accountUrl(`/contacts/search?q=${encodeURIComponent(phone)}&page=1`),
    { headers: agentHeaders() },
  );
  if (!res.ok) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body = (await res.json()) as any;
  const list: { id: number }[] = Array.isArray(body?.payload) ? body.payload : [];
  return list.length > 0 && list[0].id ? list[0].id : null;
}

async function main(): Promise<void> {
  // ── Paso 1: actualizar contactos existentes desde Tango ──────────────────
  console.log("[backfill] obteniendo clientes de Tango...");
  const all = await fetchAllCustomers();
  const tangoMap = new Map(all.map((c) => [c.tangoId, c.priceListNumber]));
  console.log(`[backfill] ${tangoMap.size} clientes activos en Tango`);

  const { rows: existing } = await pool.query<{ id: number; tango_id: string; name: string }>(
    `SELECT id, tango_id, name FROM contacts ORDER BY tango_id`,
  );
  console.log(`[backfill] ${existing.length} contactos en la DB del bot\n`);

  let fromTango  = 0;
  let forcedPlus = 0;
  let defaulted  = 0;

  for (const contact of existing) {
    let priceListNumber: string;

    if (FORCE_D_PLUS.has(contact.tango_id)) {
      priceListNumber = "400";
      forcedPlus++;
      console.log(`[backfill] D+ forzado : ${contact.tango_id} (${contact.name})`);
    } else {
      const tangoPrice = tangoMap.get(contact.tango_id);
      if (tangoPrice) {
        priceListNumber = tangoPrice;
        fromTango++;
      } else {
        priceListNumber = "100";
        defaulted++;
        console.log(`[backfill] no en Tango → 100: ${contact.tango_id} (${contact.name})`);
      }
    }

    await pool.query(
      `UPDATE contacts SET price_list_number = $1 WHERE id = $2`,
      [priceListNumber, contact.id],
    );
  }

  // ── Paso 2: cuentas internas D+ (Sabrina, Maxi) ─────────────────────────
  console.log("\n[backfill] procesando cuentas internas D+...");
  for (const internal of INTERNAL_D_PLUS) {
    const phoneNorm = normalizeArgentinePhone(internal.phone);
    if (!phoneNorm) {
      console.log(`[backfill] SKIP ${internal.name}: teléfono inválido`);
      continue;
    }

    // Ver si ya existe en la bot DB por teléfono
    const { rows: found } = await pool.query<{ id: number }>(
      `SELECT id FROM contacts WHERE phone_normalized = $1`,
      [phoneNorm],
    );

    if (found.length > 0) {
      // Ya existe → solo actualizar price_list_number
      await pool.query(
        `UPDATE contacts SET price_list_number = '400' WHERE id = $1`,
        [found[0].id],
      );
      console.log(`[backfill] D+ (existente): ${internal.name} (${phoneNorm})`);
      continue;
    }

    // No existe en bot DB → buscar en Chatwoot por su teléfono (+549...)
    const chatwootId = await findChatwootIdByPhone(internal.phone);
    if (!chatwootId) {
      console.log(`[backfill] SKIP ${internal.name}: no encontrado en Chatwoot`);
      continue;
    }

    // Insertar con un tango_id placeholder para cumplir con el UNIQUE NOT NULL
    const placeholderTangoId = `__INT:${phoneNorm}__`;
    await pool.query(
      `INSERT INTO contacts
         (tango_id, name, phone_normalized, chatwoot_contact_id, price_list_number,
          delivers_monday, delivers_tuesday, delivers_wednesday, delivers_thursday,
          delivers_friday, delivers_saturday, delivers_sunday)
       VALUES ($1,$2,$3,$4,'400', FALSE,FALSE,FALSE,FALSE,FALSE,FALSE,FALSE)
       ON CONFLICT (tango_id) DO UPDATE SET
         price_list_number  = '400',
         chatwoot_contact_id = EXCLUDED.chatwoot_contact_id`,
      [placeholderTangoId, internal.name, phoneNorm, chatwootId],
    );
    console.log(`[backfill] D+ (nuevo)    : ${internal.name} (${phoneNorm}) → chatwoot_id=${chatwootId}`);
  }

  // ── Resumen ──────────────────────────────────────────────────────────────
  console.log(`\n[backfill] ── RESULTADO ──────────────────────────`);
  console.log(`  actualizados desde Tango : ${fromTango}`);
  console.log(`  forzados a D+ (Tango)    : ${forcedPlus}`);
  console.log(`  sin dato en Tango → 100  : ${defaulted}`);
  console.log(`  TOTAL                    : ${existing.length}`);
  console.log(`────────────────────────────────────────────────`);

  // Distribución final
  const { rows: dist } = await pool.query<{ price_list_number: string; count: string }>(
    `SELECT COALESCE(price_list_number, 'NULL') AS price_list_number, COUNT(*)::int AS count
     FROM contacts GROUP BY price_list_number ORDER BY price_list_number`,
  );
  console.log("\n[backfill] distribución final:");
  for (const r of dist) {
    console.log(`  ${r.price_list_number}: ${r.count} contactos`);
  }

  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error("[backfill] error fatal:", err);
  process.exit(1);
});
