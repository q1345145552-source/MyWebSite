import { prisma } from "../../db/prisma";
import type { MinimalHttpApp } from "../../server";
import { fail, ok, requireRole } from "../core/http-utils";
import { InsufficientBalanceError, PaymentConflictError, chargeForConsolidation } from "../wallet/consolidation-balance";
import { lockPlanAliveById, lockPlanAliveByPrealert, PlanCancelledError, PlanMissingError } from "./plan-guard";
import { saveImageToDisk, deleteImageFile } from "../orders/image-storage";
import { BusinessError } from "../core/business-error";
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
      /**
       * ⚠️ 先锁住这个柜，确认它还活着（2026-08-27 补）。
       * 上面「计划已结束就拦」在事务外面：管理员正好在这一刻取消/结束了这个柜，
       * 客户这张新单还是会建进去 —— 建进一个已经作废的柜里，
       * 之后既收不了钱也发不了货，还会被管理员删柜时连带清掉。
       * 锁序照旧【计划 → 预报单 → 钱包】，所以这句必须排在最前面。
       */
      await lockPlanAliveById(tx, customer.planId);
      const planNow = await tx.whrConsolidationPlan.findUnique({
        where: { id: customer.planId },
        select: { status: true },
      });
      if (planNow?.status === "completed") {
        throw new BusinessError("该拼柜计划已结束，无法创建预报单");
      }

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
  // ==========================================================================
  // 客户付款：用集货余额直接扣（2026-08-07 改）
  // 原来是上传付款凭证 → 等管理员审核。现在改成余额支付：当场扣钱、当场完成，
  // 不用传水单、不用审核。水单只在充值那一步传一次。
  // 误操作由管理员端「撤销付款」兜底（退钱 + 单子回到待付款）。
  // ==========================================================================
  app.post("/client/whr-consolidation/pay", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
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
    if (!prealert.planCustomer.deliveryAddress?.trim()) {
      fail(res, 400, "BAD_REQUEST", "请先填写泰国收货地址，再付款");
      return;
    }

    const amount = prealert.totalFee == null ? 0 : Number(prealert.totalFee);
    if (!(amount > 0)) {
      fail(res, 400, "BAD_REQUEST", "这张预报单还没有计费金额，请联系客服核对后再付款");
      return;
    }

    try {
      const paid = await prisma.$transaction(async (tx) => {
        /**
         * ⚠️⚠️ 事务里必须**重新读一遍并锁住这张预报单**（2026-08-25 新增）。
         *
         * 上面那几道 `if` 是在事务**外面**查的。客户手抖点两下「付款」，
         * 两个请求会同时通过检查、各自开事务、各扣一次钱 —— 单子一张，钱扣两遍。
         * 前端禁用按钮挡不住（抓包重放、网络重试都能绕过）。
         *
         * FOR UPDATE 之后第二个请求会等第一个提交完，读到状态已是 paid，
         * 直接报「已付款」退出，一分钱不扣。
         *
         * ⚠️ 金额也要用事务里读出来的：仓库版是签收那一刻按方数×单价自动算的，
         * 管理员改单价会重算 totalFee，用事务外那个旧金额会扣错数。
         */
        // ⚠️ 锁序固定为【计划 → 预报单 → 钱包】，四条碰钱的路都按这个顺序拿锁，
        // 反着拿会死锁。所以先锁柜、再锁单，别调换。
        await lockPlanAliveByPrealert(tx, prealert.id);
        await tx.$queryRaw`SELECT id FROM whr_consolidation_prealerts WHERE id = ${prealert.id} FOR UPDATE`;
        const fresh = await tx.whrConsolidationPrealert.findUnique({
          where: { id: prealert.id },
          select: { status: true, totalFee: true },
        });
        if (!fresh || fresh.status !== "received_pending_payment") {
          throw new PaymentConflictError(
            fresh?.status === "paid"
              ? "这张预报单已付款，不用重复付"
              : "这张预报单的状态刚刚变了，请刷新页面后再试",
          );
        }
        const amount = fresh.totalFee == null ? 0 : Number(fresh.totalFee);
        if (!(amount > 0)) {
          throw new PaymentConflictError("这张预报单还没有计费金额，请联系客服核对后再付款");
        }

        // 扣钱和改状态必须在同一个事务里，不能出现「钱扣了单子没付上」
        const after = await chargeForConsolidation(tx as any, {
          companyId: auth.companyId,
          clientId: auth.userId,
          amount,
          refType: "whr",
          refId: prealert.id,
          refNo: prealert.trackingNo,
          remark: "仓库版集货付款",
          operatorId: auth.userId,
          operatorName: auth.name || auth.userId,
        });
        await tx.whrConsolidationPrealert.update({
          where: { id: prealert.id },
          data: {
            status: "paid",
            paymentReviewedAt: new Date(),
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
            toStatus: "paid",
            remark: `客户用集货余额付款 ¥${amount.toFixed(2)}`,
          },
        });
        return { balanceAfter: after, amount };
      });

      ok(res, {
        prealertId: prealert.id,
        status: "paid",
        paidAmount: paid.amount,
        balanceAfter: paid.balanceAfter,
        message: `付款成功，已扣 ¥${paid.amount.toFixed(2)}，集货余额剩余 ¥${paid.balanceAfter.toFixed(2)}`,
      });
    } catch (e) {
      if (e instanceof PlanCancelledError || e instanceof PlanMissingError) {
        fail(res, 400, "BAD_REQUEST", e.message);
        return;
      }
      if (e instanceof InsufficientBalanceError || e instanceof PaymentConflictError) {
        fail(res, 400, "BAD_REQUEST", e.message);
        return;
      }
      throw e;
    }
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
