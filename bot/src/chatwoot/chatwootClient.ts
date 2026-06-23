import { config } from "../config.js";

// Cliente de la API de Chatwoot. Todo lo saliente pasa por acá,
// nunca directo a Meta (ver decisión de arquitectura del proyecto).

function chatwootHeaders() {
  return {
    "Content-Type": "application/json",
    api_access_token: config.chatwoot.accessToken,
  };
}

function accountUrl(path: string): string {
  return `${config.chatwoot.baseUrl}/api/v1/accounts/${config.chatwoot.accountId}${path}`;
}

// ── Mensajes reactivos (webhook del Agent Bot) ────────────────────────────

// Envía un mensaje del bot a una conversación existente.
export async function sendMessage(
  conversationId: number,
  content: string,
): Promise<void> {
  const res = await fetch(accountUrl(`/conversations/${conversationId}/messages`), {
    method: "POST",
    headers: chatwootHeaders(),
    body: JSON.stringify({ content, message_type: "outgoing" }),
  });
  if (!res.ok) throw new Error(`sendMessage falló (${res.status}): ${await res.text()}`);
}

// ── Difusiones salientes (campañas) ──────────────────────────────────────

// Busca un contacto por teléfono; si no existe, lo crea. Devuelve el ID de Chatwoot.
export async function findOrCreateContact(
  name: string,
  phone: string,
): Promise<number> {
  // Buscar primero por teléfono
  const searchRes = await fetch(
    accountUrl(`/contacts/search?q=${encodeURIComponent(phone)}&page=1`),
    { headers: chatwootHeaders() },
  );
  if (searchRes.ok) {
    const data = (await searchRes.json()) as { payload: { id: number }[] };
    if (data.payload.length > 0) return data.payload[0].id;
  }

  // Crear si no existe
  const createRes = await fetch(accountUrl("/contacts"), {
    method: "POST",
    headers: chatwootHeaders(),
    body: JSON.stringify({ name, phone_number: phone, inbox_id: config.chatwoot.inboxId }),
  });
  if (!createRes.ok) throw new Error(`createContact falló (${createRes.status}): ${await createRes.text()}`);
  const created = (await createRes.json()) as { id: number };
  return created.id;
}

// Crea una conversación saliente para el contacto en el inbox de WhatsApp.
export async function createConversation(
  contactId: number,
  inboxId: number,
): Promise<number> {
  const res = await fetch(accountUrl(`/contacts/${contactId}/conversations`), {
    method: "POST",
    headers: chatwootHeaders(),
    body: JSON.stringify({ inbox_id: inboxId }),
  });
  if (!res.ok) throw new Error(`createConversation falló (${res.status}): ${await res.text()}`);
  const data = (await res.json()) as { id: number };
  return data.id;
}

// Envía un template de WhatsApp aprobado por Meta dentro de una conversación.
// Las variables son posicionales: { "1": "valor1", "2": "valor2" }
export async function sendTemplateMessage(
  conversationId: number,
  template: { name: string; language: string; variables: Record<string, string> },
): Promise<void> {
  const res = await fetch(accountUrl(`/conversations/${conversationId}/messages`), {
    method: "POST",
    headers: chatwootHeaders(),
    body: JSON.stringify({
      message_type: "outgoing",
      content_type: "text",
      template_params: {
        name: template.name,
        category: "MARKETING",
        language: template.language,
        processed_params: template.variables,
      },
    }),
  });
  if (!res.ok) throw new Error(`sendTemplateMessage falló (${res.status}): ${await res.text()}`);
}
