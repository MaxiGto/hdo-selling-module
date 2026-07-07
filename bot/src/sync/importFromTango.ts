// Importación completa de clientes de Tango → Chatwoot + bot DB.
// Correr DESPUÉS de borrar los contactos en Chatwoot (ver instrucciones en README).
//
// Uso en el VPS:
//   docker compose exec bot node dist/sync/importFromTango.js

import { fetchAllCustomers, type TangoCustomerFlat } from "./tangoClient.js";
import { upsertContact, setChatwootContactId } from "../contacts/contactRepository.js";
import { upsertChatwootContact } from "../chatwoot/chatwootClient.js";
import pool from "../db/pool.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Deduplica por teléfono: si dos códigos tienen el mismo número conserva el primero.
function deduplicateByPhone(customers: TangoCustomerFlat[]): {
  unique: TangoCustomerFlat[];
  skipped: number;
} {
  const seen = new Map<string, string>(); // phone → tangoId del primero
  const unique: TangoCustomerFlat[] = [];
  let skipped = 0;

  for (const c of customers) {
    if (!c.phone) { unique.push(c); continue; }
    if (seen.has(c.phone)) {
      console.log(`[import] duplicado: ${c.tangoId} (${c.name}) tiene el mismo tel que ${seen.get(c.phone)} → se omite`);
      skipped++;
    } else {
      seen.set(c.phone, c.tangoId);
      unique.push(c);
    }
  }

  return { unique, skipped };
}

async function main(): Promise<void> {
  console.log("[import] obteniendo clientes de Tango...");
  const all = await fetchAllCustomers();
  console.log(`[import] ${all.length} clientes activos encontrados en Tango`);

  const { unique: customers, skipped: dupSkipped } = deduplicateByPhone(all);
  const sinTelefono = customers.filter((c) => !c.phone).length;
  const conTelefono = customers.filter((c) => c.phone).length;
  console.log(`[import] ${dupSkipped} duplicados por teléfono omitidos`);
  console.log(`[import] ${sinTelefono} sin teléfono válido (se omiten)`);
  console.log(`[import] ${conTelefono} a importar\n`);

  let created = 0;
  let updated = 0;
  let failed  = 0;
  const total = conTelefono;

  for (const c of customers) {
    if (!c.phone) continue;

    const done = created + updated + failed;
    process.stdout.write(`\r[import] ${done + 1}/${total}  ${c.tangoId} - ${c.name.slice(0, 40).padEnd(40)}`);

    try {
      // 1. Upsert en bot DB
      await upsertContact({
        tangoId:         c.tangoId,
        name:            c.name,
        phoneNormalized: c.phone,
        provinceCode:    c.provinceCode,
        sellerCode:      c.sellerCode,
        priceListNumber: c.priceListNumber,
        deliveryDays:    c.deliveryDays,
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
    } catch (err) {
      process.stdout.write("\n");
      console.error(`[import] ERROR ${c.tangoId} (${c.name}): ${(err as Error).message}`);
      failed++;
    }

    // 100 ms entre requests para no saturar Chatwoot (~10 contactos/s)
    await sleep(100);
  }

  process.stdout.write("\n");
  console.log(`\n[import] ── RESULTADO ──────────────────────────`);
  console.log(`  contactos agregados  : ${created}`);
  console.log(`  contactos actualizados: ${updated}`);
  console.log(`  duplicados omitidos  : ${dupSkipped}`);
  console.log(`  sin teléfono omitidos: ${sinTelefono}`);
  console.log(`  fallidos             : ${failed}`);
  console.log(`  TOTAL importados     : ${created + updated}`);
  console.log(`────────────────────────────────────────────────`);

  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[import] error fatal:", err);
  process.exit(1);
});
