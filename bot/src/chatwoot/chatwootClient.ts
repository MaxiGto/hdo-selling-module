import { config } from "../config.js";

// Cliente de la API de Chatwoot. Todo lo saliente pasa por acá,
// nunca directo a Meta (ver decisión de arquitectura del proyecto).

// Token del Agent Bot: para respuestas reactivas (webhook).
function botHeaders() {
  return { "Content-Type": "application/json", api_access_token: config.chatwoot.accessToken };
}

// Token de agente/admin: para crear contactos, conversaciones y enviar templates salientes.
function agentHeaders() {
  return { "Content-Type": "application/json", api_access_token: config.chatwoot.agentToken };
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
    headers: botHeaders(),
    body: JSON.stringify({ content, message_type: "outgoing" }),
  });
  if (!res.ok) throw new Error(`sendMessage falló (${res.status}): ${await res.text()}`);
}

// ── Importación / sincronización de contactos ────────────────────────────

export interface ChatwootContactData {
  tangoId: string;
  name: string;
  businessName: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  postalCode: string | null;
  provinceCode: string | null;
  documentNumber: string | null;
  sellerCode: string | null;
  deliveryDays: {
    monday: boolean; tuesday: boolean; wednesday: boolean;
    thursday: boolean; friday: boolean; saturday: boolean; sunday: boolean;
  };
}

// Crea o actualiza un contacto en Chatwoot con todos los datos de Tango.
// Busca primero por teléfono. Devuelve { id, created: true/false }.
export async function upsertChatwootContact(data: ChatwootContactData): Promise<{ id: number; created: boolean }> {
  const payload: Record<string, unknown> = {
    name:       data.name,
    identifier: data.tangoId,
    additional_attributes: {
      tango_id:          data.tangoId,
      razon_social:      data.businessName,
      cuit:              data.documentNumber,
      vendedor:          data.sellerCode,
      localidad:         data.city,
      codigo_postal:     data.postalCode,
      provincia:         data.provinceCode,
      direccion:         data.address,
      entrega_lunes:     data.deliveryDays.monday,
      entrega_martes:    data.deliveryDays.tuesday,
      entrega_miercoles: data.deliveryDays.wednesday,
      entrega_jueves:    data.deliveryDays.thursday,
      entrega_viernes:   data.deliveryDays.friday,
      entrega_sabado:    data.deliveryDays.saturday,
      entrega_domingo:   data.deliveryDays.sunday,
    },
  };
  if (data.phone) payload.phone_number = data.phone;
  if (data.email) payload.email        = data.email;

  // Buscar por teléfono si tiene
  if (data.phone) {
    const searchRes = await fetch(
      accountUrl(`/contacts/search?q=${encodeURIComponent(data.phone)}&page=1`),
      { headers: agentHeaders() },
    );
    if (searchRes.ok) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = (await searchRes.json()) as any;
      const list: { id: number }[] = Array.isArray(body?.payload) ? body.payload : [];
      if (list.length > 0 && list[0].id) {
        const id = list[0].id;
        const patchRes = await fetch(accountUrl(`/contacts/${id}`), {
          method: "PATCH",
          headers: agentHeaders(),
          body: JSON.stringify(payload),
        });
        if (!patchRes.ok) {
          throw new Error(
            `upsertChatwootContact PATCH (${data.tangoId}) falló (${patchRes.status}): ${await patchRes.text()}`,
          );
        }
        return { id, created: false };
      }
    }
  }

  // Crear si no existe
  const createRes = await fetch(accountUrl("/contacts"), {
    method: "POST",
    headers: agentHeaders(),
    body: JSON.stringify(payload),
  });
  if (!createRes.ok) {
    throw new Error(
      `upsertChatwootContact (${data.tangoId}) falló (${createRes.status}): ${await createRes.text()}`,
    );
  }
  return { id: extractId(await createRes.json(), `upsertChatwootContact(${data.tangoId})`), created: true };
}

// ── Difusiones salientes (campañas) ──────────────────────────────────────

// Extrae el id de una respuesta de Chatwoot que puede venir como
// { id } o { payload: { id } } según la versión/endpoint.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractId(body: any, context: string): number {
  const id: unknown = body?.id ?? body?.payload?.id ?? body?.payload?.contact?.id;
  if (typeof id !== "number" || !id) {
    throw new Error(`${context}: no se pudo extraer el id del response: ${JSON.stringify(body)}`);
  }
  return id;
}

// Busca un contacto por teléfono; si no existe, lo crea. Devuelve el ID de Chatwoot.
export async function findOrCreateContact(
  name: string,
  phone: string,
): Promise<number> {
  // Buscar primero por teléfono
  const searchRes = await fetch(
    accountUrl(`/contacts/search?q=${encodeURIComponent(phone)}&page=1`),
    { headers: agentHeaders() },
  );
  if (searchRes.ok) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = (await searchRes.json()) as any;
    const list: { id: number }[] = Array.isArray(data?.payload) ? data.payload : [];
    if (list.length > 0 && list[0].id) return list[0].id;
  }

  // Crear si no existe
  const createRes = await fetch(accountUrl("/contacts"), {
    method: "POST",
    headers: agentHeaders(),
    body: JSON.stringify({ name, phone_number: phone, inbox_id: config.chatwoot.inboxId }),
  });
  if (!createRes.ok) {
    throw new Error(`createContact falló (${createRes.status}): ${await createRes.text()}`);
  }
  return extractId(await createRes.json(), "createContact");
}

// Crea una conversación saliente para el contacto en el inbox de WhatsApp.
export async function createConversation(
  contactId: number,
  inboxId: number,
): Promise<number> {
  const res = await fetch(accountUrl("/conversations"), {
    method: "POST",
    headers: agentHeaders(),
    body: JSON.stringify({ contact_id: contactId, inbox_id: inboxId }),
  });
  if (!res.ok) {
    throw new Error(`createConversation falló (${res.status}): ${await res.text()}`);
  }
  return extractId(await res.json(), "createConversation");
}

// Envía un template de WhatsApp aprobado por Meta dentro de una conversación.
// Las variables son posicionales: { "1": "valor1", "2": "valor2" }
export async function sendTemplateMessage(
  conversationId: number,
  template: { name: string; language: string; variables: Record<string, string> },
): Promise<void> {
  const res = await fetch(accountUrl(`/conversations/${conversationId}/messages`), {
    method: "POST",
    headers: agentHeaders(),
    body: JSON.stringify({
      message_type: "outgoing",
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
