import { GoogleGenerativeAI, SchemaType, type Content, type Part } from "@google/generative-ai";
import { config } from "../config.js";
import { buildSystemPrompt } from "./guidelines.js";
import { fetchConversationMessages, type ChatwootMessage } from "../chatwoot/chatwootClient.js";
import { searchStock, formatStockResults } from "./productStockRepository.js";
import { createTangoOrder, type OrderItem } from "../tango/tangoOrderService.js";

const genAI = new GoogleGenerativeAI(config.gemini.apiKey);

export type AgentResult =
  | { type: "reply"; content: string }
  | { type: "handoff"; mensaje: string; motivo: string };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const TOOL_DERIVAR: any = {
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
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const TOOL_CREAR_PEDIDO: any = {
  name: "crear_pedido",
  description:
    "Crea el pedido en Tango cuando el cliente confirmó todos los ítems. Usá esta herramienta SOLO después de haber validado el stock de cada producto con consultar_stock y de que el cliente confirmó el pedido explícitamente. Después de crear el pedido exitoso, derivá al asesor para coordinar entrega y pago.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      items: {
        type: SchemaType.ARRAY,
        description: "Lista de productos confirmados por el cliente",
        items: {
          type: SchemaType.OBJECT,
          properties: {
            sku_code:    { type: SchemaType.STRING, description: "Código SKU obtenido de consultar_stock" },
            tango_id:    { type: SchemaType.NUMBER, description: "ID interno de Tango obtenido de consultar_stock" },
            description: { type: SchemaType.STRING, description: "Descripción del producto" },
            cantidad:    { type: SchemaType.NUMBER, description: "Cantidad pedida" },
          },
          required: ["sku_code", "tango_id", "description", "cantidad"],
        },
      },
      observaciones: {
        type: SchemaType.STRING,
        description: "Observaciones adicionales del cliente (opcional)",
      },
    },
    required: ["items"],
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const TOOL_STOCK: any = {
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
};

function buildTools(orderCreationEnabled: boolean) {
  const declarations = [TOOL_DERIVAR];
  if (orderCreationEnabled) declarations.push(TOOL_CREAR_PEDIDO);
  declarations.push(TOOL_STOCK);
  return [{ functionDeclarations: declarations }];
}

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
  chatwootContactId?: number | null,
  orderCreationEnabled?: boolean,
): Promise<AgentResult> {
  const orderEnabled = orderCreationEnabled ?? false;
  const systemPrompt = buildSystemPrompt(clientCategory ?? null, orderEnabled);
  const tools = buildTools(orderEnabled);

  const model = genAI.getGenerativeModel({
    model: config.gemini.model,
    systemInstruction: systemPrompt,
    tools,
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

    // Creación de pedido en Tango
    const orderPart = functionCallParts.find(
      (p) => "functionCall" in p && p.functionCall?.name === "crear_pedido",
    );
    if (orderPart && "functionCall" in orderPart && orderPart.functionCall) {
      const args = orderPart.functionCall.args as {
        items: { sku_code: string; tango_id: number; description: string; cantidad: number }[];
        observaciones?: string;
      };

      if (!chatwootContactId) {
        return {
          type: "handoff",
          motivo: "error al crear pedido: sin ID de contacto",
          mensaje: "Hubo un problema técnico al registrar tu pedido. Te paso con un asesor.",
        };
      }

      const orderItems: OrderItem[] = args.items.map((i) => ({
        skuCode:     i.sku_code,
        tangoId:     i.tango_id,
        description: i.description,
        quantity:    i.cantidad,
      }));

      try {
        const orderResult = await withTimeout(
          createTangoOrder(chatwootContactId, orderItems, args.observaciones),
          30_000,
        );
        const responseText = orderResult.success
          ? `Pedido registrado exitosamente (ID: ${orderResult.orderId})`
          : `Error al registrar pedido: ${orderResult.error}`;

        contents = [
          ...contents,
          { role: "model" as const, parts },
          {
            role: "user" as const,
            parts: [{
              functionResponse: {
                name: "crear_pedido",
                response: { result: responseText },
              },
            } as Part],
          },
        ];
        continue;
      } catch (err) {
        console.error("[agent] error en crear_pedido:", err);
        return {
          type: "handoff",
          motivo: "error técnico al crear pedido en Tango",
          mensaje: "Hubo un problema al registrar tu pedido. Te paso con un asesor para confirmarlo.",
        };
      }
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
