// Importa todos los clientes de Tango a Chatwoot con la mayor cantidad de datos posible.
// Crea el contacto si no existe (búsqueda por teléfono) o lo actualiza si ya está.
//
// Uso:
//   node dist/scripts/importContactsToChatwoot.js
//
// Recomendado correrlo en screen/tmux ya que puede tardar ~30-40 minutos para 9000 clientes:
//   screen -S importar
//   docker compose exec bot node dist/scripts/importContactsToChatwoot.js
//   Ctrl+A D  (detach y dejar corriendo)

import { fetchAllCustomers } from "../sync/tangoClient.js";
import { upsertChatwootContact } from "../chatwoot/chatwootClient.js";
import { config } from "../config.js";

// Cuántos contactos procesar en paralelo. Mantenerlo bajo para no saturar Chatwoot.
const CONCURRENCY = 5;
// Cada cuántos contactos loguear progreso.
const LOG_EVERY = 50;

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

async function main(): Promise<void> {
  if (!config.chatwoot.agentToken) {
    console.error("[import] CHATWOOT_AGENT_TOKEN no configurado. Abortando.");
    process.exit(1);
  }
  if (!config.tango.accessToken) {
    console.error("[import] TANGO_ACCESS_TOKEN no configurado. Abortando.");
    process.exit(1);
  }

  console.log("[import] Obteniendo clientes de Tango...");
  const customers = await fetchAllCustomers();
  const total = customers.length;
  console.log(`[import] ${total} clientes activos encontrados en Tango.\n`);

  let done = 0;
  let created = 0;
  let updated = 0;
  let sinTelefono = 0;
  let errores = 0;
  const errLog: { tangoId: string; error: string }[] = [];
  const startMs = Date.now();

  // Procesar en lotes de CONCURRENCY en paralelo
  for (let i = 0; i < customers.length; i += CONCURRENCY) {
    const batch = customers.slice(i, i + CONCURRENCY);

    await Promise.all(
      batch.map(async (c) => {
        try {
          if (!c.phone) sinTelefono++;

          const result = await upsertChatwootContact({
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

          if (result.created) created++; else updated++;
        } catch (err) {
          errores++;
          const msg = err instanceof Error ? err.message : String(err);
          errLog.push({ tangoId: c.tangoId, error: msg.slice(0, 120) });
        } finally {
          done++;
        }
      }),
    );

    // Log de progreso
    if (done % LOG_EVERY === 0 || done === total) {
      const pct = ((done / total) * 100).toFixed(1);
      const elapsed = Date.now() - startMs;
      const eta = done > 0
        ? formatDuration((elapsed / done) * (total - done))
        : "—";
      console.log(
        `[import] ${done}/${total} (${pct}%) | +${created} nuevos | ~${updated} act. | sin tel: ${sinTelefono} | ✗ ${errores} | ETA: ${eta}`,
      );
    }
  }

  const elapsed = formatDuration(Date.now() - startMs);
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`[import] COMPLETADO en ${elapsed}`);
  console.log(`  Total procesados : ${total}`);
  console.log(`  Nuevos           : ${created}`);
  console.log(`  Actualizados     : ${updated}`);
  console.log(`  Sin teléfono     : ${sinTelefono}`);
  console.log(`  Errores          : ${errores}`);

  if (errLog.length > 0) {
    console.log("\n[import] Primeros errores:");
    for (const e of errLog.slice(0, 20)) {
      console.log(`  ${e.tangoId}: ${e.error}`);
    }
  }
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
}

main().catch((err) => {
  console.error("[import] Error fatal:", err);
  process.exit(1);
});
