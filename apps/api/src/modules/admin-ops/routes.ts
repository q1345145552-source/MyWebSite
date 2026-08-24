// B-7: 已从 node:sqlite 迁移到 Prisma + PostgreSQL（2026-05-20）
import { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma";
import { syncParentStatusFromChildren } from "../shipments/parent-status";
import type { MinimalHttpApp } from "../../server";
import { fail, ok, requireRole } from "../core/http-utils";

/** 同一票货重复进派送单时抛这个，调用方转成 400 而不是 500 */
class LastmileConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LastmileConflictError";
  }
}

/** Decimal | null → number */
function decToNumber(value: Prisma.Decimal | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return Number(value.toString());
}

/**
 * 注册管理员运营侧（LMP/关务/末端/结算）接口。
 */
export function registerAdminOpsRoutes(app: MinimalHttpApp): void {
  app.get("/admin/lmp/rates", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;
    const rows = await prisma.adminLmpRate.findMany({
      where: { companyId: auth.companyId },
      orderBy: { updatedAt: "desc" },
    });
    ok(res, {
      items: rows.map((item) => ({
        id: item.id,
        routeCode: item.routeCode,
        supplierName: item.supplierName,
        transportMode: item.transportMode,
        seasonTag: item.seasonTag,
        supplierCost: decToNumber(item.supplierCost),
        quotePrice: decToNumber(item.quotePrice),
        currency: item.currency,
        effectiveFrom: item.effectiveFrom,
        effectiveTo: item.effectiveTo ?? undefined,
        updatedAt: item.updatedAt.toISOString(),
      })),
    });
  });

  app.post("/admin/lmp/rates", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;
    const body = (req.body ?? {}) as {
      routeCode?: string;
      supplierName?: string;
      transportMode?: string;
      seasonTag?: string;
      supplierCost?: number;
      quotePrice?: number;
      currency?: string;
      effectiveFrom?: string;
      effectiveTo?: string;
    };
    const routeCode = body.routeCode?.trim();
    const supplierName = body.supplierName?.trim();
    const transportMode = body.transportMode?.trim();
    const seasonTag = body.seasonTag?.trim();
    const supplierCost = Number(body.supplierCost);
    const quotePrice = Number(body.quotePrice);
    if (!routeCode || !supplierName || !transportMode || !seasonTag || !Number.isFinite(supplierCost) || !Number.isFinite(quotePrice)) {
      fail(res, 400, "BAD_REQUEST", "invalid lmp rate payload");
      return;
    }
    const id = `lmp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const created = await prisma.adminLmpRate.create({
      data: {
        id,
        companyId: auth.companyId,
        routeCode,
        supplierName,
        transportMode,
        seasonTag,
        supplierCost,
        quotePrice,
        currency: body.currency?.trim() || "CNY",
        effectiveFrom: body.effectiveFrom?.trim() || new Date().toISOString().slice(0, 10),
        effectiveTo: body.effectiveTo?.trim() || null,
      },
      select: { id: true, updatedAt: true },
    });
    ok(res, { id: created.id, updatedAt: created.updatedAt.toISOString() });
  });

  app.get("/admin/customs/cases", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;
    const rows = await prisma.adminCustomsCase.findMany({
      where: { companyId: auth.companyId },
      orderBy: { updatedAt: "desc" },
    });
    const shipmentIds = [...new Set(rows.map((r) => r.shipmentId).filter(Boolean))];
    const shipments = await prisma.shipment.findMany({ where: { id: { in: shipmentIds } }, select: { id: true, trackingNo: true } });
    const tnMap = new Map(shipments.map((s) => [s.id, s.trackingNo]));
    ok(res, {
      items: rows.map((item) => ({
        id: item.id,
        shipmentId: item.shipmentId ?? undefined,
        shipmentTrackingNo: item.shipmentId ? (tnMap.get(item.shipmentId) ?? null) : null,
        orderId: item.orderId ?? undefined,
        status: item.status,
        remark: item.remark ?? undefined,
        updatedAt: item.updatedAt.toISOString(),
      })),
    });
  });

  app.post("/admin/customs/cases", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;
    const body = (req.body ?? {}) as { shipmentId?: string; orderId?: string; status?: string; remark?: string };
    const status = body.status?.trim();
    if (!status) {
      fail(res, 400, "BAD_REQUEST", "status is required");
      return;
    }
    const VALID_CUSTOMS_STATUSES = ["pending", "inspection", "cleared", "rejected"];
    if (!VALID_CUSTOMS_STATUSES.includes(status)) {
      fail(res, 400, "BAD_REQUEST", `status must be one of: ${VALID_CUSTOMS_STATUSES.join(", ")}`);
      return;
    }
    const id = `cus_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const created = await prisma.adminCustomsCase.create({
      data: {
        id,
        companyId: auth.companyId,
        shipmentId: body.shipmentId?.trim() || null,
        orderId: body.orderId?.trim() || null,
        status,
        remark: body.remark?.trim() || null,
      },
      select: { id: true, updatedAt: true },
    });
    ok(res, { id: created.id, updatedAt: created.updatedAt.toISOString() });
  });

  app.get("/admin/lastmile/orders", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    /**
     * ⚠️⚠️ 这里必须用 select 一个个点名要字段，**绝不能用 include 或不写 select**。
     *
     * 2026-08-22 实测：原来这里是 include（等于把所有标量字段都查出来），
     * 而这张表里 `signImageBase64`（数据库列 sign_product_image_base64）存的是签收凭证 base64 原图 ——
     * 570 条派送单里 553 条带图，**光图片就 181 MB，最大单张 4.9 MB**。
     * nginx 日志实测：这个接口**平均每次返回 113 MB**，118 次调用烧掉 13.4 GB 流量。
     *
     * 后果是三重的：
     *   ① 后端每被调一次就吞 100 多 MB 内存 —— 线上 API 因此**每 6 天被 V8 堆撑爆一次**
     *      （日志原话：FATAL ERROR: JavaScript heap out of memory，崩时已跑 144 小时）
     *   ② 员工每打开一次「尾端派送」就要下 113 MB，页面自然慢（用户原话：「每次都加载很慢」）
     *   ③ 白烧流量
     *
     * 而页面上那些图**只显示成 40×40 的缩略图** —— 为了一个指甲盖大的图下载 113 MB。
     *
     * 现在列表只回一个「有没有图」的布尔值；真要看图时走
     * `/admin/lastmile/sign-image?id=xxx` 单张取。
     * （CLAUDE.md 第 3 条早就写了「大数据量字段不要随列表返回」，这里是同一个错换了个地方。）
     */
    const rows = await prisma.adminLastmileOrder.findMany({
      where: { companyId: auth.companyId },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        deliveryNo: true,
        shipmentId: true,
        deliveryDate: true,
        carrierName: true,
        externalTrackingNo: true,
        driverName: true,
        licensePlate: true,
        phoneNumber: true,
        status: true,
        updatedAt: true,
        // signImageBase64（数据库列 sign_product_image_base64）故意不查 —— 见上面那段
        shipment: { select: { trackingNo: true, order: { select: { clientId: true } } } },
      },
    });

    // 「这条有没有签收图」单独用一次轻量查询算出来：只取 id，不碰图片内容。
    // 用 `not: null` + `not: ""` 是因为历史数据里两种空值都有。
    const withImageIds = new Set(
      (await prisma.adminLastmileOrder.findMany({
        where: {
          companyId: auth.companyId,
          AND: [{ signImageBase64: { not: null } }, { signImageBase64: { not: "" } }],
        },
        select: { id: true },
      })).map((r) => r.id),
    );
    ok(res, {
      items: rows.map((item) => ({
        id: item.id,
        deliveryNo: item.deliveryNo,
        shipmentId: item.shipmentId,
        trackingNo: item.shipment?.trackingNo ?? item.shipmentId,
        clientId: item.shipment?.order?.clientId ?? null,
        deliveryDate: item.deliveryDate,
        carrierName: item.carrierName,
        externalTrackingNo: item.externalTrackingNo,
        driverName: item.driverName,
        licensePlate: item.licensePlate,
        phoneNumber: item.phoneNumber,
        // 只告诉前端「有没有图」，图本身走 /admin/lastmile/sign-image 单张取
        hasSignImage: withImageIds.has(item.id),
        status: item.status,
        updatedAt: item.updatedAt.toISOString(),
      })),
    });
  });

  /**
   * 单独取一张签收凭证（2026-08-22 新增）。
   *
   * 配合上面列表接口的瘦身：列表只回 hasSignImage，用户点「看凭证」时才来这里取那一张。
   * 一次只查一条、只取图片一个字段，最大 4.9 MB —— 而原来是一次 113 MB。
   *
   * ⚠️ 必须带 companyId 查，别只按 id 查（同文件里创建派送单那处就是漏了公司条件的反面教材）。
   */
  app.get("/admin/lastmile/sign-image", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const id = typeof req.query?.id === "string" ? req.query.id.trim() : "";
    if (!id) {
      fail(res, 400, "BAD_REQUEST", "id 为必填");
      return;
    }
    const row = await prisma.adminLastmileOrder.findFirst({
      where: { id, companyId: auth.companyId },
      select: { signImageBase64: true },
    });
    if (!row) {
      fail(res, 404, "NOT_FOUND", "派送单不存在");
      return;
    }
    ok(res, { signImageBase64: row.signImageBase64 || null });
  });

  app.post("/admin/lastmile/orders", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const body = (req.body ?? {}) as { shipmentIds?: string[]; driverName?: string; licensePlate?: string; phoneNumber?: string; status?: string; deliveryNo?: string; deliveryDate?: string };
    const shipmentIds = (body.shipmentIds ?? []).map(s => s.trim()).filter(Boolean);
    let driverName = body.driverName?.trim() || "";
    let licensePlate = body.licensePlate?.trim() || "";
    let phoneNumber = body.phoneNumber?.trim() || "";
    let deliveryDate = body.deliveryDate?.trim() || "";
    const status = body.status?.trim() || "DELIVERING";
    const existingDeliveryNo = body.deliveryNo?.trim();
    if (shipmentIds.length === 0) {
      fail(res, 400, "BAD_REQUEST", "at least one shipmentId is required");
      return;
    }
    // 2026-08-06：派送日期在库里是纯文本，原来填什么存什么 ——
    // 生产上真出现过 WD000199 的日期是「20206-08-06」（年份多打一个 0）。
    // 前端那个 <input type="date"> 拦不住五位数年份，只能在这里卡。
    if (deliveryDate) {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(deliveryDate);
      const d = m ? new Date(`${deliveryDate}T00:00:00Z`) : null;
      const year = m ? Number(m[1]) : 0;
      const validCalendarDate = !!d && !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === deliveryDate;
      // 上下界放宽到 2020～当年+2，够用又能挡住手滑（2 月 30 号这种也会被上面那句挡掉）
      const thisYear = new Date().getUTCFullYear();
      if (!validCalendarDate || year < 2020 || year > thisYear + 2) {
        fail(res, 400, "VALIDATION_ERROR", `派送日期不对：${deliveryDate}。正确格式是 2026-08-06 这样的年-月-日`);
        return;
      }
    }
    // 生成或复用派送单号
    let deliveryNo: string;
    if (existingDeliveryNo) {
      // 追加到已有派送单，继承司机信息
      const exist = await prisma.adminLastmileOrder.findFirst({ where: { deliveryNo: existingDeliveryNo, companyId: auth.companyId }, select: { deliveryNo: true, driverName: true, licensePlate: true, phoneNumber: true, deliveryDate: true } });
      if (!exist) { fail(res, 404, "NOT_FOUND", "deliveryNo not found"); return; }
      deliveryNo = existingDeliveryNo;
      // 追加时不传司机信息则继承已有值
      if (!driverName) driverName = exist.driverName ?? "";
      if (!licensePlate) licensePlate = exist.licensePlate ?? "";
      if (!phoneNumber) phoneNumber = exist.phoneNumber ?? "";
      if (!deliveryDate) deliveryDate = exist.deliveryDate ?? "";
    } else {
      deliveryNo = await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(2901)');
        const last = await tx.adminLastmileOrder.findFirst({
          where: { deliveryNo: { startsWith: "WD" } },
          orderBy: { deliveryNo: "desc" },
          select: { deliveryNo: true },
        });
        const num = last ? parseInt(last.deliveryNo.replace("WD", ""), 10) || 0 : 0;
        return `WD${String(num + 1).padStart(6, "0")}`;
      });
    }
    
    // 2026-08-06：原来是「一个运单一个事务」，循环里第 N 个失败时，前 N-1 个已经提交了 ——
    // 运单状态被改成「派送中」、派送单却没建成，留下查不到派送单的孤儿运单（生产实测 3 张）。
    // 现在整车放进**同一个事务**：要么全部成功，要么一条都不写。
    // 2026-08-06：出车这条轨迹带上司机姓名和电话，客户看到的是
    // 「司机【张三 - 0993176818】正在为您派送，请注意查收」。
    // ⚠️ 司机信息不是必填 —— 没填就退回原来的写法，别弄出「司机【】」这种东西。
    const driverLabel = [driverName, phoneNumber].filter(Boolean).join(" - ");
    const departRemark = driverLabel
      ? `司机【${driverLabel}】正在为您派送，请注意查收`
      : `正在为您派送，请注意查收（${deliveryNo}）`;

    const results: Array<{ id: string; shipmentId: string }> = [];
    try {
      await prisma.$transaction(async (tx) => {
        for (const sid of shipmentIds) {
          /**
           * ⚠️ 一票货不能同时在两张「还没签收」的派送单里（2026-08-25 新增）。
           *
           * 数据库的唯一约束只管住了「同一张派送单里不能重复放同一票货」
           * （@@unique([deliveryNo, shipmentId])），**管不住跨派送单**。
           * 生产实测 4 票货进了两张单、5 行状态互相打架，比如：
           *   SZ260702524-1  WD000326 显示「派送中」，WD000379 显示「已签收」
           * 更麻烦的是删单：删掉其中一张会把运单退回「已到仓」，
           * 另一张明明还在派送中，货就从流程里消失了。
           *
           * ⚠️ 只挡「派送中」，**不挡已签收** —— 「删单重派 / 真的派两趟」是正常业务
           * （2026-08-14 用户拍板：数据忠实记录，不算毛病）。签收完再派一趟要放行。
           *
           * ⚠️ 先给运单行上锁再查：两个员工同时把同一票货加进各自的派送单时，
           * 不锁的话两边都查到「没有在途派送单」，双双放行。
           */
          await tx.$queryRaw`SELECT id FROM shipments WHERE id = ${sid} FOR UPDATE`;
          const busy = await tx.adminLastmileOrder.findFirst({
            where: { shipmentId: sid, companyId: auth.companyId, status: "DELIVERING" },
            select: { deliveryNo: true },
          });
          if (busy) {
            const no = await tx.shipment.findUnique({ where: { id: sid }, select: { trackingNo: true } });
            throw new LastmileConflictError(
              `运单 ${no?.trackingNo ?? sid} 已经在派送单 ${busy.deliveryNo} 里派送中了，不能重复派。要改派请先把那张单删掉或签收。`,
            );
          }

          const id = `lm_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
          const now = new Date();
          await tx.adminLastmileOrder.create({
            data: { id, companyId: auth.companyId, deliveryNo, shipmentId: sid, carrierName: "自营", driverName, licensePlate, phoneNumber, deliveryDate, externalTrackingNo: "", status },
          });
          // 同步运单状态 + 日志
          const ship = await tx.shipment.findUnique({ where: { id: sid }, select: { currentStatus: true, parentTrackingNo: true } });
          if (ship) {
            await tx.shipment.update({ where: { id: sid }, data: { currentStatus: "outForDelivery", updatedAt: now } });
            await tx.statusLog.create({
              data: { id: `sl_lm_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, companyId: auth.companyId, shipmentId: sid, operatorId: auth.userId, operatorRole: auth.role, operatorName: auth.name ?? "", fromStatus: ship.currentStatus, toStatus: "outForDelivery", remark: departRemark, changedAt: now },
            });
            if (ship.parentTrackingNo) {
              // ⚠️ 不能直接把父单写成 outForDelivery：分柜后可能只有一个子单出去派送，
              // 其余还在仓库。按全部子单重新推算（2026-08-22）。
              await syncParentStatusFromChildren(tx, ship.parentTrackingNo, auth.companyId);
            }
          }
          results.push({ id, shipmentId: sid });
        }
      });
    } catch (e: any) {
      // 重复装同一票货（(delivery_no, shipment_id) 唯一）说人话，别把 Prisma 原文抛给员工
      // 注意：ApiCode 里没有 CONFLICT（只有 BAD_REQUEST/UNAUTHORIZED/FORBIDDEN/
      // NOT_FOUND/VALIDATION_ERROR/INTERNAL_ERROR），别顺手写 "CONFLICT" ——
      // 项目里已经有两处那么写、常年挂在 tsc 基线错误里了，不要再添一处
      if (e instanceof LastmileConflictError) {
        fail(res, 409, "VALIDATION_ERROR", e.message);
        return;
      }
      if (e?.code === "P2002") {
        fail(res, 409, "VALIDATION_ERROR", "选中的运单里有已经在这张派送单里的，请去掉后重试");
        return;
      }
      throw e;
    }
    ok(res, { deliveryNo, count: results.length });
  });

  // 尾程派送状态更新
  app.post("/admin/lastmile/status", async (req, res) => {
    const auth = requireRole(req, res, ["admin", "staff"]);
    if (!auth) return;
    const body = (req.body ?? {}) as { id?: string; status?: string; signImageBase64?: string };
    if (!body.id || !body.status) { fail(res, 400, "BAD_REQUEST", "id and status required"); return; }
    const updateData: any = { status: body.status };
    if (body.signImageBase64) updateData.signImageBase64 = body.signImageBase64;
    const now = new Date();

    /**
     * ⚠️ 整个签收动作必须在**同一个事务**里（2026-08-25 改）。
     *
     * 原来是两段：先单独 `update` 派送单（状态 + 签收图立刻提交），
     * 再另开一个事务改运单、写轨迹、算父单。第二段失败就留下
     * **「派送单显示已签收、还有签收凭证，但运单还停在派送中」** ——
     * 员工看到货签收了，客户看到货还在路上，两边对不上而且没人会发现。
     *
     * 合成一个事务之后：要么全部生效，要么一个字都不写，派送单也不会单独变成已签收。
     *
     * ⚠️ 顺带补上 companyId 过滤 —— 原来只按 id 查，等于别家公司的派送单也能改。
     * 目前生产只有一家公司，暂时没影响，但接第二家之前必须是现在这样。
     */
    const updated = await prisma.$transaction(async (tx) => {
      const own = await tx.adminLastmileOrder.findFirst({
        where: { id: body.id, companyId: auth.companyId },
        select: { id: true },
      });
      if (!own) return null;

      const row = await tx.adminLastmileOrder.update({ where: { id: own.id }, data: updateData });
      if (body.status !== "SIGNED") return row;

      {
        const updated = row;
        const shipment = await tx.shipment.findUnique({ where: { id: updated.shipmentId }, select: { id: true, currentStatus: true, parentTrackingNo: true } });
        if (shipment) {
          await tx.shipment.update({ where: { id: shipment.id }, data: { currentStatus: "delivered", updatedAt: now } });
          await tx.statusLog.create({
            data: {
              id: `sl_lm_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              companyId: auth.companyId, shipmentId: shipment.id,
              operatorId: auth.userId, operatorRole: auth.role, operatorName: auth.name ?? "",
              fromStatus: shipment.currentStatus, toStatus: "delivered",
              remark: `尾程派送已签收（${updated.deliveryNo ?? updated.id}）`,
              changedAt: now,
            },
          });
          // 同步父运单
          if (shipment.parentTrackingNo) {
            // ⚠️⚠️ 这里原来是「任何一个子单签收 → 父单直接写成已签收」。
            // 生产实测造成 7 张父单显示「已签收」，子单却还在「已到仓」——
            // 客户订单列表看到已签收、点开轨迹却看到货在仓库。改成按全部子单推算：
            // **全部子单都签收了，父单才签收**（2026-08-22）。
            await syncParentStatusFromChildren(tx, shipment.parentTrackingNo, auth.companyId);
          }
        }
      }
      return row;
    });

    if (!updated) { fail(res, 404, "NOT_FOUND", "派送单不存在"); return; }
    ok(res, { id: updated.id, status: updated.status });
  });

  // 删除派送单
  app.delete("/admin/lastmile/orders", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const id = req.query.id as string;
    if (!id) { fail(res, 400, "BAD_REQUEST", "id required"); return; }

    // 2026-08-06：原来只 deleteMany 一行就完事，**运单状态留在「派送中」没人管** ——
    // 派送单没了、运单却还显示派送中，尾端派送列表里也挑不到它（那个列表只看已到仓/派送中/已签收
    // 里能对上派送单的），等于这票货从流程里消失。生产实测 YW0001244 就是这么卡了将近一个月。
    // 现在：删记录的同时把运单退回「已到仓」，并写一条状态轨迹说明原因。
    const now = new Date();
    const result = await prisma.$transaction(async (tx) => {
      const row = await tx.adminLastmileOrder.findFirst({
        where: { id, companyId: auth.companyId },
        select: { id: true, shipmentId: true, deliveryNo: true },
      });
      if (!row) return { deleted: false, reverted: false };

      await tx.adminLastmileOrder.delete({ where: { id: row.id } });

      const ship = await tx.shipment.findUnique({
        where: { id: row.shipmentId },
        select: { id: true, currentStatus: true, parentTrackingNo: true },
      });
      // 只在「还在派送中」时退回。已经签收的不动 —— 货都签收了，不该因为删一张单就变回没送。
      if (!ship || ship.currentStatus !== "outForDelivery") return { deleted: true, reverted: false };

      /**
       * ⚠️ 这票货可能还在**别的**派送单里派着（2026-08-25 新增）。
       *
       * 历史数据里有 4 票货同时进了两张派送单。删掉其中一张就把运单退回「已到仓」，
       * 可另一张还在「派送中」—— 员工看着车已经出去了，系统却说货在仓库。
       * 上面新加的拦截能防止以后再出现，但**存量数据还在**，所以删除这边也得防一手。
       */
      const stillOut = await tx.adminLastmileOrder.findFirst({
        where: { shipmentId: ship.id, companyId: auth.companyId, status: "DELIVERING" },
        select: { deliveryNo: true },
      });
      if (stillOut) return { deleted: true, reverted: false, stillIn: stillOut.deliveryNo };

      await tx.shipment.update({ where: { id: ship.id }, data: { currentStatus: "inWarehouseTH", updatedAt: now } });
      await tx.statusLog.create({
        data: {
          id: `sl_lmdel_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          companyId: auth.companyId, shipmentId: ship.id,
          operatorId: auth.userId, operatorRole: auth.role, operatorName: auth.name ?? "",
          fromStatus: "outForDelivery", toStatus: "inWarehouseTH",
          remark: `删除派送单（${row.deliveryNo}），退回已到仓`, changedAt: now,
        },
      });

      // 父单按全部子单重新推算（2026-08-22 统一成 syncParentStatusFromChildren）。
      //
      // 这里原来自己写了一套「名下没有其他派送中/已签收的子单才退回」的判断 ——
      // 方向是对的（比另外两处强），但只处理 outForDelivery → inWarehouseTH 这一种情形，
      // 其余情形照样会把父单留在错误状态上。四个改父单状态的地方共用同一个函数，
      // 才不会下次又有人只改其中一处。
      if (ship.parentTrackingNo) {
        await syncParentStatusFromChildren(tx, ship.parentTrackingNo, auth.companyId);
      }
      return { deleted: true, reverted: true };
    });

    if (!result.deleted) { fail(res, 404, "NOT_FOUND", "派送单不存在"); return; }
    ok(res, {
      deleted: true,
      reverted: result.reverted,
      // 这票货还在别的派送单里，所以没退回「已到仓」—— 说清楚，别让员工以为没生效
      message: (result as any).stillIn
        ? `已删除。这票货还在派送单 ${(result as any).stillIn} 里派送中，所以运单状态保持「派送中」。`
        : undefined,
    });
  });

  app.get("/admin/settlement/entries", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;
    const rows = await prisma.adminSettlementEntry.findMany({
      where: { companyId: auth.companyId },
      orderBy: { updatedAt: "desc" },
    });
    const orderIds = [...new Set(rows.map((r) => r.orderId))];
    const orders = await prisma.order.findMany({ where: { id: { in: orderIds }, companyId: auth.companyId }, select: { id: true, shipments: { take: 1, orderBy: { updatedAt: "desc" }, select: { trackingNo: true } } } });
    const tnMap = new Map(orders.map((o) => [o.id, o.shipments[0]?.trackingNo ?? null]));
    ok(res, {
      items: rows.map((item) => ({
        id: item.id,
        orderId: item.orderId,
        trackingNo: tnMap.get(item.orderId) ?? null,
        clientReceivable: decToNumber(item.clientReceivable),
        supplierPayable: decToNumber(item.supplierPayable),
        taxFee: decToNumber(item.taxFee),
        currency: item.currency,
        updatedAt: item.updatedAt.toISOString(),
      })),
    });
  });

  app.post("/admin/settlement/entries", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;
    const body = (req.body ?? {}) as {
      orderId?: string;
      clientReceivable?: number;
      supplierPayable?: number;
      taxFee?: number;
      currency?: string;
    };
    const orderId = body.orderId?.trim();
    const clientReceivable = Number(body.clientReceivable);
    const supplierPayable = Number(body.supplierPayable);
    const taxFee = Number(body.taxFee);
    if (!orderId || !Number.isFinite(clientReceivable) || !Number.isFinite(supplierPayable) || !Number.isFinite(taxFee)) {
      fail(res, 400, "BAD_REQUEST", "invalid settlement payload");
      return;
    }
    const id = `set_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const created = await prisma.adminSettlementEntry.create({
      data: {
        id,
        companyId: auth.companyId,
        orderId,
        clientReceivable,
        supplierPayable,
        taxFee,
        currency: body.currency?.trim() || "CNY",
      },
      select: { id: true, updatedAt: true },
    });
    ok(res, { id: created.id, updatedAt: created.updatedAt.toISOString() });
  });

  app.get("/admin/settlement/profit", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;
    const rows = await prisma.adminSettlementEntry.findMany({
      where: { companyId: auth.companyId },
      orderBy: { updatedAt: "desc" },
    });
    const orderIds = [...new Set(rows.map((r) => r.orderId))];
    const orders = await prisma.order.findMany({ where: { id: { in: orderIds }, companyId: auth.companyId }, select: { id: true, shipments: { take: 1, orderBy: { updatedAt: "desc" }, select: { trackingNo: true } } } });
    const tnMap = new Map(orders.map((o) => [o.id, o.shipments[0]?.trackingNo ?? null]));
    ok(res, {
      items: rows.map((item) => {
        const cr = decToNumber(item.clientReceivable);
        const sp = decToNumber(item.supplierPayable);
        const tf = decToNumber(item.taxFee);
        return {
          orderId: item.orderId,
          trackingNo: tnMap.get(item.orderId) ?? null,
          clientReceivable: cr,
          supplierPayable: sp,
          taxFee: tf,
          profit: Number((cr - sp - tf).toFixed(2)),
          currency: item.currency,
          updatedAt: item.updatedAt.toISOString(),
        };
      }),
    });
  });

  app.get("/admin/ops/overview", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;

    // 趋势只需要最近 7 条；顶部“总收入/总成本/总利润”必须汇总全部结算，
    // 不能拿最近 20 条冒充总计。
    const [profitRows, profitTotals] = await Promise.all([
      prisma.adminSettlementEntry.findMany({
        where: { companyId: auth.companyId },
        orderBy: { updatedAt: "desc" },
        take: 7,
      }),
      prisma.adminSettlementEntry.aggregate({
        where: { companyId: auth.companyId },
        _sum: { clientReceivable: true, supplierPayable: true, taxFee: true },
      }),
    ]);
    const profitNumeric = profitRows.map((item) => ({
      orderId: item.orderId,
      clientReceivable: decToNumber(item.clientReceivable),
      supplierPayable: decToNumber(item.supplierPayable),
      taxFee: decToNumber(item.taxFee),
      updatedAt: item.updatedAt.toISOString(),
    }));
    const totalRevenue = decToNumber(profitTotals._sum.clientReceivable);
    const totalCost =
      decToNumber(profitTotals._sum.supplierPayable) + decToNumber(profitTotals._sum.taxFee);
    const totalProfit = totalRevenue - totalCost;
    const grossMarginPercent = totalRevenue > 0 ? Number(((totalProfit / totalRevenue) * 100).toFixed(2)) : 0;
    const profitOrderIds = [...new Set(profitNumeric.map((item) => item.orderId))];
    const profitOrders = await prisma.order.findMany({ where: { id: { in: profitOrderIds }, companyId: auth.companyId }, select: { id: true, shipments: { take: 1, orderBy: { updatedAt: "desc" }, select: { trackingNo: true } } } });
    const trackingNoByOrderId = new Map(profitOrders.map((o) => [o.id, o.shipments[0]?.trackingNo ?? null]));
    const profitTrend = profitNumeric.slice(0, 7).map((item) => ({
      orderId: item.orderId,
      trackingNo: trackingNoByOrderId.get(item.orderId) ?? null,
      profit: Number((item.clientReceivable - item.supplierPayable - item.taxFee).toFixed(2)),
      updatedAt: item.updatedAt,
    }));

    const customsRows = await prisma.adminCustomsCase.findMany({
      where: { companyId: auth.companyId, status: { in: ["inspection", "pending"] } },
      orderBy: { updatedAt: "desc" },
      take: 20,
    });

    const lmpRows = await prisma.adminLmpRate.findMany({
      where: { companyId: auth.companyId },
      orderBy: [{ routeCode: "asc" }, { supplierName: "asc" }, { updatedAt: "desc" }],
    });
    type RateSnapshot = {
      routeCode: string;
      supplierName: string;
      transportMode: string;
      seasonTag: string;
      currency: string;
      quotePrice: number;
      updatedAt: string;
    };
    const latestByKey = new Map<string, RateSnapshot>();
    const previousByKey = new Map<string, RateSnapshot>();
    lmpRows.forEach((item) => {
      // 同一路线和供应商也可能同时有海/陆运、不同季节和不同币种报价；
      // 这些维度不相同时不能互相比较，否则会制造假涨价/假降价提醒。
      const key = JSON.stringify([
        item.routeCode,
        item.supplierName,
        item.transportMode,
        item.seasonTag,
        item.currency,
      ]);
      const snapshot: RateSnapshot = {
        routeCode: item.routeCode,
        supplierName: item.supplierName,
        transportMode: item.transportMode,
        seasonTag: item.seasonTag,
        currency: item.currency,
        quotePrice: decToNumber(item.quotePrice),
        updatedAt: item.updatedAt.toISOString(),
      };
      if (!latestByKey.has(key)) {
        latestByKey.set(key, snapshot);
      } else if (!previousByKey.has(key)) {
        previousByKey.set(key, snapshot);
      }
    });
    const supplierPriceAlerts = Array.from(latestByKey.entries())
      .map(([key, latest]) => {
        const previous = previousByKey.get(key);
        if (!previous) return null;
        const delta = Number((latest.quotePrice - previous.quotePrice).toFixed(2));
        if (Math.abs(delta) < 0.01) return null;
        return {
          routeCode: latest.routeCode,
          supplierName: latest.supplierName,
          transportMode: latest.transportMode,
          seasonTag: latest.seasonTag,
          currency: latest.currency,
          previousQuotePrice: previous.quotePrice,
          latestQuotePrice: latest.quotePrice,
          delta,
          updatedAt: latest.updatedAt,
        };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item))
      .slice(0, 10);

    const customsShipmentIds = [...new Set(customsRows.map((r) => r.shipmentId).filter(Boolean))];
    const customsOrders = await prisma.shipment.findMany({ where: { id: { in: customsShipmentIds }, companyId: auth.companyId }, select: { id: true, trackingNo: true, orderId: true } });
    const trackingNoByShipmentId = new Map(customsOrders.map((s) => [s.id, s.trackingNo]));

    ok(res, {
      profitSummary: {
        totalRevenue: Number(totalRevenue.toFixed(2)),
        totalCost: Number(totalCost.toFixed(2)),
        totalProfit: Number(totalProfit.toFixed(2)),
        grossMarginPercent,
      },
      profitTrend,
      customsAlerts: customsRows.map((item) => ({
        id: item.id,
        shipmentId: item.shipmentId ?? undefined,
        shipmentTrackingNo: item.shipmentId ? (trackingNoByShipmentId.get(item.shipmentId) ?? null) : null,
        orderId: item.orderId ?? undefined,
        status: item.status,
        remark: item.remark ?? undefined,
        updatedAt: item.updatedAt.toISOString(),
      })),
      supplierPriceAlerts,
    });
  });
}
