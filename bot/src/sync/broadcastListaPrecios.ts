// Script de difusión de listas de precios por categoría.
//
// Envía el template de WhatsApp correspondiente a cada contacto según su lista de precios:
//   C   (100/101) → lista_comercio
//   D   (300/301) → lista_distribuidor
//   D+  (400/401) → lista_plus
//
// Cada template tiene una variable {{1}} con la URL de la carpeta Drive de recursos.
//
// Uso en el VPS:
//   docker compose exec bot node dist/sync/broadcastListaPrecios.js <categoria> [--test]
//
//   Categorías: C | D | D+
//   --test: solo envía al contacto de prueba (Maxi GT)
//
// Ejemplos:
//   docker compose exec bot node dist/sync/broadcastListaPrecios.js D+ --test
//   docker compose exec bot node dist/sync/broadcastListaPrecios.js C

import pool from "../db/pool.js";
import { config } from "../config.js";
import { createConversation } from "../chatwoot/chatwootClient.js";

// ── Configuración por categoría ─────────────────────────────────────────────

const CATEGORIA_CONFIG: Record<string, {
  priceLists: string[];
  templateName: string;
  folderUrl: string;
}> = {
  C: {
    priceLists: ["100", "101"],
    templateName: "lista_comercio",
    folderUrl: "https://drive.google.com/drive/folders/1_l320AkF5WBF40B6LqyxNTpluzvcAZMG",
  },
  D: {
    priceLists: ["300", "301"],
    templateName: "lista_distribuidor",
    folderUrl: "https://drive.google.com/drive/u/0/folders/1QOw93h-VNRE2Wlr5OzhQtOg_QnKl0STL",
  },
  "D+": {
    priceLists: ["400", "401"],
    templateName: "lista_plus",
    folderUrl: "https://drive.google.com/drive/u/0/folders/1A2menTExdH0L-CcEVSBG--KrPT2KQnic",
  },
};

// Teléfono de prueba (Maxi GT, D+)
const TEST_PHONE = "+541123996330";

// ── Helpers de Chatwoot ──────────────────────────────────────────────────────

function agentHeaders() {
  return { "Content-Type": "application/json", api_access_token: config.chatwoot.agentToken };
}

function accountUrl(path: string): string {
  return `${config.chatwoot.baseUrl}/api/v1/accounts/${config.chatwoot.accountId}${path}`;
}

async function getOrCreateConversation(chatwootContactId: number): Promise<number> {
  // Busca conversaciones abiertas/pendientes existentes para este contacto en el inbox
  const res = await fetch(
    accountUrl(`/contacts/${chatwootContactId}/conversations`),
    { headers: agentHeaders() },
  );
  if (res.ok) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (await res.json()) as any;
    const convs: { id: number; inbox_id: number }[] = body?.payload ?? [];
    const existing = convs.find((c) => c.inbox_id === config.chatwoot.inboxId);
    if (existing) return existing.id;
  }
  // Si no hay conversación, crear una nueva
  return createConversation(chatwootContactId, config.chatwoot.inboxId);
}

async function sendTemplate(
  conversationId: number,
  templateName: string,
  folderUrl: string,
): Promise<void> {
  const res = await fetch(accountUrl(`/conversations/${conversationId}/messages`), {
    method: "POST",
    headers: agentHeaders(),
    body: JSON.stringify({
      message_type: "outgoing",
      template_params: {
        name: templateName,
        category: "MARKETING",
        language: "es",
        processed_params: { "1": folderUrl },
      },
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`sendTemplate(${templateName}) falló (${res.status}): ${text}`);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const categoria = args[0] as string | undefined;
  const isTest = args.includes("--test");

  if (!categoria || !(categoria in CATEGORIA_CONFIG)) {
    console.error(`Uso: broadcastListaPrecios.js <C|D|D+> [--test]`);
    process.exit(1);
  }

  const { priceLists, templateName, folderUrl } = CATEGORIA_CONFIG[categoria];

  console.log(`\n[broadcast] categoría  : ${categoria}`);
  console.log(`[broadcast] template   : ${templateName}`);
  console.log(`[broadcast] folder_url : ${folderUrl}`);
  console.log(`[broadcast] modo       : ${isTest ? "TEST (solo Maxi GT)" : "PRODUCCIÓN"}\n`);

  // Obtener contactos de la DB según categoría (o solo el de prueba)
  let query: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let queryParams: any[];

  if (isTest) {
    query = `
      SELECT id, name, phone_normalized, chatwoot_contact_id, price_list_number
      FROM contacts
      WHERE phone_normalized = $1
      LIMIT 1
    `;
    queryParams = [TEST_PHONE];
  } else {
    query = `
      SELECT id, name, phone_normalized, chatwoot_contact_id, price_list_number
      FROM contacts
      WHERE price_list_number = ANY($1::text[])
        AND chatwoot_contact_id IS NOT NULL
      ORDER BY name
    `;
    queryParams = [priceLists];
  }

  const { rows } = await pool.query<{
    id: number;
    name: string;
    phone_normalized: string | null;
    chatwoot_contact_id: number | null;
    price_list_number: string | null;
  }>(query, queryParams);

  if (rows.length === 0) {
    console.warn("[broadcast] No se encontraron contactos. Verificá la DB.");
    await pool.end();
    return;
  }

  console.log(`[broadcast] ${rows.length} contacto(s) a procesar\n`);

  let ok = 0;
  let errors = 0;

  for (const contact of rows) {
    if (!contact.chatwoot_contact_id) {
      console.warn(`[broadcast] SKIP ${contact.name}: sin chatwoot_contact_id`);
      errors++;
      continue;
    }

    try {
      const conversationId = await getOrCreateConversation(contact.chatwoot_contact_id);
      await sendTemplate(conversationId, templateName, folderUrl);
      console.log(`[broadcast] ✓ ${contact.name} (conv ${conversationId})`);
      ok++;

      // Pausa breve para no saturar la API de Chatwoot
      await new Promise((r) => setTimeout(r, 300));
    } catch (err) {
      console.error(`[broadcast] ✗ ${contact.name}:`, err);
      errors++;
    }
  }

  console.log(`\n[broadcast] ── RESULTADO ─────────────────────`);
  console.log(`  enviados : ${ok}`);
  console.log(`  errores  : ${errors}`);
  console.log(`  total    : ${rows.length}`);
  console.log(`────────────────────────────────────────────`);

  await pool.end();
  process.exit(errors > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[broadcast] error fatal:", err);
  process.exit(1);
});
