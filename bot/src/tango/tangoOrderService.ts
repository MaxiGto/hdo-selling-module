import { config } from "../config.js";
import pool from "../db/pool.js";
import { getContactForOrder, getShippingAddresses, type ShippingAddress } from "../contacts/contactRepository.js";

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

function formatShippingAddress(a: ShippingAddress) {
  const flag = (b: boolean) => b ? "S" : "N";
  return {
    Code:              a.code,
    Address:           a.address ?? "",
    ProvinceCode:      a.provinceCode ?? "0",
    City:              a.city ?? "",
    PostalCode:        a.postalCode ?? "",
    PhoneNumber1:      a.phoneNumber1 ?? "",
    PhoneNumber2:      a.phoneNumber2 ?? "",
    DefaultAddress:    flag(a.defaultAddress),
    Enabled:           flag(a.enabled),
    DeliveryHours:     a.deliveryHours ?? "",
    DeliversMonday:    flag(a.deliversMonday),
    DeliversTuesday:   flag(a.deliversTuesday),
    DeliversWednesday: flag(a.deliversWednesday),
    DeliversThursday:  flag(a.deliversThursday),
    DeliversFriday:    flag(a.deliversFriday),
    DeliversSaturday:  flag(a.deliversSaturday),
    DeliversSunday:    flag(a.deliversSunday),
  };
}

export async function createTangoOrder(
  chatwootContactId: number,
  items: OrderItem[],
  observaciones?: string,
  shippingAddressCode?: string,
): Promise<OrderResult> {
  // ── 1. Datos del contacto ────────────────────────────────────────────────
  console.log(`[order] iniciando pedido para chatwootContactId=${chatwootContactId}`);
  const contact = await getContactForOrder(chatwootContactId);
  if (!contact) {
    console.error(`[order] contacto no encontrado en DB (chatwootContactId=${chatwootContactId})`);
    return { success: false, error: "Contacto no encontrado en la base de datos del bot" };
  }
  console.log(`[order] contacto: ${contact.name} | tangoInternalId=${contact.tangoInternalId} | lista=${contact.priceListNumber}`);
  if (!contact.tangoInternalId) {
    console.error(`[order] contacto sin tango_internal_id — sync pendiente`);
    return { success: false, error: "El contacto no tiene ID interno de Tango (pendiente de sync)" };
  }

  const priceList = basePriceList(contact.priceListNumber);

  // ── 2. Precios de los ítems ──────────────────────────────────────────────
  const skuCodes = items.map((i) => i.skuCode);
  console.log(`[order] buscando precios en lista ${priceList} para SKUs: ${skuCodes.join(", ")}`);
  const { rows: priceRows } = await pool.query<{ sku_code: string; price: string }>(
    `SELECT sku_code, price FROM price_cache
     WHERE sku_code = ANY($1) AND price_list_number = $2`,
    [skuCodes, priceList],
  );
  const priceMap = new Map(priceRows.map((r) => [r.sku_code, Number(r.price)]));

  const missingPrices = skuCodes.filter((sku) => !priceMap.has(sku));
  if (missingPrices.length > 0) {
    console.error(`[order] sin precio en lista ${priceList} para: ${missingPrices.join(", ")}`);
    return {
      success: false,
      error: `Sin precio para lista ${priceList}: ${missingPrices.join(", ")}`,
    };
  }

  // ── 3. Dirección de envío ────────────────────────────────────────────────
  const allAddresses = await getShippingAddresses(chatwootContactId);
  let selectedAddress: ShippingAddress | undefined;
  if (shippingAddressCode) {
    selectedAddress = allAddresses.find((a) => a.code === shippingAddressCode);
    if (!selectedAddress) {
      console.warn(`[order] dirección "${shippingAddressCode}" no encontrada — usando la predeterminada`);
    }
  }
  if (!selectedAddress) {
    selectedAddress = allAddresses.find((a) => a.defaultAddress) ?? allAddresses[0];
  }
  const shippingAddressesPayload = selectedAddress ? [formatShippingAddress(selectedAddress)] : [];
  console.log(`[order] dirección de envío: ${selectedAddress?.address ?? "sin dirección"} — ${selectedAddress?.city ?? ""}`);

  // ── 4. Armar body del pedido ─────────────────────────────────────────────
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
      Code:            contact.tangoId,
      DocumentType:    "80",
      DocumentNumber:  (contact.cuit ?? "").replace(/[-\s]/g, ""),
      IVACategoryCode: contact.ivaCategory ?? "RI",
      User:            "ADMIN",
      BusinessName:    contact.name.replace(/^[^-]+ - /, ""),
      Email:           contact.email ?? "",
      Street:          contact.address ?? "",
      HouseNumber:     "",
      Floor:           "",
      Apartment:       "",
      City:            contact.city ?? "",
      ProvinceCode:    contact.provinceCode ?? "0",
      PostalCode:      contact.postalCode ?? "",
      PhoneNumber1:    contact.phone ?? "",
      BusinessAddress: contact.address ?? "",
      NumberListPrice: priceList,
      Removed:         false,
    },
    CancelOrder:       false,
    OrderItems:        orderItems,
    ShippingAddresses: shippingAddressesPayload,
    CashPayments:      null,
    Payments:          null,
  };

  // ── 5. POST a la API de Tiendas ──────────────────────────────────────────
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

  console.log(`[order] pedido creado: ${orderId} — total: $${total.toFixed(2)} — respuesta Tango: ${responseText}`);
  return { success: true, orderId };
}
