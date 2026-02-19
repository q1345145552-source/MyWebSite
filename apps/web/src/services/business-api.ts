import { authHeaders, apiBaseUrl, parseApiResponse } from "./core-api";

export interface StaffCreateOrderPayload {
  clientId: string;
  warehouseId: string;
  batchNo?: string;
  trackingNo: string;
  arrivedAt: string;
  itemName: string;
  productQuantity: number;
  packageCount: number;
  packageUnit: "bag" | "box";
  weightKg?: number;
  volumeM3?: number;
  domesticTrackingNo?: string;
  transportMode: "sea" | "land";
  receiverNameTh: string;
  receiverPhoneTh: string;
  receiverAddressTh: string;
}

export interface ClientPrealertPayload {
  warehouseId: string;
  itemName: string;
  packageCount: number;
  packageUnit: "bag" | "box";
  weightKg?: number;
  volumeM3?: number;
  shipDate?: string;
  domesticTrackingNo?: string;
  transportMode: "sea" | "land";
}

export interface ShipmentItem {
  id: string;
  trackingNo: string;
  batchNo?: string;
  clientId?: string;
  clientName?: string;
  itemName?: string;
  domesticTrackingNo?: string;
  packageCount?: number;
  productQuantity?: number;
  weightKg?: number;
  volumeM3?: number;
  arrivedAt?: string;
  currentStatus: string;
  currentLocation?: string;
  updatedAt?: string;
  warehouseId?: string;
  canEdit?: boolean;
}

export interface OrderItem {
  id: string;
  orderNo?: string;
  clientId?: string;
  clientName?: string;
  warehouseId?: string;
  batchNo?: string;
  latestRemark?: string;
  logisticsRecords?: Array<{
    remark: string;
    changedAt: string;
    fromStatus?: string;
    toStatus?: string;
  }>;
  itemName: string;
  transportMode: string;
  approvalStatus?: "pending" | "approved";
  domesticTrackingNo?: string;
  trackingNo?: string;
  currentStatus?: string;
  productQuantity: number;
  packageCount: number;
  packageUnit: string;
  weightKg?: number;
  volumeM3?: number;
  shipDate?: string;
  createdAt: string;
}

export interface AdminOverview {
  staffAccountCount: number;
  clientAccountCount: number;
  newOrderCountToday: number;
  inTransitOrderCount: number;
  receivedVolumeM3Today: number;
}

export async function createStaffOrder(payload: StaffCreateOrderPayload): Promise<{
  orderId: string;
  createdAt: string;
}> {
  const response = await fetch(`${apiBaseUrl()}/staff/orders`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify(payload),
  });
  return parseApiResponse(response);
}

export async function createClientPrealert(payload: ClientPrealertPayload): Promise<{
  prealertId: string;
  createdAt: string;
}> {
  const response = await fetch(`${apiBaseUrl()}/client/prealerts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify(payload),
  });
  return parseApiResponse(response);
}

export async function fetchClientOrders(params?: {
  statusGroup?: "completed" | "unfinished";
}): Promise<OrderItem[]> {
  const query = new URLSearchParams();
  if (params?.statusGroup) query.set("statusGroup", params.statusGroup);
  const response = await fetch(`${apiBaseUrl()}/client/orders?${query.toString()}`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  const data = await parseApiResponse<{ items: OrderItem[] }>(response);
  return data.items;
}

export async function fetchClientPrealerts(): Promise<OrderItem[]> {
  const response = await fetch(`${apiBaseUrl()}/client/prealerts`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  const data = await parseApiResponse<{ items: OrderItem[] }>(response);
  return data.items;
}

export async function fetchStaffPrealerts(): Promise<OrderItem[]> {
  const response = await fetch(`${apiBaseUrl()}/staff/prealerts`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  const data = await parseApiResponse<{ items: OrderItem[] }>(response);
  return data.items;
}

export async function approveStaffPrealert(payload: {
  orderId: string;
  batchNo: string;
  warehouseId?: string;
  itemName?: string;
  packageCount?: number;
  packageUnit?: "bag" | "box";
  productQuantity?: number;
  weightKg?: number;
  volumeM3?: number;
  domesticTrackingNo?: string;
  transportMode?: "sea" | "land";
  shipDate?: string;
}): Promise<{
  orderId: string;
  batchNo: string;
  approvalStatus: "approved";
  approvedAt: string;
}> {
  const response = await fetch(`${apiBaseUrl()}/staff/prealerts/approve`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify(payload),
  });
  return parseApiResponse(response);
}

export async function fetchClientShipments(): Promise<ShipmentItem[]> {
  const response = await fetch(`${apiBaseUrl()}/client/shipments/search`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  const data = await parseApiResponse<{ items: ShipmentItem[] }>(response);
  return data.items;
}

export async function fetchStaffShipments(): Promise<ShipmentItem[]> {
  const response = await fetch(`${apiBaseUrl()}/staff/shipments`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  const data = await parseApiResponse<{ items: ShipmentItem[] }>(response);
  return data.items;
}

export async function updateStaffShipmentStatus(payload: {
  shipmentId?: string;
  batchNo?: string;
  updateByBatch?: boolean;
  toStatus: string;
  remark?: string;
}): Promise<{
  mode: "single" | "batch";
  batchNo?: string | null;
  shipmentId?: string | null;
  shipmentIds: string[];
  fromStatus?: string | null;
  toStatus: string;
  updatedCount: number;
  changedAt: string;
}> {
  const response = await fetch(`${apiBaseUrl()}/staff/shipments/update-status`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify(payload),
  });
  return parseApiResponse(response);
}

export async function fetchAdminOverview(): Promise<AdminOverview> {
  const response = await fetch(`${apiBaseUrl()}/admin/dashboard/overview`, {
    method: "GET",
    headers: { ...authHeaders() },
  });
  return parseApiResponse(response);
}
