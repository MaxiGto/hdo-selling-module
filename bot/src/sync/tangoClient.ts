import { config } from "../config.js";

// Schema real del endpoint GET /api/Aperture/Customer (verificado 2026-06-23).
interface TangoShippingAddress {
  Code: string;
  PhoneNumber1?: string;
  PhoneNumber2?: string;
  DefaultAddress: "S" | "N";
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
  Code: string;
  BusinessName?: string;
  TradeName?: string;
  ProvinceCode?: string;
  PhoneNumbers?: string;         // teléfono principal (puede tener múltiples separados por coma)
  MobilePhoneNumber?: string;
  Email?: string;
  SellerCode?: string;           // código del vendedor asignado → base para zona
  ShippingAddresses?: TangoShippingAddress[];
  DisabledDate?: string | null;  // null = activo
}

interface TangoPage {
  Paging: { PageNumber: number; PageSize: number; MoreData: boolean };
  Data: TangoCustomer[];
}

const PAGE_SIZE = 500;

// Normaliza un número argentino a formato E.164 (+549XXXXXXXXXX).
// Cubre los formatos más comunes en Tango; retorna null si no se puede resolver.
export function normalizeArgentinePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (!digits) return null;

  // Ya tiene código de país completo
  if (digits.startsWith("54") && digits.length >= 12) return "+" + digits;

  // Quita prefijo troncal 0
  const local = digits.startsWith("0") ? digits.slice(1) : digits;

  // 11 dígitos comenzando con 9 → ya tiene indicador de celular → +54
  if (local.length === 11 && local.startsWith("9")) return "+54" + local;

  // 10 dígitos → celular sin indicador → +549
  if (local.length === 10) return "+549" + local;

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

export interface TangoCustomerFlat {
  tangoId: string;
  name: string;
  phone: string | null;
  provinceCode: string | null;
  sellerCode: string | null;
  // Días de entrega de la dirección principal (true = entrega ese día)
  deliveryDays: {
    monday: boolean; tuesday: boolean; wednesday: boolean;
    thursday: boolean; friday: boolean; saturday: boolean; sunday: boolean;
  };
}

function flattenCustomer(c: TangoCustomer): TangoCustomerFlat {
  const name = c.TradeName?.trim() || c.BusinessName?.trim() || `Cliente ${c.Code}`;
  const defaultAddr = c.ShippingAddresses?.find((a) => a.DefaultAddress === "S");
  const flag = (v?: string) => v === "S";

  return {
    tangoId:      c.Code,
    name,
    phone:        bestPhone(c),
    provinceCode: c.ProvinceCode?.trim() ?? null,
    sellerCode:   c.SellerCode?.trim() ?? null,
    deliveryDays: {
      monday:    flag(defaultAddr?.DeliversMonday),
      tuesday:   flag(defaultAddr?.DeliversTuesday),
      wednesday: flag(defaultAddr?.DeliversWednesday),
      thursday:  flag(defaultAddr?.DeliversThursday),
      friday:    flag(defaultAddr?.DeliversFriday),
      saturday:  flag(defaultAddr?.DeliversSaturday),
      sunday:    flag(defaultAddr?.DeliversSunday),
    },
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
