import { prisma } from "../../db/prisma";
import type { MinimalHttpApp } from "../../server";
import { fail, ok, requireRole } from "../core/http-utils";
import { saveImageToDisk, deleteImageFile } from "../orders/image-storage";
import {
  ACTIVE_PREALERT_WHERE,
  EDITABLE_PREALERT_STATUS,
  buildFeeBreakdown,
  calcItemVolumeM3,
  deriveLatestStatus,
  mergeFeeBreakdowns,
  recalcCustomerTotals,
  recalcPrealertFee,
  round3,
  sumPlanUsedVolume,
  toNum,
} from "./utils";

/** 单张图片 base64 上限（约 8MB 原图），整个请求体上限由 server.ts 控制在 20MB */
const MAX_IMAGE_BASE64_LENGTH = 8 * 1024 * 1024;
/** 一张预报单最多的货品行数，防止误操作打爆事务 */
const MAX_ITEMS_PER_PREALERT = 200;
/** 一次最多上传的付款凭证张数 */
const MAX_PAYMENT_PROOFS = 10;

function isValidBase64(s: unknown): s is string {
  return typeof s === "string" && s.trim().length > 0 && /^[A-Za-z0-9+/=\s]+$/.test(s.trim());
}

export function registerWhrConsolidationClientRoutes(app: MinimalHttpApp): void {
  // =======================================================================
  // 1. 查看我被选中的拼柜计划（预报单级别汇总）
  // =======================================================================
  app.get("/client/whr-consolidation/plans", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;

    const myCustomers = await prisma.whrConsolidationPlanCustomer.findMany({
      where: { clientId: auth.userId, companyId: auth.companyId },
      include: {
        plan: true,
        prealerts: { select: { status: true, totalFee: true }, orderBy: { createdAt: "desc" } },
      },
      orderBy: { createdAt: "desc" },
      take: 500,
    });

    if (myCustomers.length === 0) {
      ok(res, { items: [] });
      return;
    }

    // 计划已用方数：汇总同计划下所有客户，且排除已取消的预报单
    const planIds = Array.from(new Set(myCustomers.map((c) => c.planId)));
    const volumeMap = new Map<string, number>();
    for (const planId of planIds) {
      volumeMap.set(planId, await sumPlanUsedVolume(planId));
    }

    ok(res, {
      items: myCustomers.map((c) => {
        const activePrealerts = c.prealerts.filter((pa) => pa.status !== "cancelled");
        // 我的费用：只统计未取消的预报单
        const myTotalFee = activePrealerts.reduce((s, pa) => s + toNum(pa.totalFee), 0);
        return {
          planId: c.planId,
          planNo: c.plan.planNo,
          warehouse: c.plan.warehouse,
          containerType: c.plan.containerType,
          destinationTh: c.plan.destinationTh,
          totalVolumeM3: toNum(c.plan.totalVolumeM3),
          usedVolumeM3: volumeMap.get(c.planId) ?? 0,
          myTotalVolumeM3: toNum(c.totalVolumeM3),
          myTotalFee: activePrealerts.length > 0 ? Math.round(myTotalFee * 100) / 100 : null,
          myUnitPriceNormal: toNum(c.unitPriceNormal),
          myUnitPriceInspection: toNum(c.unitPriceInspection),
          myUnitPriceSensitive: toNum(c.unitPriceSensitive),
          prealertCount: activePrealerts.length,
          cancelledCount: c.prealerts.length - activePrealerts.length,
          latestStatus: deriveLatestStatus(c.prealerts.map((pa) => pa.status)),
          deliveryAddress: c.deliveryAddress,
          createdAt: c.plan.createdAt.toISOString(),
        };
      }),
    });
  });

  // =======================================================================
  // 2. 创建预报单
  // =======================================================================
  app.post("/client/whr-consolidation/prealerts", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;

    const body = (req.body ?? {}) as { planId?: string; expressNo?: string; mark?: string };
    if (!body.planId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "planId 为必填");
      return;
    }
    if (!body.mark?.trim()) {
      fail(res, 400, "BAD_REQUEST", "唛头为必填");
      return;
    }

    const customer = await prisma.whrConsolidationPlanCustomer.findFirst({
      where: { planId: body.planId, clientId: auth.userId, companyId: auth.companyId },
      include: { plan: { select: { status: true } } },
    });
    if (!customer) {
      fail(res, 403, "FORBIDDEN", "您不在该拼柜计划中");
      return;
    }
    if (customer.plan.status === "completed" || customer.plan.status === "cancelled") {
      fail(res, 400, "BAD_REQUEST", "该拼柜计划已结束，无法创建预报单");
      return;
    }
    // 收货地址必填：尾端拆派要用，没有地址的货到了泰国没法派送
    if (!customer.deliveryAddress?.trim()) {
      fail(res, 400, "BAD_REQUEST", "请先填写泰国收货地址，再创建预报单");
      return;
    }

    const prealert = await prisma.$transaction(async (tx) => {
      // 咨询锁 + 插入必须在同一个事务里，锁才真正护住「取最大值 → 插入」这段
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(83011)`;
      // 按数值取最大，避免字符串排序在位数变化后算错（"WHRP10000" < "WHRP9999"）
      const rows = await tx.$queryRaw<{ maxno: bigint | number | null }[]>`
        SELECT MAX(CAST(SUBSTRING(tracking_no FROM 5) AS BIGINT)) AS maxno
        FROM whr_consolidation_prealerts
        WHERE tracking_no ~ '^WHRP[0-9]+$'
      `;
      const nextNum = Number(rows?.[0]?.maxno ?? 0) + 1;
      const trackingNo = `WHRP${String(nextNum).padStart(4, "0")}`;

      const created = await tx.whrConsolidationPrealert.create({
        data: {
          customerId: customer.id,
          companyId: auth.companyId,
          trackingNo,
          expressNo: body.expressNo?.trim() || null,
          mark: body.mark!.trim(),
          status: "pending",
        },
      });
      // totalPrealerts 交给统一重算，避免只增不减
      await recalcCustomerTotals(customer.id, tx);
      return created;
    });

    ok(res, {
      id: prealert.id,
      trackingNo: prealert.trackingNo,
      mark: prealert.mark,
      status: prealert.status,
    });
  });

  // =======================================================================
  // 3. 编辑货品（覆盖式更新 + 重算方数/费用）
  // =======================================================================
  app.post("/client/whr-consolidation/prealerts/items", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      prealertId?: string;
      items?: {
        productName?: string;
        packageCount?: number;
        quantityPerBox?: number;
        lengthCm?: number;
        widthCm?: number;
        heightCm?: number;
        unitWeightKg?: number;
        material?: string;
        cargoValue?: string;
        cargoType?: string;
        imageFileName?: string;
        imageMime?: string;
        imageBase64?: string;
        /** 保留原有图片：把详情接口返回的 productImageBase64（其实是 /images/xxx 路径）原样回传 */
        existingImagePath?: string;
      }[];
    };

    if (!body.prealertId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "prealertId 为必填");
      return;
    }
    // items 允许为空数组 —— 代表「清空该预报单的货品」（删掉最后一件时会走到这里）
    const items = Array.isArray(body.items) ? body.items : null;
    if (!items) {
      fail(res, 400, "BAD_REQUEST", "items 必须是数组");
      return;
    }
    if (items.length > MAX_ITEMS_PER_PREALERT) {
      fail(res, 400, "BAD_REQUEST", `货品行数不能超过 ${MAX_ITEMS_PER_PREALERT} 行`);
      return;
    }

    // 注意：Prisma 不允许同一层同时写 select 和 include，这里统一用 include
    const prealert = await prisma.whrConsolidationPrealert.findFirst({
      where: { id: body.prealertId, companyId: auth.companyId },
      include: {
        items: { select: { id: true, productImageBase64: true } },
        planCustomer: {
          include: {
            plan: { select: { id: true, status: true, totalVolumeM3: true } },
          },
        },
      },
    });

    if (!prealert || prealert.planCustomer.clientId !== auth.userId) {
      fail(res, 403, "FORBIDDEN", "无权操作该预报单");
      return;
    }
    // 状态校验：只有待签收的预报单客户才能改货品
    if (prealert.status !== EDITABLE_PREALERT_STATUS) {
      fail(res, 400, "BAD_REQUEST", "该预报单已签收，货品不可再修改，如需变更请联系客服");
      return;
    }
    const plan = prealert.planCustomer.plan;
    if (plan.status === "completed" || plan.status === "cancelled") {
      fail(res, 400, "BAD_REQUEST", "该拼柜计划已结束，无法修改货品");
      return;
    }

    // ---- 逐行校验 ----
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const row = i + 1;
      if (!it.productName?.trim()) {
        fail(res, 400, "BAD_REQUEST", `第 ${row} 行品名为必填`);
        return;
      }
      const pkg = Number(it.packageCount);
      if (!Number.isFinite(pkg) || pkg <= 0) {
        fail(res, 400, "BAD_REQUEST", `第 ${row} 行件数必须大于 0`);
        return;
      }
      const qpb = it.quantityPerBox == null ? 1 : Number(it.quantityPerBox);
      if (!Number.isFinite(qpb) || qpb <= 0) {
        fail(res, 400, "BAD_REQUEST", `第 ${row} 行每箱数量必须大于 0`);
        return;
      }
      // 长宽高必填：缺了方数算不出来，签收时会按 0 方计费
      const dims: Array<[string, unknown]> = [
        ["长", it.lengthCm],
        ["宽", it.widthCm],
        ["高", it.heightCm],
      ];
      for (const [label, val] of dims) {
        const n = Number(val);
        if (!Number.isFinite(n) || n <= 0) {
          fail(res, 400, "BAD_REQUEST", `第 ${row} 行${label}(cm)必须大于 0，否则无法计算方数`);
          return;
        }
      }
      if (!it.material?.trim()) {
        fail(res, 400, "BAD_REQUEST", `第 ${row} 行材质为必填`);
        return;
      }
      if (!it.cargoValue?.trim()) {
        fail(res, 400, "BAD_REQUEST", `第 ${row} 行货值为必填`);
        return;
      }
      if (it.cargoType && !["normal", "inspection", "sensitive"].includes(it.cargoType)) {
        fail(res, 400, "BAD_REQUEST", `第 ${row} 行货物类型不合法`);
        return;
      }
      if (it.imageBase64 != null && it.imageBase64 !== "") {
        if (!isValidBase64(it.imageBase64)) {
          fail(res, 400, "BAD_REQUEST", `第 ${row} 行图片格式不正确`);
          return;
        }
        if (it.imageBase64.length > MAX_IMAGE_BASE64_LENGTH) {
          fail(res, 400, "BAD_REQUEST", `第 ${row} 行图片过大，请压缩后再上传`);
          return;
        }
      }
    }

    // ---- 容量校验：拿整个计划的已用方数来比，而不是单个客户 ----
    const myNewVolume = round3(
      items.reduce((sum, it) => {
        const v = calcItemVolumeM3(
          Number(it.lengthCm),
          Number(it.widthCm),
          Number(it.heightCm),
          Number(it.packageCount) || 1,
        );
        return sum + (v ?? 0);
      }, 0),
    );
    // 该客户其它预报单（未取消、且不是当前这张）已占的方数
    const myOtherPrealerts = await prisma.whrConsolidationPrealert.findMany({
      where: {
        customerId: prealert.customerId,
        id: { not: prealert.id },
        ...ACTIVE_PREALERT_WHERE,
      },
      select: { items: { select: { volumeM3: true } } },
    });
    let myOtherVolume = 0;
    for (const pa of myOtherPrealerts) {
      for (const it of pa.items) myOtherVolume += toNum(it.volumeM3);
    }
    const otherCustomersVolume = await sumPlanUsedVolume(plan.id, prisma, prealert.customerId);
    const planTotal = toNum(plan.totalVolumeM3);
    const planUsedAfter = round3(otherCustomersVolume + myOtherVolume + myNewVolume);

    if (planTotal > 0 && planUsedAfter > planTotal) {
      // 用 fail() 返回 400，而不是 throw —— throw 在生产环境会被兜底 catch 换成 "Internal server error"
      fail(
        res,
        400,
        "BAD_REQUEST",
        `本柜已用 ${round3(otherCustomersVolume + myOtherVolume)} 方，` +
          `本次再报 ${myNewVolume} 方将达到 ${planUsedAfter} 方，超过计划上限 ${planTotal} 方`,
      );
      return;
    }

    // ---- 组装货品数据 ----
    // 已有图片路径白名单，防止客户端回传任意路径
    const existingPaths = new Set(
      prealert.items.map((it) => it.productImageBase64).filter((p): p is string => !!p),
    );

    const itemData: any[] = items.map((it, idx) => {
      const pkg = Number(it.packageCount) || 1;
      const qpb = Number(it.quantityPerBox) || 1;
      const unitWeightRaw = it.unitWeightKg == null ? null : Number(it.unitWeightKg);
      const unitWeight =
        unitWeightRaw != null && Number.isFinite(unitWeightRaw) && unitWeightRaw > 0 ? unitWeightRaw : null;
      const keepPath =
        !it.imageBase64 && it.existingImagePath && existingPaths.has(it.existingImagePath)
          ? it.existingImagePath
          : null;
      return {
        productName: it.productName!.trim(),
        packageCount: pkg,
        quantityPerBox: qpb,
        totalQuantity: pkg * qpb,
        lengthCm: Number(it.lengthCm),
        widthCm: Number(it.widthCm),
        heightCm: Number(it.heightCm),
        unitWeightKg: unitWeight,
        totalWeightKg: unitWeight == null ? null : Math.round(unitWeight * pkg * qpb * 100) / 100,
        volumeM3: calcItemVolumeM3(Number(it.lengthCm), Number(it.widthCm), Number(it.heightCm), pkg),
        material: it.material!.trim(),
        cargoValue: it.cargoValue!.trim(),
        cargoType: it.cargoType || "normal",
        sortOrder: idx,
        productImageFileName: null as string | null,
        productImageMime: null as string | null,
        productImageBase64: keepPath as string | null,
      };
    });
    // 保留原图时，文件名/mime 也要跟着保留
    const oldItemMeta = new Map<string, { fileName: string | null; mime: string | null }>();
    {
      const fullOld = await prisma.whrConsolidationPrealertItem.findMany({
        where: { prealertId: prealert.id },
        select: { productImageBase64: true, productImageFileName: true, productImageMime: true },
      });
      for (const o of fullOld) {
        if (o.productImageBase64) {
          oldItemMeta.set(o.productImageBase64, {
            fileName: o.productImageFileName,
            mime: o.productImageMime,
          });
        }
      }
    }
    for (const d of itemData) {
      if (d.productImageBase64 && oldItemMeta.has(d.productImageBase64)) {
        const meta = oldItemMeta.get(d.productImageBase64)!;
        d.productImageFileName = meta.fileName;
        d.productImageMime = meta.mime;
      }
    }

    // ---- 先写盘再开事务：文件 IO 不该待在事务里，事务回滚也回滚不了磁盘 ----
    const newlyWrittenPaths: string[] = [];
    const cleanupNew = () => {
      for (const p of newlyWrittenPaths) {
        try {
          deleteImageFile(p);
        } catch {
          /* ignore */
        }
      }
    };
    try {
      for (const [i, it] of items.entries()) {
        if (!it.imageBase64?.trim()) continue;
        const imgPath = saveImageToDisk(
          `whr_item_${prealert.id}_${i}_${Date.now()}`,
          it.imageMime || "image/png",
          it.imageBase64.trim(),
        );
        newlyWrittenPaths.push(imgPath);
        itemData[i].productImageFileName = it.imageFileName || imgPath.split("/").pop() || "";
        itemData[i].productImageMime = it.imageMime || "image/png";
        itemData[i].productImageBase64 = imgPath;
      }
    } catch {
      cleanupNew();
      fail(res, 400, "BAD_REQUEST", "产品图片保存失败，请重试或更换图片");
      return;
    }

    let result: { totalVolumeM3: number; totalPackages: number };
    try {
      result = await prisma.$transaction(async (tx) => {
        await tx.whrConsolidationPrealertItem.deleteMany({ where: { prealertId: prealert.id } });
        if (itemData.length > 0) {
          await tx.whrConsolidationPrealertItem.createMany({
            data: itemData.map((it) => ({
              ...it,
              prealertId: prealert.id,
              companyId: auth.companyId,
            })),
          });
        }
        // 货品变了，费用和客户汇总一起重算
        await recalcPrealertFee(prealert.id, tx);
        return recalcCustomerTotals(prealert.customerId, tx);
      });
    } catch (e) {
      cleanupNew();
      throw e;
    }

    // ---- 事务成功后清理不再被引用的旧图片，避免磁盘越堆越多 ----
    const keptPaths = new Set(
      itemData.map((it) => it.productImageBase64).filter((p): p is string => !!p),
    );
    for (const oldPath of existingPaths) {
      if (!keptPaths.has(oldPath)) {
        try {
          deleteImageFile(oldPath);
        } catch {
          /* 清理失败不影响主流程 */
        }
      }
    }

    ok(res, {
      prealertId: prealert.id,
      totalVolumeM3: result.totalVolumeM3,
      totalPackages: result.totalPackages,
      itemCount: itemData.length,
      planUsedVolumeM3: planUsedAfter,
      planTotalVolumeM3: planTotal,
    });
  });

  // =======================================================================
  // 4. 上传付款凭证（预报单级别）
  // =======================================================================
  app.post("/client/whr-consolidation/pay", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      planId?: string;
      prealertId?: string;
      proofs?: { fileName?: string; mime?: string; base64?: string }[];
    };
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
        planCustomer: { planId: body.planId, clientId: auth.userId, companyId: auth.companyId },
      },
      include: { planCustomer: { select: { deliveryAddress: true } } },
    });
    if (!prealert) {
      fail(res, 403, "FORBIDDEN", "无权操作该预报单");
      return;
    }
    if (prealert.status !== "received_pending_payment") {
      fail(res, 400, "BAD_REQUEST", "当前状态不可付款，仅待付款状态可操作");
      return;
    }
    // 收货地址必填
    if (!prealert.planCustomer.deliveryAddress?.trim()) {
      fail(res, 400, "BAD_REQUEST", "请先填写泰国收货地址，再上传付款凭证");
      return;
    }

    const proofs = Array.isArray(body.proofs) ? body.proofs : [];
    if (proofs.length === 0) {
      fail(res, 400, "BAD_REQUEST", "请至少上传一张付款凭证");
      return;
    }
    if (proofs.length > MAX_PAYMENT_PROOFS) {
      fail(res, 400, "BAD_REQUEST", `一次最多上传 ${MAX_PAYMENT_PROOFS} 张付款凭证`);
      return;
    }
    for (let i = 0; i < proofs.length; i++) {
      const b64 = proofs[i]?.base64;
      if (!isValidBase64(b64)) {
        fail(res, 400, "BAD_REQUEST", `第 ${i + 1} 张付款凭证内容为空或格式不正确`);
        return;
      }
      if (b64.length > MAX_IMAGE_BASE64_LENGTH) {
        fail(res, 400, "BAD_REQUEST", `第 ${i + 1} 张付款凭证过大，请压缩后再上传`);
        return;
      }
    }

    // 旧凭证路径，事务成功后再删文件
    const oldProofPaths = (Array.isArray(prealert.paymentProofs) ? prealert.paymentProofs : [])
      .map((p: any) => p?.base64Path)
      .filter((p: any): p is string => typeof p === "string" && p.startsWith("/images/"));

    const now = new Date();
    const savedProofs: any[] = [];
    const cleanupSaved = () => {
      for (const s of savedProofs) {
        try {
          deleteImageFile(s.base64Path);
        } catch {
          /* ignore */
        }
      }
    };
    try {
      for (const [i, p] of proofs.entries()) {
        const imgPath = saveImageToDisk(
          `whr_payment_${prealert.id}_${i}_${Date.now()}`,
          p.mime || "image/png",
          (p.base64 as string).trim(),
        );
        savedProofs.push({
          fileName: p.fileName || imgPath.split("/").pop() || "payment.png",
          mime: p.mime || "image/png",
          base64Path: imgPath,
          uploadedAt: now.toISOString(),
        });
      }
    } catch {
      cleanupSaved();
      fail(res, 400, "BAD_REQUEST", "付款凭证保存失败，请重试");
      return;
    }

    try {
      await prisma.$transaction(async (tx) => {
        await tx.whrConsolidationPrealert.update({
          where: { id: prealert.id },
          data: {
            status: "payment_submitted",
            paymentProofs: savedProofs as any,
            paymentProofUploadedAt: now,
            paymentReviewedAt: null,
            paymentReviewedBy: null,
            paymentRejectReason: null,
          } as any,
        });
        await tx.whrConsolidationStatusLog.create({
          data: {
            prealertId: prealert.id,
            companyId: auth.companyId,
            operatorId: auth.userId,
            operatorRole: "client",
            operatorName: auth.name || auth.userId,
            fromStatus: "received_pending_payment",
            toStatus: "payment_submitted",
            remark: "客户上传付款凭证",
          },
        });
        return true;
      });
    } catch (e) {
      cleanupSaved();
      throw e;
    }

    for (const oldPath of oldProofPaths) {
      try {
        deleteImageFile(oldPath);
      } catch {
        /* ignore */
      }
    }

    ok(res, {
      prealertId: prealert.id,
      status: "payment_submitted",
      paymentProofUploadedAt: now.toISOString(),
      proofCount: savedProofs.length,
    });
  });

  // =======================================================================
  // 4b. 保存收货地址
  // =======================================================================
  app.post("/client/whr-consolidation/address", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;

    const body = (req.body ?? {}) as { planId?: string; deliveryAddress?: string };
    if (!body.planId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "planId 为必填");
      return;
    }
    if (!body.deliveryAddress?.trim()) {
      fail(res, 400, "BAD_REQUEST", "收货地址为必填");
      return;
    }
    if (body.deliveryAddress.trim().length > 500) {
      fail(res, 400, "BAD_REQUEST", "收货地址过长");
      return;
    }

    const customer = await prisma.whrConsolidationPlanCustomer.findFirst({
      where: { planId: body.planId, clientId: auth.userId, companyId: auth.companyId },
      include: { prealerts: { select: { status: true } } },
    });
    if (!customer) {
      fail(res, 403, "FORBIDDEN", "您不在该拼柜计划中");
      return;
    }
    // 已发运之后地址已经用于尾端派送，不能再改
    if (customer.prealerts.some((pa) => pa.status === "shipped" || pa.status === "thailand_received")) {
      fail(res, 400, "BAD_REQUEST", "已有货物发运，收货地址不可再修改，如需变更请联系客服");
      return;
    }

    await prisma.whrConsolidationPlanCustomer.update({
      where: { id: customer.id },
      data: { deliveryAddress: body.deliveryAddress.trim() },
    });
    ok(res, { customerId: customer.id, deliveryAddress: body.deliveryAddress.trim() });
  });

  // =======================================================================
  // 5. 查看我的详情（预报单级别）
  // =======================================================================
  app.get("/client/whr-consolidation/my-detail", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;

    const planId = (req.query as any)?.planId as string | undefined;
    if (!planId?.trim()) {
      fail(res, 400, "BAD_REQUEST", "planId 为必填");
      return;
    }

    const customer = await prisma.whrConsolidationPlanCustomer.findFirst({
      where: { planId, clientId: auth.userId, companyId: auth.companyId },
      include: {
        client: { select: { name: true, phone: true } },
        prealerts: {
          orderBy: { createdAt: "asc" },
          take: 500,
          include: {
            items: { orderBy: { sortOrder: "asc" } },
            statusLogs: { orderBy: { createdAt: "desc" }, take: 50 },
          },
        },
      },
    });
    if (!customer) {
      fail(res, 403, "FORBIDDEN", "您不在该拼柜计划中");
      return;
    }

    // 费用明细：让客户看得见「总费用是怎么算出来的」
    const prices = {
      unitPriceNormal: customer.unitPriceNormal,
      unitPriceInspection: customer.unitPriceInspection,
      unitPriceSensitive: customer.unitPriceSensitive,
    };
    const breakdownByPrealert = new Map<string, ReturnType<typeof buildFeeBreakdown>>();
    for (const pa of customer.prealerts) {
      breakdownByPrealert.set(pa.id, buildFeeBreakdown(pa.items, prices, pa.totalFee));
    }
    // 客户级明细只汇总未取消的单
    const customerBreakdown = mergeFeeBreakdowns(
      customer.prealerts
        .filter((pa) => pa.status !== "cancelled")
        .map((pa) => breakdownByPrealert.get(pa.id)!),
    );

    // 时间线在这里聚合一次即可，不再逐单重复下发一份（原来同一批日志会传两遍）
    const allLogs = customer.prealerts
      .flatMap((pa) => pa.statusLogs.map((sl) => ({ ...sl, trackingNo: pa.trackingNo })))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, 200);

    ok(res, {
      customerId: customer.id,
      customerName: customer.client.name,
      customerPhone: customer.client.phone,
      unitPriceNormal: toNum(customer.unitPriceNormal),
      unitPriceInspection: toNum(customer.unitPriceInspection),
      unitPriceSensitive: toNum(customer.unitPriceSensitive),
      totalVolumeM3: toNum(customer.totalVolumeM3),
      totalFee: customer.totalFee == null ? null : toNum(customer.totalFee),
      feeBreakdown: customerBreakdown,
      deliveryAddress: customer.deliveryAddress,
      totalPrealerts: customer.totalPrealerts,
      totalPackages: customer.totalPackages,
      prealerts: customer.prealerts.map((pa) => ({
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
      })),
      statusLogs: allLogs.map((sl) => ({
        id: sl.id,
        trackingNo: sl.trackingNo,
        operatorName: sl.operatorName,
        operatorRole: sl.operatorRole,
        fromStatus: sl.fromStatus,
        toStatus: sl.toStatus,
        remark: sl.remark,
        createdAt: sl.createdAt.toISOString(),
      })),
    });
  });
}
