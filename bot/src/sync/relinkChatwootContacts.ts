// Revincula cada contacto de la DB del bot con su contacto de Chatwoot (chatwoot_contact_id).
// Por defecto SIMULA: muestra qué haría sin tocar nada. Con --aplicar escribe.
//
// Uso en el VPS:
//   docker compose exec bot node dist/sync/relinkChatwootContacts.js
//   docker compose exec bot node dist/sync/relinkChatwootContacts.js --aplicar
//
// Reglas:
// - Un cliente suele tener perfil C (factura) y X (remito) con el mismo celular. El contacto de
//   Chatwoot queda vinculado solo al C; el X no se vincula si existe su C.
// - Celulares inválidos (+5415..., número local sin código de área) no se crean en Chatwoot.
// - Respeta los límites de la API de Chatwoot (100 búsquedas/min) y reintenta ante un 429.

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

// Separación mínima entre pedidos de cada tipo: la búsqueda tiene un límite propio de 100/min
// y todo el resto comparte 3000/min con el bot, que usa la misma IP para atender clientes.
const MIN_GAP_MS = { get: 100, search: 750, write: 300 };
const lastCall: Record<keyof typeof MIN_GAP_MS, number> = { get: 0, search: 0, write: 0 };

async function cw(kind: keyof typeof MIN_GAP_MS, path: string, init?: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const wait = lastCall[kind] + MIN_GAP_MS[kind] - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall[kind] = Date.now();
    const res = await fetch(`${BASE}${path}`, { ...init, headers: HDR });
    if (res.status !== 429 || attempt >= 5) return res;
    const retryAfter = Number(res.headers.get("retry-after"));
    const ms = (retryAfter > 0 ? retryAfter : 30) * 1000;
    console.log(`[relink] Chatwoot pidió bajar el ritmo (429), reintento en ${ms / 1000}s`);
    await sleep(ms);
  }
}

async function contactExists(id: number): Promise<boolean> {
  const res = await cw("get", `/contacts/${id}`);
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`GET contacto ${id} → ${res.status}`);
  return true;
}

async function search(q: string): Promise<CWContact[]> {
  const res = await cw("search", `/contacts/search?q=${encodeURIComponent(q)}&page=1`);
  if (!res.ok) throw new Error(`búsqueda "${q}" → ${res.status}`);
  const body = (await res.json()) as { payload?: CWContact[] };
  return Array.isArray(body.payload) ? body.payload : [];
}

// +5415... es un celular cargado con "15" en lugar del código de área: no es un número válido.
function cleanPhone(raw: string): string | null {
  const n = normalizeArgentinePhone(raw);
  if (!n || n.startsWith("+5415")) return null;
  return n;
}

// Chatwoot puede tener el celular como +54... o +549...: se busca por los últimos 10 dígitos
// y se compara normalizado. Si no aparece por celular, se busca por código de Tango.
async function findCandidates(tangoId: string, phone: string): Promise<CWContact[]> {
  const last10 = phone.replace(/\D/g, "").slice(-10);
  const byPhone = (await search(last10)).filter(
    (x) => x.phone_number && normalizeArgentinePhone(x.phone_number) === phone,
  );
  if (byPhone.length > 0) return byPhone;
  return (await search(tangoId)).filter((x) => x.identifier === tangoId);
}

// Con duplicados: prioriza el que tiene el código de Tango, después el de actividad más reciente.
function pickBest(tangoId: string, candidates: CWContact[]): CWContact {
  return [...candidates].sort((a, b) => {
    const idA = a.identifier === tangoId ? 1 : 0;
    const idB = b.identifier === tangoId ? 1 : 0;
    if (idA !== idB) return idB - idA;
    const actA = a.last_activity_at ?? 0;
    const actB = b.last_activity_at ?? 0;
    if (actA !== actB) return actB - actA;
    return a.id - b.id;
  })[0];
}

async function createContact(c: BotContact, phone: string): Promise<number> {
  const res = await cw("write", "/contacts", {
    method: "POST",
    body: JSON.stringify({
      name: c.name,
      phone_number: phone,
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

const isRemitoOf = (x: string, c: string) => x.startsWith("X") && c.startsWith("C") && x.slice(1) === c.slice(1);

async function setLink(c: BotContact, chatwootId: number | null) {
  c.chatwoot_contact_id = chatwootId;
  if (APPLY) await pool.query(`UPDATE contacts SET chatwoot_contact_id = $1 WHERE id = $2`, [chatwootId, c.id]);
}

async function run() {
  console.log(`[relink] modo: ${APPLY ? "APLICAR (escribe en Chatwoot y en la DB)" : "SIMULACIÓN (no modifica nada)"}`);

  const { rows: contacts } = await pool.query<BotContact>(
    `SELECT id, tango_id, name, phone_normalized, chatwoot_contact_id
     FROM contacts
     WHERE phone_normalized IS NOT NULL AND phone_normalized <> ''
     ORDER BY tango_id`,
  );
  const byCode = new Map(contacts.map((c) => [c.tango_id, c]));
  console.log(`[relink] ${contacts.length} contactos con teléfono en la DB del bot`);

  let ok = 0, linked = 0, created = 0, reassigned = 0, xUnlinked = 0, xSkipped = 0;
  const normalized: string[] = [];
  const invalid: string[] = [];
  const duplicates: string[] = [];
  const shared: string[] = [];
  const errors: string[] = [];

  // 1. Perfiles X vinculados al mismo contacto de Chatwoot que su C: se desvinculan.
  const holders = new Map<number, BotContact[]>();
  for (const c of contacts) {
    if (!c.chatwoot_contact_id) continue;
    holders.set(c.chatwoot_contact_id, [...(holders.get(c.chatwoot_contact_id) ?? []), c]);
  }
  for (const group of holders.values()) {
    if (group.length < 2) continue;
    for (const x of group) {
      if (group.some((c) => isRemitoOf(x.tango_id, c.tango_id))) {
        await setLink(x, null);
        xUnlinked++;
      }
    }
  }

  // Qué contacto del bot ocupa cada ID de Chatwoot, para no asignar el mismo a dos clientes.
  const owner = new Map<number, BotContact>();
  for (const c of contacts) if (c.chatwoot_contact_id) owner.set(c.chatwoot_contact_id, c);

  // 2. Revisión contacto por contacto (los C se procesan antes que los X por el orden alfabético).
  for (const c of contacts) {
    try {
      const phone = cleanPhone(c.phone_normalized);
      if (phone && phone !== c.phone_normalized) {
        normalized.push(`${c.tango_id}: ${c.phone_normalized} → ${phone}`);
        if (APPLY) await pool.query(`UPDATE contacts SET phone_normalized = $1 WHERE id = $2`, [phone, c.id]);
      }

      if (c.chatwoot_contact_id) {
        if (await contactExists(c.chatwoot_contact_id)) { ok++; continue; }
        console.log(`[relink] ${c.tango_id}: el ID ${c.chatwoot_contact_id} ya no existe en Chatwoot`);
        owner.delete(c.chatwoot_contact_id);
        await setLink(c, null);
      }

      const pairC = c.tango_id.startsWith("X") ? byCode.get(`C${c.tango_id.slice(1)}`) : undefined;
      if (pairC) { xSkipped++; continue; }

      if (!phone) {
        invalid.push(`${c.tango_id}: ${c.phone_normalized}`);
        continue;
      }

      const candidates = await findCandidates(c.tango_id, phone);
      if (candidates.length === 0) {
        if (APPLY) {
          const id = await createContact(c, phone);
          await setLink(c, id);
          owner.set(id, c);
          console.log(`[relink] ${c.tango_id}: creado en Chatwoot → ${id}`);
        } else {
          console.log(`[relink] ${c.tango_id}: se crearía en Chatwoot (${phone})`);
        }
        created++;
        continue;
      }

      const best = pickBest(c.tango_id, candidates);
      if (candidates.length > 1) {
        duplicates.push(`${c.tango_id} → elegido ${best.id}, otros: ${candidates.filter((x) => x.id !== best.id).map((x) => x.id).join(", ")}`);
      }

      const takenBy = owner.get(best.id);
      if (takenBy && takenBy !== c) {
        if (isRemitoOf(takenBy.tango_id, c.tango_id)) {
          await setLink(takenBy, null);
          reassigned++;
          console.log(`[relink] ${c.tango_id}: toma el contacto ${best.id} que tenía su perfil ${takenBy.tango_id}`);
        } else {
          shared.push(`${c.tango_id} y ${takenBy.tango_id} → Chatwoot ${best.id} (${phone})`);
          continue;
        }
      } else {
        console.log(`[relink] ${c.tango_id}: ${APPLY ? "vinculado" : "se vincularía"} a ${best.id}`);
        linked++;
      }
      await setLink(c, best.id);
      owner.set(best.id, c);
    } catch (err) {
      errors.push(`${c.tango_id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const verb = APPLY ? "" : " (simulado)";
  console.log(`\n[relink] ===== RESUMEN${verb} =====`);
  console.log(`  Ya vinculados correctamente: ${ok}`);
  console.log(`  Vinculados a un contacto existente: ${linked}`);
  console.log(`  Creados en Chatwoot: ${created}`);
  console.log(`  Contacto pasado del perfil X a su perfil C: ${reassigned}`);
  console.log(`  Perfiles X desvinculados (compartían contacto con su C): ${xUnlinked}`);
  console.log(`  Perfiles X sin vincular porque existe su C: ${xSkipped}`);
  console.log(`  Celulares corregidos de formato en la DB del bot: ${normalized.length}`);
  normalized.forEach((n) => console.log(`    - ${n}`));
  console.log(`  Celulares inválidos (corregir en Tango): ${invalid.length}`);
  invalid.forEach((i) => console.log(`    - ${i}`));
  console.log(`  Con duplicados en Chatwoot (revisar a mano): ${duplicates.length}`);
  duplicates.forEach((d) => console.log(`    - ${d}`));
  console.log(`  Celular compartido entre clientes distintos (no vinculados): ${shared.length}`);
  shared.forEach((s) => console.log(`    - ${s}`));
  console.log(`  Errores: ${errors.length}`);
  errors.forEach((e) => console.log(`    - ${e}`));
  if (!APPLY) console.log(`\n  Para aplicar los cambios: node dist/sync/relinkChatwootContacts.js --aplicar`);
}

run()
  .then(() => pool.end())
  .catch((err) => { console.error("[relink] error fatal:", err); process.exit(1); });
