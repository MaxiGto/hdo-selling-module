import { config } from "../config.js";

// Respuesta del endpoint GET /api/Aperture/Customer
interface TangoCustomer {
  CustomerID: number;
  Code: string;
  FirstName?: string;
  LastName?: string;
  BusinessName?: string;
  ProvinceCode?: string;
  MobilePhoneNumber?: string;
  PhoneNumber1?: string;
  PhoneNumber2?: string;
}

interface TangoPage {
  Data: TangoCustomer[];
  TotalCount: number;
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

  // No se puede determinar el formato con certeza
  return null;
}

// Obtiene el mejor número de teléfono disponible para un cliente.
function bestPhone(c: TangoCustomer): string | null {
  for (const field of [c.MobilePhoneNumber, c.PhoneNumber1, c.PhoneNumber2]) {
    if (field?.trim()) {
      const normalized = normalizeArgentinePhone(field.trim());
      if (normalized) return normalized;
    }
  }
  return null;
}

// Nombre para mostrar al cliente.
function displayName(c: TangoCustomer): string {
  const full = [c.FirstName, c.LastName].filter(Boolean).join(" ").trim();
  return full || c.BusinessName?.trim() || `Cliente ${c.Code}`;
}

// Trae todos los clientes de Tango paginando automáticamente.
export async function fetchAllCustomers(): Promise<
  { tangoId: string; name: string; phone: string | null; provinceCode: string | null }[]
> {
  const results: ReturnType<typeof fetchAllCustomers> extends Promise<infer T> ? T : never = [];
  let page = 1;

  while (true) {
    const url =
      `${config.tango.baseUrl}/api/Aperture/Customer` +
      `?pageSize=${PAGE_SIZE}&pageNumber=${page}`;

    const res = await fetch(url, {
      headers: { "access-token": config.tango.accessToken },
    });

    if (!res.ok) {
      throw new Error(`Tango API error (${res.status}): ${await res.text()}`);
    }

    const body = (await res.json()) as TangoPage;
    const customers = body.Data ?? [];

    for (const c of customers) {
      results.push({
        tangoId: String(c.CustomerID),
        name: displayName(c),
        phone: bestPhone(c),
        provinceCode: c.ProvinceCode?.trim() ?? null,
      });
    }

    if (results.length >= body.TotalCount || customers.length < PAGE_SIZE) break;
    page++;
  }

  return results;
}
