import type { Request, Response } from "express";
import { removeHandoff } from "../agent/handoffRepository.js";

// Webhook de eventos generales de Chatwoot (Settings → Integrations → Webhooks).
// Distinto del Agent Bot webhook — este recibe conversation_status_changed y otros.
export function handleChatwootEvent(req: Request, res: Response): void {
  res.sendStatus(200);
  void processEvent(req.body);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function processEvent(payload: any): Promise<void> {
  try {
    console.log(`[events] evento recibido: ${payload?.event} | status: ${payload?.status} | id: ${payload?.id}`);

    if (payload?.event !== "conversation_status_changed") return;

    if (payload?.status === "resolved") {
      const conversationId: unknown = payload?.id;
      if (typeof conversationId !== "number") return;
      await removeHandoff(conversationId);
      console.log(`[events] conv. ${conversationId} resuelta — bot reactivado`);
    }
  } catch (err) {
    console.error("[events] error procesando evento:", err);
  }
}
