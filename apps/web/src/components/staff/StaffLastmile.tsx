"use client";

import LastmileDispatchWorkspace from "../../modules/lastmile/LastmileDispatchWorkspace";
import type { LastmileOrderItem, LastmileShipmentOption } from "../../modules/lastmile/types";

export type StaffLastmileProps = {
  visible: boolean;
  lmShipments: LastmileShipmentOption[];
  lmOrderList: LastmileOrderItem[];
  ordersLoading?: boolean;
  ordersError?: string;
  shipmentsLoading?: boolean;
  shipmentsError?: string;
  onToast: (message: string) => void;
  onReloadOrders: () => void | Promise<void>;
  onLoadShipments: () => void | Promise<void>;
};

/**
 * 员工端只保留一层语义包装；核心 WD 创建、签收、搜索和客户导出
 * 与管理员端共用同一个工作台，避免两端再次分叉。
 */
export default function StaffLastmile(props: StaffLastmileProps) {
  return (
    <LastmileDispatchWorkspace
      {...props}
      id="staff-lastmile"
      surface="page"
      showHeading
    />
  );
}
