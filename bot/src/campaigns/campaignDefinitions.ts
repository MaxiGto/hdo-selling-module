import type { DeliveryDay } from "../contacts/contactRepository.js";

// La difusión se envía 2 días hábiles ANTES del día de entrega.
// Envíos: lunes a viernes a las 9:00 hs (ART).
//
// sendDay → deliveryDay  (deliveryOffset)   endDay (corte de pedidos)   (endDayOffset)
//   Lunes    → Miércoles  (+2)               Martes                       (+1)
//   Martes   → Jueves     (+2)               Miércoles                    (+1)
//   Miércoles→ Viernes    (+2)               Jueves                       (+1)
//   Jueves   → Lunes      (+4)               Viernes                      (+1)
//   Viernes  → Martes     (+4)               Lunes                        (+3)

export interface CampaignDefinition {
  sendDay: "monday" | "tuesday" | "wednesday" | "thursday" | "friday";
  deliveryDay: DeliveryDay;
  // Días calendario desde sendDay hasta el día de entrega.
  deliveryDateOffset: number;
  // Días calendario desde sendDay hasta el día de corte de pedidos (end_day en el template).
  endDayOffset: number;
  template: {
    name: string;
    language: string;
    // Variables posicionales del template (1-indexed), resueltas en runtime:
    //   "{{delivery.dayName}}" → nombre del día de entrega en español (ej. "Miércoles")
    //   "{{delivery.date}}"    → fecha de entrega d/m (ej. "25/6")
    //   "{{end.dayName}}"      → día de corte de pedidos
    variables: Record<string, string>;
  };
}

export const CAMPAIGNS: CampaignDefinition[] = [
  {
    sendDay: "monday",
    deliveryDay: "wednesday",
    deliveryDateOffset: 2,
    endDayOffset: 1,          // martes
    template: {
      name: "difusion_1",
      language: "es_AR",
      variables: {
        order_day:  "{{delivery.dayName}}",
        order_date: "{{delivery.date}}",
        end_day:    "{{end.dayName}}",
        end_time:   "10AM",
      },
    },
  },
  {
    sendDay: "tuesday",
    deliveryDay: "thursday",
    deliveryDateOffset: 2,
    endDayOffset: 1,          // miércoles
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
    endDayOffset: 1,          // jueves
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
    endDayOffset: 1,          // viernes (jueves + 1)
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
    sendDay: "friday",
    deliveryDay: "tuesday",
    deliveryDateOffset: 4,
    endDayOffset: 3,          // lunes (viernes + 3)
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
];
