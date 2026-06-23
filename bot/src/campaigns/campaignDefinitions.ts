// Definición de todas las campañas automáticas.
// Este es el ÚNICO archivo que el equipo edita para agregar, quitar o
// reprogramar campañas. No hay que tocar ningún otro archivo.
//
// schedule: expresión cron  →  "minuto hora * * díaSemana"
//   0 9 * * 1  = lunes 9:00 hs
//   0 9 * * 3  = miércoles 9:00 hs
//   0 10 * * 5 = viernes 10:00 hs
//
// template.name: nombre exacto de la plantilla aprobada en Meta.
// template.variables: variables en el orden que pide la plantilla.
//   Podés usar {{contact.name}} — se reemplaza por el nombre del cliente.

export interface CampaignDefinition {
  name: string;
  schedule: string;
  audienceFilter: { zone: string };
  template: {
    name: string;
    language: string;
    variables: Record<string, string>;
  };
}

export const CAMPAIGNS: CampaignDefinition[] = [
  // ── Descomentá y completá cuando estén definidas las zonas y los templates ──

  // {
  //   name: "visita_zona_norte",
  //   schedule: "0 9 * * 1",            // lunes 9:00 hs
  //   audienceFilter: { zone: "zona_norte" },
  //   template: {
  //     name: "visita_programada",
  //     language: "es_AR",
  //     variables: {
  //       "1": "{{contact.name}}",
  //       "2": "el lunes",
  //       "3": "entre las 9 y las 13 hs",
  //     },
  //   },
  // },

  // {
  //   name: "visita_zona_sur",
  //   schedule: "0 9 * * 3",            // miércoles 9:00 hs
  //   audienceFilter: { zone: "zona_sur" },
  //   template: {
  //     name: "visita_programada",
  //     language: "es_AR",
  //     variables: {
  //       "1": "{{contact.name}}",
  //       "2": "el miércoles",
  //       "3": "entre las 14 y las 18 hs",
  //     },
  //   },
  // },
];
