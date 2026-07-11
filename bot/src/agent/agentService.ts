import Groq from "groq-sdk";
import { config } from "../config.js";
import { buildSystemPrompt } from "./guidelines.js";
import { fetchConversationMessages, type ChatwootMessage } from "../chatwoot/chatwootClient.js";
import { searchStock, formatStockResults } from "./productStockRepository.js";

const client = new Groq({ apiKey: config.groq.apiKey });

export type AgentResult =
  | { type: "reply"; content: string }
  | { type: "handoff"; mensaje: string; motivo: string };

const HANDOFF_TOOL: Groq.Chat.ChatCompletionTool = {
  type: "function",
  function: {
    name: "derivar_a_asesor",
    description:
      "Deriva la conversación a un asesor humano. Usá esta herramienta (no solo lo menciones en el texto) cuando el cliente pide algo fuera del scope del bot: formas de pago, envíos, estado de pedido anterior, reclamos, devoluciones, dudas sobre propiedades de productos, o cuando el cliente está molesto. También usala cuando el cliente confirmó su pedido y ya no quiere agregar más ítems, o cuando un producto no aparece en el catálogo.",
    parameters: {
      type: "object",
      properties: {
        motivo: {
          type: "string",
          description: "Nota interna de una línea (ej.: 'pedido completo', 'cliente molesto', 'producto no encontrado')",
        },
        mensaje: {
          type: "string",
          description: "Mensaje de despedida para el cliente, cálido y breve (máx. 2 oraciones)",
        },
      },
      required: ["motivo", "mensaje"],
    },
  },
};

const STOCK_TOOL: Groq.Chat.ChatCompletionTool = {
  type: "function",
  function: {
    name: "consultar_stock",
    description:
      "Consulta el stock disponible de un producto en el catálogo. Usá esta herramienta cuando el cliente pregunta por disponibilidad de un producto específico, o al final de un pedido para validar cada ítem antes de derivar al asesor. El stock se actualiza cada 30 minutos desde Tango.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Nombre o código del producto a buscar (ej: 'romero', 'té verde jengibre', '08INF093')",
        },
        cantidad: {
          type: "number",
          description: "Cantidad que el cliente pidió (opcional). Si se indica, la respuesta dirá si hay stock suficiente para esa cantidad.",
        },
      },
      required: ["query"],
    },
  },
};

type GroqMessage = Groq.Chat.ChatCompletionMessageParam;

// Convierte el historial de Chatwoot al formato de mensajes de Groq/OpenAI.
// Colapsa mensajes consecutivos del mismo rol (WhatsApp permite ráfagas multi-mensaje).
function buildMessages(history: ChatwootMessage[]): GroqMessage[] {
  const raw: GroqMessage[] = history.map((m) => ({
    role: (m.message_type === 0 ? "user" : "assistant") as "user" | "assistant",
    content: m.content!.trim(),
  }));

  const collapsed: GroqMessage[] = [];
  for (const msg of raw) {
    const last = collapsed[collapsed.length - 1];
    if (
      last?.role === msg.role &&
      typeof last.content === "string" &&
      typeof msg.content === "string"
    ) {
      last.content = `${last.content}\n${msg.content}`;
    } else {
      collapsed.push({ ...msg });
    }
  }

  // Groq requiere que el primer mensaje no sea del assistant
  while (collapsed.length > 0 && collapsed[0].role === "assistant") {
    collapsed.shift();
  }

  return collapsed;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), ms),
    ),
  ]);
}

// Genera la respuesta del agente con historial completo de la conversación.
// Loop agentic: el modelo puede llamar consultar_stock N veces antes de responder.
export async function generateReply(
  conversationId: number,
  currentMessage: string,
  clientCategory?: string | null,
): Promise<AgentResult> {
  const systemPrompt = buildSystemPrompt(clientCategory ?? null);
  const history = await fetchConversationMessages(conversationId, 30);
  let messages = buildMessages(history);

  if (messages.length === 0 || messages[messages.length - 1].role !== "user") {
    messages = [{ role: "user", content: currentMessage }];
  }

  // Máximo 10 iteraciones para evitar loops infinitos
  for (let i = 0; i < 10; i++) {
    const response = await client.chat.completions.create({
      model: config.groq.model,
      max_tokens: 512,
      messages: [{ role: "system", content: systemPrompt }, ...messages],
      tools: [HANDOFF_TOOL, STOCK_TOOL],
      tool_choice: "auto",
    });

    const message = response.choices[0].message;
    const toolCalls = message.tool_calls ?? [];

    // Derivación tiene prioridad sobre cualquier otra herramienta
    const handoffCall = toolCalls.find((t) => t.function.name === "derivar_a_asesor");
    if (handoffCall) {
      const input = JSON.parse(handoffCall.function.arguments) as { motivo: string; mensaje: string };
      return {
        type: "handoff",
        motivo: input.motivo ?? "sin motivo",
        mensaje: input.mensaje ?? "Te paso con un asesor ahora mismo 🙌",
      };
    }

    // Consultas de stock: puede haber varias en la misma respuesta (paralelas)
    const stockCalls = toolCalls.filter((t) => t.function.name === "consultar_stock");
    if (stockCalls.length > 0) {
      let toolResults: GroqMessage[];
      try {
        toolResults = await Promise.all(
          stockCalls.map(async (t) => {
            const { query, cantidad } = JSON.parse(t.function.arguments) as {
              query: string;
              cantidad?: number;
            };
            const results = await withTimeout(searchStock(query), 60_000);
            return {
              role: "tool" as const,
              tool_call_id: t.id,
              content: formatStockResults(query, results, cantidad),
            };
          }),
        );
      } catch (err) {
        console.error("[agent] error en consultar_stock:", err);
        return {
          type: "handoff",
          motivo: "error en validación de stock",
          mensaje: "Te paso con un asesor para que te confirme la disponibilidad de los productos.",
        };
      }

      messages = [
        ...messages,
        {
          role: "assistant" as const,
          content: message.content ?? null,
          tool_calls: message.tool_calls,
        },
        ...toolResults,
      ];
      continue;
    }

    // Sin herramientas → respuesta de texto final
    const text = (message.content ?? "").trim();
    return {
      type: "reply",
      content: text || "Disculpá, no pude generar una respuesta. Te paso con un asesor.",
    };
  }

  return {
    type: "reply",
    content: "Disculpá, no pude procesar tu consulta. Te paso con un asesor.",
  };
}
