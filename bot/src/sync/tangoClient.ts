import { config } from "../config.js";

// Schema real del endpoint GET /api/Aperture/Customer (verificado 2026-06-23).
interface TangoShippingAddress {
  Code: string;
  Address?: string;
  ProvinceCode?: string;
  City?: string;
  PostalCode?: string;
  PhoneNumber1?: string;
  PhoneNumber2?: string;
  DefaultAddress: "S" | "N";
  Enabled?: "S" | "N";
  DeliversMonday:    "S" | "N";
  DeliversTuesday:   "S" | "N";
  DeliversWednesday: "S" | "N";
  DeliversThursday:  "S" | "N";
  DeliversFriday:    "S" | "N";
  DeliversSaturday:  "S" | "N";
  DeliversSunday:    "S" | "N";
  DeliveryHours?: string;
}

interface TangoCustomer {
  Id?: number;                   // ID interno de Tango (ID_GVA14)
  Code: string;
  BusinessName?: string;
  TradeName?: string;
  Address?: string;
  PostalCode?: string;
  City?: string;
  ProvinceCode?: string;
  PhoneNumbers?: string;
  MobilePhoneNumber?: string;
  Email?: string;
  DocumentType?: string;
  DocumentNumber?: string;       // CUIT/DNI
  SellerCode?: string;
  PriceListNumber?: number | string | null;
  ShippingAddresses?: TangoShippingAddress[];
  DisabledDate?: string | null;
}

interface TangoPage {
  Paging: { PageNumber: number; PageSize: number; MoreData: boolean };
  Data: TangoCustomer[];
}

const PAGE_SIZE = config.tango.pageSize;

// Normaliza un número argentino a formato E.164 (+549XXXXXXXXXX).
// Cubre los formatos más comunes en Tango; retorna null si no se puede resolver.
export function normalizeArgentinePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (!digits) return null;

  // Ya tiene código de país completo — quitar el 9 si está presente (+549... → +54...)
  if (digits.startsWith("54") && digits.length >= 12) {
    const rest = digits.slice(2); // sin "54"
    return "+54" + (rest.startsWith("9") ? rest.slice(1) : rest);
  }

  // Quita prefijo troncal 0
  const local = digits.startsWith("0") ? digits.slice(1) : digits;

  // 11 dígitos comenzando con 9 → quitar el 9
  if (local.length === 11 && local.startsWith("9")) return "+54" + local.slice(1);

  // 10 dígitos → directo, sin indicador de celular
  if (local.length === 10) return "+54" + local;

  return null;
}

// Primer número válido disponible. PhoneNumbers puede tener varios separados por coma/guión.
function bestPhone(c: TangoCustomer): string | null {
  const candidates = [
    c.MobilePhoneNumber,
    // PhoneNumbers puede contener múltiples: tomamos el primero
    c.PhoneNumbers?.split(/[,/]/)[0],
    // Teléfonos de la dirección de entrega principal
    c.ShippingAddresses?.find((a) => a.DefaultAddress === "S")?.PhoneNumber1,
  ];
  for (const raw of candidates) {
    if (!raw?.trim()) continue;
    const normalized = normalizeArgentinePhone(raw.trim());
    if (normalized) return normalized;
  }
  return null;
}

export interface TangoShippingAddressFlat {
  code: string;
  address: string | null;
  provinceCode: string | null;
  city: string | null;
  postalCode: string | null;
  phoneNumber1: string | null;
  phoneNumber2: string | null;
  defaultAddress: boolean;
  enabled: boolean;
  deliveryHours: string | null;
  deliversMonday: boolean;
  deliversTuesday: boolean;
  deliversWednesday: boolean;
  deliversThursday: boolean;
  deliversFriday: boolean;
  deliversSaturday: boolean;
  deliversSunday: boolean;
}

export interface TangoCustomerFlat {
  tangoId: string;
  tangoInternalId: number | null;
  name: string;
  businessName: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  postalCode: string | null;
  provinceCode: string | null;
  documentNumber: string | null;
  sellerCode: string | null;
  priceListNumber: string | null;
  deliveryDays: {
    monday: boolean; tuesday: boolean; wednesday: boolean;
    thursday: boolean; friday: boolean; saturday: boolean; sunday: boolean;
  };
  shippingAddresses: TangoShippingAddressFlat[];
}

function categoryLabel(priceListNumber: string | null): string {
  if (priceListNumber === "100" || priceListNumber === "101") return "/C";
  if (priceListNumber === "300" || priceListNumber === "301") return "/D";
  if (priceListNumber === "400" || priceListNumber === "401") return "/D+";
  return "";
}

function flattenCustomer(c: TangoCustomer): TangoCustomerFlat {
  // Nombre visible: "C7D001/C - 7 DE ORO S.R.L." — el sufijo identifica la categoría del cliente.
  const displayName = c.BusinessName?.trim() || c.TradeName?.trim() || "";
  const priceListNum = c.PriceListNumber != null ? String(c.PriceListNumber) : null;
  const label = categoryLabel(priceListNum);
  const name = displayName ? `${c.Code}${label} - ${displayName}` : `${c.Code}${label}`;
  const defaultAddr = c.ShippingAddresses?.find((a) => a.DefaultAddress === "S");
  const flag = (v?: string) => v === "S";
  const str = (v?: string) => v?.trim() || null;

  const shippingAddresses: TangoShippingAddressFlat[] = (c.ShippingAddresses ?? []).map((a) => ({
    code:            a.Code,
    address:         str(a.Address),
    provinceCode:    str(a.ProvinceCode),
    city:            str(a.City),
    postalCode:      str(a.PostalCode),
    phoneNumber1:    str(a.PhoneNumber1),
    phoneNumber2:    str(a.PhoneNumber2),
    defaultAddress:  a.DefaultAddress === "S",
    enabled:         a.Enabled !== "N",
    deliveryHours:   str(a.DeliveryHours),
    deliversMonday:    flag(a.DeliversMonday),
    deliversTuesday:   flag(a.DeliversTuesday),
    deliversWednesday: flag(a.DeliversWednesday),
    deliversThursday:  flag(a.DeliversThursday),
    deliversFriday:    flag(a.DeliversFriday),
    deliversSaturday:  flag(a.DeliversSaturday),
    deliversSunday:    flag(a.DeliversSunday),
  }));

  return {
    tangoId:         c.Code,
    tangoInternalId: c.Id ?? null,
    name,
    businessName:    str(c.BusinessName),
    phone:           bestPhone(c),
    email:           str(c.Email),
    address:         str(defaultAddr?.Address ?? c.Address),
    city:            str(defaultAddr?.City ?? c.City),
    postalCode:      str(defaultAddr?.PostalCode ?? c.PostalCode),
    provinceCode:    str(c.ProvinceCode),
    documentNumber:  str(c.DocumentNumber),
    sellerCode:      str(c.SellerCode),
    priceListNumber: priceListNum,
    deliveryDays: {
      monday:    flag(defaultAddr?.DeliversMonday),
      tuesday:   flag(defaultAddr?.DeliversTuesday),
      wednesday: flag(defaultAddr?.DeliversWednesday),
      thursday:  flag(defaultAddr?.DeliversThursday),
      friday:    flag(defaultAddr?.DeliversFriday),
      saturday:  flag(defaultAddr?.DeliversSaturday),
      sunday:    flag(defaultAddr?.DeliversSunday),
    },
    shippingAddresses,
  };
}

// Trae todos los clientes activos de Tango paginando automáticamente.
export async function fetchAllCustomers(): Promise<TangoCustomerFlat[]> {
  const results: TangoCustomerFlat[] = [];
  let page = 1;

  while (true) {
    const url =
      `${config.tango.baseUrl}/api/Aperture/Customer` +
      `?pageSize=${PAGE_SIZE}&pageNumber=${page}`;

    const res = await fetch(url, {
      headers: { accesstoken: config.tango.accessToken },
    });

    if (!res.ok) throw new Error(`Tango API error (${res.status}): ${await res.text()}`);

    const body = (await res.json()) as TangoPage;

    for (const c of body.Data ?? []) {
      // Ignorar clientes dados de baja
      if (c.DisabledDate) continue;
      results.push(flattenCustomer(c));
    }

    if (!body.Paging.MoreData) break;
    page++;
  }

  return results;
}
