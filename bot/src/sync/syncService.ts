import { fetchAllCustomers } from "./tangoClient.js";
import { upsertContact, countWithoutDeliveryDays } from "../contacts/contactRepository.js";
import { config } from "../config.js";

export async function runSync(): Promise<void> {
  console.log("[sync] iniciando sincronización con Tango...");

  if (!config.tango.accessToken) {
    console.warn("[sync] TANGO_ACCESS_TOKEN no configurado — sync omitido");
    return;
  }

  const all = await fetchAllCustomers();
  console.log(`[sync] ${all.length} clientes activos obtenidos de Tango`);

  const customers = all.filter(
    (c) => c.priceListNumber === "100" || c.priceListNumber === "101",
  );
  console.log(`[sync] ${customers.length} clientes comercio (lista 100/101)`);

  let sinTelefono = 0;
  for (const c of customers) {
    if (!c.phone) { sinTelefono++; continue; }

    await upsertContact({
      tangoId:         c.tangoId,
      name:            c.name,
      phoneNormalized: c.phone,
      provinceCode:    c.provinceCode,
      sellerCode:      c.sellerCode,
      deliveryDays:    c.deliveryDays,
    });
  }

  const sinDias = await countWithoutDeliveryDays();
  console.log(
    `[sync] completado — omitidos sin teléfono: ${sinTelefono}` +
    (sinDias > 0 ? ` | sin días de entrega en Tango: ${sinDias}` : ""),
  );
}
