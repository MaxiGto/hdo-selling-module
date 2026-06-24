import { schedule } from "node-cron";
import { CAMPAIGNS } from "./campaignDefinitions.js";
import { runCampaign } from "./campaignService.js";
import { runSync } from "../sync/syncService.js";
import { clearAllHandoffs } from "../agent/handoffRepository.js";

// Zona horaria de Argentina (UTC-3, sin DST).
const TZ = "America/Argentina/Buenos_Aires";

// Cron DOW: 1=Lunes … 5=Viernes (estándar POSIX, soportado por node-cron).
const DOW: Record<"monday" | "tuesday" | "wednesday" | "thursday" | "friday", number> = {
  monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5,
};

export function startCrons(): void {
  // Limpieza de handoffs: todos los días a las 00:00 hs.
  // Libera conversaciones donde ningún asesor respondió durante el día.
  schedule("0 0 * * *", () => {
    void clearAllHandoffs().then((n) =>
      console.log(`[cron] handoffs limpiados: ${n} conversaciones liberadas`),
    );
  }, { timezone: TZ });
  console.log("[cron] limpieza handoffs → todos los días 00:00 hs (ART)");

  // Sync nocturno con Tango: todos los días a las 3:00 hs.
  schedule("0 3 * * *", () => void runSync(), { timezone: TZ });
  console.log("[cron] sync Tango → todos los días 03:00 hs (ART)");

  // 5 difusiones: lunes a viernes a las 9:00 hs.
  // Cada una envía a los clientes que reciben entrega 2 días hábiles después.
  for (const def of CAMPAIGNS) {
    const dow = DOW[def.sendDay];
    const expr = `0 9 * * ${dow}`;
    schedule(expr, () => void runCampaign(def), { timezone: TZ });
    console.log(
      `[cron] difusión ${def.sendDay.padEnd(9)} (entrega ${def.deliveryDay}) → ${expr} (ART)`,
    );
  }
}
