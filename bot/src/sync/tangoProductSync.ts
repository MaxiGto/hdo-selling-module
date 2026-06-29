import { config } from "../config.js";
import pool from "../db/pool.js";

interface TangoProduct {
  Id: number;
  SKUCode: string;
  Description: string;
  AdditionalDescription?: string;
  BarCode?: string;
  Disabled: boolean;
}

interface TangoStock {
  SKUCode: string;
  Quantity: number;
  EngagedQuantity: number;
}

interface TangoPage<T> {
  Paging: { PageNumber: number; PageSize: number; MoreData: boolean };
  Data: T[];
}

// SKUs excluidos de venta (no se sincronizan en la DB).
const EXCLUDED_SKU_PREFIXES = ["00", "18"];

const HDR = { accesstoken: config.tango.accessToken };

function isExcluded(skuCode: string): boolean {
  return EXCLUDED_SKU_PREFIXES.some((prefix) => skuCode.startsWith(prefix));
}

async function fetchProducts(): Promise<TangoProduct[]> {
  const results: TangoProduct[] = [];
  let page = 1;
  while (true) {
    const url = `${config.tango.baseUrl}/api/Aperture/Product?pageSize=${config.tango.pageSize}&pageNumber=${page}`;
    const res = await fetch(url, { headers: HDR });
    if (!res.ok) throw new Error(`Tango Product (${res.status}): ${await res.text()}`);
    const body = (await res.json()) as TangoPage<TangoProduct>;
    for (const p of body.Data ?? []) {
      if (!p.Disabled && !isExcluded(p.SKUCode)) results.push(p);
    }
    if (!body.Paging.MoreData) break;
    page++;
  }
  return results;
}

// Agrega stock de todos los depósitos para el mismo SKU.
async function fetchStockMap(): Promise<Map<string, { quantity: number; engagedQuantity: number }>> {
  const map = new Map<string, { quantity: number; engagedQuantity: number }>();
  let page = 1;
  while (true) {
    const url = `${config.tango.baseUrl}/api/Aperture/Stock?pageSize=${config.tango.pageSize}&pageNumber=${page}`;
    const res = await fetch(url, { headers: HDR });
    if (!res.ok) throw new Error(`Tango Stock (${res.status}): ${await res.text()}`);
    const body = (await res.json()) as TangoPage<TangoStock>;
    for (const s of body.Data ?? []) {
      const existing = map.get(s.SKUCode);
      if (existing) {
        existing.quantity += Number(s.Quantity);
        existing.engagedQuantity += Number(s.EngagedQuantity);
      } else {
        map.set(s.SKUCode, { quantity: Number(s.Quantity), engagedQuantity: Number(s.EngagedQuantity) });
      }
    }
    if (!body.Paging.MoreData) break;
    page++;
  }
  return map;
}

export async function syncProductStock(): Promise<void> {
  console.log("[stock-sync] iniciando...");
  const started = Date.now();

  const [products, stockMap] = await Promise.all([fetchProducts(), fetchStockMap()]);
  console.log(`[stock-sync] ${products.length} productos activos, ${stockMap.size} SKUs con stock`);

  let upserted = 0;
  for (const p of products) {
    const s = stockMap.get(p.SKUCode) ?? { quantity: 0, engagedQuantity: 0 };
    await pool.query(
      `INSERT INTO product_stock_cache
         (sku_code, tango_id, description, additional_description, bar_code,
          quantity, engaged_quantity, last_synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
       ON CONFLICT (sku_code) DO UPDATE SET
         tango_id               = EXCLUDED.tango_id,
         description            = EXCLUDED.description,
         additional_description = EXCLUDED.additional_description,
         bar_code               = EXCLUDED.bar_code,
         quantity               = EXCLUDED.quantity,
         engaged_quantity       = EXCLUDED.engaged_quantity,
         last_synced_at         = NOW()`,
      [p.SKUCode, p.Id, p.Description, p.AdditionalDescription || null,
       p.BarCode || null, s.quantity, s.engagedQuantity],
    );
    upserted++;
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`[stock-sync] ${upserted} productos sincronizados en ${elapsed}s`);
}
