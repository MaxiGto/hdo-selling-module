// Borra TODOS los contactos de Chatwoot. Usar antes de reimportar desde Tango.
// También borra las conversaciones asociadas (cascade en Chatwoot).
//
// Uso:
//   docker compose exec bot node dist/scripts/deleteAllContacts.js

import { config } from "../config.js";

const ACCOUNT_URL = `${config.chatwoot.baseUrl}/api/v1/accounts/${config.chatwoot.accountId}`;
const HEADERS = {
  "Content-Type": "application/json",
  api_access_token: config.chatwoot.agentToken,
};

async function fetchPage1(): Promise<number[]> {
  const res = await fetch(`${ACCOUNT_URL}/contacts?page=1`, { headers: HEADERS });
  if (!res.ok) throw new Error(`GET /contacts falló (${res.status}): ${await res.text()}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body = (await res.json()) as any;
  const contacts: { id: number }[] = body?.payload ?? [];
  return contacts.map((c) => c.id);
}

async function deleteContact(id: number): Promise<void> {
  const res = await fetch(`${ACCOUNT_URL}/contacts/${id}`, {
    method: "DELETE",
    headers: HEADERS,
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`(${res.status}): ${await res.text()}`);
  }
}

async function main(): Promise<void> {
  if (!config.chatwoot.agentToken) {
    console.error("[delete] CHATWOOT_AGENT_TOKEN no configurado. Abortando.");
    process.exit(1);
  }
  if (!config.chatwoot.accountId) {
    console.error("[delete] CHATWOOT_ACCOUNT_ID no configurado. Abortando.");
    process.exit(1);
  }

  console.log("[delete] Borrando todos los contactos de Chatwoot...");
  console.log("[delete] ATENCIÓN: esto también borra las conversaciones asociadas.\n");

  let totalDeleted = 0;
  let totalErrors = 0;

  while (true) {
    const ids = await fetchPage1();
    if (ids.length === 0) break;

    await Promise.all(
      ids.map(async (id) => {
        try {
          await deleteContact(id);
          totalDeleted++;
        } catch (err) {
          totalErrors++;
          console.error(`  ✗ ID ${id}:`, err instanceof Error ? err.message : String(err));
        }
      }),
    );

    console.log(`[delete] Borrados: ${totalDeleted} | Errores: ${totalErrors}`);
  }

  console.log(`\n[delete] COMPLETADO. Total borrados: ${totalDeleted} | Errores: ${totalErrors}`);
}

main().catch((err) => {
  console.error("[delete] Error fatal:", err);
  process.exit(1);
});
