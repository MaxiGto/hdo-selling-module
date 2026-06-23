import type { DeliveryDay } from "../contacts/contactRepository.js";

// La difusión se envía 2 días hábiles ANTES del día de entrega.
// Envíos: lunes a viernes a las 9:00 hs (ART).
//
// Día de difusión → Día de entrega  (offset calendario)
//   Lunes         → Miércoles       (+2)
//   Martes        → Jueves          (+2)
//   Miércoles     → Viernes         (+2)
//   Jueves        → Lunes           (+4 — saltando fin de semana)
//   Viernes       → Martes          (+4 — saltando fin de semana)

export interface CampaignDefinition {
  sendDay: "monday" | "tuesday" | "wednesday" | "thursday" | "friday";
  deliveryDay: DeliveryDay;
  // Días calendario entre sendDay y deliveryDay. Se usa para calcular la fecha exacta.
  deliveryDateOffset: number;
  template: {
    name: string;
    language: string;
    // Variables posicionales del template (1-indexed), resueltas en runtime:
    //   "{{delivery.dayName}}" → nombre del día de entrega en español (ej. "Miércoles")
    //   "{{delivery.date}}"    → fecha de entrega d/m (ej. "25/6")
    //   "{{end.dayName}}"      → día anterior a la entrega (corte de pedidos)
    variables: Record<string, string>;
  };
}

export const CAMPAIGNS: CampaignDefinition[] = [
  {
    sendDay: "monday",
    deliveryDay: "wednesday",
    deliveryDateOffset: 2,
    template: {
      name: "difusion_1",
      language: "es_AR",
      variables: {
        "1": "{{delivery.dayName}}",  // order_day
        "2": "{{delivery.date}}",     // order_date
        "3": "{{end.dayName}}",       // end_day
        "4": "10AM",                  // end_time
      },
    },
  },
  {
    sendDay: "tuesday",
    deliveryDay: "thursday",
    deliveryDateOffset: 2,
    template: {
      name: "difusion_1",
      language: "es_AR",
      variables: {
        "1": "{{delivery.dayName}}",
        "2": "{{delivery.date}}",
        "3": "{{end.dayName}}",
        "4": "10AM",
      },
    },
  },
  {
    sendDay: "wednesday",
    deliveryDay: "friday",
    deliveryDateOffset: 2,
    template: {
      name: "difusion_1",
      language: "es_AR",
      variables: {
        "1": "{{delivery.dayName}}",
        "2": "{{delivery.date}}",
        "3": "{{end.dayName}}",
        "4": "10AM",
      },
    },
  },
  {
    sendDay: "thursday",
    deliveryDay: "monday",
    deliveryDateOffset: 4,
    template: {
      name: "difusion_1",
      language: "es_AR",
      variables: {
        "1": "{{delivery.dayName}}",
        "2": "{{delivery.date}}",
        "3": "{{end.dayName}}",       // el domingo antes del lunes
        "4": "10AM",
      },
    },
  },
  {
    sendDay: "friday",
    deliveryDay: "tuesday",
    deliveryDateOffset: 4,
    template: {
      name: "difusion_1",
      language: "es_AR",
      variables: {
        "1": "{{delivery.dayName}}",
        "2": "{{delivery.date}}",
        "3": "{{end.dayName}}",       // el lunes antes del martes
        "4": "10AM",
      },
    },
  },
];
