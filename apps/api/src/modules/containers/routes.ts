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
import { syncParentStatusFromChildren } from "../shipments/parent-status";
import type { MinimalHttpApp } from "../../server";
import { fail, ok, requireRole } from "../core/http-utils";
import { sanitizeRemarkForClient } from "../core/client-privacy";
import { logger } from "../core/logger";
import { canTransitLoose } from "../shipments/routes";
import { BusinessError } from "../core/business-error";
// 柜子状态流程的唯一定义处，别在本文件里再抄一份
import {
  CONTAINER_STATUS_FLOW,
  CONTAINER_STATUS_FLOW_LAND,
  CONTAINER_STATUS_LABEL,
  nextStopOf,
  CONTAINER_TO_SHIPMENT_STATUS,
  flowOf,
  neverGuessOf,
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
      transportMode?: string;
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
      fail(res, 409, "VALIDATION_ERROR", "柜号已存在，请换一个");
      return;
    }

    /**
     * ⚠️ 运输方式必填（2026-08-27 补）。
     * 这个字段可以为空，而 flowOf(null) 会**默认按海运**走 ——
     * 于是从这个接口建出来的陆运柜，推「过境越南」会被拒（说不属于海运流程），
     * 「下一站」也会被填成海运的默认值。装柜页那个正式入口一直是强制选的，
     * 只有这条老路漏了（前端目前没人调它，但接口开着就可能被用到）。
     */
    const transportMode = body.transportMode?.trim();
    if (transportMode !== "sea" && transportMode !== "land") {
      fail(res, 400, "BAD_REQUEST", "请选择运输方式：海运或陆运");
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
        transportMode,
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
    // ⚠️ 默认值必须按柜子的运输方式取。原来这里不看运输方式，海运柜推到「已封柜」
    //    也会被填成陆运的「广西凭祥出口」，而且**前端把框清空也照样补上**。
    const nextStop = typeof body.nextStop === "string" && body.nextStop.trim()
      ? body.nextStop.trim().slice(0, 50)
      : nextStopOf(toStatus, container.transportMode);

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
    // 这批子单涉及的父单号，等主体事务提交后统一重算父单状态
    let parentNosToSync: string[] = [];

    /**
     * ⚠️ 这里存的是「拿到事务后再执行」的函数，不是已经发出去的 PrismaPromise（2026-08-25 改）。
     *
     * 原来是 `prisma.xxx()` 直接塞数组，最后 `prisma.$transaction(ops)` —— 那是**批量事务**，
     * 中途没法读一次数据再决定写什么，所以父单重算只能另开一个事务放在后面。
     * 两个事务之间断一下，就会留下「柜子和子单都推进了、父单还停在旧状态」的半截数据。
     * 说「重跑一次就好」也不成立：同一个状态再推一遍会**再写一批轨迹**，客户轨迹里多出重复的一行。
     *
     * 换成函数之后，下面用交互式事务把「柜子 + 子单 + 轨迹 + 父单」一次做完，
     * 要么全成，要么全不写。
     */
    const ops: Array<(tx: any) => Promise<unknown>> = [
      (tx) => tx.container.update({ where: { id: container.id }, data: updateData }),
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

      ops.push((tx) =>
        tx.shipment.updateMany({
          where: { id: { in: shipmentIds }, companyId: auth.companyId },
          data: { currentStatus: shipmentNextStatus, updatedAt: now },
        }),
      );

      // 同步父运单状态 —— 收集父单号，下面那个事务里统一重算。
      //
      // ⚠️ 原来这里是把父单直接 updateMany 成 shipmentNextStatus，等于
      //    「这批子单推到哪，父单就跟到哪」，完全没看其他子单走到哪了。
      //    分柜后另一个子单还在更早的环节时，父单就被推快了。
      //    改成推完之后按全部子单重新推算（2026-08-22）。
      parentNosToSync = [...new Set(shipments.filter(s => s.parentTrackingNo).map(s => s.parentTrackingNo!))];

      // 轨迹一次性写进去，不要一条一条发 —— 一个柜子里几十票货就是几十次往返，
      // 交互式事务默认 5 秒超时，逐条写很容易撞上。id 前缀必须保持 sl_ctn_，
      // 撤销柜子状态就是靠这个前缀认出「哪些轨迹是柜子推进写的」（红线 2.10）。
      const stamp = Date.now();
      const logRows = shipmentIds.map((sid, i) => ({
        id: `sl_ctn_${stamp}_${i}_${Math.random().toString(36).slice(2, 6)}`,
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
      }));
      ops.push((tx) => tx.statusLog.createMany({ data: logRows }));
    }

    /**
     * 柜子 + 子单 + 轨迹 + 父单，**一个事务全做完**（2026-08-25 合并）。
     *
     * 之前是分两个事务：前一个批量写柜子/子单/轨迹，后一个重算父单。
     * 中间断掉就留下「柜子和子单推进了、父单没推」的半截数据。
     *
     * ⚠️ 超时给到 30 秒：一个柜子里可能装着几十票货，父单也可能有好几个，
     * 默认 5 秒在网络慢的时候不够。maxWait 是「等空闲连接」的时间，跟执行时长无关。
     */
    await prisma.$transaction(
      async (tx) => {
        /**
         * ⚠️ 锁住柜子再复查一遍当前状态（2026-08-27 补）。
         * 上面 canContainerTransit 那道检查是在事务外面做的：两个员工同时推进同一个柜，
         * 两边都是从同一个旧状态出发算「能不能推」，结果**两批轨迹都写进去了**，
         * 状态还可能跳过中间那一步 —— 客户轨迹里就会多出重复或错序的记录。
         */
        await tx.$queryRaw`SELECT id FROM containers WHERE id = ${container.id} FOR UPDATE`;
        const nowStatus = (
          await tx.container.findUnique({ where: { id: container.id }, select: { currentStatus: true } })
        )?.currentStatus;
        if (nowStatus == null) throw new BusinessError("柜子不存在", 404, "NOT_FOUND");
        if (nowStatus !== container.currentStatus) {
          throw new BusinessError(
            `这个柜刚刚被别人推到了「${CONTAINER_STATUS_LABEL[nowStatus] ?? nowStatus}」，本次推进没有执行，请刷新后再看`,
          );
        }

        for (const run of ops) await run(tx);
        // ⚠️ 排序后再逐个锁父单：两个柜子同时推进、又正好涉及同几张父单时，
        // 加锁顺序相反会被 PostgreSQL 判定死锁掐掉一个。固定顺序就不会打架。
        for (const no of [...parentNosToSync].sort()) {
          await syncParentStatusFromChildren(tx, no, auth.companyId);
        }
      },
      { timeout: 30000, maxWait: 10000 },
    );

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

    /* ⚠️ 「派送中 / 已签收」不是装柜页推的，是尾端派送那边推的。
       在这里撤销会把客户已经签收的单子悄悄退回去，还会删掉尾端派送写的轨迹。
       2026-08-10 之前这两个状态因为没有时间表记录本来就撤不了，等于被 bug 挡着；
       现在按流程往回推能算出上一步了，必须显式挡住，否则是「修好一个、放出一个更大的」。
       生产上现在有 3 个柜子停在「已签收」。 */
    const LASTMILE_ONLY = new Set(["OUT_FOR_DELIVERY", "SIGNED", "DELIVERING"]);
    if (LASTMILE_ONLY.has(container.currentStatus)) {
      fail(
        res,
        400,
        "VALIDATION_ERROR",
        `「${CONTAINER_STATUS_LABEL[container.currentStatus] ?? container.currentStatus}」是尾端派送那边推的，不能在装柜页撤销。要退请到「尾端派送」里操作。`,
      );
      return;
    }

    let dates: Record<string, string> = {};
    try { dates = container.statusDates ? JSON.parse(container.statusDates) : {}; } catch { dates = {}; }

    const shipmentIds = container.items.map((it) => it.shipmentId);
    const shipmentStatusOfThisPush: string | null = CONTAINER_TO_SHIPMENT_STATUS[container.currentStatus] ?? null;

    /* ==================================================================
       2026-08-10 修：撤销在生产上基本全废了。
       106 个柜子里 102 个点「撤销」都报「这是第一个状态，没有上一步可以退」——
       而它们明明是「运输中」「已到仓」这种中间状态。

       原因：这里完全依赖柜子身上那张「状态时间表」(statusDates)。那张表是
       2026-08-06 才加的，**加之前推过的状态一条都没补记**，所以老柜子要么整张表
       是空的（68 个），要么只有当前这一条（34 个）→ 找不到上一步 → 报了那句错话。
       而且那句话本身是错的：不是「第一个状态」，是「前面的没记录」。

       现在两级兜底：
         ① 这次推进是什么时候发生的：先看时间表；没有就去柜内运单的轨迹里，
            找「最后一次推到这个状态」的那条 —— 那条就是这次推进留下的痕迹。
         ② 上一步是哪个状态：先看时间表；没有就按流程往回退一格，
            但**跳过没记录推过的「意外状态」**（滞留/查验/延迟），
            否则等于把柜子退回一个它从来没到过的状态。
       ================================================================== */

    /* ⚠️ 只认「柜子推进状态」自己写的那批轨迹。
       轨迹按来源分好几种，id 前缀不一样（生产实测 2311 条）：
         sl_ctn_  柜子推进状态   1516 条  ← 只有这种是本次撤销该动的
         sl_lm_   尾端派送        619 条
         sl_mnf_  装柜时随柜补记  113 条
         sl_new_ / sl_fix_ 等老数据
       不加这个限制的后果（我拿生产数据算过）：68 个「时间表整张空」的柜子里，
       有 6 个会去删**别人写的**轨迹 —— 1 个删到尾端派送的、3 个删到装柜补记的、
       2 个删到老数据。那不是撤销，那是破坏。
       加了之后这 6 个找不到自己的推进记录，就只退柜子状态、不动运单，宁可少做。 */
    const PUSH_LOG_PREFIX = "sl_ctn_";

    // ① 这次推进发生的时间
    let currentTs: string | null = dates[container.currentStatus] ?? null;
    if (!currentTs && shipmentStatusOfThisPush && shipmentIds.length > 0) {
      const lastLog = await prisma.statusLog.findFirst({
        where: {
          companyId: auth.companyId,
          shipmentId: { in: shipmentIds },
          toStatus: shipmentStatusOfThisPush,
          id: { startsWith: PUSH_LOG_PREFIX },
        },
        orderBy: { changedAt: "desc" },
        select: { changedAt: true },
      });
      if (lastLog) currentTs = lastLog.changedAt.toISOString();
    }

    // ② 上一步是哪个状态
    let prevStatus: string | null = null;
    if (currentTs) {
      const prevEntry = Object.entries(dates)
        .filter(([status, ts]) => status !== container.currentStatus && new Date(ts).getTime() <= new Date(currentTs!).getTime())
        .sort((a, b) => new Date(b[1]).getTime() - new Date(a[1]).getTime())[0];
      if (prevEntry) prevStatus = prevEntry[0];
    }
    if (!prevStatus) {
      // 先按柜子自己的运输方式找；找不到再按另一条流程找 ——
      // 有柜子中途改过运输方式，当前状态可能压根不在现在这条流程里
      // （实测：一个标着「陆运」的柜子停在「运输中」，那是海运才有的环节）。
      const flows = [flowOf(container.transportMode), flowOf(container.transportMode === "land" ? "sea" : "land")];
      for (const flow of flows) {
        const idx = flow.indexOf(container.currentStatus);
        if (idx < 0) continue;
        for (let i = idx - 1; i >= 0; i--) {
          const candidate = flow[i]!;
          // 没记录推过的意外状态，绝不能退到那里去
          // ⚠️ 名单按运输方式取 —— 海运柜不能退进「出口已放行」，
          //    陆运柜不能退进「清关中」，两边的「少数柜才走」不是同一批。
          if (neverGuessOf(container.transportMode).has(candidate) && !dates[candidate]) continue;
          prevStatus = candidate;
          break;
        }
        if (prevStatus) break;
      }
    }
    if (!prevStatus) {
      fail(
        res,
        400,
        "VALIDATION_ERROR",
        `「${CONTAINER_STATUS_LABEL[container.currentStatus] ?? container.currentStatus}」已经是这个柜子流程里的第一步，没有上一步可以退。`,
      );
      return;
    }

    // 找不到推进时间时（老柜子、且运单那边也没留下轨迹）：这次推进没在运单上留下任何痕迹，
    // 所以只退柜子状态，不去删轨迹、不动运单 —— 见下面 changedAt 为 null 的分支。
    const changedAt: Date | null = currentTs ? new Date(currentTs) : null;

    const result = await prisma.$transaction(async (tx) => {
      /**
       * ⚠️ 锁住再复查一遍状态（2026-08-27 补）。
       * 上面「上一步是哪个状态、要删哪批轨迹」全是按事务外面读到的那个 currentStatus 算的。
       * 两个人同时点「撤销」，两边都从同一个状态往回退，就会连退两格并删掉两批轨迹；
       * 一个人撤销、一个人推进撞上，删的还可能是别人刚写的那批。
       */
      await tx.$queryRaw`SELECT id FROM containers WHERE id = ${container.id} FOR UPDATE`;
      const nowStatus = (
        await tx.container.findUnique({ where: { id: container.id }, select: { currentStatus: true } })
      )?.currentStatus;
      if (nowStatus == null) throw new BusinessError("柜子不存在", 404, "NOT_FOUND");
      if (nowStatus !== container.currentStatus) {
        throw new BusinessError(
          `这个柜刚刚被别人改成了「${CONTAINER_STATUS_LABEL[nowStatus] ?? nowStatus}」，撤销没有执行，请刷新后再看`,
        );
      }

      let deletedLogs = 0;
      let affectedShipments = 0;

      if (changedAt && shipmentStatusOfThisPush && shipmentIds.length > 0) {
        const del = await tx.statusLog.deleteMany({
          where: {
            companyId: auth.companyId,
            shipmentId: { in: shipmentIds },
            changedAt,
            toStatus: shipmentStatusOfThisPush,
            // 同上：只删柜子推进自己写的那条，别人写的一律不碰
            id: { startsWith: PUSH_LOG_PREFIX },
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

        // 父运单当初是跟着一起改的，这里也要跟着退（2026-08-22 改成统一推算）
        //
        // ⚠️ 原来是拿一个 Map<父单号, 状态> 收集，同一个父单下有多个子单时，
        //    **循环里后一个子单会覆盖前一个**，最后把「最后那个子单的状态」写给父单 ——
        //    典型的「最后写入者赢」，父单可能被退到一个跟实际不符的状态。
        //    现在只收集父单号，逐个按**全部子单**重算。
        const kids = await tx.shipment.findMany({
          where: { id: { in: shipmentIds }, companyId: auth.companyId },
          select: { id: true, parentTrackingNo: true },
        });
        const parentNos = [...new Set(kids.map((k) => k.parentTrackingNo).filter((v): v is string => !!v))];
        for (const trackingNo of parentNos) {
          await syncParentStatusFromChildren(tx, trackingNo, auth.companyId);
        }
      }

      delete dates[container.currentStatus];
      const containerUpdate: Prisma.ContainerUpdateInput = {
        currentStatus: prevStatus,
        statusDates: JSON.stringify(dates),
        updatedAt: new Date(),
      };
      // 开船/到港日期如果就是这次推进写进去的，一并撤掉
      // （changedAt 为 null 表示找不到这次推进的时间，那就不敢认这个日期是它写的，不动）
      if (changedAt && container.currentStatus === "IN_TRANSIT" && container.departureDate
          && container.departureDate.getTime() === changedAt.getTime()) {
        containerUpdate.departureDate = null;
      }
      if (changedAt && container.currentStatus === "ARRIVED" && container.ata
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
    // 「该把运单同步成什么状态」改到事务里算了（见下面 syncStatusNow），
    // 这里不再提前算 —— 提前算出来的可能是柜子上一秒的状态。

    try {
      const item = await prisma.$transaction(async (tx) => {
        /**
         * ⚠️⚠️ **锁序必须是【柜 → 运单】**（2026-08-28 补）。
         *
         * 「推进柜子状态」那条路（本文件 ~426 行）是先锁柜、再动里面的运单；
         * 装柜这条路原来是**先锁运单、再去读柜子**，两条方向正好相反 ——
         * 一个人装柜、一个人推进同一个柜时，两边各握着对方要的锁，
         * PostgreSQL 会判定死锁掐掉一个（这个分支之前在集货那边踩过同样的坑：
         * 真实 PostgreSQL 实测 16 个事务死锁 7 个，统一锁序后 0 死锁）。
         *
         * 而且柜子状态原来是**只读不锁**的：读完之后、写 shipment_container_items 之前，
         * 「推进柜子状态」完全可以提交 —— 于是这一票新装进来的货
         * 被同步成柜子的**旧状态**、轨迹也按旧状态写，
         * 而推进那条路已经走完了、不会再回头补这一票，**这条记录永远是错的**。
         *
         * 锁住柜子之后：装柜和推进必须排队，谁先谁后都能拿到对方提交后的真实状态。
         */
        await tx.$queryRaw`SELECT id FROM containers WHERE id = ${containerId} FOR UPDATE`;

        /**
         * ⚠️ 锁住运单，再复查「体积会不会装超」和「柜子现在什么状态」（2026-08-27 补）。
         *
         * 上面两样都是事务外面读的：
         *   ① 同一张运单被两个人同时装进两个柜，两边都拿装之前那个「已装体积」去算，
         *      两边都觉得没超 —— 实际加起来超了运单总方数。
         *   ② 柜子状态也是外面读的，用它算出来的 syncStatus 可能已经过时，
         *      会把运单同步成一个柜子已经离开的状态。
         */
        await tx.$queryRaw`SELECT id FROM shipments WHERE id = ${shipmentId} FOR UPDATE`;
        const freshShipment = await tx.shipment.findUnique({
          where: { id: shipmentId },
          select: { currentStatus: true, volumeM3: true, containerItems: { select: { loadedVolumeM3: true } } },
        });
        if (!freshShipment) throw new BusinessError("运单不存在", 404, "NOT_FOUND");
        if (completedOrException.has(freshShipment.currentStatus)) {
          throw new BusinessError("这张运单刚刚变成了「" + freshShipment.currentStatus + "」，不能再装柜了，请刷新后再看");
        }
        if (freshShipment.volumeM3 !== null) {
          const loadedNow = freshShipment.containerItems.reduce(
            (sum, it) => sum + decToNumber(it.loadedVolumeM3),
            0,
          );
          const total = decToNumber(freshShipment.volumeM3);
          if (total > 0 && loadedNow + volume > total + 0.01) {
            throw new BusinessError(
              `装不下了：这张运单一共 ${total.toFixed(3)} 方，已经装了 ${loadedNow.toFixed(3)} 方，再装 ${volume.toFixed(3)} 方会超`,
            );
          }
        }
        // 柜子状态也用事务里读到的，别用外面那份可能过时的
        const freshContainerStatus = (
          await tx.container.findUnique({ where: { id: containerId }, select: { currentStatus: true } })
        )?.currentStatus;
        if (freshContainerStatus == null) throw new BusinessError("柜子不存在", 404, "NOT_FOUND");
        const syncStatusNow = freshContainerStatus !== "LOADING"
          ? (CONTAINER_TO_SHIPMENT_STATUS[freshContainerStatus] ?? null)
          : null;

        const created = await tx.shipmentContainerItem.create({
          data: { shipmentId, containerId, loadedVolumeM3: volume, loadedPieceCount: pieces },
        });

        // 同步运单状态 + 写日志（事务内读取当前状态，防 TOCTOU）
        if (syncStatusNow) {
          const current = await tx.shipment.findUnique({ where: { id: shipmentId }, select: { currentStatus: true } });
          if (current && current.currentStatus !== syncStatusNow) {
            await tx.shipment.update({ where: { id: shipmentId }, data: { currentStatus: syncStatusNow, updatedAt: now } });
            await tx.statusLog.create({
              data: {
                id: `sl_load_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                companyId: auth.companyId,
                shipmentId,
                operatorId: auth.userId,
                operatorRole: auth.role,
                operatorName: auth.name,
                fromStatus: current.currentStatus,
                toStatus: syncStatusNow,
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
        fail(res, 409, "VALIDATION_ERROR", "这张运单已经装进这个柜了，不用重复装");
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
      /**
       * ⚠️ 锁住再复查一遍状态（2026-08-27 补）。上面那道「只能删装柜中的柜」在事务外面：
       * 另一个人正好在这一刻把柜封了/发运了，这边照样把整个柜连同装柜记录删掉 ——
       * 已经在路上的柜凭空消失，运单也从柜里掉出来了。
       */
      await tx.$queryRaw`SELECT id FROM containers WHERE id = ${id} FOR UPDATE`;
      const nowStatus = (
        await tx.container.findUnique({ where: { id }, select: { currentStatus: true } })
      )?.currentStatus;
      if (nowStatus == null) throw new BusinessError("柜子不存在", 404, "NOT_FOUND");
      if (nowStatus !== "LOADING") {
        throw new BusinessError(
          `这个柜刚刚被推到了「${CONTAINER_STATUS_LABEL[nowStatus] ?? nowStatus}」，已经不能删了，请刷新后再看`,
        );
      }

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
     *
     * 2026-08-11：抽到 core/client-privacy.ts，免登录查轨迹那边共用同一份，
     * 别再各写各的（CLAUDE.md 第 20 条）。
     */
    const sanitizeRemark = (remark: string): string =>
      sanitizeRemarkForClient(remark, isClient);

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
