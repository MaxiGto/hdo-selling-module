import { schedule } from "node-cron";
import { CAMPAIGNS } from "./campaignDefinitions.js";
import { runCampaign } from "./campaignService.js";
import { runSync } from "../sync/syncService.js";

// Zona horaria de Argentina (UTC-3, sin DST).
const TZ = "America/Argentina/Buenos_Aires";

export function startCrons(): void {
  // Sync nocturno con Tango: todos los días a las 3:00 hs.
  schedule("0 3 * * *", () => void runSync(), { timezone: TZ });
  console.log("[cron] sync Tango programado → todos los días 03:00 hs (ART)");

  // Campañas de difusión
  if (CAMPAIGNS.length === 0) {
    console.log("[cron] sin campañas configuradas — editar campaignDefinitions.ts para activarlas");
    return;
  }

  for (const def of CAMPAIGNS) {
    schedule(
      def.schedule,
      () => void runCampaign(def),
      { timezone: TZ },
    );
    console.log(`[cron] campaña "${def.name}" programada → ${def.schedule} (ART)`);
  }
}
