import { prisma } from "../../db/prisma";
import type { MinimalHttpApp } from "../../server";
import { fail, ok, requireRole } from "../core/http-utils";
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
          warehouseReceiptFileName: pa.warehouseReceiptFileName,
          warehouseReceiptBase64: pa.warehouseReceiptBase64,
          totalFee: pa.totalFee == null ? null : toNum(pa.totalFee),
          feeBreakdown: breakdownByPrealert.get(pa.id) ?? null,
          paymentProofs: pa.paymentProofs ?? [],
          paymentProofUploadedAt: pa.paymentProofUploadedAt?.toISOString() ?? null,
          paymentReviewedAt: pa.paymentReviewedAt?.toISOString() ?? null,
          paymentRejectReason: pa.paymentRejectReason,
          thailandReceiptFileName: pa.thailandReceiptFileName,
          thailandReceiptBase64: pa.thailandReceiptBase64,
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
}
