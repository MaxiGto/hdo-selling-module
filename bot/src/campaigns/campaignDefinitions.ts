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
  deliveryDateOffset: number;
  endDayOffset: number;
  template: {
    name: string;
    language: string;
    // Claves = nombres de las variables del template en Meta.
    // Tokens resueltos en runtime:
    //   "{{delivery.dayName}}" → nombre del día de entrega en español
    //   "{{delivery.date}}"    → fecha de entrega d/m
    //   "{{end.dayName}}"      → día de corte de pedidos
    variables: Record<string, string>;
  };
}

const TEMPLATE_VARS = {
  order_day:  "{{delivery.dayName}}",
  order_date: "{{delivery.date}}",
  end_day:    "{{end.dayName}}",
  end_date:   "{{end.date}}",
};

export const CAMPAIGNS: CampaignDefinition[] = [
  {
    sendDay: "monday",
    deliveryDay: "wednesday",
    deliveryDateOffset: 2,
    endDayOffset: 1,
    template: { name: "difusion_1", language: "es_AR", variables: TEMPLATE_VARS },
  },
  {
    sendDay: "tuesday",
    deliveryDay: "thursday",
    deliveryDateOffset: 2,
    endDayOffset: 1,
    template: { name: "difusion_1", language: "es_AR", variables: TEMPLATE_VARS },
  },
  {
    sendDay: "wednesday",
    deliveryDay: "friday",
    deliveryDateOffset: 2,
    endDayOffset: 1,
    template: { name: "difusion_1", language: "es_AR", variables: TEMPLATE_VARS },
  },
  {
    sendDay: "thursday",
    deliveryDay: "monday",
    deliveryDateOffset: 4,
    endDayOffset: 1,
    template: { name: "difusion_1", language: "es_AR", variables: TEMPLATE_VARS },
  },
  {
    sendDay: "friday",
    deliveryDay: "tuesday",
    deliveryDateOffset: 4,
    endDayOffset: 3,
    template: { name: "difusion_1", language: "es_AR", variables: TEMPLATE_VARS },
  },
];
