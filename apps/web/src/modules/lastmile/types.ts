export type LastmileShipmentOption = {
  id: string;
  trackingNo: string;
  clientId: string;
  itemName: string;
  packageCount: number;
  containerNo?: string;
  receiverName?: string;
  receiverPhone?: string;
  receiverAddress?: string;
};

export type LastmileOrderItem = {
  id: string;
  deliveryNo: string;
  shipmentId: string;
  trackingNo?: string;
  clientId?: string | null;
  clientName?: string | null;
  receiverName?: string | null;
  receiverPhone?: string | null;
  receiverAddress?: string | null;
  itemName?: string | null;
  packageCount?: number | null;
  packageUnit?: string | null;
  driverName?: string | null;
  licensePlate?: string | null;
  phoneNumber?: string | null;
  deliveryDate?: string | null;
  hasSignImage?: boolean;
  status: string;
  updatedAt?: string;
};

export type LastmileCustomerGroup = {
  key: string;
  clientId: string;
  clientName: string;
  addressCount: number;
  orders: LastmileOrderItem[];
};

export type LastmileWdGroup = {
  deliveryNo: string;
  orders: LastmileOrderItem[];
  customers: LastmileCustomerGroup[];
  signed: number;
  total: number;
  done: boolean;
  addressCount: number;
};
