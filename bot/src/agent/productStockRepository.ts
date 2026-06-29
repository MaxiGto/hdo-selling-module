import pool from "../db/pool.js";

export interface StockResult {
  skuCode: string;
  description: string;
  additionalDescription: string | null;
  available: number;
}

// Busca productos por descripción o SKU (insensible a mayúsculas).
// Devuelve hasta 5 coincidencias ordenadas por descripción.
export async function searchStock(query: string): Promise<StockResult[]> {
  const { rows } = await pool.query<{
    sku_code: string;
    description: string;
    additional_description: string | null;
    quantity: string;
    engaged_quantity: string;
  }>(
    `SELECT sku_code, description, additional_description, quantity, engaged_quantity
     FROM product_stock_cache
     WHERE description ILIKE $1 OR sku_code ILIKE $1
     ORDER BY description
     LIMIT 5`,
    [`%${query}%`],
  );

  return rows.map((r) => ({
    skuCode: r.sku_code,
    description: r.description,
    additionalDescription: r.additional_description,
    available: Number(r.quantity) - Number(r.engaged_quantity),
  }));
}

// Formatea resultados de stock como texto para pasar al modelo.
export function formatStockResults(query: string, results: StockResult[]): string {
  if (results.length === 0) {
    return `No encontré "${query}" en el catálogo.`;
  }
  return results
    .map((r) => {
      const format = r.additionalDescription ? ` (${r.additionalDescription})` : "";
      const stockLabel = r.available > 0 ? `${r.available} disponibles` : "sin stock";
      return `${r.description}${format} [${r.skuCode}]: ${stockLabel}`;
    })
    .join("\n");
}
