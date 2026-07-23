// Backfill de zonas de entrega desde un CSV exportado de Excel.
//
// Uso en el VPS (luego de subir el CSV):
//   docker compose exec -T bot node dist/sync/backfillDeliveryZone.js /ruta/al/zonas.csv
//
// Columnas requeridas en el CSV:
//   COD_CLIENT_PERFIL  →  tango_id en contacts
//   ZONA DE ENTREGA    →  delivery_zone en contacts

import fs from "fs";
import readline from "readline";
import pool from "../db/pool.js";

async function parseCSV(filePath: string): Promise<Array<{ code: string; zone: string }>> {
  const rows: Array<{ code: string; zone: string }> = [];
  const rl = readline.createInterface({ input: fs.createReadStream(filePath) });

  let headers: string[] = [];
  let codeIdx = -1;
  let zoneIdx = -1;
  let lineNum = 0;

  for await (const line of rl) {
    lineNum++;
    // Detectar separador: coma o punto y coma
    const sep = line.includes(";") ? ";" : ",";
    const cols = line.split(sep).map((c) => c.trim().replace(/^"|"$/g, ""));

    if (lineNum === 1) {
      headers = cols;
      codeIdx = headers.findIndex((h) => h.toUpperCase().includes("COD_CLIENT"));
      zoneIdx = headers.findIndex((h) => h.toUpperCase().includes("ZONA"));
      if (codeIdx === -1 || zoneIdx === -1) {
        throw new Error(
          `No se encontraron las columnas requeridas.\n` +
          `  Buscando: COD_CLIENT_PERFIL, ZONA DE ENTREGA\n` +
          `  Encontradas: ${headers.join(", ")}`,
        );
      }
      continue;
    }

    const code = cols[codeIdx]?.trim();
    const zone = cols[zoneIdx]?.trim();
    if (code) rows.push({ code, zone: zone ?? "" });
  }

  return rows;
}

async function main(): Promise<void> {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error("Uso: node backfillDeliveryZone.js <ruta-al-csv>");
    process.exit(1);
  }
  if (!fs.existsSync(filePath)) {
    console.error(`Archivo no encontrado: ${filePath}`);
    process.exit(1);
  }

  console.log(`[backfill] leyendo ${filePath}...`);
  const rows = await parseCSV(filePath);
  console.log(`[backfill] ${rows.length} filas en el CSV\n`);

  let updated   = 0;
  let notFound  = 0;
  let sinZona   = 0;
  const total   = rows.length;

  for (let i = 0; i < rows.length; i++) {
    const { code, zone } = rows[i];
    process.stdout.write(`\r[backfill] ${i + 1}/${total}  ${code.padEnd(12)} → ${(zone || "(vacío)").slice(0, 30).padEnd(30)}`);

    if (!zone) {
      sinZona++;
      continue;
    }

    const { rowCount } = await pool.query(
      `UPDATE contacts SET delivery_zone = $1 WHERE tango_id = $2`,
      [zone, code],
    );

    if ((rowCount ?? 0) > 0) {
      updated++;
    } else {
      notFound++;
    }
  }

  process.stdout.write("\n");
  console.log(`\n[backfill] ── RESULTADO ────────────────────────────`);
  console.log(`  filas en CSV            : ${total}`);
  console.log(`  actualizados en DB      : ${updated}`);
  console.log(`  no encontrados en DB    : ${notFound}`);
  console.log(`  sin zona (fila vacía)   : ${sinZona}`);
  console.log(`────────────────────────────────────────────────────`);

  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error("[backfill] error fatal:", err);
  process.exit(1);
});
