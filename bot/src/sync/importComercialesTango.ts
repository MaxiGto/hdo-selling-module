// Importa desde Tango solo los clientes "comercio" (PriceListNumber 100 o 101)
// a la bot DB y a Chatwoot. Deduplica por teléfono.
//
// Correr DESPUÉS de deleteImportedContacts.js
//
// Uso en el VPS:
//   docker compose exec bot node dist/sync/importComercialesTango.js

import { fetchAllCustomers, type TangoCustomerFlat } from "./tangoClient.js";
import { upsertContact, setChatwootContactId } from "../contacts/contactRepository.js";
import { upsertChatwootContact } from "../chatwoot/chatwootClient.js";
import pool from "../db/pool.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function deduplicateByPhone(customers: TangoCustomerFlat[]): {
  unique: TangoCustomerFlat[];
  skipped: number;
} {
  const seen = new Map<string, string>();
  const unique: TangoCustomerFlat[] = [];
  let skipped = 0;
  for (const c of customers) {
    if (!c.phone) { unique.push(c); continue; }
    if (seen.has(c.phone)) {
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
  console.log(`[import] ${all.length} clientes activos en Tango`);

  const comerciales = all.filter((c) => c.priceListNumber === "100" || c.priceListNumber === "101");
  console.log(`[import] ${comerciales.length} con lista de precios 100 o 101`);

  const { unique: customers, skipped: dupSkipped } = deduplicateByPhone(comerciales);
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
      await upsertContact({
        tangoId:         c.tangoId,
        name:            c.name,
        phoneNormalized: c.phone,
        provinceCode:    c.provinceCode,
        sellerCode:      c.sellerCode,
        deliveryDays:    c.deliveryDays,
      });

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

      const { rows } = await pool.query<{ id: number }>(
        `SELECT id FROM contacts WHERE tango_id = $1`,
        [c.tangoId],
      );
      if (rows[0]) await setChatwootContactId(rows[0].id, chatwootId);

      isNew ? created++ : updated++;
    } catch (err) {
      process.stdout.write("\n");
      console.error(`[import] ERROR ${c.tangoId} (${c.name}): ${(err as Error).message}`);
      failed++;
    }

    await sleep(100);
  }

  process.stdout.write("\n");
  console.log(`\n[import] ── RESULTADO ──────────────────────────`);
  console.log(`  contactos agregados   : ${created}`);
  console.log(`  contactos actualizados: ${updated}`);
  console.log(`  duplicados omitidos   : ${dupSkipped}`);
  console.log(`  sin teléfono omitidos : ${sinTelefono}`);
  console.log(`  fallidos              : ${failed}`);
  console.log(`  TOTAL importados      : ${created + updated}`);
  console.log(`────────────────────────────────────────────────`);

  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[import] error fatal:", err);
  process.exit(1);
});
