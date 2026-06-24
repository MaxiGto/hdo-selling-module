import type { Request, Response } from "express";
import { generateReply } from "../agent/agentService.js";
import { isHandedOff, markHandedOff } from "../agent/handoffRepository.js";
import { sendMessage, openConversation } from "../chatwoot/chatwootClient.js";

// Idempotencia básica: evita procesar el mismo message.id dos veces en el mismo proceso.
const processedMessageIds = new Set<number>();

// Webhook del Agent Bot de Chatwoot.
// ACK rápido (200) + procesamiento async, sin colas.
export function handleChatwootWebhook(req: Request, res: Response): void {
  res.sendStatus(200);
  void processEvent(req.body);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function processEvent(payload: any): Promise<void> {
  try {
    if (payload?.event !== "message_created") return;

    // Solo respondemos a mensajes entrantes del cliente
    const isIncoming =
      payload?.message_type === "incoming" || payload?.message_type === 0;
    if (!isIncoming) return;

    const messageId: unknown = payload?.id;
    if (typeof messageId === "number") {
      if (processedMessageIds.has(messageId)) return;
      processedMessageIds.add(messageId);
    }

    const conversationId: unknown = payload?.conversation?.id;
    if (typeof conversationId !== "number") return;

    const content: string = String(payload?.content ?? "").trim();
    const hasAttachment =
      Array.isArray(payload?.attachments) && payload.attachments.length > 0;

    // Asegura que la conversación esté "open" para todos los mensajes entrantes
    openConversation(conversationId);

    // Conversación derivada a un asesor → el bot no interviene más
    if (await isHandedOff(conversationId)) {
      console.log(`[bot] conv. ${conversationId} derivada a asesor, ignorando`);
      return;
    }

    // Mensaje sin texto (audio, imagen, documento, sticker, etc.)
    if (!content && hasAttachment) {
      await sendMessage(
        conversationId,
        "Para armar tu pedido necesito que me lo pases por escrito, con el nombre del producto y la cantidad. ¿Me lo mandás en texto? ✍️",
      );
      return;
    }

    if (!content) return;

    const result = await generateReply(conversationId, content);

    if (result.type === "handoff") {
      await sendMessage(conversationId, result.mensaje);
      await markHandedOff(conversationId, result.motivo);
      console.log(`[bot] conv. ${conversationId} derivada: ${result.motivo}`);
    } else {
      await sendMessage(conversationId, result.content);
      console.log(`[bot] respondió a conv. ${conversationId}`);
    }
  } catch (err) {
    console.error("[bot] error procesando evento:", err);
  }
}
