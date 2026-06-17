import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { SYSTEM_PROMPT } from "./guidelines.js";

const client = new Anthropic({ apiKey: config.anthropicApiKey });

// Genera la respuesta del agente a partir del mensaje del cliente.
// Por ahora es single-turn (solo el último mensaje). La memoria por contacto
// y el historial de la conversación llegan en pasos siguientes (Fase 2.8).
export async function generateReply(userMessage: string): Promise<string> {
  const response = await client.messages.create({
    model: config.model,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
  });

  const text = response.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();

  return (
    text ||
    "Disculpá, no pude generar una respuesta en este momento. Te paso con un asesor."
  );
}
