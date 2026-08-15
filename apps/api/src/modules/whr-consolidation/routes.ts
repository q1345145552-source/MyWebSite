import { prisma } from "../../db/prisma";
import type { MinimalHttpApp } from "../../server";
import { fail, ok, requireRole } from "../core/http-utils";
import { logger } from "../core/logger";
import { verifyPassword } from "../auth/crypto-utils";
import {
  computePendingRefunds,
  refundPendingOnDelete,
  refundToConsolidation,
} from "../wallet/consolidation-balance";
import {
  NON_CANCELLABLE_STATUSES,
  buildFeeBreakdown,
  mergeFeeBreakdowns,
  recalcCustomerTotals,
  recalcPrealertFee,
  recalcUnpaidPrealertFees,
  syncPlanStatus,
  toNum,
} from "./utils";

/** 列表查询上限，避免计划数变多之后接口整包返回 */
const PLAN_LIST_TAKE = 500;
/** 一个计划最多参与客户数 */
const MAX_CUSTOMERS_PER_PLAN = 100;

/** 货型取值 */
const CARGO_TYPES = ["normal", "inspection", "sensitive"];
const CARGO_TYPE_ZH: Record<string, string> = { normal: "普货", inspection: "商检", sensitive: "敏感" };

/**
 * 允许管理员改货型 / 删单件货物的状态（用户 2026-08-15 拍板）。
 *
 * 口径是「客户还没交钱」：
 *   pending                  货还没到，客户自己就能改
 *   received_pending_payment 仓库已收货、账单已生成但还没付款
 *                            —— 货型报错通常正是收货时才发现的，卡在 pending 等于功能用不了
 * payment_submitted 及之后一律不给动：钱已经交了，改了对不上账。
 */
const ITEM_EDITABLE_STATUSES = ["pending", "received_pending_payment"];

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 在**已有事务内**生成拼柜计划编号 WHR + 7位数字（如 WHR0000001）。
 *
 * 必须和 create 在同一个事务里调用：pg_advisory_xact_lock 随事务结束释放，
 * 原来的写法在独立事务里取完最大值就把锁放了，两个并发请求会拿到同一个号，
 * planNo 上有唯一约束，第二个插入直接 500。
 * 另外按数值取最大而不是字符串排序，位数变化后才不会算错。
 */
async function generatePlanNoInTx(tx: any): Promise<string> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(83010)`;
  const rows = await tx.$queryRaw<{ maxno: bigint | number | null }[]>`
    SELECT MAX(CAST(SUBSTRING(plan_no FROM 4) AS BIGINT)) AS maxno
    FROM whr_consolidation_plans
    WHERE plan_no ~ '^WHR[0-9]+$'
  `;
  const nextNum = Number(rows?.[0]?.maxno ?? 0) + 1;
  return `WHR${String(nextNum).padStart(7, "0")}`;
}

/**
 * 改完单价后重算：先刷新所有未付款预报单的费用，再汇总到客户。
 * 已付款/已装柜/已发运的单子金额已结清，不会被改单价影响。
 */
async function repriceCustomer(customerId: string, tx: any): Promise<number> {
  await recalcUnpaidPrealertFees(customerId, tx);
  const totals = await recalcCustomerTotals(customerId, tx);
  return totals.totalFee;
}

// ============================================================================
// 路由注册
// ============================================================================

export function registerWhrConsolidationRoutes(app: MinimalHttpApp): void {
  // ==========================================================================
  // 1. 创建拼柜计划
  // ==========================================================================
  app.post("/admin/whr-consolidation/plans", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      warehouse?: string;
      containerType?: string;
      destinationTh?: string;
      totalVolumeM3?: number;
      customers?: {
        clientId?: string;
        unitPriceNormal?: number;
        unitPriceInspection?: number;
        unitPriceSensitive?: number;
      }[];
    };

    // 校验必填字段
    if (!body.destinationTh?.trim()) {
      fail(res, 400, "BAD_REQUEST", "目的地为必填");
      return;
    }
    if (!body.customers || !Array.isArray(body.customers) || body.customers.length === 0) {
      fail(res, 400, "BAD_REQUEST", "至少选择一个客户");
      return;
    }
    if (body.customers.length > MAX_CUSTOMERS_PER_PLAN) {
      fail(res, 400, "BAD_REQUEST", `一个计划最多 ${MAX_CUSTOMERS_PER_PLAN} 个客户`);
      return;
    }
    const totalVolumeM3 = body.totalVolumeM3 == null ? 68 : Number(body.totalVolumeM3);
    if (!Number.isFinite(totalVolumeM3) || totalVolumeM3 <= 0) {
      fail(res, 400, "BAD_REQUEST", "总方数必须大于 0");
      return;
    }

    const seenClientIds = new Set<string>();
    for (let i = 0; i < body.customers.length; i++) {
      const c = body.customers[i];
      if (!c.clientId?.trim()) {
        fail(res, 400, "BAD_REQUEST", `第 ${i + 1} 个客户ID为必填`);
        return;
      }
      // 同一个客户不能在同一个计划里出现两次（数据库没有这个唯一约束，在这里挡住）
      if (seenClientIds.has(c.clientId.trim())) {
        fail(res, 400, "BAD_REQUEST", `第 ${i + 1} 个客户重复选择，同一客户在一个计划中只能出现一次`);
        return;
      }
      seenClientIds.add(c.clientId.trim());
      const priceChecks: Array<[string, number | undefined]> = [
        ["普货", c.unitPriceNormal],
        ["商检", c.unitPriceInspection],
        ["敏感货", c.unitPriceSensitive],
      ];
      for (const [label, val] of priceChecks) {
        if (val == null || !Number.isFinite(Number(val)) || Number(val) <= 0) {
          fail(res, 400, "BAD_REQUEST", `第 ${i + 1} 个客户${label}单价必须大于0`);
          return;
        }
      }
    }

    // 客户必须存在、属于本公司、且确实是客户角色
    const clientIds = Array.from(seenClientIds);
    const validClients = await prisma.user.findMany({
      where: { id: { in: clientIds }, companyId: auth.companyId, role: "client" },
      select: { id: true },
    });
    if (validClients.length !== clientIds.length) {
      const validSet = new Set(validClients.map((u) => u.id));
      const missing = clientIds.filter((id) => !validSet.has(id));
      fail(res, 400, "BAD_REQUEST", `以下客户不存在或不属于本公司：${missing.join(", ")}`);
      return;
    }

    // 编号生成和插入放同一个事务，锁才有意义
    const plan = await prisma.$transaction(async (tx) => {
      const planNo = await generatePlanNoInTx(tx);
      const created = await tx.whrConsolidationPlan.create({
        data: {
          companyId: auth.companyId,
          planNo,
          warehouse: body.warehouse?.trim() || "义乌",
          containerType: body.containerType?.trim() || "40HQ",
          destinationTh: body.destinationTh!.trim(),
          totalVolumeM3,
          status: "collecting",
          createdBy: auth.userId,
          creatorName: auth.name,
        },
      });

      await tx.whrConsolidationPlanCustomer.createMany({
        data: body.customers!.map((c) => ({
          planId: created.id,
          companyId: auth.companyId,
          clientId: c.clientId!.trim(),
          unitPriceNormal: Number(c.unitPriceNormal),
          unitPriceInspection: Number(c.unitPriceInspection),
          unitPriceSensitive: Number(c.unitPriceSensitive),
        })),
      });

      return created;
    });

    ok(res, { id: plan.id, planNo: plan.planNo });
  });

  // ==========================================================================
  // 2. 获取拼柜计划列表
  // ==========================================================================
  app.get("/admin/whr-consolidation/plans", async (req, res) => {
    const auth = requireRole(req, res, ["admin", "staff"]);
    if (!auth) return;

    const plans = await prisma.whrConsolidationPlan.findMany({
      where: { companyId: auth.companyId },
      orderBy: { createdAt: "desc" },
      take: PLAN_LIST_TAKE,
      include: {
        _count: { select: { customers: true } },
      },
    });

    // 批量查询每个计划的已用方数（不含已取消客户）
    const volumeSums = await prisma.whrConsolidationPlanCustomer.groupBy({
      by: ["planId"],
      where: { planId: { in: plans.map(p => p.id) } },
      _sum: { totalVolumeM3: true },
    });
    const volumeMap = new Map(volumeSums.map(r => [r.planId, r._sum?.totalVolumeM3?.toNumber() ?? 0]));

    ok(res, {
      items: plans.map((p) => ({
        id: p.id,
        planNo: p.planNo,
        warehouse: p.warehouse,
        containerType: p.containerType,
        destinationTh: p.destinationTh,
        totalVolumeM3: toNum(p.totalVolumeM3),
        status: p.status,
        createdBy: p.createdBy,
        creatorName: p.creatorName,
        customerCount: p._count.customers,
        usedVolumeM3: Math.round((volumeMap.get(p.id) ?? 0) * 1000) / 1000,
        createdAt: p.createdAt.toISOString(),
        updatedAt: p.updatedAt.toISOString(),
      })),
    });
  });

  // ==========================================================================
  // 3. 获取计划详情（含客户、预报单、货品、状态日志）
  // ==========================================================================
  app.get("/admin/whr-consolidation/plans/detail", async (req, res) => {
    const auth = requireRole(req, res, ["admin", "staff"]);
    if (!auth) return;

    const planId = (req.query as any)?.planId as string | undefined;
    if (!planId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "planId 为必填");
      return;
    }

    const plan = await prisma.whrConsolidationPlan.findFirst({
      where: { id: planId, companyId: auth.companyId },
      include: {
        customers: {
          orderBy: { createdAt: "asc" },
          take: MAX_CUSTOMERS_PER_PLAN,
          include: {
            client: { select: { id: true, name: true, phone: true, companyName: true } },
            prealerts: {
              orderBy: { createdAt: "asc" },
              take: 500,
              include: {
                items: { orderBy: { sortOrder: "asc" } },
                statusLogs: { orderBy: { createdAt: "desc" }, take: 50 },
              },
            },
          },
        },
      },
    });

    if (!plan) {
      fail(res, 404, "NOT_FOUND", "计划不存在");
      return;
    }

    // 计划已用方数：排除已取消的预报单
    const planUsedVolumeM3 =
      Math.round(
        plan.customers.reduce(
          (sum, c) =>
            sum +
            c.prealerts
              .filter((pa) => pa.status !== "cancelled")
              .reduce((s, pa) => s + pa.items.reduce((n, it) => n + toNum(it.volumeM3), 0), 0),
          0,
        ) * 1000,
      ) / 1000;

    ok(res, {
      id: plan.id,
      planNo: plan.planNo,
      warehouse: plan.warehouse,
      containerType: plan.containerType,
      destinationTh: plan.destinationTh,
      totalVolumeM3: toNum(plan.totalVolumeM3),
      usedVolumeM3: planUsedVolumeM3,
      status: plan.status,
      createdBy: plan.createdBy,
      creatorName: plan.creatorName,
      createdAt: plan.createdAt.toISOString(),
      updatedAt: plan.updatedAt.toISOString(),
      customers: plan.customers.map((c) => {
        const prices = {
          unitPriceNormal: c.unitPriceNormal,
          unitPriceInspection: c.unitPriceInspection,
          unitPriceSensitive: c.unitPriceSensitive,
        };
        const breakdownByPrealert = new Map<string, ReturnType<typeof buildFeeBreakdown>>();
        for (const pa of c.prealerts) {
          breakdownByPrealert.set(pa.id, buildFeeBreakdown(pa.items, prices, pa.totalFee));
        }
        const customerBreakdown = mergeFeeBreakdowns(
          c.prealerts.filter((pa) => pa.status !== "cancelled").map((pa) => breakdownByPrealert.get(pa.id)!),
        );
        return {
        id: c.id,
        clientId: c.clientId,
        clientName: c.client.name,
        clientPhone: c.client.phone,
        clientCompany: c.client.companyName,
        unitPriceNormal: toNum(c.unitPriceNormal),
        unitPriceInspection: toNum(c.unitPriceInspection),
        unitPriceSensitive: toNum(c.unitPriceSensitive),
        totalVolumeM3: toNum(c.totalVolumeM3),
        totalFee: c.totalFee == null ? null : toNum(c.totalFee),
        feeBreakdown: customerBreakdown,
        deliveryAddress: c.deliveryAddress,
        totalPrealerts: c.totalPrealerts,
        totalPackages: c.totalPackages,
        totalItems: c.prealerts.reduce((sum, pa) => sum + pa.items.length, 0),
        // 客户级时间线不再重复下发一份，前端从 prealerts[].statusLogs 聚合即可
        prealerts: c.prealerts.map((pa) => ({
          id: pa.id,
          trackingNo: pa.trackingNo,
          expressNo: pa.expressNo,
          mark: pa.mark,
          status: pa.status,
          receivedAt: pa.receivedAt?.toISOString() ?? null,
          signedAt: pa.signedAt?.toISOString() ?? null,
          warehouseReceiptProofs: pa.warehouseReceiptProofs ?? [],
          totalFee: pa.totalFee == null ? null : toNum(pa.totalFee),
          feeBreakdown: breakdownByPrealert.get(pa.id) ?? null,
          paymentProofs: pa.paymentProofs ?? [],
          paymentProofUploadedAt: pa.paymentProofUploadedAt?.toISOString() ?? null,
          paymentReviewedAt: pa.paymentReviewedAt?.toISOString() ?? null,
          paymentRejectReason: pa.paymentRejectReason,
          thailandReceiptProofs: pa.thailandReceiptProofs ?? [],
          thailandReceivedAt: pa.thailandReceivedAt?.toISOString() ?? null,
          cancelReason: pa.cancelReason,
          cancelledAt: pa.cancelledAt?.toISOString() ?? null,
          createdAt: pa.createdAt.toISOString(),
          items: pa.items.map((it: any) => ({
            id: it.id,
            productName: it.productName,
            packageCount: it.packageCount,
            quantityPerBox: it.quantityPerBox,
            totalQuantity: it.totalQuantity,
            lengthCm: it.lengthCm == null ? null : toNum(it.lengthCm),
            widthCm: it.widthCm == null ? null : toNum(it.widthCm),
            heightCm: it.heightCm == null ? null : toNum(it.heightCm),
            unitWeightKg: it.unitWeightKg == null ? null : toNum(it.unitWeightKg),
            totalWeightKg: it.totalWeightKg == null ? null : toNum(it.totalWeightKg),
            volumeM3: it.volumeM3 == null ? null : toNum(it.volumeM3),
            material: it.material,
            cargoValue: it.cargoValue,
            cargoType: it.cargoType,
            productImageFileName: it.productImageFileName,
            productImageBase64: it.productImageBase64,
            sortOrder: it.sortOrder,
          })),
          statusLogs: pa.statusLogs.map((sl) => ({
            id: sl.id,
            operatorName: sl.operatorName,
            operatorRole: sl.operatorRole,
            fromStatus: sl.fromStatus,
            toStatus: sl.toStatus,
            remark: sl.remark,
            createdAt: sl.createdAt.toISOString(),
          })),
        })),
        };
      }),
    });
  });

  // ==========================================================================
  // 4. 修改客户单价
  // ==========================================================================
  app.post("/admin/whr-consolidation/customers/price", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      planId?: string;
      customerId?: string;
      unitPriceNormal?: number;
      unitPriceInspection?: number;
      unitPriceSensitive?: number;
    };

    if (!body.planId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "planId 为必填");
      return;
    }
    if (!body.customerId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "customerId 为必填");
      return;
    }

    const customer = await prisma.whrConsolidationPlanCustomer.findFirst({
      where: { id: body.customerId, planId: body.planId, companyId: auth.companyId },
      select: { id: true },
    });

    if (!customer) {
      fail(res, 404, "NOT_FOUND", "客户记录不存在");
      return;
    }

    // 构建更新数据（只改传了的单价）
    const updateData: Record<string, number> = {};
    const priceFields: Array<[string, number | undefined]> = [
      ["unitPriceNormal", body.unitPriceNormal],
      ["unitPriceInspection", body.unitPriceInspection],
      ["unitPriceSensitive", body.unitPriceSensitive],
    ];
    for (const [field, raw] of priceFields) {
      if (raw == null) continue;
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) {
        fail(res, 400, "BAD_REQUEST", "单价必须大于 0");
        return;
      }
      updateData[field] = n;
    }

    if (Object.keys(updateData).length === 0) {
      fail(res, 400, "BAD_REQUEST", "至少需要修改一种单价");
      return;
    }

    // 改价 + 重算放同一个事务，避免只改了价没重算就崩了
    const result = await prisma.$transaction(async (tx) => {
      await tx.whrConsolidationPlanCustomer.update({
        where: { id: customer.id },
        data: updateData,
      });
      const totalFee = await repriceCustomer(customer.id, tx);
      return { totalFee };
    });

    ok(res, {
      customerId: customer.id,
      totalFee: result.totalFee,
    });
  });

  // ==========================================================================
  // 4b. 给已有计划新增参与客户（2026-08-07）
  //     原来客户只能在建计划时一次性选定，建完就再也加不进去了。
  // ==========================================================================
  app.post("/admin/whr-consolidation/customers/add", async (req, res) => {
    const auth = requireRole(req, res, ["admin", "staff"]);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      planId?: string;
      clientId?: string;
      unitPriceNormal?: number;
      unitPriceInspection?: number;
      unitPriceSensitive?: number;
    };

    if (!body.planId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "planId 为必填");
      return;
    }
    if (!body.clientId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "请选择客户");
      return;
    }
    const clientId = body.clientId.trim();

    const priceChecks: Array<[string, number | undefined]> = [
      ["普货", body.unitPriceNormal],
      ["商检", body.unitPriceInspection],
      ["敏感货", body.unitPriceSensitive],
    ];
    for (const [label, val] of priceChecks) {
      if (val == null || !Number.isFinite(Number(val)) || Number(val) <= 0) {
        fail(res, 400, "BAD_REQUEST", `${label}单价必须大于 0`);
        return;
      }
    }

    const plan = await prisma.whrConsolidationPlan.findFirst({
      where: { id: body.planId.trim(), companyId: auth.companyId },
      select: { id: true, status: true },
    });
    if (!plan) {
      fail(res, 404, "NOT_FOUND", "拼柜计划不存在");
      return;
    }
    // 已经装柜/发运/完成/取消的计划不能再往里塞人，否则费用和方数都对不上了
    if (!["planning", "collecting"].includes(plan.status)) {
      fail(res, 400, "BAD_REQUEST", "该计划已开始装柜或已发运，不能再新增客户");
      return;
    }

    const client = await prisma.user.findFirst({
      where: { id: clientId, companyId: auth.companyId, role: "client" },
      select: { id: true },
    });
    if (!client) {
      fail(res, 400, "BAD_REQUEST", "客户不存在或不属于本公司");
      return;
    }

    const exists = await prisma.whrConsolidationPlanCustomer.findFirst({
      where: { planId: plan.id, clientId, companyId: auth.companyId },
      select: { id: true },
    });
    if (exists) {
      fail(res, 400, "BAD_REQUEST", "该客户已在这个计划里，不能重复添加");
      return;
    }

    const count = await prisma.whrConsolidationPlanCustomer.count({
      where: { planId: plan.id, companyId: auth.companyId },
    });
    if (count >= MAX_CUSTOMERS_PER_PLAN) {
      fail(res, 400, "BAD_REQUEST", `一个计划最多 ${MAX_CUSTOMERS_PER_PLAN} 个客户`);
      return;
    }

    const created = await prisma.whrConsolidationPlanCustomer.create({
      data: {
        planId: plan.id,
        companyId: auth.companyId,
        clientId,
        unitPriceNormal: Number(body.unitPriceNormal),
        unitPriceInspection: Number(body.unitPriceInspection),
        unitPriceSensitive: Number(body.unitPriceSensitive),
      },
      select: { id: true },
    });

    ok(res, { customerId: created.id });
  });

  // ==========================================================================
  // 4c. 从计划里移除参与客户（2026-08-07）
  //     ⚠️ 数据库对 whr_consolidation_prealerts 设的是 onDelete: Cascade，
  //     删这一行会把该客户的预报单、货物明细、产品图、状态日志全部级联删掉。
  //     所以名下只要还有任何一条预报单（含已取消的）就一律不让删。
  // ==========================================================================
  app.post("/admin/whr-consolidation/customers/remove", async (req, res) => {
    const auth = requireRole(req, res, ["admin", "staff"]);
    if (!auth) return;

    const body = (req.body ?? {}) as { planId?: string; customerId?: string };

    if (!body.planId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "planId 为必填");
      return;
    }
    if (!body.customerId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "customerId 为必填");
      return;
    }

    const plan = await prisma.whrConsolidationPlan.findFirst({
      where: { id: body.planId.trim(), companyId: auth.companyId },
      select: { id: true, status: true },
    });
    if (!plan) {
      fail(res, 404, "NOT_FOUND", "拼柜计划不存在");
      return;
    }
    // 货已经发走了，参与名单就不该再动 —— 和「新增客户」用同一条口径
    if (!["planning", "collecting"].includes(plan.status)) {
      fail(res, 400, "BAD_REQUEST", "该计划已开始装柜或已发运，不能再移除客户");
      return;
    }

    const customer = await prisma.whrConsolidationPlanCustomer.findFirst({
      where: { id: body.customerId.trim(), planId: plan.id, companyId: auth.companyId },
      select: { id: true, clientId: true },
    });
    if (!customer) {
      fail(res, 404, "NOT_FOUND", "客户记录不存在");
      return;
    }

    const prealertCount = await prisma.whrConsolidationPrealert.count({
      where: { customerId: customer.id },
    });
    if (prealertCount > 0) {
      fail(
        res,
        400,
        "BAD_REQUEST",
        `该客户名下还有 ${prealertCount} 个预报单，删除会把这些单据连同货物明细、产品图一起删掉。请先逐个取消这些预报单，或者保留该客户。`,
      );
      return;
    }

    await prisma.whrConsolidationPlanCustomer.delete({ where: { id: customer.id } });

    ok(res, { removed: true, clientId: customer.clientId });
  });

  // ==========================================================================
  // 4d. 撤销付款并退款（2026-08-07）
  //     客户在集货里付款是当场扣余额、不可撤销的，这里是唯一的后手：
  //     客户点错了，管理员把钱退回集货余额、单子回到「待付款」，客户可重付。
  //     退多少不看当前报价，看流水里**实际扣过**的钱 —— 报价后来改过也不会退错。
  // ==========================================================================
  app.post("/admin/whr-consolidation/payments/revoke", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as { prealertId?: string; reason?: string };
    if (!body.prealertId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "prealertId 为必填");
      return;
    }

    const prealert = await prisma.whrConsolidationPrealert.findFirst({
      where: { id: body.prealertId.trim(), companyId: auth.companyId },
      include: { planCustomer: { select: { clientId: true } } },
    });
    if (!prealert) {
      fail(res, 404, "NOT_FOUND", "预报单不存在");
      return;
    }
    if (prealert.status !== "paid") {
      fail(res, 400, "BAD_REQUEST", "只有「已付款」的预报单能撤销；已装柜或已发运的不能退");
      return;
    }

    // 实际净扣金额 = 流水里这单的 pay（负数）和 refund（正数）相加后取反
    const rows = await prisma.consolidationBalanceLedger.findMany({
      where: { refType: "whr", refId: prealert.id },
      select: { amount: true },
    });
    const refundable = -rows.reduce((sum, r) => sum + Number(r.amount), 0);
    if (!(refundable > 0)) {
      fail(res, 400, "BAD_REQUEST", "这张预报单没有可退的金额（可能已经退过了）");
      return;
    }

    const balanceAfter = await prisma.$transaction(async (tx) => {
      const after = await refundToConsolidation(tx as any, {
        companyId: auth.companyId,
        clientId: prealert.planCustomer.clientId,
        amount: refundable,
        refType: "whr",
        refId: prealert.id,
        refNo: prealert.trackingNo,
        remark: body.reason?.trim() ? `管理员撤销付款：${body.reason.trim()}` : "管理员撤销付款",
        operatorId: auth.userId,
        operatorName: auth.name || auth.userId,
      });
      await tx.whrConsolidationPrealert.update({
        where: { id: prealert.id },
        data: { status: "received_pending_payment", paymentReviewedAt: null } as any,
      });
      await tx.whrConsolidationStatusLog.create({
        data: {
          prealertId: prealert.id,
          companyId: auth.companyId,
          operatorId: auth.userId,
          operatorRole: "admin",
          operatorName: auth.name || auth.userId,
          fromStatus: "paid",
          toStatus: "received_pending_payment",
          remark: `管理员撤销付款，退回集货余额 ¥${refundable.toFixed(2)}${body.reason?.trim() ? `（${body.reason.trim()}）` : ""}`,
        },
      });
      return after;
    });

    ok(res, {
      prealertId: prealert.id,
      refunded: refundable,
      balanceAfter,
      status: "received_pending_payment",
      message: `已退回 ¥${refundable.toFixed(2)} 到客户集货余额，单子回到待付款`,
    });
  });

  // ==========================================================================
  // 5. 审核付款（预报单级别）
  // ==========================================================================
  app.post("/admin/whr-consolidation/prealerts/review", async (req, res) => {
    const auth = requireRole(req, res, ["admin", "staff"]);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      planId?: string;
      prealertId?: string;
      action?: string;
      rejectReason?: string;
      unitPriceNormal?: number;
      unitPriceInspection?: number;
      unitPriceSensitive?: number;
    };

    if (!body.planId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "planId 为必填");
      return;
    }
    if (!body.prealertId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "prealertId 为必填");
      return;
    }
    if (!body.action || !["approve", "reject"].includes(body.action)) {
      fail(res, 400, "BAD_REQUEST", "action 必须是 approve 或 reject");
      return;
    }

    const prealert = await prisma.whrConsolidationPrealert.findFirst({
      where: {
        id: body.prealertId,
        companyId: auth.companyId,
        planCustomer: { planId: body.planId, companyId: auth.companyId },
      },
      select: { id: true, status: true, customerId: true },
    });
    if (!prealert) {
      fail(res, 404, "NOT_FOUND", "预报单不存在");
      return;
    }
    if (prealert.status !== "payment_submitted") {
      fail(res, 400, "BAD_REQUEST", "当前状态不可审核，仅待审核状态可操作");
      return;
    }

    if (body.action === "approve") {
      await prisma.$transaction(async (tx) => {
        await tx.whrConsolidationPrealert.update({
          where: { id: prealert.id },
          data: {
            status: "paid",
            paymentReviewedAt: new Date(),
            paymentReviewedBy: auth.userId,
            paymentRejectReason: null,
          },
        });
        await tx.whrConsolidationStatusLog.create({
          data: {
            prealertId: prealert.id,
            companyId: auth.companyId,
            operatorId: auth.userId,
            operatorRole: auth.role,
            operatorName: auth.name || auth.userId,
            fromStatus: "payment_submitted",
            toStatus: "paid",
            remark: "审核通过",
          },
        });
        await recalcCustomerTotals(prealert.customerId, tx);
        await syncPlanStatus(body.planId!, tx);
        return true;
      });
      ok(res, { prealertId: prealert.id, status: "paid" });
      return;
    }

    // ---- 拒绝 ----
    if (!body.rejectReason?.trim()) {
      fail(res, 400, "BAD_REQUEST", "拒绝原因为必填");
      return;
    }
    if (body.rejectReason.trim().length > 500) {
      fail(res, 400, "BAD_REQUEST", "拒绝原因过长");
      return;
    }

    // 顺带改单价（可选）
    const priceUpdate: Record<string, number> = {};
    const rejectPriceFields: Array<[string, number | undefined]> = [
      ["unitPriceNormal", body.unitPriceNormal],
      ["unitPriceInspection", body.unitPriceInspection],
      ["unitPriceSensitive", body.unitPriceSensitive],
    ];
    for (const [field, raw] of rejectPriceFields) {
      if (raw == null) continue;
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) {
        fail(res, 400, "BAD_REQUEST", "单价必须大于 0");
        return;
      }
      priceUpdate[field] = n;
    }

    const rejectResult = await prisma.$transaction(async (tx) => {
      // 改单价必须和状态回退在同一个事务里，之前写在事务外，事务失败时价格已经改掉了
      if (Object.keys(priceUpdate).length > 0) {
        await tx.whrConsolidationPlanCustomer.update({
          where: { id: prealert.customerId },
          data: priceUpdate,
        });
      }

      await tx.whrConsolidationPrealert.update({
        where: { id: prealert.id },
        data: {
          status: "received_pending_payment",
          paymentRejectReason: body.rejectReason!.trim(),
          paymentProofs: [] as any,
          paymentProofUploadedAt: null,
          paymentReviewedAt: new Date(),
          paymentReviewedBy: auth.userId,
        } as any,
      });

      // 关键：改了单价就要按新价重算这张单的应付金额，否则客户看到的还是签收时冻结的旧金额
      const newFee = await recalcPrealertFee(prealert.id, tx);
      if (Object.keys(priceUpdate).length > 0) {
        await recalcUnpaidPrealertFees(prealert.customerId, tx);
      }
      await recalcCustomerTotals(prealert.customerId, tx);

      await tx.whrConsolidationStatusLog.create({
        data: {
          prealertId: prealert.id,
          companyId: auth.companyId,
          operatorId: auth.userId,
          operatorRole: auth.role,
          operatorName: auth.name || auth.userId,
          fromStatus: "payment_submitted",
          toStatus: "received_pending_payment",
          remark:
            Object.keys(priceUpdate).length > 0
              ? `审核不通过；${body.rejectReason!.trim()}；单价已调整，应付金额更新为 ¥${newFee}`
              : `审核不通过；${body.rejectReason!.trim()}`,
        },
      });

      return { newFee };
    });

    ok(res, {
      prealertId: prealert.id,
      status: "received_pending_payment",
      totalFee: rejectResult.newFee,
    });
  });

  // ==========================================================================
  // 6. 取消预报单资格（装柜前任何状态均可取消，取消后释放方数）
  // ==========================================================================
  app.post("/admin/whr-consolidation/prealerts/cancel", async (req, res) => {
    const auth = requireRole(req, res, ["admin", "staff"]);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      planId?: string;
      prealertId?: string;
      cancelReason?: string;
    };

    if (!body.planId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "planId 为必填");
      return;
    }
    if (!body.prealertId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "prealertId 为必填");
      return;
    }
    if (!body.cancelReason?.trim()) {
      fail(res, 400, "BAD_REQUEST", "取消原因为必填");
      return;
    }
    if (body.cancelReason.trim().length > 500) {
      fail(res, 400, "BAD_REQUEST", "取消原因过长");
      return;
    }

    const prealert = await prisma.whrConsolidationPrealert.findFirst({
      where: {
        id: body.prealertId,
        companyId: auth.companyId,
        planCustomer: { planId: body.planId, companyId: auth.companyId },
      },
      select: { id: true, status: true, customerId: true },
    });

    if (!prealert) {
      fail(res, 404, "NOT_FOUND", "预报单不存在");
      return;
    }

    if (NON_CANCELLABLE_STATUSES.includes(prealert.status)) {
      fail(
        res,
        400,
        "BAD_REQUEST",
        prealert.status === "cancelled"
          ? "该预报单已取消，无需重复操作"
          : "该预报单已装柜，不能再取消",
      );
      return;
    }

    const previousStatus = prealert.status;

    const totals = await prisma.$transaction(async (tx) => {
      await tx.whrConsolidationPrealert.update({
        where: { id: prealert.id },
        data: {
          status: "cancelled",
          cancelReason: body.cancelReason!.trim(),
          cancelledAt: new Date(),
        },
      });

      await tx.whrConsolidationStatusLog.create({
        data: {
          prealertId: prealert.id,
          companyId: auth.companyId,
          operatorId: auth.userId,
          operatorRole: auth.role,
          operatorName: auth.name || auth.userId,
          fromStatus: previousStatus,
          toStatus: "cancelled",
          remark: body.cancelReason!.trim(),
        },
      });

      // 取消的单费用清 0，然后重算客户的方数/件数/单数/费用 —— 这才是真正的「释放方数」
      await recalcPrealertFee(prealert.id, tx);
      const t = await recalcCustomerTotals(prealert.customerId, tx);
      await syncPlanStatus(body.planId!, tx);
      return t;
    });

    ok(res, {
      prealertId: prealert.id,
      status: "cancelled",
      customerVolume: totals.totalVolumeM3,
      customerTotalFee: totals.totalFee,
      customerPrealerts: totals.totalPrealerts,
    });
  });

  // ==========================================================================
  // 9b. 管理员改单件货物的货型（仓库版，2026-08-15 新增）
  //     客户报单时经常把商检/敏感报成普货，仓库收货才发现。改完金额立刻重算。
  // ==========================================================================
  app.post("/admin/whr-consolidation/prealerts/item-cargo-type", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as { itemId?: string; cargoType?: string };

    if (!body.itemId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "itemId 为必填");
      return;
    }
    if (!body.cargoType || !CARGO_TYPES.includes(body.cargoType)) {
      fail(res, 400, "BAD_REQUEST", "货型不合法");
      return;
    }

    const item = await prisma.whrConsolidationPrealertItem.findFirst({
      where: { id: body.itemId, companyId: auth.companyId },
      select: {
        id: true,
        productName: true,
        cargoType: true,
        prealert: { select: { id: true, status: true, customerId: true } },
      },
    });

    if (!item) {
      fail(res, 404, "NOT_FOUND", "货物明细不存在");
      return;
    }
    if (!ITEM_EDITABLE_STATUSES.includes(item.prealert.status)) {
      fail(res, 400, "BAD_REQUEST", "该预报单客户已付款或已进入装柜流程，货型不能再改");
      return;
    }
    if (item.cargoType === body.cargoType) {
      fail(res, 400, "BAD_REQUEST", "货型没有变化");
      return;
    }

    const fromZh = CARGO_TYPE_ZH[item.cargoType] ?? item.cargoType;
    const toZh = CARGO_TYPE_ZH[body.cargoType]!;

    await prisma.$transaction(async (tx) => {
      await tx.whrConsolidationPrealertItem.update({
        where: { id: item.id },
        data: { cargoType: body.cargoType! },
      });

      await tx.whrConsolidationStatusLog.create({
        data: {
          prealertId: item.prealert.id,
          companyId: auth.companyId,
          operatorId: auth.userId,
          operatorRole: auth.role,
          operatorName: auth.name || auth.userId,
          fromStatus: item.prealert.status,
          toStatus: item.prealert.status,
          remark: `管理员把「${item.productName}」的货型由${fromZh}改为${toZh}`,
        },
      });

      // ⚠️ 这里**故意不重算金额**（用户 2026-08-15 拍板：「全部手动报价，系统不用去算价格」）。
      // 签收那一刻的自动计费保持原样不动，改货型只改记录，钱要不要跟着改由管理员自己定。
      // 方数和件数也不受影响：换货型不改长宽高，也不改件数。
    });

    ok(res, {
      itemId: item.id,
      cargoType: body.cargoType,
    });
  });

  // ==========================================================================
  // 9c. 管理员删单件货物明细（仓库版，2026-08-15 新增）
  //     原来只能删整张预报单，客户多报一件就得整张作废重来。
  //     ⚠️ 这是删数据，删完方数和金额都会变，界面必须先弹窗说清楚影响。
  // ==========================================================================
  app.post("/admin/whr-consolidation/prealerts/item-delete", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as { itemId?: string };

    if (!body.itemId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "itemId 为必填");
      return;
    }

    const item = await prisma.whrConsolidationPrealertItem.findFirst({
      where: { id: body.itemId, companyId: auth.companyId },
      select: {
        id: true,
        productName: true,
        packageCount: true,
        prealert: {
          select: {
            id: true,
            status: true,
            customerId: true,
            _count: { select: { items: true } },
          },
        },
      },
    });

    if (!item) {
      fail(res, 404, "NOT_FOUND", "货物明细不存在");
      return;
    }
    if (!ITEM_EDITABLE_STATUSES.includes(item.prealert.status)) {
      fail(res, 400, "BAD_REQUEST", "该预报单客户已付款或已进入装柜流程，货物不能再删");
      return;
    }
    // 最后一件不给删：空预报单签收时会被挡住，留一张删不掉又签不了的单更麻烦。
    // 整张不要了要走「取消预报单」，那条路会清费用、退方数、写流转记录。
    if (item.prealert._count.items <= 1) {
      fail(res, 400, "BAD_REQUEST", "这是该预报单最后一件货物，不能删。整张不要了请用「取消预报单」");
      return;
    }

    const result = await prisma.$transaction(async (tx) => {
      await tx.whrConsolidationPrealertItem.delete({ where: { id: item.id } });

      await tx.whrConsolidationStatusLog.create({
        data: {
          prealertId: item.prealert.id,
          companyId: auth.companyId,
          operatorId: auth.userId,
          operatorRole: auth.role,
          operatorName: auth.name || auth.userId,
          fromStatus: item.prealert.status,
          toStatus: item.prealert.status,
          remark: `管理员删除了货物「${item.productName}」（${item.packageCount}件）`,
        },
      });

      // ⚠️ 只重算「方数 / 件数」这类数量汇总，**不重算金额**
      //（用户 2026-08-15 拍板：系统不去算价格）。
      // recalcCustomerTotals 里的 totalFee 只是把各张单已存的金额加起来，不会重新定价。
      // 删了货但账单金额不变，是有意的 —— 要不要减价由管理员自己决定，界面弹窗已写明。
      const totals = await recalcCustomerTotals(item.prealert.customerId, tx);
      return { totals };
    });

    ok(res, {
      itemId: item.id,
      customerVolume: result.totals.totalVolumeM3,
    });
  });

  /**
   * 删除整个集货计划（仓库版，管理员，2026-08-07 新增）。
   *
   * ⚠️ 级联链最长的一个：
   *   计划 → 计划客户(Cascade) → 预报单(Cascade) → 货物明细 + 状态日志(Cascade)
   * 删一个计划 = 上面全部一起没。CLAUDE.md 第 2.6 条特意警告过这条链。
   *
   * 安全规则（用户 2026-08-07 定）：默认拦住已经开始走流程的，
   * 要删必须带管理员密码强删。判定复用 NON_CANCELLABLE_STATUSES
   * （loading / shipped / thailand_received / cancelled）再加上已付款相关状态。
   *
   * dryRun 只预检不删，界面靠它显示「会删掉几个客户、几张预报单」。
   */
  app.post("/admin/whr-consolidation/plans/delete", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as { planId?: string; confirmPassword?: string; dryRun?: boolean };
    const planId = typeof body.planId === "string" ? body.planId.trim() : "";
    if (!planId) {
      fail(res, 400, "BAD_REQUEST", "planId 为必填");
      return;
    }

    const plan = await prisma.whrConsolidationPlan.findFirst({
      where: { id: planId, companyId: auth.companyId },
      include: {
        customers: {
          select: {
            id: true,
            prealerts: { select: { id: true, status: true, trackingNo: true } },
          },
        },
      },
    });
    if (!plan) {
      fail(res, 404, "NOT_FOUND", "集货计划不存在");
      return;
    }

    const allPrealerts = plan.customers.flatMap((c) => c.prealerts);
    const [itemCount, logCount] = await Promise.all([
      prisma.whrConsolidationPrealertItem.count({
        where: { prealertId: { in: allPrealerts.map((p) => p.id) } },
      }),
      prisma.whrConsolidationStatusLog.count({
        where: { prealertId: { in: allPrealerts.map((p) => p.id) } },
      }),
    ]);

    // 已经收过钱或已发货的，算「开始走流程了」
    const STARTED = ["payment_submitted", "paid", "loading", "shipped", "thailand_received"];
    const started = allPrealerts.filter((p) => STARTED.includes(p.status));
    const blockers = [];
    if (started.length > 0) {
      blockers.push(`有 ${started.length} 张预报单已付款或已发货（${started.slice(0, 3).map((p) => p.trackingNo).join("、")}${started.length > 3 ? " 等" : ""}）`);
    }
    if (!["planning", "collecting", "cancelled"].includes(plan.status)) {
      blockers.push(`计划状态已是「${plan.status}」，不是计划中/收货中`);
    }

    const willDelete = {
      计划客户: plan.customers.length,
      预报单: allPrealerts.length,
      货物明细: itemCount,
      状态日志: logCount,
    };

    // 客户已经付过的钱，删之前要退回去（2026-08-08 补）。
    // 不退的话单子删了钱还挂在客户账上，客户来问都查不到 —— 实测确认过这个洞。
    const pendingRefunds = await computePendingRefunds(
      prisma,
      allPrealerts.map((p) => ({ refType: "whr", refId: p.id })),
    );
    const refundTotal = pendingRefunds.reduce((s, r) => s + r.amount, 0);

    if (body.dryRun) {
      ok(res, { planNo: plan.planNo, willDelete, blockers, refundTotal, refundCount: pendingRefunds.length });
      return;
    }

    if (blockers.length > 0) {
      if (!body.confirmPassword?.trim()) {
        fail(res, 409, "VALIDATION_ERROR",
          `这个集货计划不能直接删除：${blockers.join("；")}。确实要删请输入管理员密码。`);
        return;
      }
      const admin = await prisma.user.findUnique({
        where: { id: auth.userId },
        select: { passwordHash: true },
      });
      if (!admin || !verifyPassword(body.confirmPassword, admin.passwordHash ?? "")) {
        fail(res, 403, "FORBIDDEN", "管理员密码不对，没有删除");
        return;
      }
    }

    // 退款和删除必须在同一个事务里：不然会出现「钱退了单子还在」或者反过来
    await prisma.$transaction(async (tx) => {
      if (pendingRefunds.length > 0) {
        await refundPendingOnDelete(tx as any, {
          companyId: auth.companyId,
          refType: "whr",
          refId: plan.id,
          refunds: pendingRefunds,
          remark: `管理员删除集货计划 ${plan.planNo}，退回已付款项`,
          operatorId: auth.userId,
          operatorName: auth.name || auth.userId,
        });
      }
      await tx.whrConsolidationPlan.delete({ where: { id: planId } });
    });

    logger.warn("删除集货计划（仓库版）", {
      操作人: auth.userId, 计划号: plan.planNo, 计划状态: plan.status,
      连带删除: willDelete, 是否强删: blockers.length > 0,
      退款客户数: pendingRefunds.length, 退款总额: refundTotal,
    });

    ok(res, {
      deleted: true, planNo: plan.planNo, willDelete, forced: blockers.length > 0,
      refundTotal, refundCount: pendingRefunds.length,
    });
  });
}
