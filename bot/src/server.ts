import express from "express";
import { config, warnMissingConfig } from "./config.js";
import { handleChatwootWebhook } from "./controllers/webhookController.js";
import { handleChatwootEvent } from "./controllers/eventsController.js";
import { runMigrations } from "./db/migrate.js";
import { startCrons } from "./campaigns/cronService.js";

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "oasis-whatsapp-bot" });
});

// Webhook del Agent Bot de Chatwoot: recibe mensajes y responde con el agente IA.
app.post("/chatwoot/webhook", handleChatwootWebhook);

// Webhook de eventos generales de Chatwoot (conversation_status_changed, etc.).
// Configurar en Chatwoot → Settings → Integrations → Webhooks → http://bot:3000/chatwoot/events
app.post("/chatwoot/events", handleChatwootEvent);

// --- Debug: webhook directo de Meta (solo para diagnóstico, no se usa en el flujo real) ---
const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN ?? "oasis-verify-token";

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

app.post("/meta/webhook", (req, res) => {
  console.log("[meta] evento recibido:\n", JSON.stringify(req.body, null, 2));
  res.sendStatus(200);
});

runMigrations()
  .then(() => {
    app.listen(config.port, () => {
      console.log(`oasis-whatsapp-bot escuchando en :${config.port}`);
      warnMissingConfig();
      startCrons();
    });
  })
  .catch((err) => {
    console.error("[startup] error en migraciones:", err);
    process.exit(1);
  });
