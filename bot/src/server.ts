import express from "express";
import { config, warnMissingConfig } from "./config.js";
import { handleChatwootWebhook } from "./controllers/webhookController.js";

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "oasis-whatsapp-bot" });
});

// Webhook del Agent Bot de Chatwoot: recibe mensajes y responde con el agente IA.
app.post("/chatwoot/webhook", handleChatwootWebhook);

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

app.listen(config.port, () => {
  console.log(`oasis-whatsapp-bot escuchando en :${config.port}`);
  warnMissingConfig();
});
