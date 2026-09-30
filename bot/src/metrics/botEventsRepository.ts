import pool from "../db/pool.js";

export type BotEventType =
  | "derivacion_bot"
  | "derivacion_asesor"
  | "no_registrado"
  | "fallback_ia"
  | "error";

// Nunca lanza: un fallo registrando métricas no debe cortar la atención al cliente.
export async function logBotEvent(
  eventType: BotEventType,
  data: { conversationId?: number | null; chatwootContactId?: number | null; detail?: string | null } = {},
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO bot_events (event_type, conversation_id, chatwoot_contact_id, detail)
       VALUES ($1, $2, $3, $4)`,
      [eventType, data.conversationId ?? null, data.chatwootContactId ?? null, data.detail ?? null],
    );
  } catch (err) {
    console.error(`[metrics] no se pudo registrar evento ${eventType}:`, err);
  }
}
