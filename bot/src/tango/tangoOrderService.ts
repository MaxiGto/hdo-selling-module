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
  orderId2?: string; // segundo pedido en caso de factura_remito
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

interface OrderContext {
  tangoInternalId: number;
  tangoId: string;
  ivaCategory: string;
  cuit: string | null;
  name: string;
  email: string | null;
  address: string | null;
  city: string | null;
  provinceCode: string | null;
  postalCode: string | null;
  phone: string | null;
  sellerCode: string | null;
  priceList: number;
  shippingAddresses: ReturnType<typeof formatShippingAddress>[];
  comment: string | null;
}

function buildOrderBody(
  ctx: OrderContext,
  items: OrderItem[],
  priceMap: Map<string, number>,
  customerCode: string,
  applyIva: boolean,
  orderId: string,
) {
  const orderItems = items.map((item) => ({
    ProductCode: String(item.tangoId),
    SKUCode:     item.skuCode,
    Description: item.description,
    Quantity:    item.quantity,
    UnitPrice:   priceMap.get(item.skuCode)!,
    DiscountPercentage: 0.0,
  }));

  const subtotal = orderItems.reduce((sum, i) => sum + i.UnitPrice * i.Quantity, 0);
  const total = applyIva ? subtotal * 1.21 : subtotal;

  return {
    OrderID:     orderId,
    OrderNumber: orderId.slice(-6),
    Date:        new Date().toISOString().slice(0, 19),
    Total:       total,
    TotalDiscount:      0.0,
    PaidTotal:          0.0,
    FinancialSurcharge: 0.0,
    WarehouseCode:     "1",
    SellerCode:        ctx.sellerCode ?? "OA",
    SaleConditionCode: 19,
    PriceListNumber:   ctx.priceList,
    ValidateTotalWithPaidTotal: false,
    ValidateTotalWithItems:     false,
    Comment:     ctx.comment,
    Customer: {
      CustomerID:      ctx.tangoInternalId,
      Code:            customerCode,
      DocumentType:    "80",
      DocumentNumber:  (ctx.cuit ?? "").replace(/[-\s]/g, ""),
      IVACategoryCode: ctx.ivaCategory,
      User:            "ADMIN",
      BusinessName:    ctx.name.replace(/^[^-]+ - /, ""),
      Email:           ctx.email ?? "",
      Street:          ctx.address ?? "",
      HouseNumber:     "",
      Floor:           "",
      Apartment:       "",
      City:            ctx.city ?? "",
      ProvinceCode:    ctx.provinceCode ?? "0",
      PostalCode:      ctx.postalCode ?? "",
      PhoneNumber1:    ctx.phone ?? "",
      BusinessAddress: ctx.address ?? "",
      NumberListPrice: ctx.priceList,
      Removed:         false,
    },
    CancelOrder:       false,
    OrderItems:        orderItems,
    ShippingAddresses: ctx.shippingAddresses,
    CashPayments:      null,
    Payments:          null,
  };
}

async function sendOrder(
  ctx: OrderContext,
  items: OrderItem[],
  priceMap: Map<string, number>,
  customerCode: string,
  applyIva: boolean,
  orderId: string,
): Promise<{ success: boolean; orderId?: string; error?: string }> {
  const body = buildOrderBody(ctx, items, priceMap, customerCode, applyIva, orderId);
  const bodyJson = JSON.stringify(body);
  console.log(`[order] enviando pedido ${orderId} (${applyIva ? "con IVA" : "sin IVA"}, code=${customerCode}):\n${bodyJson}`);

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

  const total = body.Total;
  console.log(`[order] pedido creado: ${orderId} — total: $${total.toFixed(2)} — respuesta Tango: ${responseText}`);
  return { success: true, orderId };
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
  console.log(`[order] contacto: ${contact.name} | tangoInternalId=${contact.tangoInternalId} | lista=${contact.priceListNumber} | condicion=${contact.billingCondition ?? "sin condición"}`);
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

  // ── 4. Contexto común ───────────────────────────────────────────────────
  const ctx: OrderContext = {
    tangoInternalId: contact.tangoInternalId,
    tangoId:         contact.tangoId,
    ivaCategory:     contact.ivaCategory ?? "RI",
    cuit:            contact.cuit,
    name:            contact.name,
    email:           contact.email,
    address:         contact.address,
    city:            contact.city,
    provinceCode:    contact.provinceCode,
    postalCode:      contact.postalCode,
    phone:           contact.phone,
    sellerCode:      contact.sellerCode,
    priceList,
    shippingAddresses: shippingAddressesPayload,
    comment:         observaciones ?? null,
  };

  const ts = Date.now();
  const codeC = contact.tangoId;
  const codeX = contact.tangoId.replace(/^C/, "X");
  const billingCondition = contact.billingCondition;

  // ── 5. Enviar según condición de facturación ─────────────────────────────
  if (billingCondition === "remito") {
    const orderId = `BOT-${chatwootContactId}-${ts}-R`;
    return sendOrder(ctx, items, priceMap, codeX, false, orderId);
  }

  if (billingCondition === "factura_remito") {
    // Dividir los SKUs: la mitad va a factura, el resto a remito.
    // Si la cantidad es impar, remito se lleva el SKU extra.
    const facturaCount = Math.floor(items.length / 2);
    const facturaItems = items.slice(0, facturaCount);
    const remitoItems  = items.slice(facturaCount);

    console.log(`[order] factura_remito — ${items.length} SKUs → factura: ${facturaCount}, remito: ${remitoItems.length}`);

    const orderIdF = `BOT-${chatwootContactId}-${ts}-F`;
    const orderIdR = `BOT-${chatwootContactId}-${ts}-R`;

    // Si solo hay 1 SKU, todo va a remito (no hay nada para factura).
    if (facturaItems.length === 0) {
      console.log(`[order] factura_remito con 1 solo SKU — enviando todo como remito`);
      return sendOrder(ctx, remitoItems, priceMap, codeX, false, orderIdR);
    }

    const resultF = await sendOrder(ctx, facturaItems, priceMap, codeC, true,  orderIdF);
    if (!resultF.success) return resultF;

    const resultR = await sendOrder(ctx, remitoItems, priceMap, codeX, false, orderIdR);
    if (!resultR.success) return resultR;

    return { success: true, orderId: orderIdF, orderId2: orderIdR };
  }

  // factura (o sin condición configurada — se factura con IVA por defecto)
  if (billingCondition !== "factura") {
    console.warn(`[order] billing_condition="${billingCondition ?? "null"}" — usando factura con IVA por defecto`);
  }
  const orderId = `BOT-${chatwootContactId}-${ts}-F`;
  return sendOrder(ctx, items, priceMap, codeC, true, orderId);
}
