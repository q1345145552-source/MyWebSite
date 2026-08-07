// 任务 #10: Container & 拆柜 API（2026-05-20）
// 实现湘泰物流 P0 阶段最核心的"出柜追踪"业务能力
//
// 数据模型：
//   Container（柜子）─┬─< ShipmentContainerItem（拆柜关系）>─┬─ Shipment（运单）
//                    │   loadedVolumeM3 + loadedPieceCount  │
// 一票货可拆到多个柜子（N:N）；柜子的状态自成一套状态机
//
// 柜子状态：LOADING → SEALED → DELAY_DEPARTED → IN_TRANSIT → DELAY_IN_TRANSIT
//           → ARRIVED → CUSTOMS → DELIVERING → SIGNED
//   两个「延迟」是可跳过的中间态：正常走就是 SEALED → IN_TRANSIT → ARRIVED

import { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma";
import type { MinimalHttpApp } from "../../server";
import { fail, ok, requireRole } from "../core/http-utils";
import { logger } from "../core/logger";
import { canTransitLoose } from "../shipments/routes";
// 柜子状态流程的唯一定义处，别在本文件里再抄一份
import {
  CONTAINER_STATUS_FLOW,
  CONTAINER_STATUS_FLOW_LAND,
  CONTAINER_STATUS_LABEL,
  CONTAINER_NEXT_STOP,
  CONTAINER_TO_SHIPMENT_STATUS,
  flowOf,
} from "./status-flow";

/**
 * 判断状态切换是否合法（只能往前推进，不能倒退；可同状态续写）。
 * 2026-08-06：加了 transportMode 参数 —— 陆运柜按陆运流程判断，
 * 不传（老调用方）时行为与以前完全一致，仍按海运流程。
 */
function canContainerTransit(from: string, to: string, transportMode?: string | null): boolean {
  if (from === to) return true;
  const flow = flowOf(transportMode);
  const fromIdx = flow.indexOf(from);
  const toIdx = flow.indexOf(to);
  if (fromIdx < 0 || toIdx < 0) return false;
  return toIdx > fromIdx;
}

function decToNumber(value: Prisma.Decimal | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return Number(value.toString());
}

export function registerContainerRoutes(app: MinimalHttpApp): void {
  // ============ 柜子列表 ============
  app.get("/admin/containers", async (req, res) => {
    const auth = requireRole(req, res, ["admin", "staff"]);
    if (!auth) return;

    const statusFilter = req.query.status?.trim();
    const where: Prisma.ContainerWhereInput = { companyId: auth.companyId };
    if (statusFilter) where.currentStatus = statusFilter;

    const containers = await prisma.container.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: {
        _count: { select: { items: true } },
        items: { select: { loadedVolumeM3: true, loadedPieceCount: true } },
      },
    });

    const items = containers.map((c) => {
      const totalVolume = c.items.reduce((sum, it) => sum + decToNumber(it.loadedVolumeM3), 0);
      const totalPieces = c.items.reduce((sum, it) => sum + it.loadedPieceCount, 0);
      return {
        id: c.id,
        containerNo: c.containerNo,
        containerType: c.containerType,
        carrierName: c.carrierName ?? null,
        loadingDate: c.loadingDate?.toISOString() ?? null,
        departureDate: c.departureDate?.toISOString() ?? null,
        eta: c.eta?.toISOString() ?? null,
        ata: c.ata?.toISOString() ?? null,
        customsClearedAt: c.customsClearedAt?.toISOString() ?? null,
        currentStatus: c.currentStatus,
        currentStatusLabel: CONTAINER_STATUS_LABEL[c.currentStatus] ?? c.currentStatus,
        shipmentCount: c._count.items,
        totalLoadedVolumeM3: Number(totalVolume.toFixed(3)),
        totalLoadedPieceCount: totalPieces,
        remark: c.remark ?? undefined,
        createdAt: c.createdAt.toISOString(),
        updatedAt: c.updatedAt.toISOString(),
      };
    });

    ok(res, { items, total: items.length });
  });

  // ============ 柜子详情（含装载的所有运单）============
  app.get("/admin/containers/detail", async (req, res) => {
    const auth = requireRole(req, res, ["admin", "staff", "client"]);
    if (!auth) return;

    const id = req.query.id?.trim();
    const containerNo = req.query.containerNo?.trim();
    if (!id && !containerNo) {
      fail(res, 400, "BAD_REQUEST", "id or containerNo is required");
      return;
    }

    const container = await prisma.container.findFirst({
      where: id ? { id, companyId: auth.companyId } : { containerNo, companyId: auth.companyId },
      include: {
        items: {
          include: {
            shipment: {
              include: {
                order: {
                  select: {
                    id: true,
                    orderNo: true,
                    itemName: true,
                    clientId: true,
                    receiverNameTh: true,
                    receiverAddressTh: true,
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!container) {
      fail(res, 404, "NOT_FOUND", "container not found");
      return;
    }

    // 客户角色：只能看到含自己货的柜子
    if (auth.role === "client") {
      const isOwn = container.items.some((it) => it.shipment.order?.clientId === auth.userId);
      if (!isOwn) {
        fail(res, 403, "FORBIDDEN", "you have no shipment in this container");
        return;
      }
    }

    const totalVolume = container.items.reduce((sum, it) => sum + decToNumber(it.loadedVolumeM3), 0);
    const totalPieces = container.items.reduce((sum, it) => sum + it.loadedPieceCount, 0);

    // 客户端不允许查看柜号、船期等装柜敏感信息
    const isClient = auth.role === "client";
    ok(res, {
      id: container.id,
      containerNo: isClient ? undefined : container.containerNo,
      containerType: isClient ? undefined : container.containerType,
      carrierName: isClient ? undefined : (container.carrierName ?? null),
      loadingDate: isClient ? undefined : (container.loadingDate?.toISOString() ?? null),
      departureDate: isClient ? undefined : (container.departureDate?.toISOString() ?? null),
      eta: isClient ? undefined : (container.eta?.toISOString() ?? null),
      ata: isClient ? undefined : (container.ata?.toISOString() ?? null),
      customsClearedAt: isClient ? undefined : (container.customsClearedAt?.toISOString() ?? null),
      currentStatus: container.currentStatus,
      currentStatusLabel: isClient ? undefined : (CONTAINER_STATUS_LABEL[container.currentStatus] ?? container.currentStatus),
      remark: container.remark ?? undefined,
      totalLoadedVolumeM3: isClient ? undefined : Number(totalVolume.toFixed(3)),
      totalLoadedPieceCount: isClient ? undefined : totalPieces,
      shipments: container.items
        .filter((it) => !isClient || it.shipment.order?.clientId === auth.userId)
        .map((it) => ({
          shipmentId: it.shipmentId,
          trackingNo: it.shipment.trackingNo,
          orderId: it.shipment.order?.id ?? null,
          orderNo: it.shipment.order?.orderNo ?? null,
          itemName: it.shipment.order?.itemName ?? null,
          receiverNameTh: it.shipment.order?.receiverNameTh ?? null,
          receiverAddressTh: it.shipment.order?.receiverAddressTh ?? null,
          loadedVolumeM3: isClient ? undefined : decToNumber(it.loadedVolumeM3),
          loadedPieceCount: isClient ? undefined : it.loadedPieceCount,
          shipmentTotalVolumeM3: isClient ? undefined : (it.shipment.volumeM3 ? decToNumber(it.shipment.volumeM3) : null),
          isSplit: isClient ? undefined : (
            it.shipment.volumeM3 !== null &&
            decToNumber(it.loadedVolumeM3) < decToNumber(it.shipment.volumeM3) - 0.001
          ),
          currentStatus: it.shipment.currentStatus,
        })),
      createdAt: container.createdAt.toISOString(),
      updatedAt: container.updatedAt.toISOString(),
    });
  });

  // ============ 新建柜子 ============
  app.post("/admin/containers", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      containerNo?: string;
      containerType?: "20GP" | "40HQ" | string;
      carrierName?: string;
      loadingDate?: string;
      departureDate?: string;
      eta?: string;
      remark?: string;
    };
    const containerNo = body.containerNo?.trim();
    const containerType = body.containerType?.trim();
    if (!containerNo || !containerType) {
      fail(res, 400, "BAD_REQUEST", "containerNo and containerType are required");
      return;
    }

    const existed = await prisma.container.findUnique({
      where: { containerNo },
      select: { id: true },
    });
    if (existed) {
      fail(res, 409, "CONFLICT", "containerNo already exists");
      return;
    }

    const created = await prisma.container.create({
      data: {
        companyId: auth.companyId,
        containerNo,
        containerType,
        carrierName: body.carrierName?.trim() || null,
        loadingDate: body.loadingDate ? new Date(body.loadingDate) : null,
        departureDate: body.departureDate ? new Date(body.departureDate) : null,
        eta: body.eta ? new Date(body.eta) : null,
        currentStatus: "LOADING",
        remark: body.remark?.trim() || null,
      },
    });

    ok(res, {
      id: created.id,
      containerNo: created.containerNo,
      currentStatus: created.currentStatus,
      createdAt: created.createdAt.toISOString(),
    });
  });

  // ============ 变更柜子状态（含自动连带）============
  // - IN_TRANSIT 时记录 departureDate（若未填）
  // - ARRIVED 时记录 ata（实际到港）
  // - CUSTOMS 完成 → 自动写 customsClearedAt
  // - DELIVERING 时把柜内所有运单的 currentStatus 推进到 outForDelivery
  // - SIGNED 时把柜内所有运单的 currentStatus 推进到 delivered
  app.post("/admin/containers/status", async (req, res) => {
    const auth = requireRole(req, res, ["admin", "staff"]);
    if (!auth) return;

    const body = (req.body ?? {}) as { id?: string; toStatus?: string; remark?: string; date?: string; nextStop?: string };
    const id = body.id?.trim();
    const toStatus = body.toStatus?.trim();
    if (!id || !toStatus) {
      fail(res, 400, "BAD_REQUEST", "id and toStatus are required");
      return;
    }

    const container = await prisma.container.findFirst({
      where: { id, companyId: auth.companyId },
      include: { items: { select: { shipmentId: true } } },
    });
    if (!container) {
      fail(res, 404, "NOT_FOUND", "container not found");
      return;
    }

    // 2026-08-06：合法状态与推进规则都改为按柜子的运输方式判断。
    // 陆运柜不能推到「已开船/已到港」，海运柜也不能推到「过境越南」这类陆运环节。
    const flow = flowOf(container.transportMode);
    if (!flow.includes(toStatus)) {
      const isLand = container.transportMode === "land";
      fail(
        res,
        400,
        "VALIDATION_ERROR",
        `「${CONTAINER_STATUS_LABEL[toStatus] ?? toStatus}」不属于${isLand ? "陆运" : "海运"}流程`,
      );
      return;
    }

    if (!canContainerTransit(container.currentStatus, toStatus, container.transportMode)) {
      fail(
        res,
        400,
        "VALIDATION_ERROR",
        `不能从「${CONTAINER_STATUS_LABEL[container.currentStatus] ?? container.currentStatus}」退回或跳到「${CONTAINER_STATUS_LABEL[toStatus] ?? toStatus}」`,
      );
      return;
    }

    // 下一站：员工填了就用他填的，没填就用这个状态的默认值（可能没有，那就不写）
    const nextStop = typeof body.nextStop === "string" && body.nextStop.trim()
      ? body.nextStop.trim().slice(0, 50)
      : (CONTAINER_NEXT_STOP[toStatus] ?? null);

    const customDate = typeof body.date === "string" && body.date.trim()
      ? new Date(body.date.trim() + "T00:00:00")
      : null;
    const now = customDate && !Number.isNaN(customDate.getTime()) ? customDate : new Date();
    const updateData: Prisma.ContainerUpdateInput = {
      currentStatus: toStatus,
      updatedAt: now,
    };
    if (toStatus === "IN_TRANSIT" && !container.departureDate) updateData.departureDate = now;
    if (toStatus === "ARRIVED" && !container.ata) updateData.ata = now;
    // 2026-08-06：把这一步实际发生的日期记进柜子（员工填了日期就用他填的）。
    // 后面「货到了才建柜、再把运单装进去」时，要靠这些真实日期给运单补记轨迹，
    // 没有它补出来的时间只能瞎摊 —— 实测会把 9 条轨迹全摊在同一分钟。
    {
      let dates: Record<string, string> = {};
      try { dates = container.statusDates ? JSON.parse(container.statusDates) : {}; } catch { dates = {}; }
      dates[toStatus] = now.toISOString();
      updateData.statusDates = JSON.stringify(dates);
    }
    const shipmentIds = container.items.map((it) => it.shipmentId);
    const ops: Prisma.PrismaPromise<unknown>[] = [
      prisma.container.update({ where: { id: container.id }, data: updateData }),
    ];

    const shipmentNextStatus: string | null = CONTAINER_TO_SHIPMENT_STATUS[toStatus] ?? null;

    if (shipmentNextStatus && shipmentIds.length > 0) {
      // 查询各运单当前状态
      const shipments = await prisma.shipment.findMany({
        where: { id: { in: shipmentIds }, companyId: auth.companyId },
        select: { id: true, currentStatus: true, parentTrackingNo: true },
      });
      const statusMap = new Map(shipments.map((s) => [s.id, s.currentStatus]));

      // 校验每个运单的状态流转是否合法
      const invalidShipments = shipments.filter(
        (s) => !canTransitLoose(s.currentStatus, shipmentNextStatus!)
      );
      if (invalidShipments.length > 0) {
        const ids = invalidShipments.map((s) => `${s.id}(${s.currentStatus})`).join(", ");
        fail(res, 400, "VALIDATION_ERROR", `以下运单不允许从当前状态流转到 ${shipmentNextStatus}：${ids}`);
        return;
      }

      ops.push(
        prisma.shipment.updateMany({
          where: { id: { in: shipmentIds }, companyId: auth.companyId },
          data: { currentStatus: shipmentNextStatus, updatedAt: now },
        }),
      );

      // 同步父运单状态
      const parentNos = [...new Set(shipments.filter(s => s.parentTrackingNo).map(s => s.parentTrackingNo!))];
      if (parentNos.length > 0) {
        ops.push(
          prisma.shipment.updateMany({
            where: { trackingNo: { in: parentNos }, companyId: auth.companyId },
            data: { currentStatus: shipmentNextStatus, updatedAt: now },
          }),
        );
      }

      for (let i = 0; i < shipmentIds.length; i++) {
        const sid = shipmentIds[i];
        ops.push(
          prisma.statusLog.create({
            data: {
              id: `sl_ctn_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 6)}`,
              companyId: auth.companyId,
              shipmentId: sid,
              operatorId: auth.userId,
              operatorRole: auth.role,
              operatorName: auth.name,
              fromStatus: statusMap.get(sid) ?? "loaded",
              toStatus: shipmentNextStatus,
              remark: body.remark?.trim() || `${CONTAINER_STATUS_LABEL[toStatus] ?? toStatus}`,
              nextStop,
              changedAt: now,
            },
          }),
        );
      }
    }

    await prisma.$transaction(ops);

    ok(res, {
      id: container.id,
      containerNo: container.containerNo,
      fromStatus: container.currentStatus,
      toStatus,
      affectedShipmentCount: shipmentNextStatus ? shipmentIds.length : 0,
      updatedAt: now.toISOString(),
    });
  });

  /**
   * 撤销这个柜子「上一次状态推进」（员工和管理员都能用）。
   *
   * 2026-08-07 加的。柜子状态原来只能往前推，推错了回不去 ——
   * 真实案例：柜子已开船之后被误推成「延迟运输」，柜里每张运单都被写了一条
   * 「延迟运输」的轨迹，客户看到的就是「运输中」突然变「延迟运输」。
   * 一张张删要开几十次弹窗，所以在柜子这里一次撤掉整批。
   *
   * 怎么认出「上一次那批」：推进时整批日志用的是同一个时间戳（代码里的 now），
   * 并且柜子的 statusDates 里记着每个状态是什么时候推的。
   * 所以「柜里的运单 + changedAt 等于当前状态的时间戳 + toStatus 对得上」就是那一批。
   *
   * 撤完：
   * - 柜子退回上一个状态（按 statusDates 里时间仅次于当前的那个）
   * - 每张运单的当前状态按它自己剩下的最后一条轨迹重算；一条不剩就保持不动
   * - 这次推进顺手写进柜子的开船日期/到港日期，如果就是这次写的，也一并撤掉
   */
  app.post("/admin/containers/status/undo", async (req, res) => {
    const auth = requireRole(req, res, ["admin", "staff"]);
    if (!auth) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const id = typeof body.id === "string" ? body.id.trim() : "";
    if (!id) {
      fail(res, 400, "BAD_REQUEST", "id is required");
      return;
    }

    const container = await prisma.container.findFirst({
      where: { id, companyId: auth.companyId },
      include: { items: { select: { shipmentId: true } } },
    });
    if (!container) {
      fail(res, 404, "NOT_FOUND", "找不到这个柜子");
      return;
    }

    let dates: Record<string, string> = {};
    try { dates = container.statusDates ? JSON.parse(container.statusDates) : {}; } catch { dates = {}; }

    const currentTs = dates[container.currentStatus];
    if (!currentTs) {
      fail(
        res,
        400,
        "VALIDATION_ERROR",
        `这个柜子没有记录「${CONTAINER_STATUS_LABEL[container.currentStatus] ?? container.currentStatus}」是什么时候推的（多半是很早以前推的老柜子），整柜撤不了。可以到运单的物流轨迹里一条条删。`,
      );
      return;
    }

    // 上一步 = statusDates 里时间仅次于当前状态的那个
    const prevEntry = Object.entries(dates)
      .filter(([status, ts]) => status !== container.currentStatus && new Date(ts).getTime() <= new Date(currentTs).getTime())
      .sort((a, b) => new Date(b[1]).getTime() - new Date(a[1]).getTime())[0];
    if (!prevEntry) {
      fail(res, 400, "VALIDATION_ERROR", "这是这个柜子的第一个状态，没有上一步可以退。");
      return;
    }
    const prevStatus = prevEntry[0];

    const changedAt = new Date(currentTs);
    const shipmentIds = container.items.map((it) => it.shipmentId);
    const shipmentStatusOfThisPush: string | null = CONTAINER_TO_SHIPMENT_STATUS[container.currentStatus] ?? null;

    const result = await prisma.$transaction(async (tx) => {
      let deletedLogs = 0;
      let affectedShipments = 0;

      if (shipmentStatusOfThisPush && shipmentIds.length > 0) {
        const del = await tx.statusLog.deleteMany({
          where: {
            companyId: auth.companyId,
            shipmentId: { in: shipmentIds },
            changedAt,
            toStatus: shipmentStatusOfThisPush,
          },
        });
        deletedLogs = del.count;

        // 每张运单按「剩下的最后一条轨迹」重算当前状态；一条不剩的保持不动
        const remaining = await tx.statusLog.findMany({
          where: { shipmentId: { in: shipmentIds } },
          orderBy: { changedAt: "asc" },
          select: { shipmentId: true, toStatus: true },
        });
        const latestByShipment = new Map<string, string>();
        for (const row of remaining) latestByShipment.set(row.shipmentId, row.toStatus);

        // 按状态分组批量更新，避免几十张运单发几十条 update
        const idsByStatus = new Map<string, string[]>();
        for (const [sid, status] of latestByShipment) {
          const list = idsByStatus.get(status) ?? [];
          list.push(sid);
          idsByStatus.set(status, list);
        }
        for (const [status, ids] of idsByStatus) {
          await tx.shipment.updateMany({
            where: { id: { in: ids }, companyId: auth.companyId },
            data: { currentStatus: status, updatedAt: new Date() },
          });
          affectedShipments += ids.length;
        }

        // 父运单当初是跟着一起改的，这里也要跟着退
        const kids = await tx.shipment.findMany({
          where: { id: { in: shipmentIds }, companyId: auth.companyId },
          select: { id: true, parentTrackingNo: true },
        });
        const parentTargets = new Map<string, string>();
        for (const kid of kids) {
          const newStatus = kid.parentTrackingNo ? latestByShipment.get(kid.id) : undefined;
          if (kid.parentTrackingNo && newStatus) parentTargets.set(kid.parentTrackingNo, newStatus);
        }
        for (const [trackingNo, status] of parentTargets) {
          await tx.shipment.updateMany({
            where: { trackingNo, companyId: auth.companyId },
            data: { currentStatus: status, updatedAt: new Date() },
          });
        }
      }

      delete dates[container.currentStatus];
      const containerUpdate: Prisma.ContainerUpdateInput = {
        currentStatus: prevStatus,
        statusDates: JSON.stringify(dates),
        updatedAt: new Date(),
      };
      // 开船/到港日期如果就是这次推进写进去的，一并撤掉
      if (container.currentStatus === "IN_TRANSIT" && container.departureDate
          && container.departureDate.getTime() === changedAt.getTime()) {
        containerUpdate.departureDate = null;
      }
      if (container.currentStatus === "ARRIVED" && container.ata
          && container.ata.getTime() === changedAt.getTime()) {
        containerUpdate.ata = null;
      }
      await tx.container.update({ where: { id: container.id }, data: containerUpdate });

      return { deletedLogs, affectedShipments };
    });

    logger.warn("撤销柜子状态推进", {
      操作人: auth.userId,
      角色: auth.role,
      柜号: container.containerNo,
      撤掉的状态: container.currentStatus,
      退回到: prevStatus,
      删掉轨迹条数: result.deletedLogs,
      涉及运单数: result.affectedShipments,
    });

    ok(res, {
      id: container.id,
      containerNo: container.containerNo,
      undoneStatus: container.currentStatus,
      currentStatus: prevStatus,
      deletedLogs: result.deletedLogs,
      affectedShipmentCount: result.affectedShipments,
    });
  });

  // ============ 装柜（把某个运单装进某个柜子）============
  // 支持拆柜：同一 shipmentId 不能在同一柜子里出现两次（unique 约束）
  // 但可以在不同柜子里出现多次
  app.post("/admin/containers/load", async (req, res) => {
    const auth = requireRole(req, res, ["admin", "staff"]);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      containerId?: string;
      shipmentId?: string;
      loadedVolumeM3?: number;
      loadedPieceCount?: number;
    };
    const containerId = body.containerId?.trim();
    const shipmentId = body.shipmentId?.trim();
    const volume = Number(body.loadedVolumeM3);
    const pieces = Number(body.loadedPieceCount);
    if (!containerId || !shipmentId || !Number.isFinite(volume) || volume <= 0 || !Number.isFinite(pieces) || pieces <= 0) {
      fail(res, 400, "BAD_REQUEST", "containerId, shipmentId, loadedVolumeM3>0, loadedPieceCount>0 are required");
      return;
    }

    const [container, shipment] = await Promise.all([
      prisma.container.findFirst({ where: { id: containerId, companyId: auth.companyId } }),
      prisma.shipment.findFirst({
        where: { id: shipmentId, companyId: auth.companyId },
        include: {
          containerItems: { select: { loadedVolumeM3: true } },
        },
      }),
    ]);
    if (!container) {
      fail(res, 404, "NOT_FOUND", "container not found");
      return;
    }
    if (!shipment) {
      fail(res, 404, "NOT_FOUND", "shipment not found");
      return;
    }
    // 已完成/异常/退回/取消的运单不允许重新装柜
    const completedOrException = new Set(["delivered", "returned", "cancelled", "exception"]);
    if (completedOrException.has(shipment.currentStatus)) {
      fail(res, 400, "VALIDATION_ERROR", `shipment is ${shipment.currentStatus} and cannot be loaded`);
      return;
    }
    // 检查体积是否超过运单总体积（已装 + 本次 <= 总量）
    if (shipment.volumeM3 !== null) {
      const alreadyLoaded = shipment.containerItems.reduce(
        (sum, it) => sum + decToNumber(it.loadedVolumeM3),
        0,
      );
      const shipmentTotal = decToNumber(shipment.volumeM3);
      if (shipmentTotal > 0 && alreadyLoaded + volume > shipmentTotal + 0.01) {
        fail(
          res,
          400,
          "VALIDATION_ERROR",
          `loaded ${(alreadyLoaded + volume).toFixed(3)}m³ exceeds shipment total ${shipmentTotal.toFixed(3)}m³`,
        );
        return;
      }
    }

    const now = new Date();
    // 非 LOADING 状态的柜子，装柜时同步运单状态
    const syncStatus = container.currentStatus !== "LOADING"
      ? (CONTAINER_TO_SHIPMENT_STATUS[container.currentStatus] ?? null)
      : null;

    try {
      const item = await prisma.$transaction(async (tx) => {
        const created = await tx.shipmentContainerItem.create({
          data: { shipmentId, containerId, loadedVolumeM3: volume, loadedPieceCount: pieces },
        });

        // 同步运单状态 + 写日志（事务内读取当前状态，防 TOCTOU）
        if (syncStatus) {
          const current = await tx.shipment.findUnique({ where: { id: shipmentId }, select: { currentStatus: true } });
          if (current && current.currentStatus !== syncStatus) {
            await tx.shipment.update({ where: { id: shipmentId }, data: { currentStatus: syncStatus, updatedAt: now } });
            await tx.statusLog.create({
              data: {
                id: `sl_load_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                companyId: auth.companyId,
                shipmentId,
                operatorId: auth.userId,
                operatorRole: auth.role,
                operatorName: auth.name,
                fromStatus: current.currentStatus,
                toStatus: syncStatus,
                remark: `装入柜子 ${container.containerNo}`,
                changedAt: now,
              },
            });
          }
        }
        return created;
      });

      ok(res, {
        containerId,
        shipmentId,
        loadedVolumeM3: volume,
        loadedPieceCount: pieces,
        createdAt: item.createdAt.toISOString(),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Unique constraint")) {
        fail(res, 409, "CONFLICT", "this shipment is already loaded in this container");
        return;
      }
      throw err;
    }
  });

  // ============ 卸柜（移除装柜关系）============
  app.delete("/admin/containers/load", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;

    const id = req.query.id?.trim();
    if (!id) {
      fail(res, 400, "BAD_REQUEST", "id is required");
      return;
    }

    const item = await prisma.shipmentContainerItem.findUnique({
      where: { id },
      include: { container: true },
    });
    if (!item || item.container.companyId !== auth.companyId) {
      fail(res, 404, "NOT_FOUND", "load item not found");
      return;
    }
    await prisma.shipmentContainerItem.delete({ where: { id } });
    ok(res, { deleted: true, id });
  });

  // ============ 管理员删除柜子 ============
  app.delete("/admin/containers", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;

    const id = req.query.id?.trim();
    if (!id) {
      fail(res, 400, "BAD_REQUEST", "id is required");
      return;
    }

    const container = await prisma.container.findFirst({
      where: { id, companyId: auth.companyId },
      select: { id: true, currentStatus: true },
    });
    if (!container) {
      fail(res, 404, "NOT_FOUND", "container not found");
      return;
    }
    if (container.currentStatus !== "LOADING") {
      fail(res, 400, "VALIDATION_ERROR", "只能删除装柜中状态的柜子");
      return;
    }

    await prisma.$transaction(async (tx) => {
      await tx.shipmentContainerItem.deleteMany({ where: { containerId: id } });
      await tx.container.delete({ where: { id } });
    });

    ok(res, { deleted: true, id });
  });

  // ============ 客户追踪：根据运单 ID 查看完整的"出柜"信息 ============
  // 返回：运单基础信息 + 所属的所有柜子 + 状态时间线
  app.get("/client/shipments/track", async (req, res) => {
    const auth = requireRole(req, res, ["client", "staff", "admin"]);
    if (!auth) return;

    const shipmentId = req.query.shipmentId?.trim();
    const trackingNo = req.query.trackingNo?.trim();
    if (!shipmentId && !trackingNo) {
      fail(res, 400, "BAD_REQUEST", "shipmentId or trackingNo is required");
      return;
    }

    const shipment = await prisma.shipment.findFirst({
      where: shipmentId
        ? { id: shipmentId, companyId: auth.companyId }
        : { trackingNo, companyId: auth.companyId },
      include: {
        order: {
          select: {
            id: true,
            orderNo: true,
            itemName: true,
            clientId: true,
            receiverNameTh: true,
            receiverAddressTh: true,
            cargoType: true,
            products: {
              select: { itemName: true, packageCount: true },
              orderBy: { sortOrder: "asc" },
            },
          },
        },
        containerItems: {
          include: {
            container: true,
          },
        },
        statusLogs: {
          orderBy: { changedAt: "asc" },
        },
      },
    });

    if (!shipment) {
      fail(res, 404, "NOT_FOUND", "shipment not found");
      return;
    }

    // 客户角色：只能看自己的货
    if (auth.role === "client" && shipment.order?.clientId !== auth.userId) {
      fail(res, 403, "FORBIDDEN", "this shipment does not belong to you");
      return;
    }

    const totalVolume = shipment.volumeM3 ? decToNumber(shipment.volumeM3) : 0;
    const totalLoaded = shipment.containerItems.reduce(
      (sum, it) => sum + decToNumber(it.loadedVolumeM3),
      0,
    );
    const isSplit = shipment.containerItems.length > 1;

    const lastmileOrder = await prisma.adminLastmileOrder.findFirst({
      where: { shipmentId: shipment.id },
      orderBy: { updatedAt: "desc" },
    });

    const childShipments = shipment.parentTrackingNo
      ? []
      : await prisma.shipment.findMany({
          where: { parentTrackingNo: shipment.trackingNo, companyId: auth.companyId },
          include: {
            statusLogs: { orderBy: { changedAt: "asc" } },
          },
          orderBy: { trackingNo: "asc" },
        });

    const isClient = auth.role === "client";

    /**
     * 装柜时写的日志内容是「装入柜子 <柜号>（分装 N件）」，柜号就藏在正文里。
     * 客户端本来就不允许看柜号（containers、batchNo 都对客户屏蔽过），
     * 所以这里要把正文里的柜号一并抹掉，只保留「已装柜」和分装件数。
     */
    const sanitizeRemark = (remark: string): string =>
      // 柜号后面可能紧跟「（分装 N件）」，中间没有空格，
      // 所以匹配到括号就停，别把后半句一起吃掉
      isClient ? remark.replace(/装入柜子\s*[^\s（(]+/g, "已装柜") : remark;

    const mapLog = (
      log: { id: string; fromStatus: string; toStatus: string; remark: string | null; nextStop?: string | null; changedAt: Date; operatorRole: string; operatorName: string | null },
      trackingNo: string,
    ) => ({
      trackingNo,
      // 员工/管理员删「写错的一条」时要靠它定位；跟操作人一样，客户端不下发
      id: isClient ? "" : log.id,
      fromStatus: log.fromStatus,
      toStatus: log.toStatus,
      remark: sanitizeRemark(log.remark ?? ""),
      // 「下一站【泰国边境】」，客户看得到货接下来去哪；老轨迹没有这个字段就不显示
      nextStop: log.nextStop ?? "",
      changedAt: log.changedAt.toISOString(),
      // 操作人是内部信息，客户端连数据都不下发（不只是前端不显示）
      operatorRole: isClient ? "" : log.operatorRole,
      operatorName: isClient ? "" : (log.operatorName ?? ""),
    });

    // 父运单的轨迹 = 自己的记录 + 所有子运单的记录，按时间升序合并。
    // 拆柜后的操作只会记在子单上（同步父单状态时并不写日志），不合并的话
    // 父单标签会出现「当前状态：已签收 / 暂无物流轨迹」这种自相矛盾的显示。
    // 每条都带上来源单号，前端据此标注是哪一件货。
    const mergedTimeline = [
      ...shipment.statusLogs.map((log) => mapLog(log, shipment.trackingNo)),
      ...childShipments.flatMap((cs) => cs.statusLogs.map((log) => mapLog(log, cs.trackingNo))),
    ].sort((a, b) => a.changedAt.localeCompare(b.changedAt));

    ok(res, {
      /** 前端据此决定要不要显示操作人等内部信息 */
      viewerRole: auth.role,
      trackingNo: shipment.trackingNo,
      orderId: shipment.order?.id ?? null,
      orderNo: shipment.order?.orderNo ?? null,
      itemName: shipment.order?.itemName ?? null,
      products: shipment.order?.products?.map(p => ({ itemName: p.itemName, packageCount: p.packageCount })) ?? [],
      cargoType: shipment.order?.cargoType ?? null,
      currentStatus: shipment.currentStatus,
      currentLocation: shipment.currentLocation ?? undefined,
      receiverNameTh: shipment.order?.receiverNameTh ?? null,
      receiverAddressTh: shipment.order?.receiverAddressTh ?? null,
      totalVolumeM3: totalVolume,
      totalLoadedM3: Number(totalLoaded.toFixed(3)),
      isSplit,
      splitCount: shipment.containerItems.length,
      // 所属的所有柜子（拆柜情况下会有多个）— 客户端隐藏
      containers: auth.role === "client"
        ? shipment.containerItems.map((it) => ({
            loadingDate: it.container.loadingDate?.toISOString() ?? null,
            departureDate: it.container.departureDate?.toISOString() ?? null,
            ata: it.container.ata?.toISOString() ?? null,
            customsClearedAt: it.container.customsClearedAt?.toISOString() ?? null,
            containerStatus: it.container.currentStatus,
          }))
        : shipment.containerItems
        .sort((a, b) => a.container.createdAt.getTime() - b.container.createdAt.getTime())
        .map((it) => ({
          containerId: it.containerId,
          containerNo: it.container.containerNo,
          containerType: it.container.containerType,
          carrierName: it.container.carrierName ?? null,
          loadedVolumeM3: decToNumber(it.loadedVolumeM3),
          loadedPieceCount: it.loadedPieceCount,
          containerStatus: it.container.currentStatus,
          containerStatusLabel:
            CONTAINER_STATUS_LABEL[it.container.currentStatus] ?? it.container.currentStatus,
          loadingDate: it.container.loadingDate?.toISOString() ?? null,
          departureDate: it.container.departureDate?.toISOString() ?? null,
          eta: it.container.eta?.toISOString() ?? null,
          ata: it.container.ata?.toISOString() ?? null,
          customsClearedAt: it.container.customsClearedAt?.toISOString() ?? null,
        })),
      // 状态时间线（父单为合并后的完整链路，子单为自身记录）
      timeline: mergedTimeline,
      // 子单信息（分柜后运单才有）
      // 子单信息
      children: childShipments.length > 0
        ? childShipments.map((cs) => ({
            trackingNo: cs.trackingNo,
            batchNo: auth.role === "client" ? null : cs.batchNo,
            itemName: cs.itemName,
            packageCount: cs.packageCount,
            currentStatus: cs.currentStatus,
            timeline: cs.statusLogs.map((log) => mapLog(log, cs.trackingNo)),
          }))
        : undefined,
      createdAt: shipment.createdAt.toISOString(),
      updatedAt: shipment.updatedAt.toISOString(),
      lastmile: lastmileOrder ? {
        carrierName: lastmileOrder.carrierName,
        driverName: lastmileOrder.driverName,
        licensePlate: lastmileOrder.licensePlate,
        phoneNumber: lastmileOrder.phoneNumber,
        signImageBase64: lastmileOrder.signImageBase64 ? `data:image/jpeg;base64,${lastmileOrder.signImageBase64}` : null,
        status: lastmileOrder.status,
      } : null,
    });
  });
}
