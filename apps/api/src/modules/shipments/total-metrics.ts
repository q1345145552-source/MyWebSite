import { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma";

export type OrderMetricSource = {
  orderId: string | null | undefined;
  orderVolumeM3: Prisma.Decimal | null | undefined;
  orderWeightKg: Prisma.Decimal | null | undefined;
};

export type OrderTotalMetrics = {
  totalVolumeM3?: number;
  totalWeightKg?: number;
};

function decimalToNumber(value: Prisma.Decimal | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  return Number(value.toString());
}

/** 只合计真正有值的指标；整组缺失时返回 undefined，而不是 0。 */
export function sumPresentMetrics(
  values: readonly (Prisma.Decimal | null | undefined)[],
): number | undefined {
  let sum: Prisma.Decimal | undefined;
  for (const value of values) {
    if (value === null || value === undefined) continue;
    sum = sum?.plus(value) ?? value;
  }
  return decimalToNumber(sum);
}

/** 单个指标的业务取值：订单合计优先，否则合计父子运单家族。 */
export function resolveOrderTotalMetric(
  orderMetric: Prisma.Decimal | null | undefined,
  familyMetrics: readonly (Prisma.Decimal | null | undefined)[],
): number | undefined {
  return decimalToNumber(orderMetric) ?? sumPresentMetrics(familyMetrics);
}

/**
 * 运单列表的整票体积/重量：订单合计优先，缺失时才合计该订单的父子运单家族。
 *
 * 生产业务约束是一张订单只有一张父运单，因此按 orderId 批量取全部运单
 * 就是“父单 + 全部子单”，同时也能覆盖历史上父单缺失、只剩子单的订单。
 * 家族某一指标全为 null 时保持 undefined，绝不把“没填”合计成 0。
 */
export async function loadOrderTotalMetrics(
  companyId: string,
  sources: readonly OrderMetricSource[],
): Promise<Map<string, OrderTotalMetrics>> {
  const sourceByOrderId = new Map<string, OrderMetricSource>();
  for (const source of sources) {
    if (!source.orderId) continue;
    const existing = sourceByOrderId.get(source.orderId);
    sourceByOrderId.set(source.orderId, {
      orderId: source.orderId,
      orderVolumeM3: existing?.orderVolumeM3 ?? source.orderVolumeM3,
      orderWeightKg: existing?.orderWeightKg ?? source.orderWeightKg,
    });
  }

  const unresolvedOrderIds = [...sourceByOrderId.values()]
    .filter((source) => source.orderVolumeM3 == null || source.orderWeightKg == null)
    .map((source) => source.orderId as string);

  const familyMetrics = new Map<string, {
    volumeM3: Array<Prisma.Decimal | null>;
    weightKg: Array<Prisma.Decimal | null>;
  }>();
  if (unresolvedOrderIds.length > 0) {
    const familyRows = await prisma.shipment.findMany({
      where: {
        companyId,
        orderId: { in: unresolvedOrderIds },
      },
      select: {
        orderId: true,
        volumeM3: true,
        weightKg: true,
      },
    });

    for (const row of familyRows) {
      const current = familyMetrics.get(row.orderId) ?? { volumeM3: [], weightKg: [] };
      current.volumeM3.push(row.volumeM3);
      current.weightKg.push(row.weightKg);
      familyMetrics.set(row.orderId, current);
    }
  }

  const result = new Map<string, OrderTotalMetrics>();
  for (const [orderId, source] of sourceByOrderId) {
    const family = familyMetrics.get(orderId);
    const totalVolumeM3 = resolveOrderTotalMetric(source.orderVolumeM3, family?.volumeM3 ?? []);
    const totalWeightKg = resolveOrderTotalMetric(source.orderWeightKg, family?.weightKg ?? []);
    result.set(orderId, {
      ...(totalVolumeM3 !== undefined ? { totalVolumeM3 } : {}),
      ...(totalWeightKg !== undefined ? { totalWeightKg } : {}),
    });
  }

  return result;
}
