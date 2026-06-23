import { fetchAllCustomers } from "./tangoClient.js";
import { upsertContact, countUnzoned } from "../contacts/contactRepository.js";
import { config } from "../config.js";

// Mapa provincia AFIP → zona de reparto de Oasis.
// Editar acá cuando se definan las zonas reales.
const ZONE_BY_PROVINCE: Record<string, string> = {
  // Ejemplos — reemplazar con las zonas reales de Oasis:
  // "C": "zona_caba",
  // "B": "zona_gba",
  // "X": "zona_interior",
};

function resolveZone(provinceCode: string | null): string | null {
  if (!provinceCode) return null;
  return ZONE_BY_PROVINCE[provinceCode.toUpperCase()] ?? null;
}

export async function runSync(): Promise<void> {
  console.log("[sync] iniciando sincronización con Tango...");

  if (!config.tango.accessToken) {
    console.warn("[sync] TANGO_ACCESS_TOKEN no configurado — sync omitido");
    return;
  }

  const customers = await fetchAllCustomers();
  console.log(`[sync] ${customers.length} clientes obtenidos de Tango`);

  let sinTelefono = 0;
  for (const c of customers) {
    if (!c.phone) { sinTelefono++; continue; }

    await upsertContact({
      tangoId:         c.tangoId,
      name:            c.name,
      phoneNormalized: c.phone,
      provinceCode:    c.provinceCode,
      zone:            resolveZone(c.provinceCode),
    });
  }

  const sinZona = await countUnzoned();
  console.log(
    `[sync] completado — omitidos sin teléfono: ${sinTelefono}` +
    (sinZona > 0 ? ` | sin zona asignada: ${sinZona} (revisar ZONE_BY_PROVINCE)` : ""),
  );
}
