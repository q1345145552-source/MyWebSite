export type ShipmentStatus =
  | "loaded"
  | "created"
  | "delayDeparted"
  | "departed"
  | "delayInTransit"
  | "arrivedPort"
  | "customsTH"
  | "customsCleared"
  | "inWarehouseTH"
  | "outForDelivery"
  | "delivered"
  | "exception"
  | "returned"
  | "cancelled";

export const SHIPMENT_STATUS_FLOW: ShipmentStatus[] = [
  "created",
  "loaded",
  "delayDeparted",
  "departed",
  "delayInTransit",
  "arrivedPort",
  "customsTH",
  "customsCleared",
  "inWarehouseTH",
  "outForDelivery",
  "delivered",
];

export const SHIPMENT_EXCEPTION_STATUSES: ShipmentStatus[] = [
  "exception",
  "returned",
  "cancelled",
];
export const COMPLETED_STATUSES: ShipmentStatus[] = [
  "delivered",
  "returned",
  "cancelled",
];