// Script de prueba: dispara el flujo de difusión para UN contacto específico (por tango_id).
// Uso: node dist/campaigns/testCampaignContact.js CDN001
//
// Útil para debuggear errores de template sin afectar al resto de la audiencia.

import pool from "../db/pool.js";
import {
  findOrCreateContact,
  createConversation,
  sendTemplateMessage,
} from "../chatwoot/chatwootClient.js";
import { setChatwootContactId } from "../contacts/contactRepository.js";
import { CAMPAIGNS } from "./campaignDefinitions.js";

const ART_OFFSET_MS = -3 * 60 * 60 * 1000;
const DAY_NAMES_ES: Record<number, string> = {
  0: "Domingo", 1: "Lunes", 2: "Martes", 3: "Miércoles",
  4: "Jueves", 5: "Viernes", 6: "Sábado",
};

function buildTokens(deliveryOffset: number, endOffset: number) {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const now = new Date(Date.now() + ART_OFFSET_MS);
  const delivery = new Date(now.getTime() + deliveryOffset * DAY_MS);
  const end      = new Date(now.getTime() + endOffset * DAY_MS);
  const endDayName = DAY_NAMES_ES[end.getUTCDay()] ?? "";
  const endDateStr = `${end.getUTCDate()}/${end.getUTCMonth() + 1}`;
  return {
    "{{delivery.dayName}}": DAY_NAMES_ES[delivery.getUTCDay()] ?? "",
    "{{delivery.date}}":    `${delivery.getUTCDate()}/${delivery.getUTCMonth() + 1}`,
    "{{end.dayName}}":      endDayName,
    "{{end.date}}":         endDateStr,
    "{{end.dayAndDate}}":   `${endDayName} ${endDateStr}`,
  };
}

async function main() {
  const tangoId = process.argv[2];
  if (!tangoId) {
    console.error("Uso: node dist/campaigns/testCampaignContact.js <tango_id>");
    process.exit(1);
  }

  // Usamos la primera definición de campaña como referencia de template y fechas
  const def = CAMPAIGNS[0];

  console.log(`[test-campaign] buscando contacto: ${tangoId}`);
  const { rows } = await pool.query<{
    id: number; name: string; phone_normalized: string; chatwoot_contact_id: number | null;
  }>(
    `SELECT id, name, phone_normalized, chatwoot_contact_id
     FROM contacts WHERE tango_id = $1 LIMIT 1`,
    [tangoId],
  );

  if (!rows[0]) {
    console.error(`[test-campaign] contacto "${tangoId}" no encontrado en DB`);
    process.exit(1);
  }

  const contact = rows[0];
  console.log(`[test-campaign] contacto: ${contact.name} | teléfono: ${contact.phone_normalized}`);

  // 1. Chatwoot contact
  let chatwootId = contact.chatwoot_contact_id;
  if (!chatwootId) {
    console.log(`[test-campaign] no tiene chatwoot_contact_id — buscando/creando en Chatwoot...`);
    chatwootId = await findOrCreateContact(contact.name, contact.phone_normalized);
    await setChatwootContactId(contact.id, chatwootId);
    console.log(`[test-campaign] chatwoot_contact_id asignado: ${chatwootId}`);
  } else {
    console.log(`[test-campaign] chatwoot_contact_id existente: ${chatwootId}`);
  }

  // 2. Conversación
  console.log(`[test-campaign] creando conversación...`);
  const conversationId = await createConversation(chatwootId, Number(process.env.CHATWOOT_INBOX_ID ?? 1));
  console.log(`[test-campaign] conversación creada: ${conversationId}`);

  // 3. Resolver variables del template
  const tokens = buildTokens(def.deliveryDateOffset, def.endDayOffset);
  const vars: Record<string, string> = {};
  for (const [key, val] of Object.entries(def.template.variables)) {
    let v = val;
    for (const [token, replacement] of Object.entries(tokens)) v = v.replace(token, replacement);
    vars[key] = v;
  }
  console.log(`[test-campaign] variables del template:`, vars);

  // 4. Enviar template
  console.log(`[test-campaign] enviando template "${def.template.name}"...`);
  await sendTemplateMessage(conversationId, {
    name: def.template.name,
    language: def.template.language,
    variables: vars,
  });

  console.log(`[test-campaign] ✓ template enviado correctamente a ${contact.name} (conv. ${conversationId})`);
}

if (process.argv[1]?.endsWith("testCampaignContact.js")) {
  main()
    .then(() => pool.end())
    .catch((err) => { console.error("[test-campaign] error:", err); pool.end(); process.exit(1); });
}
