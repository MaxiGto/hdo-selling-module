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

// Llamado cuando el asesor resuelve la conversación: el bot vuelve a estar activo
// en la próxima conversación que abra ese cliente.
export async function removeHandoff(conversationId: number): Promise<void> {
  await pool.query("DELETE FROM handoffs WHERE conversation_id = $1", [conversationId]);
}

// Limpieza nocturna: libera todos los handoffs para que el bot retome
// conversaciones donde ningún asesor respondió durante el día.
export async function clearAllHandoffs(): Promise<number> {
  const res = await pool.query("DELETE FROM handoffs RETURNING conversation_id");
  return res.rowCount ?? 0;
}
