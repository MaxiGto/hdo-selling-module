// Revincula cada contacto de la DB del bot con su contacto de Chatwoot (chatwoot_contact_id).
// Por defecto SIMULA: muestra qué haría sin tocar nada. Con --aplicar escribe.
//
// Uso en el VPS:
//   docker compose exec bot node dist/sync/relinkChatwootContacts.js
//   docker compose exec bot node dist/sync/relinkChatwootContacts.js --aplicar

import pool from "../db/pool.js";
import { config } from "../config.js";
import { normalizeArgentinePhone } from "./tangoClient.js";

const APPLY = process.argv.includes("--aplicar");
const BASE = `${config.chatwoot.baseUrl}/api/v1/accounts/${config.chatwoot.accountId}`;
const HDR = { "Content-Type": "application/json", api_access_token: config.chatwoot.agentToken };

interface CWContact {
  id: number;
  name: string;
  phone_number: string | null;
  identifier: string | null;
  last_activity_at: number | null;
}

interface BotContact {
  id: number;
  tango_id: string;
  name: string;
  phone_normalized: string;
  chatwoot_contact_id: number | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function contactExists(id: number): Promise<boolean> {
  const res = await fetch(`${BASE}/contacts/${id}`, { headers: HDR });
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`GET contacto ${id} → ${res.status}`);
  return true;
}

async function search(q: string): Promise<CWContact[]> {
  const res = await fetch(`${BASE}/contacts/search?q=${encodeURIComponent(q)}&page=1`, { headers: HDR });
  if (!res.ok) throw new Error(`búsqueda "${q}" → ${res.status}`);
  const body = (await res.json()) as { payload?: CWContact[] };
  return Array.isArray(body.payload) ? body.payload : [];
}

// Chatwoot puede tener el celular como +54... o +549...; se compara normalizado.
async function findCandidates(c: BotContact): Promise<CWContact[]> {
  const byId = (await search(c.tango_id)).filter((x) => x.identifier === c.tango_id);
  const last10 = c.phone_normalized.replace(/\D/g, "").slice(-10);
  const byPhone = (await search(last10)).filter(
    (x) => x.phone_number && normalizeArgentinePhone(x.phone_number) === c.phone_normalized,
  );
  const unique = new Map<number, CWContact>();
  for (const x of [...byId, ...byPhone]) unique.set(x.id, x);
  return [...unique.values()];
}

// Con duplicados: prioriza el que tiene el código de Tango, después el de actividad más reciente.
function pickBest(c: BotContact, candidates: CWContact[]): CWContact {
  return [...candidates].sort((a, b) => {
    const idA = a.identifier === c.tango_id ? 1 : 0;
    const idB = b.identifier === c.tango_id ? 1 : 0;
    if (idA !== idB) return idB - idA;
    const actA = a.last_activity_at ?? 0;
    const actB = b.last_activity_at ?? 0;
    if (actA !== actB) return actB - actA;
    return a.id - b.id;
  })[0];
}

async function createContact(c: BotContact): Promise<number> {
  const res = await fetch(`${BASE}/contacts`, {
    method: "POST",
    headers: HDR,
    body: JSON.stringify({
      name: c.name,
      phone_number: c.phone_normalized,
      identifier: c.tango_id,
      inbox_id: config.chatwoot.inboxId,
    }),
  });
  if (!res.ok) throw new Error(`crear contacto → ${res.status}: ${await res.text()}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body = (await res.json()) as any;
  const id: unknown = body?.payload?.contact?.id ?? body?.payload?.id ?? body?.id;
  if (typeof id !== "number") throw new Error(`crear contacto: respuesta sin id: ${JSON.stringify(body)}`);
  return id;
}

async function run() {
  console.log(`[relink] modo: ${APPLY ? "APLICAR (escribe en Chatwoot y en la DB)" : "SIMULACIÓN (no modifica nada)"}`);

  const { rows: contacts } = await pool.query<BotContact>(
    `SELECT id, tango_id, name, phone_normalized, chatwoot_contact_id
     FROM contacts
     WHERE phone_normalized IS NOT NULL AND phone_normalized <> ''
     ORDER BY tango_id`,
  );
  console.log(`[relink] ${contacts.length} contactos con teléfono en la DB del bot`);

  // Qué contacto del bot ocupa cada ID de Chatwoot, para no asignar el mismo a dos clientes.
  const owner = new Map<number, string>();
  for (const c of contacts) if (c.chatwoot_contact_id) owner.set(c.chatwoot_contact_id, c.tango_id);

  let ok = 0, linked = 0, created = 0;
  const duplicates: string[] = [];
  const shared: string[] = [];
  const errors: string[] = [];

  for (const c of contacts) {
    try {
      if (c.chatwoot_contact_id) {
        if (await contactExists(c.chatwoot_contact_id)) { ok++; continue; }
        console.log(`[relink] ${c.tango_id}: el ID ${c.chatwoot_contact_id} ya no existe en Chatwoot`);
        owner.delete(c.chatwoot_contact_id);
      }

      const candidates = await findCandidates(c);
      let chatwootId: number;

      if (candidates.length === 0) {
        if (APPLY) {
          chatwootId = await createContact(c);
          console.log(`[relink] ${c.tango_id}: creado en Chatwoot → ${chatwootId}`);
        } else {
          console.log(`[relink] ${c.tango_id}: se crearía en Chatwoot (${c.phone_normalized})`);
          created++;
          continue;
        }
        created++;
      } else {
        const best = pickBest(c, candidates);
        if (candidates.length > 1) {
          duplicates.push(`${c.tango_id} → elegido ${best.id}, otros: ${candidates.filter((x) => x.id !== best.id).map((x) => x.id).join(", ")}`);
        }
        const takenBy = owner.get(best.id);
        if (takenBy && takenBy !== c.tango_id) {
          shared.push(`${c.tango_id} y ${takenBy} → Chatwoot ${best.id} (${c.phone_normalized})`);
          continue;
        }
        chatwootId = best.id;
        console.log(`[relink] ${c.tango_id}: ${APPLY ? "vinculado" : "se vincularía"} a ${chatwootId}`);
        linked++;
      }

      owner.set(chatwootId, c.tango_id);
      if (APPLY) {
        await pool.query(`UPDATE contacts SET chatwoot_contact_id = $1 WHERE id = $2`, [chatwootId, c.id]);
      }
    } catch (err) {
      errors.push(`${c.tango_id}: ${err instanceof Error ? err.message : String(err)}`);
    }
    await sleep(100);
  }

  const verb = APPLY ? "" : " (simulado)";
  console.log(`\n[relink] ===== RESUMEN${verb} =====`);
  console.log(`  Ya vinculados correctamente: ${ok}`);
  console.log(`  Vinculados a un contacto existente: ${linked}`);
  console.log(`  Creados en Chatwoot: ${created}`);
  console.log(`  Con duplicados en Chatwoot (revisar a mano): ${duplicates.length}`);
  duplicates.forEach((d) => console.log(`    - ${d}`));
  console.log(`  Teléfono compartido entre clientes (no vinculados): ${shared.length}`);
  shared.forEach((s) => console.log(`    - ${s}`));
  console.log(`  Errores: ${errors.length}`);
  errors.forEach((e) => console.log(`    - ${e}`));
  if (!APPLY) console.log(`\n  Para aplicar los cambios: node dist/sync/relinkChatwootContacts.js --aplicar`);
}

run()
  .then(() => pool.end())
  .catch((err) => { console.error("[relink] error fatal:", err); process.exit(1); });
