import { fetchAllCustomers } from "./tangoClient.js";
import { upsertContact, countUnzoned } from "../contacts/contactRepository.js";
import { config } from "../config.js";

// Mapa vendedor (SellerCode de Tango) → zona de reparto de Oasis.
// Completar con los códigos reales una vez confirmados con el equipo.
// Cada vendedor tiene su zona y sus días de visita.
const ZONE_BY_SELLER: Record<string, string> = {
  // Ejemplos — reemplazar con los SellerCodes reales de Oasis:
  // "MG": "zona_norte",
  // "OA": "zona_sur",
  // "GT": "zona_centro",
};

function resolveZone(sellerCode: string | null): string | null {
  if (!sellerCode) return null;
  return ZONE_BY_SELLER[sellerCode.toUpperCase()] ?? null;
}

export async function runSync(): Promise<void> {
  console.log("[sync] iniciando sincronización con Tango...");

  if (!config.tango.accessToken) {
    console.warn("[sync] TANGO_ACCESS_TOKEN no configurado — sync omitido");
    return;
  }

  const customers = await fetchAllCustomers();
  console.log(`[sync] ${customers.length} clientes activos obtenidos de Tango`);

  let sinTelefono = 0;
  for (const c of customers) {
    if (!c.phone) { sinTelefono++; continue; }

    await upsertContact({
      tangoId:         c.tangoId,
      name:            c.name,
      phoneNormalized: c.phone,
      provinceCode:    c.provinceCode,
      sellerCode:      c.sellerCode,
      zone:            resolveZone(c.sellerCode),
    });
  }

  const sinZona = await countUnzoned();
  console.log(
    `[sync] completado — omitidos sin teléfono: ${sinTelefono}` +
    (sinZona > 0 ? ` | sin zona asignada: ${sinZona} (revisar ZONE_BY_SELLER en syncService.ts)` : ""),
  );
}
