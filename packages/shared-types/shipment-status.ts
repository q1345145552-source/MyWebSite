export type ShipmentStatus =
  | "created"
  | "pickedUp"
  | "inWarehouseCN"
  | "customsPending"
  | "inTransit"
  | "customsTH"
  | "outForDelivery"
  | "delivered"
  | "exception"
  | "returned"
  | "cancelled";

export const SHIPMENT_STATUS_FLOW: ShipmentStatus[] = [
  "created",
  "pickedUp",
  "inWarehouseCN",
  "customsPending",
  "inTransit",
  "customsTH",
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