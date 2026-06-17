import type { Request, Response } from "express";
import { generateReply } from "../agent/agentService.js";
import { sendMessage } from "../chatwoot/chatwootClient.js";

// Idempotencia básica en memoria por message.id (ver PLAN-MVP, Fase 2.4).
// Provisorio: en la Fase 2 con Postgres pasa a la base para sobrevivir reinicios.
const processedMessageIds = new Set<number>();

// Webhook del Agent Bot de Chatwoot.
// ACK rápido (200) + procesamiento async liviano, sin colas.
export function handleChatwootWebhook(req: Request, res: Response): void {
  res.sendStatus(200);
  void processEvent(req.body);
}

// El payload del Agent Bot llega sin tipar; lo validamos defensivamente.
async function processEvent(payload: any): Promise<void> {
  try {
    if (payload?.event !== "message_created") return;

    // Solo respondemos a mensajes entrantes del cliente.
    // (message_type puede venir como "incoming" o como 0 según la versión.)
    const isIncoming =
      payload?.message_type === "incoming" || payload?.message_type === 0;
    if (!isIncoming) return;

    const messageId: unknown = payload?.id;
    if (typeof messageId === "number") {
      if (processedMessageIds.has(messageId)) return;
      processedMessageIds.add(messageId);
    }

    const content: string = String(payload?.content ?? "").trim();
    const conversationId: unknown = payload?.conversation?.id;
    if (!content || typeof conversationId !== "number") return;

    const reply = await generateReply(content);
    await sendMessage(conversationId, reply);
    console.log(`[bot] respondió a la conversación ${conversationId}`);
  } catch (err) {
    console.error("[bot] error procesando evento:", err);
  }
}
