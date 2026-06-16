# Plan del primer MVP — Bot de captación por WhatsApp

**Proyecto:** Hierbas del Oasis — "vendedor digital" de captación por WhatsApp
**Última actualización:** 2026-06-13

---

## 1. Objetivo del MVP

Un bot con IA que atrae clientes por WhatsApp, conversa automáticamente, insiste con
promociones si no hay respuesta, y entrega el lead caliente a un vendedor humano.
**No** arma pedidos todavía (eso es una fase posterior), pero la estructura queda
preparada para sumarlo sin reescribir.

## 2. Scope

**Dentro del MVP:**
- Integración con WhatsApp (vía Chatwoot, que es dueño de la conexión con Meta).
- Difusiones de captación (plantillas aprobadas, a una lista con opt-in).
- Recepción de mensajes entrantes + respuesta automática del bot (dudas, promos, info).
- Seguimiento automático: cadencia de promos si el lead no responde.
- Escalado a humano cuando el lead está caliente o el bot no puede resolver.

**Fuera del MVP (estructura preparada para sumarlos después):**
- Armado de pedidos, validación de stock, precios por ítem.
- Factura / cobro (ARCA-AFIP, Mercado Pago).
- Sincronización completa del catálogo desde Google Sheets.

## 3. Arquitectura (resumen)

```
Clientes ⇄ WhatsApp Cloud API (Meta) ⇄ Chatwoot (self-hosted) ⇄ Bot backend (Express/TS)
                                              │                         │
                                         Vendedores              Postgres + LLM (Claude)
```

- **Chatwoot Community self-hosted** = dueño de la conexión con Meta (1 inbox por número)
  y bandeja humana. Gratis.
- **Bot backend (Express/TS)** = Agent Bot de Chatwoot. Recibe mensajes, responde con el
  LLM, corre el motor de seguimiento y dispara difusiones.
- **Postgres** = fuente de verdad en runtime (contactos, estado del embudo, campañas).
- Sin sistema de colas: ACK rápido + worker async liviano + idempotencia por `message.id`.

**Embudo (máquina de estados en `contacts.status`):**
`NUEVO → CONTACTADO → EN_CONVERSACION → EN_SEGUIMIENTO → ESCALADO / DORMIDO / BAJA`

**Regla clave de WhatsApp:** fuera de la ventana de 24 h desde el último mensaje del
cliente, solo se puede escribir con **plantilla aprobada**. Por eso cada paso del
seguimiento es una plantilla de promo (no texto libre).

---

## FASE 0 — Prerrequisitos Meta + contenido  ⏱️ ~1–2 semanas · 🔴 CAMINO CRÍTICO

> Arrancar YA y en paralelo: las aprobaciones de Meta son lo que más demora.

- **0.1** Crear / verificar el **Meta Business Manager** (`business.facebook.com`).
  Si ya existe uno de Hierbas del Oasis (por Ads), usar ese — no crear duplicado.
- **0.2** Iniciar la **verificación de la empresa** (CUIT / constancia fiscal).
  Necesaria para superar el límite de 250 conv./día y aprobar plantillas de marketing.
- **0.3** Crear la **app de desarrollador** (`developers.facebook.com`, tipo Empresa) y
  agregar el producto **WhatsApp**.
- **0.4** Agregar el **número de teléfono** (usar uno **nuevo o secundario**, no el
  principal). Anotar: `Phone Number ID`, `WABA ID` y token de acceso.
- **0.5** Configurar el **método de pago** en WhatsApp Manager.
- **0.6** Redactar las **4 plantillas** y enviarlas a aprobación:
  1 de difusión inicial + 3 de seguimiento/promo (con variables).
- **0.7** Armar y limpiar la **lista de contactos con opt-in** para la primera difusión.

**Hito:** número activo en la API + 4 plantillas aprobadas + lista lista.

---

## FASE 1 — Infraestructura y canal  ⏱️ ~3–5 días

- **1.1** Provisionar el **VPS** (ej. 2 vCPU / 4 GB para Chatwoot + bot al inicio).
- **1.2** Instalar **Docker + docker-compose**.
- **1.3** Desplegar **Chatwoot self-hosted** (incluye Postgres + Redis propios de Chatwoot).
- **1.4** Configurar **dominio + HTTPS** (reverse proxy: Caddy o Nginx).
- **1.5** Conectar la **WABA como inbox de WhatsApp Cloud** en Chatwoot
  (con el `Phone Number ID`, `WABA ID` y token de la Fase 0).
- **1.6** Crear el **equipo de vendedores** y los usuarios en Chatwoot.

**Hito:** enviás y recibís un WhatsApp real a través de Chatwoot.

---

## FASE 2 — Bot mínimo: responder y escalar  ⏱️ ~1–2 semanas

- **2.1** **Scaffold** del backend Express/TS con la estructura por capas
  (`controllers / services / repositories / agent`).
- **2.2** **Postgres del bot** + migraciones. Tablas iniciales: `contacts`, `messages`.
- **2.3** Registrar el bot como **Agent Bot** en Chatwoot (configurar el webhook).
- **2.4** **Webhook**: recepción de mensajes + validación + **idempotencia** (`message.id`).
- **2.5** Integración con la **API de Chatwoot** (enviar mensajes, asignar conversaciones).
- **2.6** **AgentService**: llamada al LLM (Claude) con el system prompt de **lineamientos**
  + FAQ/promos. Incluye el guardrail de no dar consejos de salud sobre hierbas.
- **2.7** **Detección de intención** de compra → **escalado**: asignar la conversación al
  equipo humano en Chatwoot y silenciar al bot.
- **2.8** **Memoria por contacto** (estado + contexto en `contacts`).

**Hito:** entra un mensaje → el bot responde → lead caliente → pasa a un humano en Chatwoot.

---

## FASE 3 — Captación y seguimiento (el núcleo)  ⏱️ ~1–2 semanas

- **3.1** Ampliar el **modelo de datos** del embudo: campos de seguimiento en `contacts`
  (`status`, `source`, `followup_step`, `next_action_at`, `last_inbound_at`,
  `last_outbound_at`, `opt_in`, `opt_out`) + tablas `campaigns` y `campaign_sends`.
- **3.2** **CampaignService**: enviar la plantilla de difusión a la lista (vía API de
  Chatwoot), registrar cada envío y respetar el opt-in.
- **3.3** **Gestión de opt-out**: detectar "BAJA" / "no me escribas" → marcar `opt_out`
  y dejar de contactar.
- **3.4** **FollowupService** (worker tipo cron): cada N minutos busca contactos con
  `next_action_at <= ahora` y `status = EN_SEGUIMIENTO`, manda la siguiente plantilla,
  avanza el `followup_step` y reprograma; si supera la serie → `DORMIDO`.
  Respeta la ventana de 24 h (usa plantillas) y el opt-out.
- **3.5** **Transiciones de estado** del embudo conectadas a entrada/salida de mensajes.
- **3.6** Disparador de difusiones: panel mínimo o comando/endpoint para lanzar campañas.

**Hito:** sale la primera difusión + el bot reengancha solo con promos + escala al humano.

---

## FASE 4 — Medición y ajuste  ⏱️ ~3–5 días

- **4.1** **Métricas básicas**: difundidos, respondieron, escalados, bajas, conversión.
- **4.2** Reporte o dashboard simple.
- **4.3** **Ajuste** de la cadencia, los textos de las promos y los lineamientos según datos.
- **4.4** **Hardening**: token permanente de Meta, backups de Postgres/Chatwoot, logs,
  manejo de errores y reintentos.

**Hito:** primer ciclo completo medido y listo para iterar.

---

## 4. Dependencias y camino crítico

- La **Fase 0** (verificación de Meta + aprobación de plantillas) es el cuello de botella:
  arranca en paralelo a todo lo demás.
- La **Fase 1** se puede hacer en paralelo a la Fase 0 (no depende de las plantillas, solo
  del `Phone Number ID` para el paso 1.5).
- La **Fase 2** necesita la Fase 1 (canal funcionando).
- La **Fase 3** necesita la Fase 2 (bot) + las plantillas aprobadas (Fase 0).

## 5. Pendiente de definir antes de codear

- Textos exactos de las **4 plantillas** (difusión + 3 seguimiento) y la **cadencia**
  (ej. promos a los 2 / 5 / 9 días).
- El **system prompt / lineamientos** (tono, qué puede y no puede, cuándo escalar).
- Proveedor de **VPS** y dominio.
- Criterio de **"lead caliente"** para el escalado (palabras/intención que lo disparan).

## 6. Riesgos

- **Aprobación de plantillas de marketing** puede rechazarse → redactar siguiendo las
  políticas de Meta y tener alternativas.
- **Calidad del número**: difusiones poco relevantes → marcas de spam → Meta limita el
  envío. Segmentar y dar valor real.
- **Opt-in**: enviar a contactos sin consentimiento viola las políticas → solo lista limpia.
- **Ops de Chatwoot self-hosted**: actualizaciones y backups. Fallback: Chatwoot Cloud.
