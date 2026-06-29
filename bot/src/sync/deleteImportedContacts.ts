// One-time script: elimina de Chatwoot todos los contactos con "-" en el nombre
// (los importados desde Tango con formato "CODE - Nombre Empresa").
// También resetea chatwoot_contact_id en la bot DB para los contactos eliminados.
//
// Uso en el VPS:
//   docker compose exec bot node dist/sync/deleteImportedContacts.js

import { config } from "../config.js";
import pool from "../db/pool.js";

const BASE = `${config.chatwoot.baseUrl}/api/v1/accounts/${config.chatwoot.accountId}`;
const HDR = { "Content-Type": "application/json", api_access_token: config.chatwoot.agentToken };

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function getPage(page: number): Promise<{ id: number; name: string }[]> {
  const res = await fetch(`${BASE}/contacts?page=${page}`, { headers: HDR });
  if (!res.ok) throw new Error(`GET contacts p${page} → ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { payload?: { id: number; name: string }[] };
  return Array.isArray(body.payload) ? body.payload : [];
}

async function deleteContact(id: number): Promise<void> {
  const res = await fetch(`${BASE}/contacts/${id}`, { method: "DELETE", headers: HDR });
  if (!res.ok) throw new Error(`DELETE ${id} → ${res.status}: ${await res.text()}`);
}

async function main(): Promise<void> {
  console.log("[delete] recorriendo contactos de Chatwoot...");

  let page = 1;
  let deleted = 0;
  let skipped = 0;
  let failed = 0;
  const deletedIds: number[] = [];

  while (true) {
    const contacts = await getPage(page);
    if (contacts.length === 0) break;

    for (const c of contacts) {
      if (!c.name?.includes("-")) {
        skipped++;
        continue;
      }
      try {
        await deleteContact(c.id);
        deletedIds.push(c.id);
        deleted++;
      } catch (err) {
        console.error(`\n[delete] ERROR id=${c.id} "${c.name}": ${(err as Error).message}`);
        failed++;
      }
      await sleep(50);
    }

    process.stdout.write(`\r[delete] página ${page} — eliminados: ${deleted}  saltados: ${skipped}  fallidos: ${failed}`);
    page++;
  }

  process.stdout.write("\n");
  console.log(`\n[delete] ── RESULTADO CHATWOOT ─────────────────`);
  console.log(`  eliminados : ${deleted}`);
  console.log(`  saltados   : ${skipped}`);
  console.log(`  fallidos   : ${failed}`);

  if (deletedIds.length > 0) {
    const result = await pool.query(
      `UPDATE contacts SET chatwoot_contact_id = NULL WHERE chatwoot_contact_id = ANY($1)`,
      [deletedIds],
    );
    console.log(`[delete] bot DB: ${result.rowCount} registros reseteados`);
  }

  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[delete] error fatal:", err);
  process.exit(1);
});
