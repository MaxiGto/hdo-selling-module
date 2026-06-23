import { getAudienceByDeliveryDay, setChatwootContactId } from "../contacts/contactRepository.js";
import {
  findOrCreateContact,
  createConversation,
  sendTemplateMessage,
} from "../chatwoot/chatwootClient.js";
import pool from "../db/pool.js";
import type { CampaignDefinition } from "./campaignDefinitions.js";
import { config } from "../config.js";

// Argentina es UTC-3 fijo, sin horario de verano.
const ART_OFFSET_MS = -3 * 60 * 60 * 1000;

const DAY_NAMES_ES: Record<number, string> = {
  0: "Domingo",
  1: "Lunes",
  2: "Martes",
  3: "Miércoles",
  4: "Jueves",
  5: "Viernes",
  6: "Sábado",
};

// Calcula las fechas de entrega y corte de pedidos usando la hora local de Argentina.
// Ambos offsets son relativos al día de envío (sendDay = hoy cuando corre el cron).
function buildDateTokens(deliveryDateOffset: number, endDayOffset: number): Record<string, string> {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const nowART = new Date(Date.now() + ART_OFFSET_MS);
  const delivery = new Date(nowART.getTime() + deliveryDateOffset * DAY_MS);
  const endDay  = new Date(nowART.getTime() + endDayOffset * DAY_MS);

  return {
    "{{delivery.dayName}}": DAY_NAMES_ES[delivery.getUTCDay()] ?? "",
    "{{delivery.date}}":    `${delivery.getUTCDate()}/${delivery.getUTCMonth() + 1}`,
    "{{end.dayName}}":      DAY_NAMES_ES[endDay.getUTCDay()] ?? "",
  };
}

// Reemplaza tokens en los valores de las variables del template.
function resolveVars(
  vars: Record<string, string>,
  tokens: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(vars)) {
    let v = val;
    for (const [token, replacement] of Object.entries(tokens)) {
      v = v.replace(token, replacement);
    }
    result[key] = v;
  }
  return result;
}

export async function runCampaign(def: CampaignDefinition): Promise<void> {
  const label = `${def.sendDay} → ${def.deliveryDay}`;
  console.log(`[campaign] iniciando difusión (${label})...`);

  const audience = await getAudienceByDeliveryDay(def.deliveryDay);
  if (audience.length === 0) {
    console.log(`[campaign] sin contactos con entrega "${def.deliveryDay}" — saltando`);
    return;
  }

  const tokens = buildDateTokens(def.deliveryDateOffset, def.endDayOffset);
  const resolvedVars = resolveVars(def.template.variables, tokens);
  console.log(
    `[campaign] entrega: ${resolvedVars["1"]} ${resolvedVars["2"]}` +
    ` | corte: ${resolvedVars["3"]} ${resolvedVars["4"]}` +
    ` | audiencia: ${audience.length} contactos`,
  );

  const campaignName = `difusion_${def.sendDay}_${def.deliveryDay}`;
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO campaign_runs (campaign_name, contacts_count)
     VALUES ($1, $2) RETURNING id`,
    [campaignName, audience.length],
  );
  const runId = rows[0].id;

  let sent = 0;
  let failed = 0;

  for (const contact of audience) {
    try {
      let chatwootId = contact.chatwootContactId;
      if (!chatwootId) {
        chatwootId = await findOrCreateContact(contact.name, contact.phoneNormalized);
        await setChatwootContactId(contact.id, chatwootId);
      }

      const conversationId = await createConversation(chatwootId, config.chatwoot.inboxId);

      await sendTemplateMessage(conversationId, {
        name: def.template.name,
        language: def.template.language,
        variables: resolvedVars,
      });

      await pool.query(
        `INSERT INTO campaign_contacts (campaign_run_id, contact_id, status)
         VALUES ($1, $2, 'sent')`,
        [runId, contact.id],
      );
      sent++;
    } catch (err) {
      console.error(`[campaign] error con contacto ${contact.tangoId}:`, err);
      await pool.query(
        `INSERT INTO campaign_contacts (campaign_run_id, contact_id, status)
         VALUES ($1, $2, 'failed')`,
        [runId, contact.id],
      );
      failed++;
    }
  }

  await pool.query(
    `UPDATE campaign_runs SET status = $1, finished_at = NOW() WHERE id = $2`,
    [failed === audience.length ? "failed" : "done", runId],
  );

  console.log(`[campaign] (${label}) — enviados: ${sent}, fallidos: ${failed}`);
}
