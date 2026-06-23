import { getAudienceByDeliveryDay, setChatwootContactId } from "../contacts/contactRepository.js";
import {
  findOrCreateContact,
  createConversation,
  sendTemplateMessage,
} from "../chatwoot/chatwootClient.js";
import pool from "../db/pool.js";
import type { CampaignDefinition } from "./campaignDefinitions.js";
import { config } from "../config.js";

export async function runCampaign(def: CampaignDefinition): Promise<void> {
  const label = `sendDay=${def.sendDay} → deliveryDay=${def.deliveryDay}`;
  console.log(`[campaign] iniciando difusión (${label})...`);

  const audience = await getAudienceByDeliveryDay(def.deliveryDay);
  if (audience.length === 0) {
    console.log(`[campaign] sin contactos con entrega "${def.deliveryDay}" — saltando`);
    return;
  }

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

      const resolvedVars: Record<string, string> = {};
      for (const [key, val] of Object.entries(def.template.variables)) {
        resolvedVars[key] = val.replace("{{contact.name}}", contact.name);
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
