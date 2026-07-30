import { config } from "../config.js";
import pool from "../db/pool.js";

// Solo sincronizamos las listas base con precios reales.
// Las listas "S/IVA" (101, 301, 401) siempre tienen Price=0 en la API.
const SYNCED_LISTS = new Set([100, 300, 400]);

interface TangoPrice {
  PriceListNumber: number;
  SKUCode: string;
  Price: number;
  DatePrice: string | null;
}

interface TangoPage<T> {
  Paging: { PageNumber: number; PageSize: number; MoreData: boolean };
  Data: T[];
}

const HDR = { accesstoken: config.tango.accessToken };

async function fetchPrices(): Promise<TangoPrice[]> {
  const results: TangoPrice[] = [];
  let page = 1;
  while (true) {
    const url = `${config.tango.baseUrl}/api/Aperture/Price?pageSize=${config.tango.pageSize}&pageNumber=${page}`;
    const res = await fetch(url, { headers: HDR });
    if (!res.ok) throw new Error(`Tango Price (${res.status}): ${await res.text()}`);
    const body = (await res.json()) as TangoPage<TangoPrice>;
    for (const p of body.Data ?? []) {
      if (SYNCED_LISTS.has(p.PriceListNumber) && p.Price > 0) {
        results.push(p);
      }
    }
    if (!body.Paging.MoreData) break;
    page++;
  }
  return results;
}

export async function syncPrices(): Promise<void> {
  console.log("[price-sync] iniciando...");
  const started = Date.now();

  const prices = await fetchPrices();
  console.log(`[price-sync] ${prices.length} precios obtenidos (listas 100/300/400)`);

  let upserted = 0;
  for (const p of prices) {
    await pool.query(
      `INSERT INTO price_cache (sku_code, price_list_number, price, date_price, last_synced_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (sku_code, price_list_number) DO UPDATE SET
         price          = EXCLUDED.price,
         date_price     = EXCLUDED.date_price,
         last_synced_at = NOW()`,
      [p.SKUCode, p.PriceListNumber, p.Price, p.DatePrice ?? null],
    );
    upserted++;
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`[price-sync] ${upserted} precios sincronizados en ${elapsed}s`);
}

if (process.argv[1]?.endsWith("tangoPriceSync.js")) {
  syncPrices()
    .then(() => pool.end())
    .catch((err) => {
      console.error("[price-sync] error fatal:", err);
      process.exit(1);
    });
}
