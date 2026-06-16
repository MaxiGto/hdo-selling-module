import express from "express";

// Stub mínimo para validar la infraestructura (Fase 1).
// La lógica real (recepción, idempotencia, agente IA, escalado) llega en la Fase 2.

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT ?? 3000);

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "oasis-whatsapp-bot" });
});

// Webhook del Agent Bot de Chatwoot (placeholder)
app.post("/chatwoot/webhook", (req, res) => {
  console.log("[webhook] evento:", JSON.stringify(req.body));
  res.sendStatus(200);
});

// --- Debug: webhook directo de Meta (para confirmar que llegan las requests) ---
const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN ?? "oasis-verify-token";

// Verificación (GET): Meta espera que devolvamos el hub.challenge
app.get("/meta/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === META_VERIFY_TOKEN) {
    console.log("[meta] webhook verificado OK");
    return res.status(200).send(challenge);
  }
  console.warn("[meta] verificación FALLIDA:", { mode, token });
  return res.sendStatus(403);
});

// Eventos entrantes (POST): logueamos el payload completo
app.post("/meta/webhook", (req, res) => {
  console.log("[meta] evento recibido:\n", JSON.stringify(req.body, null, 2));
  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`oasis-whatsapp-bot escuchando en :${PORT}`);
});
