import { GoogleGenerativeAI, SchemaType, type Content, type Part } from "@google/generative-ai";
import { config } from "../config.js";
import { buildSystemPrompt } from "./guidelines.js";
import { fetchConversationMessages, type ChatwootMessage } from "../chatwoot/chatwootClient.js";
import { searchStock, formatStockResults } from "./productStockRepository.js";

const genAI = new GoogleGenerativeAI(config.gemini.apiKey);

export type AgentResult =
  | { type: "reply"; content: string }
  | { type: "handoff"; mensaje: string; motivo: string };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const TOOLS: any[] = [
  {
    functionDeclarations: [
      {
        name: "derivar_a_asesor",
        description:
          "Deriva la conversación a un asesor humano. Usá esta herramienta (no solo lo menciones en el texto) cuando el cliente pide algo fuera del scope del bot: formas de pago, envíos, estado de pedido anterior, reclamos, devoluciones, dudas sobre propiedades de productos, o cuando el cliente está molesto. También usala cuando el cliente confirmó su pedido y ya no quiere agregar más ítems, o cuando un producto no aparece en el catálogo.",
        parameters: {
          type: SchemaType.OBJECT,
          properties: {
            motivo: {
              type: SchemaType.STRING,
              description: "Nota interna de una línea (ej.: 'pedido completo', 'cliente molesto', 'producto no encontrado')",
            },
            mensaje: {
              type: SchemaType.STRING,
              description: "Mensaje de despedida para el cliente, cálido y breve (máx. 2 oraciones)",
            },
          },
          required: ["motivo", "mensaje"],
        },
      },
      {
        name: "consultar_stock",
        description:
          "Consulta el stock disponible de un producto en el catálogo. Usá esta herramienta cuando el cliente pregunta por disponibilidad de un producto específico, o al final de un pedido para validar cada ítem antes de derivar al asesor. El stock se actualiza cada 30 minutos desde Tango.",
        parameters: {
          type: SchemaType.OBJECT,
          properties: {
            query: {
              type: SchemaType.STRING,
              description: "Nombre o código del producto a buscar (ej: 'romero', 'té verde jengibre', '08INF093')",
            },
            cantidad: {
              type: SchemaType.NUMBER,
              description: "Cantidad que el cliente pidió (opcional). Si se indica, la respuesta dirá si hay stock suficiente para esa cantidad.",
            },
          },
          required: ["query"],
        },
      },
    ],
  },
];

// Convierte el historial de Chatwoot al formato Content de Gemini.
// Colapsa mensajes consecutivos del mismo rol (WhatsApp permite ráfagas multi-mensaje).
function buildContents(history: ChatwootMessage[]): Content[] {
  const raw: Content[] = history.map((m) => ({
    role: m.message_type === 0 ? "user" : "model",
    parts: [{ text: m.content!.trim() }],
  }));

  const collapsed: Content[] = [];
  for (const msg of raw) {
    const last = collapsed[collapsed.length - 1];
    if (last?.role === msg.role) {
      const lastText = (last.parts[last.parts.length - 1] as { text: string }).text;
      const msgText = (msg.parts[0] as { text: string }).text;
      last.parts[last.parts.length - 1] = { text: `${lastText}\n${msgText}` };
    } else {
      collapsed.push({ role: msg.role, parts: [...msg.parts] });
    }
  }

  // Gemini requiere que el primer mensaje sea del usuario
  while (collapsed.length > 0 && collapsed[0].role === "model") {
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

  const model = genAI.getGenerativeModel({
    model: config.gemini.model,
    systemInstruction: systemPrompt,
    tools: TOOLS,
  });

  const history = await fetchConversationMessages(conversationId, 30);
  let contents = buildContents(history);

  if (contents.length === 0 || contents[contents.length - 1].role !== "user") {
    contents = [{ role: "user", parts: [{ text: currentMessage }] }];
  }

  // Máximo 10 iteraciones para evitar loops infinitos
  for (let i = 0; i < 10; i++) {
    const result = await model.generateContent({ contents });
    const candidate = result.response.candidates?.[0];
    const parts: Part[] = candidate?.content?.parts ?? [];

    const functionCallParts = parts.filter((p) => "functionCall" in p && p.functionCall);

    // Derivación tiene prioridad
    const handoffPart = functionCallParts.find(
      (p) => "functionCall" in p && p.functionCall?.name === "derivar_a_asesor",
    );
    if (handoffPart && "functionCall" in handoffPart && handoffPart.functionCall) {
      const args = handoffPart.functionCall.args as { motivo: string; mensaje: string };
      return {
        type: "handoff",
        motivo: args.motivo ?? "sin motivo",
        mensaje: args.mensaje ?? "Te paso con un asesor ahora mismo 🙌",
      };
    }

    // Consultas de stock (pueden ser varias en paralelo)
    const stockParts = functionCallParts.filter(
      (p) => "functionCall" in p && p.functionCall?.name === "consultar_stock",
    );
    if (stockParts.length > 0) {
      let toolResponseParts: Part[];
      try {
        toolResponseParts = await Promise.all(
          stockParts.map(async (p) => {
            if (!("functionCall" in p) || !p.functionCall) throw new Error("invalid part");
            const { query, cantidad } = p.functionCall.args as { query: string; cantidad?: number };
            const results = await withTimeout(searchStock(query), 60_000);
            return {
              functionResponse: {
                name: "consultar_stock",
                response: { result: formatStockResults(query, results, cantidad) },
              },
            } as Part;
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

      contents = [
        ...contents,
        { role: "model" as const, parts },
        { role: "user" as const, parts: toolResponseParts },
      ];
      continue;
    }

    // Sin herramientas → respuesta de texto final
    const text = parts
      .map((p) => ("text" in p ? p.text : ""))
      .join("")
      .trim();

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
