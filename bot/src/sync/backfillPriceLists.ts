// Rellena price_list_number en los contactos EXISTENTES de la bot DB.
// NO importa contactos nuevos — solo actualiza los que ya están.
//
// Lógica:
//   1. Trae todos los clientes de Tango.
//   2. Para cada contacto existente en la DB, busca su PriceListNumber en Tango.
//   3. Si no lo encuentra, usa "100" como default.
//   4. Los tango_ids en FORCE_D_PLUS quedan en "400" (D+) sin importar lo que diga Tango.
//
// Uso en el VPS:
//   docker compose exec bot node dist/sync/backfillPriceLists.js

import { fetchAllCustomers } from "./tangoClient.js";
import pool from "../db/pool.js";

// Clientes que queremos forzar a D+ (PriceListNumber 400) sin importar Tango.
const FORCE_D_PLUS = new Set<string>([
  "CAN039",
]);

async function main(): Promise<void> {
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

  console.log(`\n[backfill] ── RESULTADO ──────────────────────────`);
  console.log(`  actualizados desde Tango : ${fromTango}`);
  console.log(`  forzados a D+ (400)      : ${forcedPlus}`);
  console.log(`  sin dato en Tango → 100  : ${defaulted}`);
  console.log(`  TOTAL                    : ${existing.length}`);
  console.log(`────────────────────────────────────────────────`);

  // Verificación: mostrar distribución final
  const { rows: dist } = await pool.query<{ price_list_number: string; count: string }>(
    `SELECT price_list_number, COUNT(*)::int AS count
     FROM contacts GROUP BY price_list_number ORDER BY price_list_number`,
  );
  console.log("\n[backfill] distribución final:");
  for (const r of dist) {
    console.log(`  ${r.price_list_number ?? "NULL"}: ${r.count} contactos`);
  }

  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error("[backfill] error fatal:", err);
  process.exit(1);
});
