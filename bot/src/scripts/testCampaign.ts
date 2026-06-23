// Dispara una difusión de prueba a un número hardcodeado sin tocar la DB de contactos.
//
// Uso:   node dist/scripts/testCampaign.js <phone> [campaignIndex]
// Índices de campaña:
//   0 → Lunes    (entrega Miércoles)
//   1 → Martes   (entrega Jueves)
//   2 → Miércoles (entrega Viernes)
//   3 → Jueves   (entrega Lunes)
//   4 → Viernes  (entrega Martes)
//
// Ejemplo:
//   node dist/scripts/testCampaign.js +5491123456789 0

import {
  findOrCreateContact,
  createConversation,
  sendTemplateMessage,
} from "../chatwoot/chatwootClient.js";
import { CAMPAIGNS } from "../campaigns/campaignDefinitions.js";
import { config } from "../config.js";

const phone = process.argv[2];
const campaignIdx = parseInt(process.argv[3] ?? "0", 10);

if (!phone) {
  console.error("Falta el número de teléfono.");
  console.error("Uso: node dist/scripts/testCampaign.js <phone> [campaignIndex 0-4]");
  process.exit(1);
}

const def = CAMPAIGNS[campaignIdx];
if (!def) {
  console.error(`Índice ${campaignIdx} inválido. Disponibles: 0-${CAMPAIGNS.length - 1}`);
  process.exit(1);
}

// Misma lógica que campaignService.ts
const ART_OFFSET_MS = -3 * 60 * 60 * 1000;
const DAY_NAMES_ES: Record<number, string> = {
  0: "Domingo", 1: "Lunes", 2: "Martes", 3: "Miércoles",
  4: "Jueves", 5: "Viernes", 6: "Sábado",
};

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

async function main(): Promise<void> {
  console.log(`\n[test-difusion] Campaña : ${def.sendDay} → entrega ${def.deliveryDay}`);
  console.log(`[test-difusion] Teléfono : ${phone}`);

  const tokens = buildDateTokens(def.deliveryDateOffset, def.endDayOffset);
  const resolvedVars: Record<string, string> = {};
  for (const [key, val] of Object.entries(def.template.variables)) {
    let v = val;
    for (const [token, replacement] of Object.entries(tokens)) {
      v = v.replace(token, replacement);
    }
    resolvedVars[key] = v;
  }

  console.log(`[test-difusion] Template  : ${def.template.name} (${def.template.language})`);
  console.log(`[test-difusion] Variables :`, resolvedVars);

  console.log("\n[test-difusion] Buscando/creando contacto en Chatwoot...");
  const chatwootId = await findOrCreateContact("Test Difusion", phone);
  console.log(`[test-difusion] Contacto Chatwoot ID: ${chatwootId}`);

  console.log("[test-difusion] Creando conversación...");
  const conversationId = await createConversation(chatwootId, config.chatwoot.inboxId);
  console.log(`[test-difusion] Conversación ID: ${conversationId}`);

  console.log("[test-difusion] Enviando template...");
  await sendTemplateMessage(conversationId, {
    name: def.template.name,
    language: def.template.language,
    variables: resolvedVars,
  });

  console.log("[test-difusion] ✓ Mensaje enviado correctamente\n");
}

main().catch((err) => {
  console.error("[test-difusion] Error:", err);
  process.exit(1);
});
