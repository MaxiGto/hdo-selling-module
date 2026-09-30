import type { Request, Response } from "express";
import { generateReply } from "../agent/agentService.js";
import { isHandedOff, markHandedOff } from "../agent/handoffRepository.js";
import { sendMessage, openConversation } from "../chatwoot/chatwootClient.js";
import { resetNoResponseStreak, getCategoryByChatwootId, isOrderCreationEnabled, isRegisteredContact, wasUnregisteredTemplateSentToday, markUnregisteredTemplateSent } from "../contacts/contactRepository.js";
import { TEMPLATE_CLIENTE_NUEVO } from "../agent/templates.js";
import { logBotEvent } from "../metrics/botEventsRepository.js";

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

    // Solo respondemos a mensajes entrantes del cliente.
    // Mensajes salientes: si los envía un asesor humano, marcar la conversación como derivada.
    const isIncoming =
      payload?.message_type === "incoming" || payload?.message_type === 0;
    if (!isIncoming) {
      const isOutgoing =
        payload?.message_type === "outgoing" || payload?.message_type === 1;
      if (isOutgoing) {
        const outgoingConvId: unknown = payload?.conversation?.id;
        if (typeof outgoingConvId === "number") {
          console.log(`[bot] mensaje outgoing en conv. ${outgoingConvId} — sender:`, JSON.stringify(payload?.sender));
          const senderType: unknown = payload?.sender?.type;
          // Las plantillas (difusiones) salen con el token de un usuario pero no son un asesor atendiendo.
          const isTemplate = Boolean(payload?.additional_attributes?.template_params);
          if (isTemplate) {
            console.log(`[bot] conv. ${outgoingConvId} — plantilla saliente, no se marca como derivada`);
          } else if (senderType === "user" || senderType === "agent") {
            if (!await isHandedOff(outgoingConvId)) {
              await markHandedOff(outgoingConvId, "asesor tomó la conversación");
              void logBotEvent("derivacion_asesor", {
                conversationId: outgoingConvId,
                chatwootContactId: payload?.conversation?.meta?.sender?.id ?? null,
                detail: typeof payload?.sender?.name === "string" ? payload.sender.name : null,
              });
              console.log(`[bot] conv. ${outgoingConvId} — asesor envió mensaje, marcando como derivada`);
            }
          }
        }
      }
      return;
    }

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

    // El cliente respondió → resetear streak de no-respuesta + identificar categoría
    const chatwootContactId = payload?.conversation?.meta?.sender?.id;
    let clientCategory: string | null = null;
    let orderCreationEnabled = false;
    if (typeof chatwootContactId === "number") {
      void resetNoResponseStreak(chatwootContactId);
      clientCategory = await getCategoryByChatwootId(chatwootContactId);
      orderCreationEnabled = isOrderCreationEnabled(chatwootContactId);
    }

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

    // Cliente no registrado en la DB del bot (no está en Tango) → mensaje de alta, sin AI
    // Rate-limit: se envía como máximo 1 vez por día para no ser molesto.
    if (typeof chatwootContactId === "number") {
      const registered = await isRegisteredContact(chatwootContactId);
      if (!registered) {
        const alreadySentToday = await wasUnregisteredTemplateSentToday(chatwootContactId);
        void logBotEvent("no_registrado", {
          conversationId,
          chatwootContactId,
          detail: alreadySentToday ? "ignorado" : "template_enviado",
        });
        if (!alreadySentToday) {
          console.log(`[bot] conv. ${conversationId} — cliente no registrado (chatwootId=${chatwootContactId}), enviando template de alta`);
          await sendMessage(conversationId, TEMPLATE_CLIENTE_NUEVO);
          await markUnregisteredTemplateSent(chatwootContactId);
        } else {
          console.log(`[bot] conv. ${conversationId} — cliente no registrado (chatwootId=${chatwootContactId}), template ya enviado hoy, ignorando`);
        }
        return;
      }
    }

    const result = await generateReply(conversationId, content, clientCategory, chatwootContactId ?? null, orderCreationEnabled);

    if (result.type === "handoff") {
      await sendMessage(conversationId, result.mensaje);
      await markHandedOff(conversationId, result.motivo);
      void logBotEvent("derivacion_bot", {
        conversationId,
        chatwootContactId: typeof chatwootContactId === "number" ? chatwootContactId : null,
        detail: result.motivo,
      });
      console.log(`[bot] conv. ${conversationId} derivada: ${result.motivo}`);
    } else {
      await sendMessage(conversationId, result.content);
      console.log(`[bot] respondió a conv. ${conversationId}`);
    }
  } catch (err) {
    console.error("[bot] error procesando evento:", err);
    const convId: unknown = payload?.conversation?.id;
    const contactId: unknown = payload?.conversation?.meta?.sender?.id;
    void logBotEvent("error", {
      conversationId: typeof convId === "number" ? convId : null,
      chatwootContactId: typeof contactId === "number" ? contactId : null,
      detail: (err instanceof Error ? err.message : String(err)).slice(0, 500),
    });
  }
}
