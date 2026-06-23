import type { DeliveryDay } from "../contacts/contactRepository.js";

// La difusión se envía 2 días hábiles ANTES del día de entrega.
// Envíos: lunes a viernes a las 9:00 hs (ART).
//
// Día de difusión → Día de entrega
//   Lunes         → Miércoles
//   Martes        → Jueves
//   Miércoles     → Viernes
//   Jueves        → Lunes (semana siguiente)
//   Viernes       → Martes (semana siguiente)

export interface CampaignDefinition {
  // Día en que se envía la difusión (determina el cron y el filtro de audiencia)
  sendDay: "monday" | "tuesday" | "wednesday" | "thursday" | "friday";
  // Día de entrega correspondiente (2 días hábiles después)
  deliveryDay: DeliveryDay;
  // Texto del día para el template ("el miércoles", "el lunes", etc.)
  deliveryDayLabel: string;
  template: {
    name: string;     // nombre exacto del template aprobado en Meta
    language: string;
    // Variables posicionales del template. {{contact.name}} se resuelve en runtime.
    variables: Record<string, string>;
  };
}

export const CAMPAIGNS: CampaignDefinition[] = [
  {
    sendDay: "monday",
    deliveryDay: "wednesday",
    deliveryDayLabel: "el miércoles",
    template: {
      name: "visita_programada",
      language: "es_AR",
      variables: { "1": "{{contact.name}}", "2": "el miércoles" },
    },
  },
  {
    sendDay: "tuesday",
    deliveryDay: "thursday",
    deliveryDayLabel: "el jueves",
    template: {
      name: "visita_programada",
      language: "es_AR",
      variables: { "1": "{{contact.name}}", "2": "el jueves" },
    },
  },
  {
    sendDay: "wednesday",
    deliveryDay: "friday",
    deliveryDayLabel: "el viernes",
    template: {
      name: "visita_programada",
      language: "es_AR",
      variables: { "1": "{{contact.name}}", "2": "el viernes" },
    },
  },
  {
    sendDay: "thursday",
    deliveryDay: "monday",
    deliveryDayLabel: "el lunes",
    template: {
      name: "visita_programada",
      language: "es_AR",
      variables: { "1": "{{contact.name}}", "2": "el lunes" },
    },
  },
  {
    sendDay: "friday",
    deliveryDay: "tuesday",
    deliveryDayLabel: "el martes",
    template: {
      name: "visita_programada",
      language: "es_AR",
      variables: { "1": "{{contact.name}}", "2": "el martes" },
    },
  },
];
