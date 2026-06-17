// Configuración central del bot, leída del entorno (.env vía docker-compose).

export const config = {
  port: Number(process.env.PORT ?? 3000),
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  // Modelo barato y rápido para consultas simples (ver PLAN-MVP, Fase 2.6).
  model: "claude-haiku-4-5",
  chatwoot: {
    baseUrl: process.env.CHATWOOT_BASE_URL ?? "http://rails:3000",
    accessToken: process.env.CHATWOOT_API_ACCESS_TOKEN ?? "",
    accountId: process.env.CHATWOOT_ACCOUNT_ID ?? "",
  },
};

// Avisa al arrancar si falta algo crítico, sin frenar el proceso.
export function warnMissingConfig(): void {
  const missing: string[] = [];
  if (!config.anthropicApiKey) missing.push("ANTHROPIC_API_KEY");
  if (!config.chatwoot.accessToken) missing.push("CHATWOOT_API_ACCESS_TOKEN");
  if (!config.chatwoot.accountId) missing.push("CHATWOOT_ACCOUNT_ID");
  if (missing.length > 0) {
    console.warn(
      `[config] Faltan variables (${missing.join(", ")}). El bot recibe eventos pero no podrá responder hasta completarlas.`,
    );
  }
}
