import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { SYSTEM_PROMPT } from "./guidelines.js";
import { fetchConversationMessages, type ChatwootMessage } from "../chatwoot/chatwootClient.js";

const client = new Anthropic({ apiKey: config.anthropicApiKey });

export type AgentResult =
  | { type: "reply"; content: string }
  | { type: "handoff"; mensaje: string; motivo: string };

const HANDOFF_TOOL: Anthropic.Tool = {
  name: "derivar_a_asesor",
  description:
    "Deriva la conversación a un asesor humano. Usá esta herramienta (no solo lo menciones en el texto) cuando el cliente pide algo fuera del scope de toma de pedidos: precios, disponibilidad, stock, formas de pago, envíos, estado de pedido anterior, reclamos, devoluciones, dudas sobre propiedades de productos, o cuando el cliente está molesto. También usala cuando el cliente confirmó su pedido y ya no quiere agregar más ítems.",
  input_schema: {
    type: "object" as const,
    properties: {
      motivo: {
        type: "string",
        description: "Nota interna de una línea (ej.: 'consulta de precios', 'pedido completo', 'cliente molesto')",
      },
      mensaje: {
        type: "string",
        description: "Mensaje de despedida para el cliente, cálido y breve (máx. 2 oraciones)",
      },
    },
    required: ["motivo", "mensaje"],
  },
};

// Convierte el historial de Chatwoot en el formato que espera la API de Claude.
// Colapsa mensajes consecutivos del mismo rol (WhatsApp permite ráfagas multi-mensaje).
function buildMessages(history: ChatwootMessage[]): Anthropic.MessageParam[] {
  const raw: Anthropic.MessageParam[] = history.map((m) => ({
    role: (m.message_type === 0 ? "user" : "assistant") as "user" | "assistant",
    content: m.content!.trim(),
  }));

  // Colapsar mensajes consecutivos del mismo rol
  const collapsed: Anthropic.MessageParam[] = [];
  for (const msg of raw) {
    const last = collapsed[collapsed.length - 1];
    if (last?.role === msg.role) {
      last.content = `${last.content as string}\n${msg.content as string}`;
    } else {
      collapsed.push({ ...msg });
    }
  }

  // Claude requiere que el primer mensaje sea del usuario
  while (collapsed.length > 0 && collapsed[0].role === "assistant") {
    collapsed.shift();
  }

  return collapsed;
}

// Genera la respuesta del agente con historial completo de la conversación.
// Si el historial no se puede obtener, cae a single-turn con el mensaje actual.
export async function generateReply(
  conversationId: number,
  currentMessage: string,
): Promise<AgentResult> {
  // Obtener historial de Chatwoot (incluye el mensaje actual)
  const history = await fetchConversationMessages(conversationId, 30);
  let messages = buildMessages(history);

  // Fallback: si no hay historial o quedó vacío, usar solo el mensaje actual
  if (messages.length === 0 || messages[messages.length - 1].role !== "user") {
    messages = [{ role: "user", content: currentMessage }];
  }

  const response = await client.messages.create({
    model: config.model,
    max_tokens: 512,
    system: SYSTEM_PROMPT,
    tools: [HANDOFF_TOOL],
    messages,
  });

  // Claude llamó a la herramienta de derivación
  const toolUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "derivar_a_asesor",
  );
  if (toolUse) {
    const input = toolUse.input as { motivo: string; mensaje: string };
    return {
      type: "handoff",
      motivo: input.motivo ?? "sin motivo",
      mensaje: input.mensaje ?? "Te paso con un asesor ahora mismo 🙌",
    };
  }

  // Respuesta de texto normal
  const text = response.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("")
    .trim();

  return {
    type: "reply",
    content: text || "Disculpá, no pude generar una respuesta. Te paso con un asesor.",
  };
}
