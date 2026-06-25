// One-time script: re-aplica el teléfono de cada contacto de Tango via la API de Chatwoot.
// Fuerza que Rails procese el número (validación + invalidación de caché) sin borrar nada.
//
// Uso en el VPS:
//   docker compose exec bot node dist/sync/fixChatwootPhones.js

import { config } from "../config.js";

const BASE = `${config.chatwoot.baseUrl}/api/v1/accounts/${config.chatwoot.accountId}`;
const HDR = {
  "Content-Type": "application/json",
  api_access_token: config.chatwoot.agentToken,
};

interface CWContact {
  id: number;
  identifier: string | null;
  phone_number: string | null;
  name: string;
}

interface PageResponse {
  payload?: CWContact[];
  meta?: { count: number; current_page: number };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function getPage(page: number): Promise<CWContact[]> {
  const res = await fetch(`${BASE}/contacts?page=${page}`, { headers: HDR });
  if (!res.ok) throw new Error(`GET contacts page ${page} → ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as PageResponse;
  return Array.isArray(body.payload) ? body.payload : [];
}

async function patchPhone(id: number, phone: string): Promise<{ ok: boolean; body: string }> {
  const res = await fetch(`${BASE}/contacts/${id}`, {
    method: "PATCH",
    headers: HDR,
    body: JSON.stringify({ phone_number: phone }),
  });
  return { ok: res.ok, body: await res.text() };
}

async function main(): Promise<void> {
  console.log("[fixPhones] iniciando...");

  let page = 1;
  let fixed = 0;
  let skipped = 0;
  let failed = 0;
  let firstError: string | null = null;

  while (true) {
    const contacts = await getPage(page);
    if (contacts.length === 0) break;

    console.log(`[fixPhones] página ${page} — ${contacts.length} contactos`);

    for (const c of contacts) {
      // Solo contactos de Tango (tienen identifier) con teléfono cargado
      if (!c.identifier || !c.phone_number) {
        skipped++;
        continue;
      }

      const { ok, body } = await patchPhone(c.id, c.phone_number);
      if (ok) {
        fixed++;
        if (fixed % 100 === 0) console.log(`[fixPhones] ${fixed} arreglados...`);
      } else {
        if (!firstError) {
          // Mostrar el primer error para diagnosticar el formato
          console.error(`[fixPhones] primer error — ${c.identifier} (ID ${c.id}) phone="${c.phone_number}": ${body}`);
          firstError = body;
        }
        failed++;
      }

      // 50 ms entre requests (~20/s) para no saturar Chatwoot
      await sleep(50);
    }

    page++;
  }

  console.log(`\n[fixPhones] listo`);
  console.log(`  arreglados : ${fixed}`);
  console.log(`  saltados   : ${skipped} (sin identifier o sin teléfono)`);
  console.log(`  fallidos   : ${failed}`);

  if (failed > 0) {
    console.log("\n[fixPhones] ATENCIÓN: hubo errores. Ver primer error arriba.");
    console.log("Si el error menciona validación del teléfono, el formato +54XX no es aceptado por Chatwoot.");
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[fixPhones] error fatal:", err);
  process.exit(1);
});
