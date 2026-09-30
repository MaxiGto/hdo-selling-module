import { SchemaType, type FunctionDeclaration } from "@google/generative-ai";
import { buildSystemPrompt } from "./guidelines.js";
import { fetchConversationMessages, type ChatwootMessage } from "../chatwoot/chatwootClient.js";
import { searchStock, formatStockResults, findProductsBySku } from "./productStockRepository.js";
import { createTangoOrder, type OrderItem } from "../tango/tangoOrderService.js";
import { getShippingAddresses } from "../contacts/contactRepository.js";
import { logBotEvent } from "../metrics/botEventsRepository.js";
import { createModelStepper, LlmUnavailableError, type Turn } from "./llmClient.js";

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
            sku_code:    { type: SchemaType.STRING, description: "Código SKU exacto que aparece entre corchetes en el resultado de consultar_stock (ej: '08INF042'). Nunca la descripción." },
            description: { type: SchemaType.STRING, description: "Descripción del producto" },
            cantidad:    { type: SchemaType.NUMBER, description: "Cantidad pedida" },
          },
          required: ["sku_code", "description", "cantidad"],
        },
      },
      shipping_address_code: {
        type: SchemaType.STRING,
        description: "Código de la dirección de envío elegida por el cliente (obtenido de obtener_direcciones_envio)",
      },
      observaciones: {
        type: SchemaType.STRING,
        description: "Observaciones adicionales del cliente (opcional)",
      },
    },
    required: ["items", "shipping_address_code"],
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const TOOL_DIRECCIONES: any = {
  name: "obtener_direcciones_envio",
  description:
    "Obtiene las direcciones de envío registradas para el cliente. Llamá esta herramienta antes de crear el pedido para mostrarle al cliente sus opciones de entrega y pedirle que confirme o elija una.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {},
    required: [],
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

function buildTools(orderCreationEnabled: boolean): FunctionDeclaration[] {
  const declarations = [TOOL_DERIVAR];
  if (orderCreationEnabled) {
    declarations.push(TOOL_DIRECCIONES);
    declarations.push(TOOL_CREAR_PEDIDO);
  }
  declarations.push(TOOL_STOCK);
  return declarations;
}

// Convierte el historial de Chatwoot a turnos neutrales (ver llmClient.ts).
// Colapsa mensajes consecutivos del mismo rol (WhatsApp permite ráfagas multi-mensaje).
function buildTurns(history: ChatwootMessage[]): Turn[] {
  const collapsed: Turn[] = [];
  for (const m of history) {
    const role = m.message_type === 0 ? "user" : "assistant";
    const text = m.content!.trim();
    const last = collapsed[collapsed.length - 1];
    if (last && last.role !== "tool" && last.role === role) {
      last.text = `${last.text}\n${text}`;
    } else {
      collapsed.push(role === "user" ? { role, text } : { role, text, calls: [] });
    }
  }

  // Gemini y Claude requieren que el primer mensaje sea del usuario
  while (collapsed.length > 0 && collapsed[0].role !== "user") {
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

  const step = createModelStepper(systemPrompt, tools, (reason) => {
    void logBotEvent("fallback_ia", {
      conversationId,
      chatwootContactId: chatwootContactId ?? null,
      detail: reason,
    });
  });

  const history = await fetchConversationMessages(conversationId, 30);
  let turns = buildTurns(history);

  if (turns.length === 0 || turns[turns.length - 1].role !== "user") {
    turns = [{ role: "user", text: currentMessage }];
  }

  // Si el pedido ya se creó y después falla la IA, el asesor tiene que saberlo.
  let createdOrderId: string | null = null;

  // Máximo 10 iteraciones para evitar loops infinitos
  for (let i = 0; i < 10; i++) {
    let modelStep;
    try {
      modelStep = await step(turns);
    } catch (err) {
      if (!(err instanceof LlmUnavailableError)) throw err;
      console.error(`[agent] conv. ${conversationId}: ${err.message}`);
      return {
        type: "handoff",
        motivo: createdOrderId
          ? `IA no disponible después de crear el pedido ${createdOrderId}`
          : "IA no disponible (Gemini y Claude)",
        mensaje: "Estamos con una demora técnica, te paso con un asesor para que te ayude 🙌",
      };
    }

    const { calls } = modelStep;
    const assistantTurn: Turn = {
      role: "assistant",
      text: modelStep.text,
      calls,
      geminiParts: modelStep.geminiParts,
    };

    // Derivación tiene prioridad
    const handoffCall = calls.find((c) => c.name === "derivar_a_asesor");
    if (handoffCall) {
      const args = handoffCall.args as { motivo?: string; mensaje?: string };
      return {
        type: "handoff",
        motivo: args.motivo ?? "sin motivo",
        mensaje: args.mensaje ?? "Te paso con un asesor ahora mismo 🙌",
      };
    }

    // Direcciones de envío del cliente
    const addressCall = calls.find((c) => c.name === "obtener_direcciones_envio");
    if (addressCall && chatwootContactId) {
      const addresses = await getShippingAddresses(chatwootContactId);
      let addressText: string;
      if (addresses.length === 0) {
        addressText = "Este cliente no tiene direcciones de envío registradas.";
      } else {
        const lines = addresses.map((a, i) => {
          const parts = [a.address, a.city, a.postalCode].filter(Boolean).join(", ");
          const tag = a.defaultAddress ? " (predeterminada)" : "";
          return `${i + 1}. [${a.code}]${tag} ${parts}`;
        });
        addressText = `Direcciones de envío disponibles:\n${lines.join("\n")}`;
      }
      turns = [
        ...turns,
        assistantTurn,
        { role: "tool", results: [{ id: addressCall.id, name: addressCall.name, result: addressText }] },
      ];
      continue;
    }

    // Creación de pedido en Tango
    const orderCall = calls.find((c) => c.name === "crear_pedido");
    if (orderCall) {
      const args = orderCall.args as {
        items: { sku_code: string; description: string; cantidad: number }[];
        shipping_address_code: string;
        observaciones?: string;
      };

      if (!chatwootContactId) {
        return {
          type: "handoff",
          motivo: "error al crear pedido: sin ID de contacto",
          mensaje: "Hubo un problema técnico al registrar tu pedido. Te paso con un asesor.",
        };
      }

      // El historial de Chatwoot no guarda los resultados de consultar_stock, así que el
      // modelo puede mandar SKUs inventados o la descripción. Si alguno no existe, le
      // devolvemos el error para que consulte stock y reintente (no derivamos todavía).
      const catalog = await findProductsBySku(args.items.map((i) => i.sku_code));
      const unknown = args.items.filter((i) => !catalog.get(i.sku_code.trim().toUpperCase())?.tangoId);
      if (unknown.length > 0) {
        console.warn(`[agent] crear_pedido con SKUs desconocidos: ${unknown.map((i) => i.sku_code).join(", ")}`);
        turns = [
          ...turns,
          assistantTurn,
          {
            role: "tool",
            results: [{
              id: orderCall.id,
              name: orderCall.name,
              result:
                `Pedido NO creado. Estos sku_code no existen en el catálogo: ${unknown.map((i) => `"${i.sku_code}" (${i.description})`).join(", ")}. ` +
                "Llamá consultar_stock para cada uno, usá el código exacto entre corchetes y volvé a llamar crear_pedido.",
            }],
          },
        ];
        continue;
      }

      const orderItems: OrderItem[] = args.items.map((i) => {
        const product = catalog.get(i.sku_code.trim().toUpperCase())!;
        return {
          skuCode:     product.skuCode,
          tangoId:     product.tangoId!,
          description: i.description,
          quantity:    i.cantidad,
        };
      });

      try {
        const orderResult = await withTimeout(
          createTangoOrder(chatwootContactId, orderItems, args.observaciones, args.shipping_address_code),
          30_000,
        );
        if (orderResult.success) createdOrderId = String(orderResult.orderId);
        const responseText = orderResult.success
          ? `Pedido registrado exitosamente (ID: ${orderResult.orderId})`
          : `Error al registrar pedido: ${orderResult.error}`;

        turns = [
          ...turns,
          assistantTurn,
          { role: "tool", results: [{ id: orderCall.id, name: orderCall.name, result: responseText }] },
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
    const stockCalls = calls.filter((c) => c.name === "consultar_stock");
    if (stockCalls.length > 0) {
      let results: { id: string; name: string; result: string }[];
      try {
        results = await Promise.all(
          stockCalls.map(async (c) => {
            const { query, cantidad } = c.args as { query: string; cantidad?: number };
            const found = await withTimeout(searchStock(query), 60_000);
            return { id: c.id, name: c.name, result: formatStockResults(query, found, cantidad) };
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

      turns = [...turns, assistantTurn, { role: "tool", results }];
      continue;
    }

    // Sin herramientas → respuesta de texto final
    return {
      type: "reply",
      content: modelStep.text || "Disculpá, no pude generar una respuesta. Te paso con un asesor.",
    };
  }

  return {
    type: "reply",
    content: "Disculpá, no pude procesar tu consulta. Te paso con un asesor.",
  };
}
