// B-3 ~ B-7: 已从 node:sqlite 迁移到 Prisma + PostgreSQL（2026-05-18）
import { validateProductRows, validateOrderLevelQuantity } from "./product-row-guard";
import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma";
import { getClientIp } from "../core/rate-limit";
import type { MinimalHttpApp } from "../../server";

/* 2026-08-07：运单不再涉及金额。
   原来这里有一套「按体积×单价自动算应收金额」的代码，两个 bug 叠在一起
   （只查通用价、但库里全是客户专属价；兜底价目表键名大小写对不上），
   从 2026-06 起就一直算不出来。用户决定：运单金额线下算，系统不再参与，
   钱只在两个集货拼柜板块里算。整段删除，不留半死不活的代码。 */

import { fail, ok, parseJsonArray, requireRole } from "../core/http-utils";
import { loadProductImagesForOrders, MAX_ORDER_PRODUCT_IMAGES } from "./product-images";
import { saveImageToDisk, deleteImageFile } from "./image-storage";
import { sanitizeRemarkForClient } from "../core/client-privacy";
import { loadOrderTotalMetrics } from "../shipments/total-metrics";

/** 批量加载订单的产品行 */
export async function loadOrderProducts(companyId: string, orderIds: string[]): Promise<Map<string, any[]>> {
  if (orderIds.length === 0) return new Map();
  const rows = await prisma.orderProduct.findMany({
    where: { companyId, orderId: { in: [...new Set(orderIds)] } },
    orderBy: { sortOrder: "asc" },
  });
  const map = new Map<string, any[]>();
  for (const r of rows) {
    const list = map.get(r.orderId) ?? [];
    list.push({
      id: r.id, itemName: r.itemName, packageCount: r.packageCount,
      lengthCm: r.lengthCm, widthCm: r.widthCm, heightCm: r.heightCm,
      productQuantity: r.productQuantity,
      cargoType: r.cargoType,
      domesticTrackingNo: r.domesticTrackingNo,
      weightKg: r.weightKg,
    });
    map.set(r.orderId, list);
  }
  return map;
}

import { COMPLETED_STATUSES as COMPLETED } from "../shipments/status-flow";
import { BusinessError } from "../core/business-error";

/** Prisma 的 Decimal | null 转 number | null（用于返回前端）。 */
function decToNumber(value: Prisma.Decimal | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return Number(value.toString());
}

/**
 * 根据仓库ID返回湘泰运单号前缀。
 */
function warehousePrefix(warehouseId: string): string {
  if (warehouseId === "wh_guangzhou_01") return "GZXT";
  if (warehouseId === "wh_yiwu_01") return "YWXT";
  if (warehouseId === "wh_dongguan_01") return "DGXT";
  if (warehouseId === "wh_shenzhen_01") return "SZXT";
  return "XT";
}

/**
 * 将日期格式化为 YYYYMMDD。
 */
function toDatePart(dateText: string): string {
  return dateText.replace(/-/g, "").slice(0, 8);
}

/**
 * 判断员工/管理员是否可编辑该订单仓库维度下的数据。
 *
 * ⚠️⚠️ **永远返回 true 是有意为之，不是没写完的 TODO。别来「修」它。**
 *
 * 2026-08-22 用户明确拍板：**「不分仓库管」**。
 * 他们一共 3 个员工，其中 1 个（「可爱」）干了全部操作的 80%，
 * 另外两个账号的「授权仓库」填的是全部三个仓库 —— 实际业务从来没按仓库分过工。
 *
 * ⚠️ **如果把这里改成「按 users.warehouseIds 放行」，第二天就会出事**：
 * 「可爱」那个账号的 warehouseIds 是空数组 `[]`，一改就等于她一个仓库都没授权，
 * 系统里干活最多的人立刻什么都改不了。要真改，必须先给她配上仓库再上线。
 *
 * （有一份第三方审计报告把这条列为「P1-2 上线阻断问题」，
 *   那是按通用 RBAC 规范说的，不了解这家公司的实际分工。用户已看过并否掉。）
 */
async function staffCanEditOrderWarehouse(
  _auth: { userId: string; role: string; companyId: string },
  _warehouseId: string,
): Promise<boolean> {
  return true;
}

/**
 * ⚠️ DEPRECATED: 当前不再使用，运单号由 generatePrealertNo() 生成。
 * 按"仓库前缀+日期+3位流水"生成湘泰运单号。
 * 如重新启用，需添加 pg_advisory_xact_lock 或 unique constraint retry 防止并发冲突。
 */
async function generateTrackingNo(warehouseId: string, arrivedAt: string): Promise<string> {
  const prefix = warehousePrefix(warehouseId);
  const datePart = toDatePart(arrivedAt);
  const base = `${prefix}${datePart}`;
  const count = await prisma.shipment.count({
    where: { trackingNo: { startsWith: base } },
  });
  const seq = String(count + 1).padStart(3, "0");
  return `${base}${seq}`;
}

/**
 * 生成预报单号：仓库前缀 + YB + 7 位序号，使用 pg_advisory_xact_lock 保证并发安全。
 */
const PREALERT_LOCK_KEY = 0x5afd00b1;

function prealertPrefix(warehouseId: string): string {
  if (warehouseId === "wh_guangzhou_01") return "GZYB";
  if (warehouseId === "wh_yiwu_01") return "YWYB";
  if (warehouseId === "wh_dongguan_01") return "DGYB";
  if (warehouseId === "wh_shenzhen_01") return "SZYB";
  return "YWYB";
}

async function generatePrealertNo(warehouseId: string): Promise<string> {
  const prefix = prealertPrefix(warehouseId);
  // Use $transaction to keep advisory lock active during read+compute
  const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PREALERT_LOCK_KEY})`;

    const last = await tx.order.findFirst({
      where: { orderNo: { startsWith: prefix } },
      orderBy: { orderNo: "desc" },
      select: { orderNo: true },
    });

    let nextSeq = 1;
    if (last?.orderNo) {
      const numPart = parseInt(last.orderNo.replace(prefix, ""), 10);
      if (!Number.isNaN(numPart)) {
        nextSeq = numPart + 1;
      }
    }

    return `${prefix}${String(nextSeq).padStart(7, "0")}`;
  });

  return result;
}

export function registerOrderRoutes(app: MinimalHttpApp): void {
  app.post("/client/prealerts", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      warehouseId?: string;
      itemName?: string;
      packageCount?: number;
      packageUnit?: "bag" | "box";
      weightKg?: number;
      volumeM3?: number;
      shipDate?: string;
      domesticTrackingNo?: string;
      transportMode?: "sea" | "land";
      receiverNameTh?: string;
      receiverPhoneTh?: string;
      receiverAddressTh?: string;
      trackingNo?: string;
      remark?: string;
      products?: Array<{
        itemName: string;
        packageCount: number;
        lengthCm?: number;
        widthCm?: number;
        heightCm?: number;
        productQuantity?: number;
        weightKg?: number;
        cargoType?: string;
        domesticTrackingNo?: string;
      }>;
    };

    /**
     * ⚠️⚠️ **客户建单这条路以前完全没有这道校验**（2026-08-29 补）。
     *
     * 第七轮复核真调这个路由传 `packageCount: 0`，返回 200，
     * 订单/产品行/运单三处**全部存成 1** —— 老板最早报的
     * 「系统自己把箱数猜成 1」在这条路上原样还在。
     * 上一轮我只把 `/staff/orders` 接上了校验，三个后端入口修了一个。
     *
     * 下面原来那句 `Math.max(1, p.packageCount || 1)` 就是病根，
     * 连它上面那行注释「PackageCount: 0 silently coerced to 1」都写着了 ——
     * 有人早看见过，没修。
     *
     * ⚠️ 位置必须在**碰数据库之前**，三个入口都是这个规矩。
     */
    if (body.products?.length) {
      const rowIssue = validateProductRows(body.products);
      if (rowIssue) {
        fail(res, 400, "VALIDATION_ERROR", rowIssue);
        return;
      }
    }

    if (!body.warehouseId?.trim() || (!body.itemName && !body.products?.length) || !body.transportMode) {
      fail(res, 400, "BAD_REQUEST", "missing required prealert fields");
      return;
    }

    // 没有产品行的单子，箱数全靠订单级这个字段，同样不许是 0 或小数
    if (!body.products?.length) {
      const pc = Number(body.packageCount ?? 0);
      if (!Number.isInteger(pc) || pc <= 0) {
        fail(res, 400, "VALIDATION_ERROR", "箱数必须是正整数");
        return;
      }
    }

    // Compute products totals
    const products = body.products?.length
      ? body.products.map((p, i) => ({
          itemName: p.itemName.trim(),
          packageCount: p.packageCount,
          lengthCm: p.lengthCm ?? null,
          widthCm: p.widthCm ?? null,
          heightCm: p.heightCm ?? null,
          productQuantity: p.productQuantity ?? null, cargoType: p.cargoType?.trim() || "normal", domesticTrackingNo: p.domesticTrackingNo?.trim() || "货拉拉", weightKg: p.weightKg ?? null, sortOrder: i }))
      // 兜底分支的字段要和上面那支**完全一致**，否则联合类型里少了几个字段，
      // 下面 reduce 读 weightKg / cargoType 时会报错（2026-08-27 补齐）
      : [{
          itemName: body.itemName!.trim(),
          packageCount: Number(body.packageCount ?? 0),
          lengthCm: null,
          widthCm: null,
          heightCm: null,
          productQuantity: null,
          // ⚠️ 这两个值必须和**数据库默认值**一模一样。
          // 原来这里根本没写这两个字段，createMany 传 undefined 时数据库会填默认值
          // （cargo_type='normal'、domestic_tracking_no='货拉拉'）。
          // 现在为了让类型对齐显式写出来，但**不能顺手改成别的值** ——
          // 那就不是「修类型」而是偷偷改了存进去的数据。
          cargoType: "normal",
          domesticTrackingNo: "货拉拉",
          weightKg: null,
          sortOrder: 0,
        }];

    // ⚠️ 不许 `Math.max(1, ...)`：上面已经卡死必须是正整数，这里再兜一次
    // 等于把校验的结果又抹掉一遍（2026-08-29 去掉）
    const totalPkg = products.reduce((s, p) => s + p.packageCount, 0);
    const totalWeight = products.reduce((s, p) => s + (p.weightKg ?? 0) * p.packageCount, 0);
    const totalVol = products.reduce((s, p) => {
      if (p.lengthCm && p.widthCm && p.heightCm) return s + (p.lengthCm * p.widthCm * p.heightCm * p.packageCount) / 1_000_000;
      return s;
    }, 0);
    const primaryName = products[0].itemName;

    if (!body.warehouseId?.trim() || !primaryName || !body.transportMode) {
      fail(res, 400, "BAD_REQUEST", "missing required prealert fields");
      return;
    }

    const now = new Date().toISOString();
    const shipDateText = body.shipDate?.trim() || now.slice(0, 10);
    const shipDate = new Date(`${shipDateText}T00:00:00`);
    if (Number.isNaN(shipDate.getTime())) {
      fail(res, 400, "BAD_REQUEST", "invalid shipDate");
      return;
    }
    const manualWeightKg = body.weightKg === undefined || body.weightKg === null ? null : Number(body.weightKg);
    const manualVolumeM3 = body.volumeM3 === undefined || body.volumeM3 === null ? null : Number(body.volumeM3);
    const orderId = `o_${Date.now()}`;

    const orderNo = await generatePrealertNo(body.warehouseId.trim());

    await prisma.order.create({
      data: {
        id: orderId,
        companyId: auth.companyId,
        clientId: auth.userId,
        warehouseId: body.warehouseId.trim(),
        batchNo: null,
        orderNo,
        approvalStatus: "shipped",
        itemName: primaryName,
        productQuantity: 0,
        packageCount: totalPkg,
        packageUnit: body.packageUnit ?? "box",
        weightKg: totalWeight > 0 ? (totalWeight as unknown as Prisma.Decimal) : (manualWeightKg as unknown as Prisma.Decimal | null),
        volumeM3: totalVol > 0 ? totalVol : (manualVolumeM3 as unknown as Prisma.Decimal | null),
        receivableAmountCny: null,
        receivableCurrency: "CNY",
        shipDate: shipDateText,
        domesticTrackingNo: body.domesticTrackingNo ?? null,
        transportMode: body.transportMode,
        receiverNameTh: body.receiverNameTh?.trim() || "",
        receiverPhoneTh: body.receiverPhoneTh?.trim() || "",
        receiverAddressTh: body.receiverAddressTh?.trim() || "",
        statusGroup: "unfinished",
      },
    });

    // Create product records (批量插入)
    if (products.length > 0) {
      await prisma.orderProduct.createMany({
        data: products.map((p, i) => ({
          companyId: auth.companyId,
          orderId,
          itemName: p.itemName,
          packageCount: p.packageCount,
          lengthCm: p.lengthCm ?? null,
          widthCm: p.widthCm ?? null,
          heightCm: p.heightCm ?? null,
          productQuantity: p.productQuantity ?? null,
          cargoType: p.cargoType,
          domesticTrackingNo: p.domesticTrackingNo,
          sortOrder: i,
        })),
      });
    }

    // 同步创建运单（预报单=运单号）
    const shipmentId = `s_${Date.now()}`;
    await prisma.shipment.create({
      data: {
        id: shipmentId,
        companyId: auth.companyId,
        orderId,
        trackingNo: orderNo,
        batchNo: null,
        currentStatus: "created",
        weightKg: totalWeight > 0 ? (totalWeight as unknown as Prisma.Decimal) : (manualWeightKg as unknown as Prisma.Decimal | null),
        volumeM3: totalVol > 0 ? (totalVol as unknown as Prisma.Decimal) : (manualVolumeM3 as unknown as Prisma.Decimal | null),
        packageCount: totalPkg,
        packageUnit: body.packageUnit ?? "box",
        transportMode: body.transportMode,
        domesticTrackingNo: body.domesticTrackingNo ?? null,
        warehouseId: body.warehouseId.trim(),
      },
    });

    // 2026-08-06：轨迹的起点。原来建单不写任何轨迹，客户查件最早只能看到「已装柜」，
    // 前面从预报到装柜的十天半个月是空白（生产实测「已创建」轨迹条数为 0）。
    await prisma.statusLog.create({
      data: {
        id: `sl_new_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        companyId: auth.companyId, shipmentId,
        operatorId: auth.userId, operatorRole: auth.role, operatorName: auth.name ?? "",
        fromStatus: "created", toStatus: "created",
        remark: "客户已提交预报，等待国内仓收货",
        nextStop: "国内仓",
        changedAt: new Date(),
      },
    });

    ok(res, { prealertId: orderId, trackingNo: orderNo, createdAt: now });
  });

  /**
   * 员工/管理员确认收货：核实数据并标记预报单为已收货。
   */
  app.post("/staff/prealerts/receive", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      orderId?: string;
      itemName?: string;
      packageCount?: number;
      packageUnit?: "bag" | "box";
      weightKg?: number;
      volumeM3?: number;
      productQuantity?: number;
      domesticTrackingNo?: string;
      transportMode?: "sea" | "land";
      cargoType?: string;
    };
    const orderId = body.orderId?.trim();
    if (!orderId) { fail(res, 400, "BAD_REQUEST", "orderId is required"); return; }

    const order = await prisma.order.findFirst({
      where: { id: orderId, companyId: auth.companyId },
      // currentStatus 是写「国内仓已收货」轨迹时要用的 fromStatus（2026-08-06）
      include: { shipments: { take: 1, select: { id: true, currentStatus: true } } },
    });
    if (!order) { fail(res, 404, "NOT_FOUND", "order not found"); return; }
    if (order.approvalStatus === "received") {
      fail(res, 400, "VALIDATION_ERROR", "已确认收货");
      return;
    }

    // 【审查问题 6】原来直接 Number(...) 就往库里写，Excel 里箱数填成"三箱"
    // 会变成 NaN → Prisma 写库报错 → 500。这里补上和 admin/routes.ts 一致的校验。
    const numOrFail = (raw: unknown, field: string): number | null => {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) {
        fail(res, 400, "BAD_REQUEST", `invalid ${field}`);
        return null;
      }
      return n;
    };
    let receivePackageCount: number | undefined;
    if (body.packageCount !== undefined) {
      const n = numOrFail(body.packageCount, "packageCount");
      if (n === null) return;
      receivePackageCount = n;
    }
    let receiveProductQuantity: number | undefined;
    if (body.productQuantity !== undefined) {
      const n = numOrFail(body.productQuantity, "productQuantity");
      if (n === null) return;
      receiveProductQuantity = n;
    }

    const now = new Date();
    const updateData: any = {
      approvalStatus: "received",
      statusGroup: "unfinished",
      updatedAt: now,
    };
    if (body.itemName?.trim()) updateData.itemName = body.itemName.trim();
    if (receivePackageCount !== undefined) updateData.packageCount = receivePackageCount;
    if (body.packageUnit) updateData.packageUnit = body.packageUnit;
    if (body.weightKg !== undefined) updateData.weightKg = body.weightKg as any;
    if (body.volumeM3 !== undefined) updateData.volumeM3 = body.volumeM3 as any;
    if (receiveProductQuantity !== undefined) updateData.productQuantity = receiveProductQuantity;
    if (body.transportMode) updateData.transportMode = body.transportMode;
    if (body.cargoType) updateData.cargoType = body.cargoType;
    if (body.domesticTrackingNo) updateData.domesticTrackingNo = body.domesticTrackingNo;

    await prisma.order.update({ where: { id: orderId }, data: updateData });

    // 同步更新运单
    const shipment = order.shipments[0];
    if (shipment) {
      const sUpdate: any = { updatedAt: now };
      if (body.weightKg !== undefined) sUpdate.weightKg = body.weightKg as any;
      if (body.volumeM3 !== undefined) sUpdate.volumeM3 = body.volumeM3 as any;
      if (receivePackageCount !== undefined) sUpdate.packageCount = receivePackageCount;
      if (body.packageUnit) sUpdate.packageUnit = body.packageUnit;
      if (body.transportMode) sUpdate.transportMode = body.transportMode;
      if (body.itemName?.trim()) sUpdate.itemName = body.itemName.trim();
      await prisma.shipment.update({ where: { id: shipment.id }, data: sUpdate });

      // 2026-08-06：国内仓收到货是客户最关心的一步，原来一条轨迹都不写。
      // ⚠️ 只写轨迹，**不动 currentStatus** —— inWarehouseCN 不在运单状态流程里（STATUS_FLOW），
      //    真去改状态会被流转校验拦下，而且三端列表的筛选口径也会跟着变。
      await prisma.statusLog.create({
        data: {
          id: `sl_rcv_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          companyId: auth.companyId, shipmentId: shipment.id,
          operatorId: auth.userId, operatorRole: auth.role, operatorName: auth.name ?? "",
          fromStatus: shipment.currentStatus, toStatus: "inWarehouseCN",
          remark: "国内仓已收货，等待装柜",
          nextStop: "装柜",
          changedAt: now,
        },
      });
    }

    ok(res, { orderId, status: "received", updatedAt: now.toISOString() });
  });

  /**
   * 客户端删除预报单（确认收货前可删）。
   */
  app.post("/client/prealerts/delete", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;
    const body = (req.body ?? {}) as { orderId?: string };
    const orderId = body.orderId?.trim();
    if (!orderId) {
      fail(res, 400, "BAD_REQUEST", "orderId is required");
      return;
    }
    const order = await prisma.order.findFirst({
      where: { id: orderId, companyId: auth.companyId, clientId: auth.userId },
    });
    if (!order) {
      fail(res, 404, "NOT_FOUND", "order not found");
      return;
    }
    if (order.approvalStatus === "received") {
      fail(res, 400, "VALIDATION_ERROR", "已确认收货，无法删除");
      return;
    }
    // 2026-08-04 加固：原来只挡了 received，客户可以把自己**已付款、已发货**的订单
    // 整个删掉。这个删除是硬删除且级联很深——运单、状态记录、装柜明细、派送单、
    // 签收记录、入库照片、结算分录（财务数据）全部一并清除，账单行还会变成孤儿。
    // 也就是说：客户付了钱、货发出去了，然后一键把这笔交易从系统里抹掉。
    // 与 prealerts/update 用同一套状态机口径：付款或发货后不可再动。
    if (order.paymentStatus === "paid" || order.approvalStatus === "shipped") {
      const why = order.paymentStatus === "paid" ? "该订单已付款" : "该订单已发货";
      fail(res, 400, "VALIDATION_ERROR", `${why}，无法删除。需要取消请联系客服。`);
      return;
    }
    await prisma.$transaction(async (tx) => {
      /**
       * ⚠️ 锁住订单再复查一遍（2026-08-27 补）。上面那三道闸全在事务外面：
       * 仓库正好在这一刻确认收货、或者财务标记了已付款，这边照样把整张订单
       * **硬删**掉 —— 运单、轨迹、装柜明细、派送单、入库照片、结算分录一起没，
       * 而且删了就找不回来。锁住之后重查一遍，情况变了就不删。
       */
      await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId} FOR UPDATE`;
      const fresh = await tx.order.findUnique({
        where: { id: orderId },
        select: { approvalStatus: true, paymentStatus: true },
      });
      if (!fresh) throw new BusinessError("订单不存在", 404, "NOT_FOUND");
      if (fresh.approvalStatus === "received") {
        throw new BusinessError("这张单刚刚被确认收货了，删除没有执行，请刷新后再看");
      }
      if (fresh.paymentStatus === "paid" || fresh.approvalStatus === "shipped") {
        const why = fresh.paymentStatus === "paid" ? "刚刚被标记为已付款" : "刚刚已发货";
        throw new BusinessError(`这张单${why}，删除没有执行。需要取消请联系客服。`);
      }

      // 先获取订单下所有运单，用于级联清理
      const orderShipments = await tx.shipment.findMany({
        where: { orderId },
        select: { id: true, parentTrackingNo: true },
      });
      const shipmentIdsToDelete = orderShipments.map((s) => s.id);
      /**
       * 锁序【订单 → 派送单 → 运单 → 父单】（2026-08-29 补）。
       * 派送单要排在运单**前面**：签收那条路（admin-ops/routes.ts）是
       * 先锁派送单再锁运单，这里反过来的话，删单和签收同时点就成环。
       */
      const lastmileIds = (
        await tx.adminLastmileOrder.findMany({
          where: { shipmentId: { in: shipmentIdsToDelete } },
          select: { id: true },
        })
      ).map((r) => r.id);
      for (const lid of [...lastmileIds].sort()) {
        await tx.$queryRaw`SELECT id FROM admin_lastmile_orders WHERE id = ${lid} FOR UPDATE`;
      }
      /**
       * ⚠️⚠️ **必须「先锁完全部子单，再锁全部父单」**（2026-08-29 第七轮复核之后改的）。
       *
       * 上一轮我是把父单子单**混在一起按 id 排序**逐个锁。
       * 而系统里其它所有路径都是「子单（按 id 排）→ 父单（按单号排）」
       * （containers/routes.ts ~429/490、admin-ops 建派送单、
       *   syncParentStatusFromChildren 内部那把）。
       * 一旦某个父单的 id 恰好排在它子单前面，这条路就先拿父单、别处先拿子单，
       * **方向相反**。复核在本地库开两个连接实测，PostgreSQL 报 `deadlock detected`。
       *
       * 「按 id 全排一遍」看着很整齐，但整齐 ≠ 跟别人一致 —— 锁序只有
       * **全系统同一个顺序**才有意义，自己一套排法等于没排。
       */
      const childIds = orderShipments.filter((r) => r.parentTrackingNo).map((r) => r.id);
      const parentIds = orderShipments.filter((r) => !r.parentTrackingNo).map((r) => r.id);
      for (const sid of [...childIds].sort()) {
        await tx.$queryRaw`SELECT id FROM shipments WHERE id = ${sid} FOR UPDATE`;
      }
      for (const sid of [...parentIds].sort()) {
        await tx.$queryRaw`SELECT id FROM shipments WHERE id = ${sid} FOR UPDATE`;
      }
      for (const s of orderShipments) {
        await tx.adminCustomsCase.updateMany({ where: { shipmentId: s.id }, data: { shipmentId: null } });
        await tx.adminLastmileOrder.deleteMany({ where: { shipmentId: s.id } });
        await tx.warehouseLocation.updateMany({ where: { shipmentId: s.id }, data: { shipmentId: null } });
        await tx.staffInboundPhoto.deleteMany({ where: { shipmentId: s.id } });
        await tx.statusLog.deleteMany({ where: { shipmentId: s.id } });
        await tx.shipmentContainerItem.deleteMany({ where: { shipmentId: s.id } });
        await tx.delivery.deleteMany({ where: { shipmentId: s.id } });
        await tx.shipment.delete({ where: { id: s.id } });
      }
      // Order 级别的 FK 清理
      await tx.adminCustomsCase.updateMany({ where: { orderId }, data: { orderId: null } });
      await tx.invoiceLine.updateMany({ where: { orderId }, data: { orderId: null } });
      await tx.adminSettlementEntry.deleteMany({ where: { orderId } });
      await tx.orderProductImage.deleteMany({ where: { orderId } });
      await tx.orderProduct.deleteMany({ where: { orderId } });
      await tx.order.delete({ where: { id: orderId } });
    });
    ok(res, { deleted: true, orderId });
  });

  /**
   * 客户端编辑预报单（确认收货前可编辑）。
   */
  // 客户改自己的预报单。
  //
  // 2026-08-04 安全测试后加固。三层防护，缺一不可：
  //
  //   ① 归属校验     —— 只能改自己的单（where 里带 clientId，原来就有，别删）
  //   ② 状态机锁定   —— 进入计费/物流流程后，锁死计费与报关依据
  //   ③ 输入校验     —— 数值必须合法、枚举必须在范围内、字符串限长
  //
  // 为什么不干脆禁止客户改这些字段：这是**预报单**，客户提前申报「寄什么、多重、寄到哪」，
  // 本来就该能自己修正。一刀切锁死等于砍功能。
  //
  // ② 是关键。原来只挡了 approvalStatus === "received"，于是留下两个口子：
  //   · shipped（货已发出）—— 还能改重量、品名、运输方式
  //   · paid（钱已付清）  —— 还能改计费依据
  // 这两种情况下客户改计费字段，就是在动已经成交的账，必须锁。
  app.post("/client/prealerts/update", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const orderId = typeof body.orderId === "string" ? body.orderId.trim() : "";
    if (!orderId) {
      fail(res, 400, "BAD_REQUEST", "orderId is required");
      return;
    }

    // ① 归属校验：clientId 必须是自己，否则查不到（不要改成先查后比，避免信息泄露）
    const order = await prisma.order.findFirst({
      where: { id: orderId, companyId: auth.companyId, clientId: auth.userId },
    });
    if (!order) {
      fail(res, 404, "NOT_FOUND", "order not found");
      return;
    }
    if (order.approvalStatus === "received") {
      fail(res, 400, "VALIDATION_ERROR", "已确认收货，无法编辑");
      return;
    }

    // ② 输入校验
    //    原来这里一个校验都没有：传 -999、1e20、或把 transportMode 传成任意字符串都能直接写库。
    //    transportMode 被写成乱码最要命 —— 计费时按它查单价规则，查不到就算不出金额。
    //
    //    ⚠️ null / "" 一律当「本次不改这个字段」，不能当非法值拒。
    //    因为接口返回时 decToNumber() 把空值转成 null（见本文件 decToNumber），
    //    前端拿到 null 存进表单、保存时原样回传。线上确实有重量/体积为空的运单，
    //    要是把 null 判成非法，这些客户的预报单会直接保存不了。
    //
    //    类型也要卡死：Number(true) === 1、Number(["5"]) === 5，
    //    不限定类型的话布尔和单元素数组会被悄悄转成数字写进库。
    const num = (raw: unknown, field: string, max: number): number | null | undefined => {
      if (raw === undefined || raw === null) return undefined;
      if (typeof raw === "string" && raw.trim() === "") return undefined;
      if (typeof raw !== "number" && typeof raw !== "string") {
        fail(res, 400, "BAD_REQUEST", `${field} 必须是数字`);
        return null;
      }
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0 || n > max) {
        fail(res, 400, "BAD_REQUEST", `${field} 数值不合法`);
        return null;
      }
      return n;
    };
    const str = (raw: unknown, field: string, max: number): string | null | undefined => {
      if (raw === undefined || raw === null) return undefined;
      if (typeof raw !== "string") { fail(res, 400, "BAD_REQUEST", `${field} 必须是文本`); return null; }
      const s = raw.trim();
      if (s.length > max) { fail(res, 400, "BAD_REQUEST", `${field} 超过 ${max} 字`); return null; }
      return s;
    };

    const weightKg = num(body.weightKg, "重量", 100_000);
    if (weightKg === null) return;
    const volumeM3 = num(body.volumeM3, "体积", 10_000);
    if (volumeM3 === null) return;
    const packageCount = num(body.packageCount, "箱数", 100_000);
    if (packageCount === null) return;

    const itemName = str(body.itemName, "品名", 200);
    if (itemName === null) return;
    const shipDate = str(body.shipDate, "发货日期", 32);
    if (shipDate === null) return;
    const domesticTrackingNo = str(body.domesticTrackingNo, "国内单号", 128);
    if (domesticTrackingNo === null) return;
    const receiverNameTh = str(body.receiverNameTh, "收件人", 128);
    if (receiverNameTh === null) return;
    const receiverPhoneTh = str(body.receiverPhoneTh, "收件电话", 64);
    if (receiverPhoneTh === null) return;
    const receiverAddressTh = str(body.receiverAddressTh, "收货地址", 500);
    if (receiverAddressTh === null) return;

    // 枚举同理：null / "" 当作不改，别把「本来就是空的」判成非法
    const enumOk = (raw: unknown, allowed: readonly string[], field: string): boolean => {
      if (raw === undefined || raw === null || raw === "") return true;
      if (typeof raw !== "string" || !allowed.includes(raw)) {
        fail(res, 400, "BAD_REQUEST", `${field}只能是 ${allowed.join(" 或 ")}`);
        return false;
      }
      return true;
    };
    if (!enumOk(body.packageUnit, ["bag", "box"], "包装单位")) return;
    if (!enumOk(body.transportMode, ["sea", "land"], "运输方式")) return;
    // 归一化：null/""/undefined 统一成 undefined，这样下面的 ?? 才会回落到原值。
    // 少了这一步，前端传空串会把空串直接写进库（?? 只挡 null 和 undefined）。
    const enumVal = <T,>(raw: unknown): T | undefined =>
      raw === undefined || raw === null || raw === "" ? undefined : (raw as T);

    const now = new Date();
    const data = {
      itemName: itemName ?? order.itemName,
      packageCount: packageCount ?? order.packageCount,
      packageUnit: enumVal<"bag" | "box">(body.packageUnit) ?? order.packageUnit,
      weightKg: weightKg !== undefined ? (weightKg as unknown as Prisma.Decimal) : order.weightKg,
      volumeM3: volumeM3 !== undefined ? (volumeM3 as unknown as Prisma.Decimal) : order.volumeM3,
      shipDate: shipDate ?? order.shipDate,
      domesticTrackingNo: domesticTrackingNo ?? order.domesticTrackingNo,
      transportMode: enumVal<"sea" | "land">(body.transportMode) ?? order.transportMode,
      receiverNameTh: receiverNameTh ?? order.receiverNameTh,
      receiverPhoneTh: receiverPhoneTh ?? order.receiverPhoneTh,
      receiverAddressTh: receiverAddressTh ?? order.receiverAddressTh,
      updatedAt: now,
    };

    // 值是否等价。Decimal / number / string 混着来，先按字符串比，
    // 再按数值比一次，避免 17.06 与 "17.060" 这种同值不同形被当成改动。
    const sameValue = (a: unknown, b: unknown): boolean => {
      const sa = a === null || a === undefined ? "" : String(a).trim();
      const sb = b === null || b === undefined ? "" : String(b).trim();
      if (sa === sb) return true;
      const na = Number(sa);
      const nb = Number(sb);
      return sa !== "" && sb !== "" && Number.isFinite(na) && Number.isFinite(nb) && na === nb;
    };

    // ③ 状态机锁定
    //    计费/报关依据：一旦发货或付款，客户不能再改 —— 改了就是改已成交的账。
    //    收货人姓名/电话/地址不锁：货在路上改收件信息是正常需求。
    //
    //    ⚠️ 两个坑，都踩过：
    //    1) 锁的是「改动」不是「传参」。前端保存时把整个表单原样回传
    //       （见 client/page.tsx 的 updateClientPrealert），见字段就拒的话，
    //       客户只想改个地址也会被拦下。
    //    2) 必须拿**归一化之后**的最终值来比，不能比原始 body。
    //       body 里的 null / "" 在上面已经被判定为「本次不改」，
    //       拿原始值比会把「没改」误判成「改了」，同样拦错人。
    //    所以这段放在 data 组装完之后，比的是「真正要写进去的值」vs「库里的值」。
    const billingLocked =
      order.approvalStatus === "shipped" || order.paymentStatus === "paid";
    if (billingLocked) {
      const LOCKED_WHEN_BILLED = [
        "itemName", "packageCount", "packageUnit", "weightKg",
        "volumeM3", "transportMode", "shipDate", "domesticTrackingNo",
      ] as const;
      const changedLocked = LOCKED_WHEN_BILLED.filter(
        (f) => !sameValue(data[f], (order as unknown as Record<string, unknown>)[f]),
      );
      if (changedLocked.length > 0) {
        const why = order.paymentStatus === "paid" ? "该订单已付款" : "该订单已发货";
        fail(res, 400, "VALIDATION_ERROR",
          `${why}，不能再修改计费与报关信息（${changedLocked.join("、")}）。需要更正请联系客服。`);
        return;
      }
    }

    await prisma.order.update({ where: { id: orderId }, data });

    // 留痕：只记真正变了的字段，改前改后都留。
    // audit_logs 表建好很久了但一直零写入，从这个接口开始用起来。
    // 写日志失败不能影响用户改单 —— 所以整段包 try。
    try {
      const changed: Record<string, { before: unknown; after: unknown }> = {};
      for (const [k, after] of Object.entries(data)) {
        if (k === "updatedAt") continue;
        const before = (order as unknown as Record<string, unknown>)[k];
        if (!sameValue(before, after)) changed[k] = { before, after };
      }
      if (Object.keys(changed).length > 0) {
        await prisma.auditLog.create({
          data: {
            companyId: auth.companyId,
            actorId: auth.userId,
            actorRole: "client",
            action: "UPDATE",
            resourceType: "Order",
            resourceId: orderId,
            beforeJson: JSON.stringify(Object.fromEntries(Object.entries(changed).map(([k, v]) => [k, v.before]))),
            afterJson: JSON.stringify(Object.fromEntries(Object.entries(changed).map(([k, v]) => [k, v.after]))),
            remark: "客户修改预报单",
            // 2026-08-05：原来也是取 X-Forwarded-For 第一段（客户自己填的），
            // 留痕里的「从哪个 IP 改的单」等于对方随便编。改用统一的取法。
            ip: getClientIp(req.headers ?? {}) || null,
            userAgent: (req.headers?.["user-agent"] as string) ?? null,
          },
        });
      }
    } catch {
      // 审计写不进去不影响业务，静默跳过
    }

    ok(res, { updated: true, orderId });
  });

  app.post("/staff/orders", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      clientId?: string;
      batchNo?: string;
      trackingNo?: string;
      arrivedAt?: string;
      itemName?: string;
      productQuantity?: number;
      packageCount?: number;
      packageUnit?: "bag" | "box";
      weightKg?: number;
      volumeM3?: number;
      domesticTrackingNo?: string;
      cargoType?: string;
      transportMode?: "sea" | "land";
      receiverNameTh?: string;
      receiverPhoneTh?: string;
      receiverAddressTh?: string;
      warehouseId?: string;
      remark?: string;
      products?: Array<{
        itemName: string;
        packageCount: number;
        lengthCm?: number;
        widthCm?: number;
        heightCm?: number;
        productQuantity?: number;
        weightKg?: number;
        cargoType?: string;
        domesticTrackingNo?: string;
      }>;
    };

    /**
     * 产品行的校验统一交给 product-row-guard（2026-08-29 抽出去了，方便单测）。
     * 规矩：箱数正整数、「每箱几个」全填或全空且填了就得是正整数 ——
     * 跟批量导入（batchOrderImport）和前端 productRowGuard 同一份口径。
     *
     * ⚠️ 前端三端原来都是 `Number(p.packageCount) || 1` 才发出来的，
     * 所以这道闸以前根本挡不到「员工把箱数清空」那种情况 —— 2026-08-29 已经
     * 把那三处的兜底一起去掉了，别再加回来。
     */
    if (body.products?.length) {
      const rowIssue = validateProductRows(body.products);
      if (rowIssue) {
        fail(res, 400, "VALIDATION_ERROR", rowIssue);
        return;
      }
    }
    const orderQtyIssue = validateOrderLevelQuantity(body.productQuantity);
    if (orderQtyIssue) {
      fail(res, 400, "VALIDATION_ERROR", orderQtyIssue);
      return;
    }

    const staffProducts = body.products?.length
      ? body.products.map((p, i) => ({
          itemName: p.itemName.trim(),
          packageCount: p.packageCount,
          lengthCm: p.lengthCm ?? null,
          widthCm: p.widthCm ?? null,
          heightCm: p.heightCm ?? null,
          productQuantity: p.productQuantity ?? null, cargoType: p.cargoType?.trim() || "normal", domesticTrackingNo: p.domesticTrackingNo?.trim() || "货拉拉", weightKg: p.weightKg ?? null, sortOrder: i }))
      : body.itemName ? [{
          itemName: body.itemName.trim(),
          packageCount: Number(body.packageCount ?? 0),
          lengthCm: null,
          widthCm: null,
          heightCm: null,
          productQuantity: null,
          cargoType: body.cargoType?.trim() || "normal",
          domesticTrackingNo: body.domesticTrackingNo?.trim() || "货拉拉",
          weightKg: null,
          sortOrder: 0,
        }] : [];

    const prName = staffProducts[0]?.itemName ?? body.itemName ?? "";
    const prPkg = staffProducts.reduce((s, p) => s + p.packageCount, 0) || Number(body.packageCount ?? 0);
    const prWeight = staffProducts.reduce((s, p) => s + (p.weightKg ?? 0) * p.packageCount, 0);
    const prVol = staffProducts.reduce((s, p) => {
      if (p.lengthCm && p.widthCm && p.heightCm) return s + (p.lengthCm * p.widthCm * p.heightCm * p.packageCount) / 1_000_000;
      return s;
    }, 0);

    if (
      !body.clientId ||
      (!prName && !body.itemName) ||
      !body.transportMode ||
      !body.warehouseId ||
      !body.arrivedAt?.trim()
    ) {
      fail(res, 400, "BAD_REQUEST", "missing required fields");
      return;
    }

    // Verify clientId belongs to the same company and is a client role
    const targetClient = await prisma.user.findUnique({
      where: { id: body.clientId },
      select: { id: true, companyId: true, role: true },
    });
    if (!targetClient || targetClient.companyId !== auth.companyId || targetClient.role !== "client") {
      fail(res, 400, "BAD_REQUEST", "invalid clientId");
      return;
    }

    const arrivedAtDate = new Date(`${body.arrivedAt}T00:00:00`);
    if (Number.isNaN(arrivedAtDate.getTime())) {
      fail(res, 400, "BAD_REQUEST", "invalid arrivedAt");
      return;
    }

    const now = arrivedAtDate.toISOString();
    const orderId = `o_${Date.now()}`;
    const shipmentId = `s_${Date.now()}`;
    const manualTrackingNo = body.trackingNo?.trim();
    if (manualTrackingNo) {
      const clash = await prisma.shipment.findFirst({
        where: { trackingNo: manualTrackingNo, companyId: auth.companyId },
        select: { id: true },
      });
      if (clash) {
        fail(res, 409, "VALIDATION_ERROR", `运单号 ${manualTrackingNo} 已存在`);
        return;
      }
    }
    if (!manualTrackingNo) {
      fail(res, 400, "BAD_REQUEST", "运单号为必填");
      return;
    }
    const generatedTrackingNo = manualTrackingNo;
    const weightKg = body.weightKg === undefined || body.weightKg === null ? null : Number(body.weightKg);
    const volumeM3 = body.volumeM3 === undefined || body.volumeM3 === null ? null : Number(body.volumeM3);
    const batchNo = body.batchNo?.trim() || null;
    // 件数：产品行是明细事实源，整票件数按明细汇总，避免调用方传的合计对不上。
    const packageCountNum = staffProducts.length > 0 ? prPkg : Number(body.packageCount ?? 0);

    /**
     * ⚠️ 产品数量**不能**照着件数那样按产品行求和（2026-08-28 修）。
     *
     * 同一个字段名 productQuantity 在两个层级上是两个意思：
     *   · 订单级（前端 staff/page.tsx:1413，提示语「产品数量 *」）= 员工填的**总数**
     *   · 产品行级（同文件 1375 / 2472 行，提示语「**单箱数量**」）= 每箱多少个
     * 之前改成 `sum(产品行.productQuantity)`，等于把「单箱数量」当成总数直接相加，
     * 少乘了箱数 —— 2 个产品各 3 箱、每箱 10 个，真实总数 60，会被写成 20；
     * 而且产品行这个字段允许留空，全空时直接写成 0，把员工填的总数覆盖掉。
     *
     * ⚠️ 2026-08-28 更正：原来这里写着「批量导入那条路不受影响，解析器本来就会把
     * 订单级的合计算好一起传上来」—— **那句话是错的**。
     * `batchOrderImport.ts` 的汇总当时也漏乘了箱数（老板实测：填 2/3/4 箱、每箱 2/3/4 个，
     * 正确 29，系统报 9）。那边已经补上 `× packageCount`。
     * 教训：修一处口径时，别只在注释里断言「别的路没事」，要真去看一眼那条路的代码。
     */
    /**
     * ⚠️ 2026-08-28 再补：**前端没传时不能存成 0**。
     * 复核实测这条路「信任前端合计，前端没传就写 0」——
     * 客户订单上的产品数量凭空变成 0，而产品行里明明填着数。
     * 前端传了就用它（那是员工在订单级填的总数，说了算）；
     * 没传、而产品行有数量时，按 Σ(箱数 × 单箱数量) 兜底，跟批量导入同一个算法。
     */
    const productQuantityFromRows = staffProducts.reduce(
      (s, p) => s + (p.productQuantity ?? 0) * p.packageCount,
      0,
    );
    /**
     * ⚠️ 有产品行时**以产品行为准**（2026-08-28 改），跟上面件数
     * `staffProducts.length > 0 ? prPkg : body.packageCount` 同一个规矩。
     * 原来是「前端传了就无条件用前端的」—— 前端算错、或者版本不一致时，
     * 订单上的总数会跟明细对不上，而明细才是事实源。
     * 没有产品行时才用前端传的那个订单级总数（那种单子本来就没有明细）。
     */
    const productQuantityNum =
      staffProducts.length > 0 && productQuantityFromRows > 0
        ? productQuantityFromRows
        : Number(body.productQuantity ?? 0);
    const packageUnit = body.packageUnit ?? "box";

    // 事务前计算应收金额（按产品行分别计价求和）

    const txOps: any[] = [
      prisma.order.create({
        data: {
          id: orderId,
          companyId: auth.companyId,
          clientId: body.clientId,
          warehouseId: body.warehouseId,
          batchNo,
          orderNo: null,
          approvalStatus: "approved",
          itemName: body.itemName?.trim() || prName,
          productQuantity: productQuantityNum,
          packageCount: packageCountNum,
          packageUnit,
          weightKg: prWeight > 0 ? (prWeight as unknown as Prisma.Decimal) : (weightKg as unknown as Prisma.Decimal | null),
          volumeM3: prVol > 0 ? (prVol as unknown as Prisma.Decimal) : (volumeM3 as unknown as Prisma.Decimal | null),
          receivableCurrency: "CNY",
          shipDate: body.arrivedAt.trim(),
          domesticTrackingNo: body.domesticTrackingNo ?? null,
          transportMode: body.transportMode,
          cargoType: body.cargoType?.trim() || "normal",
          receiverNameTh: "",
          receiverPhoneTh: "",
          receiverAddressTh: "",
          statusGroup: "unfinished",
        },
      }),
      prisma.shipment.create({
        data: {
          id: shipmentId,
          companyId: auth.companyId,
          orderId,
          trackingNo: generatedTrackingNo,
          batchNo,
          currentStatus: "created",
          currentLocation: null,
          weightKg: prWeight > 0 ? (prWeight as unknown as Prisma.Decimal) : (weightKg as unknown as Prisma.Decimal | null),
          volumeM3: prVol > 0 ? (prVol as unknown as Prisma.Decimal) : (volumeM3 as unknown as Prisma.Decimal | null),
          packageCount: packageCountNum,
          packageUnit,
          transportMode: body.transportMode,
          domesticTrackingNo: body.domesticTrackingNo ?? null,
          warehouseId: body.warehouseId,
          remark: body.remark?.trim() || null,
        },
      }),
      // 2026-08-06：轨迹起点。员工直接建单的这条路原来也不写轨迹，
      // 和客户预报那条路一样，客户查件最早只能看到「已装柜」。
      prisma.statusLog.create({
        data: {
          id: `sl_new_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          companyId: auth.companyId,
          shipmentId,
          operatorId: auth.userId,
          operatorRole: auth.role,
          operatorName: auth.name ?? "",
          fromStatus: "created",
          toStatus: "created",
          remark: "运单已建立",
          nextStop: "国内仓",
          changedAt: new Date(),
        },
      }),
    ];
    // 保存产品行
    if (staffProducts.length > 0) {
      txOps.push(
        prisma.orderProduct.createMany({
          data: staffProducts.map((p) => ({
            companyId: auth.companyId,
            orderId,
            itemName: p.itemName,
            packageCount: p.packageCount,
            lengthCm: p.lengthCm,
            widthCm: p.widthCm,
            heightCm: p.heightCm,
            productQuantity: p.productQuantity,
            cargoType: p.cargoType,
            domesticTrackingNo: p.domesticTrackingNo,
            weightKg: p.weightKg,
            sortOrder: p.sortOrder,
          })),
        }),
      );
    }
    await prisma.$transaction(txOps);

    ok(res, { orderId, createdAt: now });
  });



  app.get("/client/orders", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;

    const page = parseInt(req.query.page as string) || 1;
    const pageSize = Math.min(parseInt(req.query.pageSize as string) || 50, 500);
    const statusGroup = req.query.statusGroup?.trim();
    const itemName = req.query.itemName?.trim();
    const transportMode = req.query.transportMode?.trim();
    const trackingNo = req.query.trackingNo?.trim();
    const orderNo = req.query.orderNo?.trim();
    const domesticTrackingNo = req.query.domesticTrackingNo?.trim();

    const where: Prisma.OrderWhereInput = {
      companyId: auth.companyId,
      approvalStatus: { in: ["approved", "shipped"] },
      clientId: auth.userId,
      // 运单号搜索下推到数据库：父单、子单任一命中都算，且 count 与列表口径一致
      ...(trackingNo ? { shipments: { some: { trackingNo } } } : {}),
    };
    const [total, orders] = await Promise.all([
      prisma.order.count({ where }),
      prisma.order.findMany({
        where,
        orderBy: { createdAt: "asc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          shipments: {
            // 客户端只展示父运单：parentTrackingNo 为 null 的排在最前，
            // 万一某订单只剩子单（父单被删）才退回最近更新的那条，不至于整行没单号
            orderBy: [{ parentTrackingNo: { sort: "asc", nulls: "first" } }, { updatedAt: "desc" }],
            take: 1,
            select: {
              id: true,
              trackingNo: true,
              currentStatus: true,
              remark: true,
              statusLogs: {
                where: { NOT: [{ remark: null }, { remark: "" }] },
                orderBy: { changedAt: "asc" },
                select: {
                  remark: true,
                  changedAt: true,
                  fromStatus: true,
                  toStatus: true,
                  operatorRole: true,
                  operatorName: true,
                },
              },
            },
          },
        },
      }),
    ]);

    const totalMetricsByOrderId = await loadOrderTotalMetrics(
      auth.companyId,
      orders.map((order) => ({
        orderId: order.id,
        orderVolumeM3: order.volumeM3,
        orderWeightKg: order.weightKg,
      })),
    );

    const filtered = orders
      .filter((o) => !itemName || o.itemName.includes(itemName))
      .filter((o) => !transportMode || o.transportMode === transportMode)
      .filter((o) => !orderNo || o.orderNo === orderNo)
      .filter((o) => !domesticTrackingNo || o.domesticTrackingNo === domesticTrackingNo)
      .filter((o) => {
        // shipments 已用 take:1 限制为 1 条（父单优先），直接取其状态
        const cur = o.shipments[0]?.currentStatus ?? null;
        const completed = cur ? COMPLETED.has(cur) : false;
        if (statusGroup === "completed") return completed;
        if (statusGroup === "unfinished") return !completed;
        return true;
      });

    const items = filtered.map((o) => {
      // orderBy 已保证父单排在最前 + take:1，这里直接取即可
      const ship = o.shipments[0];
      const totalMetrics = totalMetricsByOrderId.get(o.id);
      const logisticsRecords = (ship?.statusLogs ?? []).map((r) => ({
        remark: sanitizeRemarkForClient(r.remark ?? "", true),
        changedAt: r.changedAt.toISOString(),
        fromStatus: r.fromStatus,
        toStatus: r.toStatus,
        operatorRole: r.operatorRole,
        operatorName: r.operatorName ?? "",
      }));
      const latestRemark = logisticsRecords.at(-1)?.remark ?? null;
      return {
        id: o.id,
        clientId: o.clientId,
        warehouseId: o.warehouseId,
        receiverAddressTh: o.receiverAddressTh,
        orderNo: o.orderNo,
        itemName: o.itemName,
        transportMode: o.transportMode,
        domesticTrackingNo: o.domesticTrackingNo,
        // 2026-08-07 移除 batchNo：这个字段存的就是柜号（员工在「预报单审核」里填的
        // 那个「柜号（可选，装柜时填写）」输入框），用户明确要求客户不能看到柜号。
        // 原来这里照发，客户端运单详情直接显示成「批次号：CAB-2026-A01」—— 实测泄漏。
        // 物流轨迹那条路早就把柜号从日志正文里抹掉了（containers/routes.ts 的 sanitizeRemark），
        // 但这条一直没堵，等于前门锁了后门开着。
        // ⚠️ /staff/prealerts 那处的 batchNo 要保留 —— 员工本来就该看到柜号。
        approvalStatus: o.approvalStatus,
        trackingNo: ship?.trackingNo ?? null,
        currentStatus: ship?.currentStatus ?? null,
        productQuantity: o.productQuantity,
        packageCount: o.packageCount,
        packageUnit: o.packageUnit,
        weightKg: decToNumber(o.weightKg),
        volumeM3: decToNumber(o.volumeM3),
        totalWeightKg: totalMetrics?.totalWeightKg,
        totalVolumeM3: totalMetrics?.totalVolumeM3,
        receivableAmountCny: decToNumber(o.receivableAmountCny),
        receivableCurrency: o.receivableCurrency ?? "CNY",
        paymentStatus: o.paymentStatus ?? "unpaid",
        paidAt: o.paidAt ? o.paidAt.toISOString() : undefined,
        paidBy: o.paidBy ?? undefined,
        shipDate: o.shipDate,
        cargoType: o.cargoType ?? "normal",
        latestRemark,
        remark: ship?.remark == null ? null : sanitizeRemarkForClient(ship.remark, true),
        logisticsRecords,
        createdAt: o.createdAt.toISOString(),
        updatedAt: o.updatedAt.toISOString(),
      };
    });

    const orderIds = items.map((item) => item.id);
    const imageMap = await loadProductImagesForOrders(auth.companyId, orderIds);
    const productsMap = await loadOrderProducts(auth.companyId, orderIds);
    const itemsWithImages = items.map((item) => ({
      ...item,
      productImages: imageMap.get(item.id) ?? [],
      products: productsMap.get(item.id) ?? [],
    }));

    ok(res, { items: itemsWithImages, page, pageSize, total });
  });

  // ===== 客户端付款 =====

  app.get("/client/prealerts", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;
    const statusFilter = req.query.status?.trim();
    const approvalFilter = statusFilter === "all"
      ? undefined
      : statusFilter === "approved" || statusFilter === "shipped"
        ? statusFilter
        : "pending";
    const orders = await prisma.order.findMany({
      where: {
        companyId: auth.companyId,
        approvalStatus: approvalFilter,
        clientId: auth.userId,
      },
      orderBy: { createdAt: "desc" },
      include: {
        client: { select: { name: true } },
        shipments: { orderBy: { createdAt: "desc" }, take: 1, select: { trackingNo: true, currentStatus: true } },
      },
    });
    const items = orders.map((o) => ({
      id: o.id,
      warehouseId: o.warehouseId,
      orderNo: o.orderNo,
      clientId: o.clientId,
      clientName: o.client?.name ?? null,
      trackingNo: o.shipments[0]?.trackingNo ?? undefined,
      currentStatus: o.shipments[0]?.currentStatus ?? undefined,
      itemName: o.itemName,
      transportMode: o.transportMode,
      domesticTrackingNo: o.domesticTrackingNo,
      batchNo: undefined, // 客户端隐藏柜号
      approvalStatus: o.approvalStatus,
      productQuantity: o.productQuantity,
      packageCount: o.packageCount,
      packageUnit: o.packageUnit,
      weightKg: decToNumber(o.weightKg),
      volumeM3: decToNumber(o.volumeM3),
      receivableAmountCny: decToNumber(o.receivableAmountCny),
      receivableCurrency: o.receivableCurrency ?? "CNY",
      paymentStatus: o.paymentStatus ?? "unpaid",
      paidAt: o.paidAt ? o.paidAt.toISOString() : undefined,
      paidBy: o.paidBy ?? undefined,
      shipDate: o.shipDate,
      createdAt: o.createdAt.toISOString(),
      updatedAt: o.updatedAt.toISOString(),
    }));
    const prealertIds = items.map((item) => item.id);
    const prealertImageMap = await loadProductImagesForOrders(auth.companyId, prealertIds);
    const prealertProductsMap = await loadOrderProducts(auth.companyId, prealertIds);
    const prealertItemsWithImages = items.map((item) => ({
      ...item,
      productImages: prealertImageMap.get(item.id) ?? [],
        products: prealertProductsMap.get(item.id) ?? [],
    }));
    ok(res, {
      items: prealertItemsWithImages,
      page: 1,
      pageSize: prealertItemsWithImages.length,
      total: prealertItemsWithImages.length,
    });
  });

  app.get("/staff/prealerts", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const user = await prisma.user.findUnique({
      where: { id: auth.userId },
      select: { warehouseIds: true },
    });
    const editableWarehouses = parseJsonArray(user?.warehouseIds);

    const orders = await prisma.order.findMany({
      where: {
        companyId: auth.companyId,
        approvalStatus: { in: ["shipped", "received"] },
      },
      orderBy: { createdAt: "desc" },
      include: {
        client: { select: { name: true } },
      },
    });

    const items = orders
      .filter((o) => auth.role === "admin" || editableWarehouses.includes(o.warehouseId))
      .map((o) => ({
        id: o.id,
        clientId: o.clientId,
        clientName: o.client?.name ?? null,
        warehouseId: o.warehouseId,
        orderNo: o.orderNo,
        itemName: o.itemName,
        transportMode: o.transportMode,
        domesticTrackingNo: o.domesticTrackingNo,
        batchNo: o.batchNo,
        approvalStatus: o.approvalStatus,
        productQuantity: o.productQuantity,
        packageCount: o.packageCount,
        packageUnit: o.packageUnit,
        weightKg: decToNumber(o.weightKg),
        volumeM3: decToNumber(o.volumeM3),
        receivableAmountCny: decToNumber(o.receivableAmountCny),
        receivableCurrency: o.receivableCurrency ?? "CNY",
        paymentStatus: o.paymentStatus ?? "unpaid",
        paidAt: o.paidAt ? o.paidAt.toISOString() : undefined,
        paidBy: o.paidBy ?? undefined,
        shipDate: o.shipDate,
        createdAt: o.createdAt.toISOString(),
        updatedAt: o.updatedAt.toISOString(),
      }));
    const staffPrealertIds = items.map((item) => item.id);
    const staffPrealertImageMap = await loadProductImagesForOrders(auth.companyId, staffPrealertIds);
    const staffPrealertProductsMap = await loadOrderProducts(auth.companyId, staffPrealertIds);
    const staffPrealertItemsWithImages = items.map((item) => ({
      ...item,
      productImages: staffPrealertImageMap.get(item.id) ?? [],
        products: staffPrealertProductsMap.get(item.id) ?? [],
    }));
    ok(res, {
      items: staffPrealertItemsWithImages,
      page: 1,
      pageSize: staffPrealertItemsWithImages.length,
      total: staffPrealertItemsWithImages.length,
    });
  });

  app.post("/staff/orders/product-images", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin", "client"]);
    if (!auth) return;
    const body = (req.body ?? {}) as {
      orderId?: string;
      fileName?: string;
      mime?: string;
      contentBase64?: string;
    };
    const orderId = body.orderId?.trim();
    const fileName = body.fileName?.trim();
    const mimeType = body.mime?.trim();
    const contentBase64 = body.contentBase64?.trim();
    if (!orderId || !fileName || !mimeType || !contentBase64) {
      fail(res, 400, "BAD_REQUEST", "orderId, fileName, mime and contentBase64 are required");
      return;
    }
    if (!mimeType.startsWith("image/")) {
      fail(res, 400, "BAD_REQUEST", "only image uploads are allowed");
      return;
    }
    if (contentBase64.length > 20_000_000) {
      fail(res, 400, "BAD_REQUEST", "file too large (max 20MB base64)");
      return;
    }
    const order = await prisma.order.findFirst({
      where: { id: orderId, companyId: auth.companyId },
      select: { id: true, warehouseId: true, approvalStatus: true, clientId: true },
    });
    if (!order) {
      fail(res, 404, "NOT_FOUND", "order not found");
      return;
    }
    if (auth.role === "client" && order.clientId !== auth.userId) {
      fail(res, 403, "FORBIDDEN", "client can only manage product images for their own orders");
      return;
    }
    if (!(await staffCanEditOrderWarehouse(auth, order.warehouseId))) {
      fail(res, 403, "FORBIDDEN", "cross warehouse update is not allowed");
      return;
    }
    const count = await prisma.orderProductImage.count({
      where: { companyId: auth.companyId, orderId },
    });
    if (count >= MAX_ORDER_PRODUCT_IMAGES) {
      fail(res, 400, "BAD_REQUEST", `image limit reached (max ${MAX_ORDER_PRODUCT_IMAGES})`);
      return;
    }
    try {
      const buf = Buffer.from(contentBase64, "base64");
      if (buf.length === 0) {
        fail(res, 400, "BAD_REQUEST", "invalid image content");
        return;
      }
    } catch {
      fail(res, 400, "BAD_REQUEST", "invalid image content");
      return;
    }
    const now = new Date();
    const imageId = `opi_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
    // 保存文件到磁盘
    try {
      const filePath = saveImageToDisk(orderId, mimeType, contentBase64);
      await prisma.orderProductImage.create({
        data: {
          id: imageId,
          companyId: auth.companyId,
          orderId,
          fileName,
          mime: mimeType,
          contentBase64,
          filePath,
          uploadedBy: auth.userId,
          createdAt: now,
        },
      });
      ok(res, { id: imageId, orderId, fileName, mime: mimeType, filePath, createdAt: now.toISOString() });
    } catch (err) {
      console.error("[product-image] save failed:", err);
      fail(res, 500, "INTERNAL_ERROR", `保存图片失败：${err instanceof Error ? err.message : "未知错误"}`);
    }
  });

  app.delete("/staff/orders/product-images", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin", "client"]);
    if (!auth) return;
    const id = req.query.id?.trim();
    if (!id) {
      fail(res, 400, "BAD_REQUEST", "id is required");
      return;
    }
    const image = await prisma.orderProductImage.findFirst({
      where: { id, companyId: auth.companyId },
      include: {
        order: { select: { warehouseId: true, approvalStatus: true, clientId: true } },
      },
    });
    if (!image || !image.order) {
      fail(res, 404, "NOT_FOUND", "image not found");
      return;
    }
    if (auth.role === "client" && image.order.clientId !== auth.userId) {
      fail(res, 403, "FORBIDDEN", "client can only manage product images for their own orders");
      return;
    }
    if (!(await staffCanEditOrderWarehouse(auth, image.order.warehouseId))) {
      fail(res, 403, "FORBIDDEN", "cross warehouse update is not allowed");
      return;
    }
    // 先删DB记录，再删磁盘文件（倒序避免悬空引用）
    const result = await prisma.orderProductImage.deleteMany({
      where: { id, companyId: auth.companyId },
    });
    if (result.count > 0 && image.filePath) {
      deleteImageFile(image.filePath);
    }
    ok(res, { deleted: result.count > 0, id });
  });

  /**
   * 员工按运单维度一次性更新关联订单与运单的基础信息（与列表「订单详情」编辑一致）。
   */
  app.post("/staff/orders/patch-shipment-bundle", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      shipmentId?: string;
      trackingNo?: string;
      batchNo?: string | null;
      itemName?: string;
      productQuantity?: number;
      packageCount?: number;
      packageUnit?: "bag" | "box";
      weightKg?: number | null;
      volumeM3?: number | null;
      domesticTrackingNo?: string | null;
      orderCreatedDate?: string;
      transportMode?: "sea" | "land";
      shipDate?: string | null;
      receiverAddressTh?: string;
      containerNo?: string | null;
      receivableAmountCny?: number | null;
      receivableCurrency?: "CNY" | "THB";
      /** 同步更新订单与运单的归属仓库（员工须对新仓库有编辑权限）。 */
      warehouseId?: string;
      remark?: string;
    };

    const shipmentId = body.shipmentId?.trim();
    if (!shipmentId) {
      fail(res, 400, "BAD_REQUEST", "shipmentId is required");
      return;
    }

    // 【审查问题 7】原来在 include.order 里写了 where —— Prisma 不允许对
    // 一对一关联加 where（schema 里 order 是必填的一对一），一调就抛校验错误变 500。
    // 归属公司的限制改到外层 where 上，等价且合法。
    const shipment = await prisma.shipment.findFirst({
      where: {
        id: shipmentId,
        companyId: auth.companyId,
        order: { companyId: auth.companyId },
      },
      include: {
        order: {
          select: {
            id: true,
            warehouseId: true,
            receivableAmountCny: true,
            receivableCurrency: true,
          },
        },
      },
    });
    if (!shipment || !shipment.order) {
      fail(res, 404, "NOT_FOUND", "shipment or order not found");
      return;
    }
    const curOrder = shipment.order;

    if (!(await staffCanEditOrderWarehouse(auth, curOrder.warehouseId))) {
      fail(res, 403, "FORBIDDEN", "cross warehouse update is not allowed");
      return;
    }

    let nextWarehouseId = curOrder.warehouseId;
    if (body.warehouseId !== undefined && body.warehouseId !== null && String(body.warehouseId).trim() !== "") {
      const nw = String(body.warehouseId).trim();
      if (!(await staffCanEditOrderWarehouse(auth, nw))) {
        fail(res, 403, "FORBIDDEN", "cross warehouse update is not allowed");
        return;
      }
      nextWarehouseId = nw;
    }

    const trackingNo = typeof body.trackingNo === "string" ? body.trackingNo.trim() : "";
    if (!trackingNo) {
      fail(res, 400, "BAD_REQUEST", "trackingNo is required");
      return;
    }
    const clash = await prisma.shipment.findFirst({
      where: {
        companyId: auth.companyId,
        trackingNo,
        NOT: { id: shipmentId },
      },
      select: { id: true },
    });
    if (clash) {
      fail(res, 400, "BAD_REQUEST", "trackingNo already exists");
      return;
    }

    const itemName = body.itemName?.trim();
    if (!itemName) {
      fail(res, 400, "BAD_REQUEST", "itemName is required");
      return;
    }

    const productQuantity = Number(body.productQuantity);
    const packageCount = Number(body.packageCount);
    if (!Number.isFinite(productQuantity) || productQuantity < 0) {
      fail(res, 400, "BAD_REQUEST", "invalid productQuantity");
      return;
    }
    if (!Number.isFinite(packageCount) || packageCount < 0) {
      fail(res, 400, "BAD_REQUEST", "invalid packageCount");
      return;
    }

    const packageUnit = body.packageUnit === "bag" ? "bag" : "box";
    const weightKg = body.weightKg === undefined || body.weightKg === null ? null : Number(body.weightKg);
    const volumeM3 = body.volumeM3 === undefined || body.volumeM3 === null ? null : Number(body.volumeM3);
    if (weightKg !== null && !Number.isFinite(weightKg)) {
      fail(res, 400, "BAD_REQUEST", "invalid weightKg");
      return;
    }
    if (volumeM3 !== null && !Number.isFinite(volumeM3)) {
      fail(res, 400, "BAD_REQUEST", "invalid volumeM3");
      return;
    }

    const orderCreatedDate = body.orderCreatedDate?.trim();
    if (!orderCreatedDate) {
      fail(res, 400, "BAD_REQUEST", "orderCreatedDate is required");
      return;
    }
    const arrived = new Date(`${orderCreatedDate}T00:00:00`);
    if (Number.isNaN(arrived.getTime())) {
      fail(res, 400, "BAD_REQUEST", "invalid orderCreatedDate");
      return;
    }

    const transportMode = body.transportMode === "land" ? "land" : "sea";

    let shipDate: string | null = null;
    if (body.shipDate !== undefined && body.shipDate !== null && String(body.shipDate).trim() !== "") {
      const raw = String(body.shipDate).trim().slice(0, 10);
      const sd = new Date(`${raw}T00:00:00`);
      if (Number.isNaN(sd.getTime())) {
        fail(res, 400, "BAD_REQUEST", "invalid shipDate");
        return;
      }
      shipDate = raw;
    }

    /* 2026-08-07：运单不再涉及金额，这个接口也不再接受/写入应收金额和币种。 */

    const batchNo = body.batchNo?.trim() || null;
    const domesticTrackingNo = body.domesticTrackingNo?.trim() || null;
    const receiverAddressTh = body.receiverAddressTh?.trim() ?? "";
    const containerNo = body.containerNo?.trim() || null;

    const now = new Date();

    /* 员工在编辑框里改的是「还剩多少没装柜」（框里预填的就是这个数）。
       订单上那个「整单箱数」是另一回事 = 还剩没装 + 已经装走。
       不换算直接写的话，改一张拆过柜的单就会把整单箱数冲成剩余数
       （YW0001342 那种：整单 101 会被写成 71，真值就找不回来了）。
       没拆过柜的单已装走为 0，两个数相等，行为跟原来完全一样。 */
    const loadedForOrder = await prisma.shipment.aggregate({
      where: { parentTrackingNo: shipment.trackingNo, companyId: auth.companyId },
      _sum: { packageCount: true },
    });
    const alreadyLoadedPkg = loadedForOrder._sum.packageCount ?? 0;

    await prisma.$transaction([
      prisma.order.update({
        where: { id: curOrder.id },
        data: {
          warehouseId: nextWarehouseId,
          batchNo,
          itemName,
          productQuantity: Math.floor(productQuantity),
          packageCount: Math.floor(packageCount) + alreadyLoadedPkg,
          packageUnit,
          weightKg: weightKg as unknown as Prisma.Decimal | null,
          volumeM3: (volumeM3 as unknown as Prisma.Decimal | null),
          domesticTrackingNo,
          transportMode,
          shipDate,
          receiverAddressTh,
          createdAt: arrived,
        },
      }),
      prisma.shipment.update({
        where: { id: shipmentId },
        data: {
          warehouseId: nextWarehouseId,
          trackingNo,
          batchNo,
          domesticTrackingNo,
          /* 这里存的是「还剩多少没装柜」，员工在编辑框里看到、改的就是这个数
             （编辑框的初值来自 buildShipmentOrderEditDraft → item.packageCount，
             就是运单自己的件数，也就是剩余），所以**原样存，不要再算**。

             2026-08-10 修：原来写的是「有子运单就强制为 0，防止重复计算」——
             重复计算是挡住了，但把**还在仓库没装柜的那部分一起抹掉了**。
             生产实测 YW0001342：整单 101 箱、装走 30 箱，员工编辑保存过一次之后
             变成 0，装柜管理显示「共30件（剩0件）」，仓库剩的 71 箱勾都勾不上。

             ⚠️ 别学管理员端那条路去减「已装走的」——
             管理员端编辑框传上来的是**产品行合计（整单箱数）**，那边才需要减；
             这边传上来的已经是剩余了，再减一次会越保存越少（71 → 41 → 11）。
             两个端传的含义不一样，这是我第一版改错过的地方。 */
          packageCount: Math.floor(packageCount),
          packageUnit,
          weightKg: weightKg as unknown as Prisma.Decimal | null,
          volumeM3: (volumeM3 as unknown as Prisma.Decimal | null),
          transportMode,
          containerNo,
          remark: body.remark !== undefined ? body.remark?.trim() || null : undefined,
        },
      }),
    ]);

    ok(res, {
      shipmentId,
      orderId: curOrder.id,
      updatedAt: now.toISOString(),
    });
  });

  // approve endpoint removed — replaced by POST /staff/prealerts/receive

  // 尾端派送：获取所有客户及其地址
  app.get("/staff/lastmile/addresses", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const keyword = req.query.keyword?.trim().toLowerCase() || "";

    const users = await prisma.user.findMany({
      where: {
        companyId: auth.companyId,
        role: "client",
        ...(keyword ? {
          OR: [
            { id: { contains: keyword, mode: "insensitive" } },
            { name: { contains: keyword, mode: "insensitive" } },
          ],
        } : {}),
      },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        phone: true,
        addresses: {
          select: {
            id: true,
            contactName: true,
            contactPhone: true,
            addressDetail: true,
            isDefault: true,
          },
          orderBy: { isDefault: "desc" },
        },
      },
    });

    ok(res, { items: users });
  });

  // 尾端派送：删除地址
  app.delete("/staff/lastmile/addresses", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const id = req.query.id?.trim();
    if (!id) { fail(res, 400, "BAD_REQUEST", "id is required"); return; }
    const addr = await prisma.clientAddress.findFirst({ where: { id, companyId: auth.companyId } });
    if (!addr) { fail(res, 404, "NOT_FOUND", "address not found"); return; }
    await prisma.clientAddress.delete({ where: { id } });
    ok(res, { deleted: true, id });
  });

  // 获取客户列表（供员工端创建订单时选择）
  app.get("/staff/clients", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const users = await prisma.user.findMany({
      where: { companyId: auth.companyId, role: "client" },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    });

    ok(res, { items: users });
  });
}

/**
 * 批量取每张订单的长/宽/高，拼成能直接放进 Excel 一个格子的值（2026-08-27）。
 *
 * 为什么要拼：长宽高记在「产品行」上，一张订单可能有好几个产品、尺寸各不相同，
 * 而导出是一行一张运单。实测 97% 的订单只有一个产品，所以：
 *   · 只有一个尺寸   → 出数字，Excel 里能求和能排序
 *   · 好几个不一样的 → 用「/」并排，比如 60/50，一个都不丢
 *   · 一个都没填     → 这三个字段干脆不出现，前端按「没有」处理
 */
export async function loadOrderProductDims(
  companyId: string,
  orderIds: string[],
): Promise<Map<string, { lengthCm?: number | string; widthCm?: number | string; heightCm?: number | string }>> {
  const out = new Map<string, { lengthCm?: number | string; widthCm?: number | string; heightCm?: number | string }>();
  const ids = Array.from(new Set(orderIds.filter(Boolean)));
  if (ids.length === 0) return out;

  const rows = await prisma.orderProduct.findMany({
    where: { orderId: { in: ids }, companyId },
    select: { orderId: true, lengthCm: true, widthCm: true, heightCm: true },
  });

  const pick = (vals: Array<number | null>): number | string | undefined => {
    const nums = vals.filter((v): v is number => v != null);
    if (nums.length === 0) return undefined;
    const uniq = Array.from(new Set(nums));
    return uniq.length === 1 ? uniq[0] : uniq.join("/");
  };

  const grouped = new Map<string, typeof rows>();
  for (const r of rows) {
    const arr = grouped.get(r.orderId) ?? [];
    arr.push(r);
    grouped.set(r.orderId, arr);
  }
  for (const [orderId, list] of grouped) {
    const entry: { lengthCm?: number | string; widthCm?: number | string; heightCm?: number | string } = {};
    const l = pick(list.map((x) => (x.lengthCm == null ? null : Number(x.lengthCm))));
    const w = pick(list.map((x) => (x.widthCm == null ? null : Number(x.widthCm))));
    const h = pick(list.map((x) => (x.heightCm == null ? null : Number(x.heightCm))));
    if (l !== undefined) entry.lengthCm = l;
    if (w !== undefined) entry.widthCm = w;
    if (h !== undefined) entry.heightCm = h;
    if (Object.keys(entry).length > 0) out.set(orderId, entry);
  }
  return out;
}
