import { config } from "../config.js";

// Cliente mínimo de la API de Chatwoot. Todo lo saliente pasa por acá,
// nunca directo a Meta (ver decisión de arquitectura del proyecto).

// Envía un mensaje del bot a una conversación existente.
export async function sendMessage(
  conversationId: number,
  content: string,
): Promise<void> {
  const url = `${config.chatwoot.baseUrl}/api/v1/accounts/${config.chatwoot.accountId}/conversations/${conversationId}/messages`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      api_access_token: config.chatwoot.accessToken,
    },
    body: JSON.stringify({ content, message_type: "outgoing" }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Chatwoot sendMessage falló (${res.status}): ${body}`);
  }
}
