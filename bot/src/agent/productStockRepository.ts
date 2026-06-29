import pool from "../db/pool.js";

export interface StockResult {
  skuCode: string;
  description: string;
  additionalDescription: string | null;
  available: number;
}

// Búsqueda amplia por palabras sueltas (OR): devuelve hasta 15 candidatos
// ordenados por cantidad de palabras coincidentes. El modelo evalúa cuál
// es el match correcto y, si hay ambigüedad, presenta lista numerada al cliente.
export async function searchStock(query: string): Promise<StockResult[]> {
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const params: string[] = words.map((w) => `%${w}%`);

  // Cada palabra genera una condición ILIKE; se ranquean primero los que
  // coinciden con más palabras del query.
  const wordConditions = words.map((_, i) => `description ILIKE $${i + 1}`);
  const scoreExpr = wordConditions.map((c) => `CASE WHEN ${c} THEN 1 ELSE 0 END`).join(" + ");
  const whereClause = `${wordConditions.join(" OR ")} OR sku_code ILIKE $1`;

  const { rows } = await pool.query<{
    sku_code: string;
    description: string;
    additional_description: string | null;
    quantity: string;
    engaged_quantity: string;
  }>(
    `SELECT sku_code, description, additional_description, quantity, engaged_quantity
     FROM product_stock_cache
     WHERE ${whereClause}
     ORDER BY (${scoreExpr}) DESC, description
     LIMIT 15`,
    params,
  );

  return rows.map((r) => ({
    skuCode: r.sku_code,
    description: r.description,
    additionalDescription: r.additional_description,
    available: Number(r.quantity) - Number(r.engaged_quantity),
  }));
}

// Formatea candidatos para que el modelo los evalúe.
// Nunca expone cantidades exactas: solo indica si hay stock suficiente para
// la cantidad pedida, o si hay/no hay stock en caso de consulta libre.
export function formatStockResults(
  query: string,
  results: StockResult[],
  cantidadPedida?: number,
): string {
  if (results.length === 0) {
    return `No encontré ningún producto que coincida con "${query}" en el catálogo.`;
  }
  const lines = results.map((r, i) => {
    const format = r.additionalDescription ? ` (${r.additionalDescription})` : "";
    const stockLabel =
      cantidadPedida !== undefined
        ? r.available >= cantidadPedida
          ? "stock suficiente"
          : "stock insuficiente"
        : r.available > 0
          ? "hay stock"
          : "sin stock";
    return `${i + 1}. ${r.description}${format} [${r.skuCode}]: ${stockLabel}`;
  });
  return `Candidatos para "${query}":\n${lines.join("\n")}`;
}
