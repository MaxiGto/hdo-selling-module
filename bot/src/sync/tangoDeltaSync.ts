import { config } from "../config.js";
import pool from "../db/pool.js";

interface DeltaCustomer {
  COD_GVA14: string;
  ID_GVA14: number;
}

interface DeltaResponse {
  list: DeltaCustomer[];
  hasNextPage: boolean;
}

function deltaHeaders() {
  return {
    "ApiAuthorization": config.tango.deltaToken,
    "Company":          config.tango.deltaCompany,
    "Accept":           "application/json",
  };
}

async function fetchDeltaPage(page: number): Promise<DeltaResponse> {
  const url =
    `${config.tango.deltaUrl}/api/GetByFilter` +
    `?process=2117&pageSize=${config.tango.pageSize}&pageNumber=${page}`;
  const res = await fetch(url, { headers: deltaHeaders() });
  if (!res.ok) throw new Error(`Delta API (${res.status}): ${await res.text()}`);
  return res.json() as Promise<DeltaResponse>;
}

// Trae ID_GVA14 para todos los clientes del Delta API y actualiza tango_internal_id en la DB.
export async function syncTangoInternalIds(): Promise<void> {
  if (!config.tango.deltaUrl || !config.tango.deltaToken) {
    console.warn("[delta-sync] TANGO_DELTA_URL o TANGO_DELTA_TOKEN no configurados — omitido");
    return;
  }

  console.log("[delta-sync] iniciando sync de IDs internos desde Delta API...");
  const started = Date.now();

  let page = 1;
  let updated = 0;
  let total = 0;

  while (true) {
    const body = await fetchDeltaPage(page);
    const customers = body.list ?? [];
    total += customers.length;

    for (const c of customers) {
      if (!c.COD_GVA14 || !c.ID_GVA14) continue;
      const { rowCount } = await pool.query(
        `UPDATE contacts SET tango_internal_id = $1
         WHERE tango_id = $2 AND (tango_internal_id IS NULL OR tango_internal_id <> $1)`,
        [c.ID_GVA14, c.COD_GVA14],
      );
      if (rowCount && rowCount > 0) updated++;
    }

    if (!body.hasNextPage) break;
    page++;
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`[delta-sync] ${updated} IDs actualizados de ${total} clientes procesados en ${elapsed}s`);
}

if (process.argv[1]?.endsWith("tangoDeltaSync.js")) {
  syncTangoInternalIds()
    .then(() => pool.end())
    .catch((err) => { console.error("[delta-sync] error fatal:", err); process.exit(1); });
}
