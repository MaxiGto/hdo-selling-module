// Importación completa de clientes de Tango → Chatwoot + bot DB.
// Correr DESPUÉS de borrar los contactos en Chatwoot (ver instrucciones en README).
//
// Uso en el VPS:
//   docker compose exec bot node dist/sync/importFromTango.js

import { fetchAllCustomers } from "./tangoClient.js";
import { upsertContact, setChatwootContactId } from "../contacts/contactRepository.js";
import { upsertChatwootContact } from "../chatwoot/chatwootClient.js";
import pool from "../db/pool.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  console.log("[import] obteniendo clientes de Tango...");
  const customers = await fetchAllCustomers();
  console.log(`[import] ${customers.length} clientes activos encontrados`);

  let created = 0;
  let updated = 0;
  let sinTelefono = 0;
  let failed = 0;

  for (const c of customers) {
    if (!c.phone) {
      sinTelefono++;
      continue;
    }

    try {
      // 1. Upsert en bot DB
      await upsertContact({
        tangoId:      c.tangoId,
        name:         c.name,
        phoneNormalized: c.phone,
        provinceCode: c.provinceCode,
        sellerCode:   c.sellerCode,
        deliveryDays: c.deliveryDays,
      });

      // 2. Crear o actualizar en Chatwoot vía API
      const { id: chatwootId, created: isNew } = await upsertChatwootContact({
        tangoId:        c.tangoId,
        name:           c.name,
        businessName:   c.businessName,
        phone:          c.phone,
        email:          c.email,
        address:        c.address,
        city:           c.city,
        postalCode:     c.postalCode,
        provinceCode:   c.provinceCode,
        documentNumber: c.documentNumber,
        sellerCode:     c.sellerCode,
        deliveryDays:   c.deliveryDays,
      });

      // 3. Guardar el ID de Chatwoot en bot DB
      const { rows } = await pool.query<{ id: number }>(
        `SELECT id FROM contacts WHERE tango_id = $1`,
        [c.tangoId],
      );
      if (rows[0]) {
        await setChatwootContactId(rows[0].id, chatwootId);
      }

      isNew ? created++ : updated++;
      const done = created + updated;
      if (done % 100 === 0) console.log(`[import] ${done} procesados...`);
    } catch (err) {
      console.error(`[import] error con ${c.tangoId} (${c.name}):`, (err as Error).message);
      failed++;
    }

    // 100 ms entre requests para no saturar Chatwoot (~10 contactos/s)
    await sleep(100);
  }

  console.log(`\n[import] listo:`);
  console.log(`  creados      : ${created}`);
  console.log(`  actualizados : ${updated}`);
  console.log(`  sin teléfono : ${sinTelefono}`);
  console.log(`  fallidos     : ${failed}`);

  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[import] error fatal:", err);
  process.exit(1);
});
