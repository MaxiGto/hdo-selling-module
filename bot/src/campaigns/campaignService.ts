import { getAudienceByZone, setChatwootContactId } from "../contacts/contactRepository.js";
import {
  findOrCreateContact,
  createConversation,
  sendTemplateMessage,
} from "../chatwoot/chatwootClient.js";
import pool from "../db/pool.js";
import type { CampaignDefinition } from "./campaignDefinitions.js";
import { config } from "../config.js";

export async function runCampaign(def: CampaignDefinition): Promise<void> {
  console.log(`[campaign] iniciando "${def.name}"...`);

  const audience = await getAudienceByZone(def.audienceFilter.zone);
  if (audience.length === 0) {
    console.log(`[campaign] "${def.name}" — sin contactos para zona "${def.audienceFilter.zone}"`);
    return;
  }

  // Registra el inicio del run
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO campaign_runs (campaign_name, contacts_count)
     VALUES ($1, $2) RETURNING id`,
    [def.name, audience.length],
  );
  const runId = rows[0].id;

  let sent = 0;
  let failed = 0;

  for (const contact of audience) {
    try {
      // 1. Asegurar que el contacto existe en Chatwoot
      let chatwootId = contact.chatwootContactId;
      if (!chatwootId) {
        chatwootId = await findOrCreateContact(contact.name, contact.phoneNormalized);
        await setChatwootContactId(contact.id, chatwootId);
      }

      // 2. Crear una conversación saliente en el inbox de WhatsApp
      const conversationId = await createConversation(chatwootId, config.chatwoot.inboxId);

      // 3. Resolver variables del template (reemplaza {{contact.name}})
      const resolvedVars: Record<string, string> = {};
      for (const [key, val] of Object.entries(def.template.variables)) {
        resolvedVars[key] = val.replace("{{contact.name}}", contact.name);
      }

      // 4. Enviar el mensaje de template por WhatsApp
      await sendTemplateMessage(conversationId, {
        name: def.template.name,
        language: def.template.language,
        variables: resolvedVars,
      });

      // 5. Registrar envío exitoso
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

  // Cierra el run
  await pool.query(
    `UPDATE campaign_runs
     SET status = $1, finished_at = NOW()
     WHERE id = $2`,
    [failed === audience.length ? "failed" : "done", runId],
  );

  console.log(`[campaign] "${def.name}" — enviados: ${sent}, fallidos: ${failed}`);
}
