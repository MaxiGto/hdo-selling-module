// Configuración central del bot, leída del entorno (.env vía docker-compose).

export const config = {
  port: Number(process.env.PORT ?? 3000),
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  // Modelo barato y rápido para consultas simples (ver PLAN-MVP, Fase 2.6).
  model: "claude-haiku-4-5",
  chatwoot: {
    baseUrl: process.env.CHATWOOT_BASE_URL ?? "http://rails:3000",
    // Token del Agent Bot — solo para respuestas reactivas (webhook).
    accessToken: process.env.CHATWOOT_API_ACCESS_TOKEN ?? "",
    // Token de un agente/admin — necesario para crear contactos, conversaciones y enviar templates.
    // Obtenelo en Chatwoot → Profile → Access Token.
    agentToken: process.env.CHATWOOT_AGENT_TOKEN ?? "",
    accountId: process.env.CHATWOOT_ACCOUNT_ID ?? "",
    // ID del inbox de WhatsApp (ver: Chatwoot → Settings → Inboxes).
    inboxId: Number(process.env.CHATWOOT_INBOX_ID ?? 1),
  },
  tango: {
    // URL base de la API de Tango Nexo Tiendas.
    baseUrl: process.env.TANGO_API_BASE_URL ?? "https://tiendas.axoft.com",
    accessToken: process.env.TANGO_ACCESS_TOKEN ?? "",
    // Tamaño de página para todos los endpoints de Tango (productos, stock, clientes).
    pageSize: Number(process.env.TANGO_PAGE_SIZE ?? 5000),
  },
};

// Avisa al arrancar si falta algo crítico, sin frenar el proceso.
export function warnMissingConfig(): void {
  const missing: string[] = [];
  if (!config.anthropicApiKey)       missing.push("ANTHROPIC_API_KEY");
  if (!config.chatwoot.accessToken)  missing.push("CHATWOOT_API_ACCESS_TOKEN");
  if (!config.chatwoot.agentToken)   missing.push("CHATWOOT_AGENT_TOKEN");
  if (!config.chatwoot.accountId)    missing.push("CHATWOOT_ACCOUNT_ID");
  if (!config.tango.accessToken) {
    console.warn("[config] TANGO_ACCESS_TOKEN no configurado — sync con Tango desactivado");
  }
  if (missing.length > 0) {
    console.warn(
      `[config] Faltan variables (${missing.join(", ")}). El bot recibe eventos pero no podrá responder hasta completarlas.`,
    );
  }
}
