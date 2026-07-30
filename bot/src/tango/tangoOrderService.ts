import { config } from "../config.js";
import pool from "../db/pool.js";
import { getContactForOrder } from "../contacts/contactRepository.js";

export interface OrderItem {
  skuCode: string;
  tangoId: number;
  description: string;
  quantity: number;
}

export interface OrderResult {
  success: boolean;
  orderId?: string;
  error?: string;
}

// Mapea price_list_number del cliente a la lista base con precios reales.
// Las listas impares (101, 301, 401) tienen Price=0 en la API; usamos la par equivalente.
function basePriceList(priceListNumber: string | null): number {
  if (priceListNumber === "300" || priceListNumber === "301") return 300;
  if (priceListNumber === "400" || priceListNumber === "401") return 400;
  return 100; // default comercio
}

export async function createTangoOrder(
  chatwootContactId: number,
  items: OrderItem[],
  observaciones?: string,
): Promise<OrderResult> {
  // ── 1. Datos del contacto ────────────────────────────────────────────────
  const contact = await getContactForOrder(chatwootContactId);
  if (!contact) {
    return { success: false, error: "Contacto no encontrado en la base de datos del bot" };
  }
  if (!contact.tangoInternalId) {
    return { success: false, error: "El contacto no tiene ID interno de Tango (pendiente de sync)" };
  }

  const priceList = basePriceList(contact.priceListNumber);

  // ── 2. Precios de los ítems ──────────────────────────────────────────────
  const skuCodes = items.map((i) => i.skuCode);
  const { rows: priceRows } = await pool.query<{ sku_code: string; price: string }>(
    `SELECT sku_code, price FROM price_cache
     WHERE sku_code = ANY($1) AND price_list_number = $2`,
    [skuCodes, priceList],
  );
  const priceMap = new Map(priceRows.map((r) => [r.sku_code, Number(r.price)]));

  const missingPrices = skuCodes.filter((sku) => !priceMap.has(sku));
  if (missingPrices.length > 0) {
    return {
      success: false,
      error: `Sin precio para lista ${priceList}: ${missingPrices.join(", ")}`,
    };
  }

  // ── 3. Armar body del pedido ─────────────────────────────────────────────
  const orderItems = items.map((item) => ({
    ProductCode: String(item.tangoId),
    SKUCode:     item.skuCode,
    Description: item.description,
    Quantity:    item.quantity,
    UnitPrice:   priceMap.get(item.skuCode)!,
    DiscountPercentage: 0.0,
  }));

  const total = orderItems.reduce((sum, i) => sum + i.UnitPrice * i.Quantity, 0);

  const orderId = `BOT-${chatwootContactId}-${Date.now()}`;

  const body = {
    OrderID:     orderId,
    OrderNumber: String(Date.now()).slice(-6),
    Date:        new Date().toISOString().slice(0, 19),
    Total:       total,
    TotalDiscount:     0.0,
    PaidTotal:         0.0,
    FinancialSurcharge: 0.0,
    WarehouseCode:     "1",
    SellerCode:        contact.sellerCode ?? "OA",
    SaleConditionCode: 19,
    PriceListNumber:   priceList,
    ValidateTotalWithPaidTotal: false,
    ValidateTotalWithItems:     false,
    Comment:     observaciones ?? null,
    Customer: {
      CustomerID:      contact.tangoInternalId,
      DocumentType:    "80",
      DocumentNumber:  contact.cuit ?? "",
      IVACategoryCode: contact.ivaCategory ?? "RI",
      User:            "ADMIN",
      BusinessName:    contact.name.replace(/^[^-]+ - /, ""), // solo la razón social, sin el código
      Email:           contact.email ?? "",
      Street:          contact.address ?? "",
      City:            contact.city ?? "",
      ProvinceCode:    contact.provinceCode ?? "0",
      PostalCode:      contact.postalCode ?? "",
      NumberListPrice: priceList,
      Removed:         false,
    },
    CancelOrder: false,
    OrderItems:  orderItems,
    CashPayments: null,
    Payments:     null,
  };

  // ── 4. POST a la API de Tiendas ──────────────────────────────────────────
  const bodyJson = JSON.stringify(body);
  console.log(`[order] enviando pedido:\n${bodyJson}`);

  const res = await fetch(`${config.tango.baseUrl}/api/Aperture/order`, {
    method:  "POST",
    headers: { accesstoken: config.tango.accessToken, "Content-Type": "application/json" },
    body:    bodyJson,
  });

  const responseText = await res.text();
  if (!res.ok) {
    console.error(`[order] falló (${res.status}): ${responseText}`);
    return { success: false, error: `Error al crear pedido en Tango (${res.status})` };
  }

  console.log(`[order] pedido creado: ${orderId} — total: $${total.toFixed(2)}`);
  return { success: true, orderId };
}
