import { prisma } from "../../db/prisma";
import type { MinimalHttpApp } from "../../server";
import { fail, ok, requireRole } from "../core/http-utils";
import { saveImageToDisk, deleteImageFile } from "../orders/image-storage";
import {
  buildFeeBreakdown,
  calcFeeFromItems,
  deriveLatestStatus,
  recalcCustomerTotals,
  round3,
  syncPlanStatus,
  toNum,
} from "./utils";

/** 单张凭证 base64 上限（约 8MB 原图） */
const MAX_IMAGE_BASE64_LENGTH = 8 * 1024 * 1024;
/** 操作区 / 拆派视图一次最多拉多少个计划 */
const PLAN_TAKE = 200;
/** 每个计划最多展开的客户数、每个客户最多展开的预报单数 */
const CUSTOMER_TAKE = 100;
const PREALERT_TAKE = 500;

function isValidBase64(s: unknown): s is string {
  return typeof s === "string" && s.trim().length > 0 && /^[A-Za-z0-9+/=\s]+$/.test(s.trim());
}

export function registerWhrConsolidationStaffRoutes(app: MinimalHttpApp): void {
  // =======================================================================
  // 0. 操作区数据（按预报单状态分组，按计划聚合）
  // =======================================================================
  app.get("/staff/whr-consolidation/operations", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const plans = await prisma.whrConsolidationPlan.findMany({
      where: {
        companyId: auth.companyId,
        status: { notIn: ["completed", "cancelled"] },
      },
      orderBy: { createdAt: "desc" },
      take: PLAN_TAKE,
      include: {
        customers: {
          take: CUSTOMER_TAKE,
          include: {
            client: { select: { id: true, name: true, phone: true, companyName: true } },
            prealerts: {
              where: { status: { not: "cancelled" } },
              take: PREALERT_TAKE,
              include: { items: { select: { volumeM3: true, packageCount: true } } },
              orderBy: { createdAt: "asc" },
            },
          },
        },
      },
    });

    const statusGroups = [
      "pending",
      "received_pending_payment",
      "payment_submitted",
      "paid",
      "loading",
      "shipped",
    ];

    ok(res, {
      plans: plans.map((p) => {
        const sections: Record<string, any[]> = {};
        for (const sg of statusGroups) sections[sg] = [];
        let planUsedVolume = 0;

        for (const c of p.customers) {
          for (const pa of c.prealerts) {
            const totalVol = pa.items.reduce((s: number, it: any) => s + toNum(it.volumeM3), 0);
            const totalPkg = pa.items.reduce((s: number, it: any) => s + (it.packageCount ?? 0), 0);
            planUsedVolume += totalVol;

            const row: any = {
              prealertId: pa.id,
              trackingNo: pa.trackingNo,
              expressNo: pa.expressNo,
              mark: pa.mark,
              status: pa.status,
              clientId: c.clientId,
              customerId: c.id,
              clientName: c.client.name,
              clientPhone: c.client.phone,
              clientCompany: c.client.companyName,
              deliveryAddress: c.deliveryAddress,
              addressMissing: !c.deliveryAddress?.trim(),
              itemCount: pa.items.length,
              volumeM3: round3(totalVol),
              packageCount: totalPkg,
              totalFee: pa.totalFee == null ? null : toNum(pa.totalFee),
            };
            if (pa.status === "payment_submitted") {
              row.paymentProofs = pa.paymentProofs ?? [];
            }
            if (pa.status === "shipped") {
              row.thailandReceiptBase64 = pa.thailandReceiptBase64;
            }
            if (sections[pa.status] !== undefined) sections[pa.status].push(row);
          }
        }

        return {
          planId: p.id,
          planNo: p.planNo,
          warehouse: p.warehouse,
          containerType: p.containerType,
          destinationTh: p.destinationTh,
          totalVolumeM3: toNum(p.totalVolumeM3),
          usedVolumeM3: round3(planUsedVolume),
          status: p.status,
          sections,
        };
      }),
    });
  });

  // =======================================================================
  // 0b. 单张预报单详情（审核弹窗用，避免为了一条单去拉整个计划）
  // =======================================================================
  app.get("/staff/whr-consolidation/prealert-detail", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const prealertId = (req.query as any)?.prealertId as string | undefined;
    if (!prealertId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "prealertId 为必填");
      return;
    }

    const pa = await prisma.whrConsolidationPrealert.findFirst({
      where: { id: prealertId, companyId: auth.companyId },
      include: {
        items: { orderBy: { sortOrder: "asc" } },
        statusLogs: { orderBy: { createdAt: "desc" }, take: 50 },
        planCustomer: {
          include: {
            client: { select: { id: true, name: true, phone: true, companyName: true } },
          },
        },
      },
    });

    if (!pa) {
      fail(res, 404, "NOT_FOUND", "预报单不存在");
      return;
    }

    const c = pa.planCustomer;
    const feeBreakdown = buildFeeBreakdown(
      pa.items,
      {
        unitPriceNormal: c.unitPriceNormal,
        unitPriceInspection: c.unitPriceInspection,
        unitPriceSensitive: c.unitPriceSensitive,
      },
      pa.totalFee,
    );
    ok(res, {
      id: pa.id,
      planId: c.planId,
      trackingNo: pa.trackingNo,
      expressNo: pa.expressNo,
      mark: pa.mark,
      status: pa.status,
      totalFee: pa.totalFee == null ? null : toNum(pa.totalFee),
      feeBreakdown,
      signedAt: pa.signedAt?.toISOString() ?? null,
      warehouseReceiptBase64: pa.warehouseReceiptBase64,
      thailandReceiptBase64: pa.thailandReceiptBase64,
      paymentProofs: pa.paymentProofs ?? [],
      paymentProofUploadedAt: pa.paymentProofUploadedAt?.toISOString() ?? null,
      paymentRejectReason: pa.paymentRejectReason,
      cancelReason: pa.cancelReason,
      customerId: c.id,
      clientId: c.clientId,
      clientName: c.client.name,
      clientPhone: c.client.phone,
      clientCompany: c.client.companyName,
      deliveryAddress: c.deliveryAddress,
      unitPriceNormal: toNum(c.unitPriceNormal),
      unitPriceInspection: toNum(c.unitPriceInspection),
      unitPriceSensitive: toNum(c.unitPriceSensitive),
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
    });
  });

  // =======================================================================
  // 1. 仓库签收（预报单级别）
  // =======================================================================
  app.post("/staff/whr-consolidation/prealert-sign", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      planId?: string;
      prealertId?: string;
      receiptFileName?: string;
      receiptMime?: string;
      receiptBase64?: string;
    };
    if (!body.planId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "planId 为必填");
      return;
    }
    if (!body.prealertId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "prealertId 为必填");
      return;
    }
    if (!isValidBase64(body.receiptBase64)) {
      fail(res, 400, "BAD_REQUEST", "收货凭证照片为必填且格式需正确");
      return;
    }
    if (body.receiptBase64.length > MAX_IMAGE_BASE64_LENGTH) {
      fail(res, 400, "BAD_REQUEST", "收货凭证照片过大，请压缩后再上传");
      return;
    }

    const prealert = await prisma.whrConsolidationPrealert.findFirst({
      where: {
        id: body.prealertId,
        companyId: auth.companyId,
        planCustomer: { planId: body.planId, companyId: auth.companyId },
      },
      include: {
        planCustomer: {
          select: {
            id: true,
            unitPriceNormal: true,
            unitPriceInspection: true,
            unitPriceSensitive: true,
          },
        },
        items: { select: { cargoType: true, volumeM3: true } },
      },
    });
    if (!prealert) {
      fail(res, 404, "NOT_FOUND", "预报单不存在");
      return;
    }
    if (prealert.status !== "pending") {
      fail(res, 400, "BAD_REQUEST", "当前状态不可签收，仅待签收状态可操作");
      return;
    }
    if (prealert.items.length === 0) {
      fail(res, 400, "BAD_REQUEST", "预报单尚无货品，无法签收");
      return;
    }

    // 方数为 0 直接签收会产生一张 ¥0 的账单，这里挡住并提示补录尺寸
    const totalVolume = prealert.items.reduce((s, it) => s + toNum(it.volumeM3), 0);
    if (totalVolume <= 0) {
      fail(res, 400, "BAD_REQUEST", "该预报单货品缺少长宽高，方数为 0，签收会导致金额为 0，请先让客户补录尺寸");
      return;
    }

    const totalFee = calcFeeFromItems(prealert.items, prealert.planCustomer);
    const now = new Date();

    // 图片先写盘，事务失败再删掉，避免事务里做文件 IO
    let receiptPath: string;
    try {
      receiptPath = saveImageToDisk(
        `whr_warehouse_receipt_${prealert.id}_${Date.now()}`,
        body.receiptMime?.trim() || "image/png",
        body.receiptBase64.trim(),
      );
    } catch {
      fail(res, 400, "BAD_REQUEST", "收货凭证保存失败，请重试");
      return;
    }

    try {
      await prisma.$transaction(async (tx) => {
        await tx.whrConsolidationPrealert.update({
          where: { id: prealert.id },
          data: {
            status: "received_pending_payment",
            signedAt: now,
            receivedAt: now,
            totalFee,
            warehouseReceiptFileName:
              body.receiptFileName?.trim() || receiptPath.split("/").pop() || "",
            warehouseReceiptMime: body.receiptMime?.trim() || "image/png",
            warehouseReceiptBase64: receiptPath,
          },
        });
        await tx.whrConsolidationStatusLog.create({
          data: {
            prealertId: prealert.id,
            companyId: auth.companyId,
            operatorId: auth.userId,
            operatorRole: auth.role,
            operatorName: auth.name || auth.userId,
            fromStatus: "pending",
            toStatus: "received_pending_payment",
            remark: `仓库签收，${round3(totalVolume)} 方，系统自动计费 ¥${totalFee}`,
          },
        });
        await recalcCustomerTotals(prealert.customerId, tx);
        await syncPlanStatus(body.planId!, tx);
        return true;
      });
    } catch (e) {
      try {
        deleteImageFile(receiptPath);
      } catch {
        /* ignore */
      }
      throw e;
    }

    ok(res, {
      prealertId: prealert.id,
      status: "received_pending_payment",
      totalFee,
      volumeM3: round3(totalVolume),
      signedAt: now.toISOString(),
    });
  });

  // =======================================================================
  // 2. 装柜确认（预报单级别）
  // =======================================================================
  app.post("/staff/whr-consolidation/loading-confirm", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as { planId?: string; prealertId?: string };
    if (!body.planId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "planId 为必填");
      return;
    }
    if (!body.prealertId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "prealertId 为必填");
      return;
    }

    const prealert = await prisma.whrConsolidationPrealert.findFirst({
      where: {
        id: body.prealertId,
        companyId: auth.companyId,
        planCustomer: { planId: body.planId, companyId: auth.companyId },
      },
      select: { id: true, status: true },
    });
    if (!prealert) {
      fail(res, 404, "NOT_FOUND", "预报单不存在");
      return;
    }
    if (prealert.status !== "paid") {
      fail(res, 400, "BAD_REQUEST", "当前状态不可装柜，仅已付款状态可操作");
      return;
    }

    await prisma.$transaction(async (tx) => {
      await tx.whrConsolidationPrealert.update({
        where: { id: prealert.id },
        data: { status: "loading" },
      });
      await tx.whrConsolidationStatusLog.create({
        data: {
          prealertId: prealert.id,
          companyId: auth.companyId,
          operatorId: auth.userId,
          operatorRole: auth.role,
          operatorName: auth.name || auth.userId,
          fromStatus: "paid",
          toStatus: "loading",
          remark: "装柜确认",
        },
      });
      await syncPlanStatus(body.planId!, tx);
      return true;
    });
    ok(res, { prealertId: prealert.id, status: "loading" });
  });

  // =======================================================================
  // 3. 发运确认（预报单级别）
  // =======================================================================
  app.post("/staff/whr-consolidation/ship-confirm", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as { planId?: string; prealertId?: string };
    if (!body.planId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "planId 为必填");
      return;
    }
    if (!body.prealertId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "prealertId 为必填");
      return;
    }

    const prealert = await prisma.whrConsolidationPrealert.findFirst({
      where: {
        id: body.prealertId,
        companyId: auth.companyId,
        planCustomer: { planId: body.planId, companyId: auth.companyId },
      },
      select: { id: true, status: true },
    });
    if (!prealert) {
      fail(res, 404, "NOT_FOUND", "预报单不存在");
      return;
    }
    if (prealert.status !== "loading") {
      fail(res, 400, "BAD_REQUEST", "当前状态不可发运，仅装柜中状态可操作");
      return;
    }

    await prisma.$transaction(async (tx) => {
      await tx.whrConsolidationPrealert.update({
        where: { id: prealert.id },
        data: { status: "shipped" },
      });
      await tx.whrConsolidationStatusLog.create({
        data: {
          prealertId: prealert.id,
          companyId: auth.companyId,
          operatorId: auth.userId,
          operatorRole: auth.role,
          operatorName: auth.name || auth.userId,
          fromStatus: "loading",
          toStatus: "shipped",
          remark: "发运确认",
        },
      });
      await syncPlanStatus(body.planId!, tx);
      return true;
    });
    ok(res, { prealertId: prealert.id, status: "shipped" });
  });

  // =======================================================================
  // 4. 泰国签收（预报单级别）
  // =======================================================================
  app.post("/staff/whr-consolidation/thailand-sign", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      planId?: string;
      prealertId?: string;
      fileName?: string;
      mime?: string;
      base64?: string;
    };
    if (!body.planId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "planId 为必填");
      return;
    }
    if (!body.prealertId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "prealertId 为必填");
      return;
    }
    if (!isValidBase64(body.base64)) {
      fail(res, 400, "BAD_REQUEST", "泰国签收单为必填且格式需正确");
      return;
    }
    if (body.base64.length > MAX_IMAGE_BASE64_LENGTH) {
      fail(res, 400, "BAD_REQUEST", "泰国签收单过大，请压缩后再上传");
      return;
    }

    const prealert = await prisma.whrConsolidationPrealert.findFirst({
      where: {
        id: body.prealertId,
        companyId: auth.companyId,
        planCustomer: { planId: body.planId, companyId: auth.companyId },
      },
      select: { id: true, status: true },
    });
    if (!prealert) {
      fail(res, 404, "NOT_FOUND", "预报单不存在");
      return;
    }
    if (prealert.status !== "shipped") {
      fail(res, 400, "BAD_REQUEST", "当前状态不可签收，仅已发运状态可操作");
      return;
    }

    const now = new Date();
    let proofPath: string;
    try {
      proofPath = saveImageToDisk(
        `whr_thailand_sign_${prealert.id}_${Date.now()}`,
        body.mime?.trim() || "image/png",
        body.base64.trim(),
      );
    } catch {
      fail(res, 400, "BAD_REQUEST", "泰国签收单保存失败，请重试");
      return;
    }

    try {
      await prisma.$transaction(async (tx) => {
        await tx.whrConsolidationPrealert.update({
          where: { id: prealert.id },
          data: {
            status: "thailand_received",
            thailandReceivedAt: now,
            thailandReceiptFileName: body.fileName?.trim() || proofPath.split("/").pop() || "",
            thailandReceiptMime: body.mime?.trim() || "image/png",
            thailandReceiptBase64: proofPath,
          },
        });
        await tx.whrConsolidationStatusLog.create({
          data: {
            prealertId: prealert.id,
            companyId: auth.companyId,
            operatorId: auth.userId,
            operatorRole: auth.role,
            operatorName: auth.name || auth.userId,
            fromStatus: "shipped",
            toStatus: "thailand_received",
            remark: "泰国签收单已上传",
          },
        });
        await syncPlanStatus(body.planId!, tx);
        return true;
      });
    } catch (e) {
      try {
        deleteImageFile(proofPath);
      } catch {
        /* ignore */
      }
      throw e;
    }

    ok(res, {
      prealertId: prealert.id,
      status: "thailand_received",
      thailandReceivedAt: now.toISOString(),
    });
  });

  // =======================================================================
  // 5. 尾端拆派视图（预报单级别）
  // =======================================================================
  app.get("/staff/whr-consolidation/dispatch-view", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const plans = await prisma.whrConsolidationPlan.findMany({
      where: { companyId: auth.companyId },
      orderBy: { createdAt: "desc" },
      take: PLAN_TAKE,
      include: {
        customers: {
          take: CUSTOMER_TAKE,
          include: {
            client: { select: { id: true, name: true, phone: true, companyName: true } },
            prealerts: {
              where: { status: { in: ["paid", "loading", "shipped", "thailand_received"] } },
              take: PREALERT_TAKE,
              include: { items: { orderBy: { sortOrder: "asc" } } },
              orderBy: { createdAt: "asc" },
            },
          },
        },
      },
    });

    ok(res, {
      items: plans
        .map((p) => ({
          planId: p.id,
          planNo: p.planNo,
          warehouse: p.warehouse,
          containerType: p.containerType,
          destinationTh: p.destinationTh,
          totalVolumeM3: toNum(p.totalVolumeM3),
          planStatus: p.status,
          createdAt: p.createdAt.toISOString(),
          customers: p.customers
            // 只保留真正有可派送预报单的客户，空客户在拆派视图里没有意义
            .filter((c) => c.prealerts.length > 0)
            .map((c) => {
              const allItems = c.prealerts.flatMap((pa) => pa.items);
              return {
                id: c.id,
                clientId: c.clientId,
                clientName: c.client.name,
                clientPhone: c.client.phone,
                clientCompany: c.client.companyName,
                // 客户维度的状态由所有预报单推导，不再拿第一条单的状态冒充
                status: deriveLatestStatus(c.prealerts.map((pa) => pa.status)),
                unitPriceNormal: toNum(c.unitPriceNormal),
                unitPriceInspection: toNum(c.unitPriceInspection),
                unitPriceSensitive: toNum(c.unitPriceSensitive),
                totalVolumeM3: round3(allItems.reduce((s, it) => s + toNum(it.volumeM3), 0)),
                totalFee: c.totalFee == null ? null : toNum(c.totalFee),
                deliveryAddress: c.deliveryAddress,
                addressMissing: !c.deliveryAddress?.trim(),
                totalItems: allItems.length,
                totalPackages: allItems.reduce((s, it) => s + (it.packageCount ?? 0), 0),
                createdAt: c.createdAt.toISOString(),
                prealerts: c.prealerts.map((pa) => ({
                  id: pa.id,
                  trackingNo: pa.trackingNo,
                  mark: pa.mark,
                  expressNo: pa.expressNo,
                  status: pa.status,
                  receivedAt: pa.receivedAt?.toISOString() ?? null,
                  signedAt: pa.signedAt?.toISOString() ?? null,
                  warehouseReceiptFileName: pa.warehouseReceiptFileName,
                  warehouseReceiptBase64: pa.warehouseReceiptBase64,
                  thailandReceiptFileName: pa.thailandReceiptFileName,
                  thailandReceiptBase64: pa.thailandReceiptBase64,
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
                })),
              };
            }),
        }))
        .filter((p) => p.customers.length > 0),
    });
  });
}
