import { schedule } from "node-cron";
import { CAMPAIGNS } from "./campaignDefinitions.js";
import { runCampaign } from "./campaignService.js";
import { runSync } from "../sync/syncService.js";

// Zona horaria de Argentina (UTC-3, sin DST).
const TZ = "America/Argentina/Buenos_Aires";

// Cron DOW: 1=Lunes … 5=Viernes (estándar POSIX, soportado por node-cron).
const DOW: Record<"monday" | "tuesday" | "wednesday" | "thursday" | "friday", number> = {
  monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5,
};

export function startCrons(): void {
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
