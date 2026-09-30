import Anthropic from "@anthropic-ai/sdk";
import {
  GoogleGenerativeAI,
  GoogleGenerativeAIFetchError,
  type Content,
  type FunctionDeclaration,
  type Part,
} from "@google/generative-ai";
import { config } from "../config.js";

// Capa neutral entre el agente y los proveedores de IA.
// Gemini es el modelo principal; si falla (503, 429, etc.) después de reintentar,
// el resto del turno sigue con Claude sobre el MISMO historial normalizado,
// así no se repiten herramientas ya ejecutadas (ej.: crear_pedido).

export type ToolCall = { id: string; name: string; args: Record<string, unknown> };

export type Turn =
  | { role: "user"; text: string }
  // geminiParts: partes crudas de Gemini, se reenvían tal cual (preserva thought signatures).
  | { role: "assistant"; text: string; calls: ToolCall[]; geminiParts?: Part[] }
  | { role: "tool"; results: { id: string; name: string; result: string }[] };

export type ModelStep = {
  text: string;
  calls: ToolCall[];
  geminiParts?: Part[];
  provider: "gemini" | "claude";
};

// Ambos proveedores fallaron (o Claude no está configurado).
export class LlmUnavailableError extends Error {}

const genAI = new GoogleGenerativeAI(config.gemini.apiKey);
let anthropic: Anthropic | null = null;

function getAnthropic(): Anthropic | null {
  if (!config.anthropic.apiKey) return null;
  // El SDK ya reintenta 429/5xx por su cuenta (maxRetries por defecto: 2).
  anthropic ??= new Anthropic({ apiKey: config.anthropic.apiKey, timeout: 30_000 });
  return anthropic;
}

const GEMINI_ATTEMPTS = 3;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

function isRetryableGeminiError(err: unknown): boolean {
  return err instanceof GoogleGenerativeAIFetchError && RETRYABLE_STATUS.has(err.status ?? 0);
}

// Backoff exponencial con jitter: ~1s, ~2s, ...
function backoffMs(attempt: number): number {
  return 1000 * 2 ** attempt * (0.5 + Math.random());
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Crea un "stepper" para un turno de conversación. Una vez que cae a Claude,
// se queda en Claude hasta terminar el turno (no mezcla proveedores a mitad del loop).
export function createModelStepper(
  systemPrompt: string,
  tools: FunctionDeclaration[],
  onFallback?: (reason: string) => void,
) {
  let useClaude = false;
  let callSeq = 0;

  const geminiModel = genAI.getGenerativeModel(
    { model: config.gemini.model, systemInstruction: systemPrompt, tools: [{ functionDeclarations: tools }] },
    { timeout: 30_000 },
  );

  async function stepGemini(turns: Turn[]): Promise<ModelStep> {
    const result = await geminiModel.generateContent({ contents: toGeminiContents(turns) });
    const parts: Part[] = result.response.candidates?.[0]?.content?.parts ?? [];
    const calls: ToolCall[] = parts
      .filter((p) => "functionCall" in p && p.functionCall)
      .map((p) => ({
        id: `gemini_${callSeq++}`,
        name: p.functionCall!.name,
        args: (p.functionCall!.args ?? {}) as Record<string, unknown>,
      }));
    const text = parts.map((p) => ("text" in p && p.text ? p.text : "")).join("").trim();
    return { text, calls, geminiParts: parts, provider: "gemini" };
  }

  async function stepClaude(client: Anthropic, turns: Turn[]): Promise<ModelStep> {
    const response = await client.messages.create({
      model: config.anthropic.model,
      max_tokens: 4096,
      system: systemPrompt,
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description ?? "",
        input_schema: t.parameters as unknown as Anthropic.Tool.InputSchema,
      })),
      messages: toAnthropicMessages(turns),
    });
    const calls: ToolCall[] = response.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
      .map((b) => ({ id: b.id, name: b.name, args: b.input as Record<string, unknown> }));
    const text = response.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim();
    return { text, calls, provider: "claude" };
  }

  return async function step(turns: Turn[]): Promise<ModelStep> {
    if (!useClaude) {
      let lastError: unknown;
      for (let attempt = 0; attempt < GEMINI_ATTEMPTS; attempt++) {
        try {
          return await stepGemini(turns);
        } catch (err) {
          lastError = err;
          if (!isRetryableGeminiError(err) || attempt === GEMINI_ATTEMPTS - 1) break;
          const wait = backoffMs(attempt);
          console.warn(`[llm] Gemini falló (${errorSummary(err)}), reintento ${attempt + 1} en ${Math.round(wait)}ms`);
          await sleep(wait);
        }
      }

      const reason = errorSummary(lastError);
      const client = getAnthropic();
      if (!client) {
        throw new LlmUnavailableError(`Gemini no disponible (${reason}) y ANTHROPIC_API_KEY no configurada`);
      }
      console.warn(`[llm] Gemini no disponible (${reason}), paso a Claude (${config.anthropic.model})`);
      onFallback?.(reason);
      useClaude = true;
    }

    try {
      return await stepClaude(getAnthropic()!, turns);
    } catch (err) {
      throw new LlmUnavailableError(`Gemini y Claude no disponibles (Claude: ${errorSummary(err)})`);
    }
  };
}

function errorSummary(err: unknown): string {
  if (err instanceof GoogleGenerativeAIFetchError) return `Gemini ${err.status ?? "?"} ${err.statusText ?? ""}`.trim();
  if (err instanceof Anthropic.APIError) return `Claude ${err.status ?? "?"} ${err.message}`.slice(0, 200);
  return (err instanceof Error ? err.message : String(err)).slice(0, 200);
}

function toGeminiContents(turns: Turn[]): Content[] {
  return turns.map((t): Content => {
    if (t.role === "user") return { role: "user", parts: [{ text: t.text }] };
    if (t.role === "tool") {
      return {
        role: "user",
        parts: t.results.map((r) => ({ functionResponse: { name: r.name, response: { result: r.result } } })),
      };
    }
    const parts: Part[] = t.geminiParts ?? [
      ...(t.text ? [{ text: t.text }] : []),
      ...t.calls.map((c) => ({ functionCall: { name: c.name, args: c.args } })),
    ];
    return { role: "model", parts };
  });
}

function toAnthropicMessages(turns: Turn[]): Anthropic.MessageParam[] {
  return turns.map((t, i): Anthropic.MessageParam => {
    if (t.role === "user") return { role: "user", content: t.text };
    if (t.role === "tool") {
      return {
        role: "user",
        content: t.results.map((r) => ({ type: "tool_result" as const, tool_use_id: r.id, content: r.result })),
      };
    }
    // Claude exige un tool_result por cada tool_use. El agente responde de a una herramienta
    // por vuelta, así que solo mandamos las llamadas que tienen respuesta en el turno siguiente.
    const next = turns[i + 1];
    const answered = new Set(next?.role === "tool" ? next.results.map((r) => r.id) : []);
    const content: Anthropic.ContentBlockParam[] = [
      ...(t.text ? [{ type: "text" as const, text: t.text }] : []),
      ...t.calls
        .filter((c) => answered.has(c.id))
        .map((c) => ({ type: "tool_use" as const, id: c.id, name: c.name, input: c.args })),
    ];
    return { role: "assistant", content: content.length > 0 ? content : "…" };
  });
}
