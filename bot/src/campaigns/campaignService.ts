import { getAudienceByDeliveryDay, setChatwootContactId, incrementNoResponseStreak } from "../contacts/contactRepository.js";
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

// Devuelve la semana ISO en hora argentina, formato "YYYY-WNN".
function currentISOWeekART(): string {
  const d = new Date(Date.now() + ART_OFFSET_MS);
  const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - dow);
  const yearStart = new Date(Date.UTC(day.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((day.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${day.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

async function wasTemplateSentThisWeek(contactId: number, templateName: string, isoWeek: string): Promise<boolean> {
  const { rows } = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM campaign_weekly_limit
       WHERE contact_id = $1 AND template_name = $2 AND iso_week = $3
     ) AS exists`,
    [contactId, templateName, isoWeek],
  );
  return rows[0]?.exists ?? false;
}

async function markTemplateSentThisWeek(contactId: number, templateName: string, isoWeek: string): Promise<void> {
  await pool.query(
    `INSERT INTO campaign_weekly_limit (contact_id, template_name, iso_week)
     VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [contactId, templateName, isoWeek],
  );
}

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

  const endDayName = DAY_NAMES_ES[endDay.getUTCDay()] ?? "";
  const endDateStr = `${endDay.getUTCDate()}/${endDay.getUTCMonth() + 1}`;
  return {
    "{{delivery.dayName}}": DAY_NAMES_ES[delivery.getUTCDay()] ?? "",
    "{{delivery.date}}":    `${delivery.getUTCDate()}/${delivery.getUTCMonth() + 1}`,
    "{{end.dayName}}":      endDayName,
    "{{end.date}}":         endDateStr,
    "{{end.dayAndDate}}":   `${endDayName} ${endDateStr}`,
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
    `[campaign] entrega: ${resolvedVars["order_day"]} ${resolvedVars["order_date"]}` +
    ` | corte: ${resolvedVars["end_day"]} ${resolvedVars["end_time"]}` +
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
  let skipped = 0;
  let failed = 0;
  const isoWeek = currentISOWeekART();

  for (const contact of audience) {
    try {
      if (await wasTemplateSentThisWeek(contact.id, def.template.name, isoWeek)) {
        console.log(`[campaign] ${contact.tangoId} ya recibió "${def.template.name}" esta semana (${isoWeek}) — saltando`);
        skipped++;
        continue;
      }

      let chatwootId = contact.chatwootContactId;
      if (!chatwootId) {
        chatwootId = await findOrCreateContact(contact.name, contact.phoneNormalized);
        await setChatwootContactId(contact.id, chatwootId);
      }

      let conversationId: number;
      try {
        conversationId = await createConversation(chatwootId, config.chatwoot.inboxId);
      } catch (err) {
        // chatwoot_contact_id stale (contacto eliminado de Chatwoot) → re-crear y reintentar
        if (String(err).includes("404")) {
          console.warn(`[campaign] chatwoot_contact_id ${chatwootId} inválido para ${contact.tangoId} — re-creando contacto`);
          chatwootId = await findOrCreateContact(contact.name, contact.phoneNormalized);
          await setChatwootContactId(contact.id, chatwootId);
          conversationId = await createConversation(chatwootId, config.chatwoot.inboxId);
        } else {
          throw err;
        }
      }

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
      await markTemplateSentThisWeek(contact.id, def.template.name, isoWeek);
      await incrementNoResponseStreak(contact.id);
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

  console.log(`[campaign] (${label}) — enviados: ${sent}, salteados: ${skipped}, fallidos: ${failed}`);
}
