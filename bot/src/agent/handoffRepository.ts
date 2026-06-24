import pool from "../db/pool.js";

export async function isHandedOff(conversationId: number): Promise<boolean> {
  const res = await pool.query(
    "SELECT 1 FROM handoffs WHERE conversation_id = $1",
    [conversationId],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function markHandedOff(conversationId: number, motivo: string): Promise<void> {
  await pool.query(
    "INSERT INTO handoffs (conversation_id, motivo) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    [conversationId, motivo],
  );
}
