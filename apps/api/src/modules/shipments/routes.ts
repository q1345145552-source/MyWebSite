// B-5: 已从 node:sqlite 迁移到 Prisma + PostgreSQL（2026-05-20）
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma";
import type { MinimalHttpApp } from "../../server";
import { checkRateLimit, getClientIp, rateLimitKey } from "../core/rate-limit";
import { fail, ok, parseJsonArray, requireRole } from "../core/http-utils";
import { logger } from "../core/logger";
import { loadProductImagesForOrders } from "../orders/product-images";
import { STATUS_FLOW, STATUS_FLOW_LAND, EXCEPTION_STATUSES, DELAY_STATUSES, COMPLETED_STATUSES } from "./status-flow";

interface Kuaidi100QueryPayload {
  com?: string;
  num: string;
}

interface Kuaidi100QueryResponse {
  status?: string;
  message?: string;
  state?: string;
  com?: string;
  nu?: string;
  data?: Array<{
    context?: string;
    ftime?: string;
    time?: string;
  }>;
}

interface Kuaidi100WebQueryResponse {
  status?: string;
  message?: string;
  state?: string;
  com?: string;
  nu?: string;
  data?: Array<{
    context?: string;
    ftime?: string;
    time?: string;
  }>;
}

export function canTransit(fromStatus: string, toStatus: string): boolean {
  if (fromStatus === toStatus) return true;
  if (EXCEPTION_STATUSES.has(toStatus)) return true;
  const fromIndex = STATUS_FLOW.indexOf(fromStatus);
  const toIndex = STATUS_FLOW.indexOf(toStatus);
  // 允许从异常状态恢复到任意正常状态（如取消→重新装柜）
  if (fromIndex < 0 && EXCEPTION_STATUSES.has(fromStatus) && toIndex >= 0) return true;
  if (fromIndex < 0 || toIndex < 0) return false;
  if (toIndex <= fromIndex) return false;
  // 一次只能往前一格，但中间隔着的如果全是「延迟」类状态，可以直接跨过去
  // （没延误的单子不该被逼着先点一下「延迟开船」/「延迟运输」才能往下走）。
  for (let i = fromIndex + 1; i < toIndex; i += 1) {
    if (!DELAY_STATUSES.has(STATUS_FLOW[i]!)) return false;
  }
  return true;
}

/** 宽松版：只要求前进不后退，允许跳步（用于容器批量同步场景） */
export function canTransitLoose(fromStatus: string, toStatus: string): boolean {
  if (fromStatus === toStatus) return true;
  if (EXCEPTION_STATUSES.has(toStatus)) return true;
  // 2026-08-06：海运、陆运两条流程，**任意一条能走通就算合法**。
  // 一票货只会走其中一条（由柜子的运输方式决定），这里不需要知道是哪条 ——
  // 「该不该走这条流程」在柜子那层已经拦过了（containers/routes.ts 的 flowOf）。
  return canTransitInFlow(STATUS_FLOW, fromStatus, toStatus)
    || canTransitInFlow(STATUS_FLOW_LAND, fromStatus, toStatus);
}

function canTransitInFlow(flow: readonly string[], fromStatus: string, toStatus: string): boolean {
  const fromIndex = flow.indexOf(fromStatus);
  const toIndex = flow.indexOf(toStatus);
  if (fromIndex < 0 && EXCEPTION_STATUSES.has(fromStatus) && toIndex >= 0) return true;
  if (fromIndex < 0 || toIndex < 0) return false;
  return toIndex > fromIndex;
}

/** Decimal | null → number | null */
function decToNumber(value: Prisma.Decimal | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return Number(value.toString());
}

/**
 * 计算快递100签名（MD5 大写）。
 */
function createKuaidi100Sign(paramText: string, key: string, customer: string): string {
  return createHash("md5").update(`${paramText}${key}${customer}`).digest("hex").toUpperCase();
}

/**
 * 将快递100状态码映射为中文文案。
 */
function mapKuaidi100State(state?: string): string {
  if (state === "0") return "在途";
  if (state === "1") return "揽收";
  if (state === "2") return "疑难";
  if (state === "3") return "已签收";
  if (state === "4") return "退签";
  if (state === "5") return "派件";
  if (state === "6") return "退回";
  return "未知";
}

export function registerShipmentRoutes(app: MinimalHttpApp): void {
  app.get("/staff/inbound-photos", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const shipmentId = req.query.shipmentId?.trim();
    if (!shipmentId) {
      fail(res, 400, "BAD_REQUEST", "shipmentId is required");
      return;
    }
    const rows = await prisma.staffInboundPhoto.findMany({
      where: { companyId: auth.companyId, shipmentId },
      orderBy: { createdAt: "desc" },
    });
    ok(res, {
      items: rows.map((item) => ({
        id: item.id,
        shipmentId: item.shipmentId,
        operatorId: item.operatorId,
        fileName: item.fileName,
        mime: item.mime,
        contentBase64: item.contentBase64,
        note: item.note ?? undefined,
        createdAt: item.createdAt.toISOString(),
      })),
    });
  });

  app.post("/staff/inbound-photos", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const body = (req.body ?? {}) as {
      shipmentId?: string;
      fileName?: string;
      mime?: string;
      contentBase64?: string;
      note?: string;
    };
    const shipmentId = body.shipmentId?.trim();
    const fileName = body.fileName?.trim();
    const mime = body.mime?.trim();
    const contentBase64 = body.contentBase64?.trim();
    if (!shipmentId || !fileName || !mime || !contentBase64) {
      fail(res, 400, "BAD_REQUEST", "shipmentId, fileName, mime, contentBase64 are required");
      return;
    }
    const shipment = await prisma.shipment.findFirst({
      where: { id: shipmentId, companyId: auth.companyId },
      select: { id: true },
    });
    if (!shipment) {
      fail(res, 404, "NOT_FOUND", "shipment not found");
      return;
    }
    if (contentBase64.length > 4_000_000) {
      fail(res, 400, "BAD_REQUEST", "file too large (max 4MB base64)");
      return;
    }
    const id = `photo_${Date.now()}`;
    const created = await prisma.staffInboundPhoto.create({
      data: {
        id,
        companyId: auth.companyId,
        shipmentId,
        operatorId: auth.userId,
        fileName,
        mime,
        contentBase64,
        note: body.note?.trim() || null,
      },
      select: { id: true, createdAt: true },
    });
    ok(res, { id: created.id, shipmentId, createdAt: created.createdAt.toISOString() });
  });

  app.post("/staff/shipments/set-container", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const body = (req.body ?? {}) as { shipmentId?: string; containerNo?: string };
    const shipmentId = body.shipmentId?.trim();
    const containerNo = body.containerNo?.trim();
    if (!shipmentId || !containerNo) {
      fail(res, 400, "BAD_REQUEST", "shipmentId and containerNo are required");
      return;
    }
    const shipment = await prisma.shipment.findFirst({
      where: { id: shipmentId, companyId: auth.companyId },
      select: { id: true, warehouseId: true },
    });
    if (!shipment) {
      fail(res, 404, "NOT_FOUND", "shipment not found");
      return;
    }
    const updated = await prisma.shipment.update({
      where: { id: shipmentId },
      data: { containerNo },
      select: { updatedAt: true },
    });
    ok(res, { shipmentId, containerNo, updatedAt: updated.updatedAt.toISOString() });
  });

  app.get("/public/track", async (req, res) => {
    // 速率限制：每个 IP 每分钟最多 30 次查询，防止暴力枚举
    const ip = getClientIp(req.headers);
    if (checkRateLimit(rateLimitKey(ip, "track"), 30, 60_000)) {
      fail(res, 429, "BAD_REQUEST", "too many requests, please try again later");
      return;
    }
    const trackingNo = req.query.trackingNo?.trim();
    const phoneLast4 = req.query.phoneLast4?.trim();
    if (!trackingNo || !phoneLast4 || phoneLast4.length !== 4) {
      fail(res, 400, "BAD_REQUEST", "trackingNo and phoneLast4(4 digits) are required");
      return;
    }
    const shipment = await prisma.shipment.findUnique({
      where: { trackingNo },
      include: {
        order: {
          select: {
            id: true,
            itemName: true,
            receiverPhoneTh: true,
            client: { select: { phone: true } },
          },
        },
      },
    });
    if (!shipment) {
      fail(res, 404, "NOT_FOUND", "shipment not found");
      return;
    }
    const receiverPhone = shipment.order.receiverPhoneTh ?? "";
    const clientPhone = shipment.order.client?.phone ?? "";
    const receiverTail = receiverPhone.length >= 4 ? receiverPhone.slice(-4) : "";
    const clientTail = clientPhone.length >= 4 ? clientPhone.slice(-4) : "";
    if (!receiverTail && !clientTail) {
      fail(res, 403, "FORBIDDEN", "phone verification failed");
      return;
    }
    if (phoneLast4 !== receiverTail && phoneLast4 !== clientTail) {
      fail(res, 403, "FORBIDDEN", "phone verification failed");
      return;
    }
    const logs = await prisma.statusLog.findMany({
      where: { shipmentId: shipment.id },
      orderBy: { changedAt: "asc" },
    });
    ok(res, {
      trackingNo: shipment.trackingNo,
      domesticTrackingNo: shipment.domesticTrackingNo ?? undefined,
      batchNo: shipment.batchNo ?? undefined,
      orderId: shipment.order.id,
      itemName: shipment.order.itemName,
      currentStatus: shipment.currentStatus,
      currentLocation: shipment.currentLocation ?? undefined,
      updatedAt: shipment.updatedAt.toISOString(),
      events: logs.map((item) => ({
        fromStatus: item.fromStatus,
        toStatus: item.toStatus,
        remark: item.remark ?? "",
        changedAt: item.changedAt.toISOString(),
      })),
    });
  });

  app.get("/client/express/universal", async (req, res) => {
    const auth = requireRole(req, res, ["client", "staff", "admin"]);
    if (!auth) return;
    const trackingNo = req.query.trackingNo?.trim();
    const companyCode = req.query.companyCode?.trim();
    if (!trackingNo) {
      fail(res, 400, "BAD_REQUEST", "trackingNo is required");
      return;
    }

    const customer = process.env.KUAIDI100_CUSTOMER?.trim();
    const key = process.env.KUAIDI100_KEY?.trim();
    const endpoint = process.env.KUAIDI100_QUERY_URL?.trim() || "https://poll.kuaidi100.com/poll/query.do";
    const webQueryEndpoint = process.env.KUAIDI100_WEB_QUERY_URL?.trim() || "https://www.kuaidi100.com/query";

    if (customer && key) {
      const payload: Kuaidi100QueryPayload = {
        num: trackingNo,
      };
      if (companyCode) payload.com = companyCode;
      const paramText = JSON.stringify(payload);
      const sign = createKuaidi100Sign(paramText, key, customer);
      const body = new URLSearchParams();
      body.set("customer", customer);
      body.set("sign", sign);
      body.set("param", paramText);

      let providerData: Kuaidi100QueryResponse | null = null;
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: body.toString(),
        });
        providerData = (await response.json()) as Kuaidi100QueryResponse;
        if (!response.ok) {
          fail(res, 502, "INTERNAL_ERROR", `kuaidi100 request failed: HTTP ${response.status}`);
          return;
        }
      } catch (error) {
        const text = error instanceof Error ? error.message : "unknown error";
        fail(res, 502, "INTERNAL_ERROR", `kuaidi100 request failed: ${text}`);
        return;
      }

      if (providerData?.status !== "200") {
        fail(res, 400, "BAD_REQUEST", providerData?.message ?? "kuaidi100 query failed");
        return;
      }

      ok(res, {
        trackingNo: providerData.nu ?? trackingNo,
        companyCode: providerData.com ?? companyCode ?? "",
        statusCode: providerData.state ?? "",
        statusText: mapKuaidi100State(providerData.state),
        events: (providerData.data ?? []).map((item) => ({
          time: item.ftime ?? item.time ?? "",
          content: item.context ?? "",
        })),
      });
      return;
    }

    if (!companyCode) {
      fail(res, 400, "BAD_REQUEST", "companyCode is required when KUAIDI100 key is not configured");
      return;
    }

    let webData: Kuaidi100WebQueryResponse | null = null;
    try {
      const query = new URLSearchParams();
      query.set("type", companyCode);
      query.set("postid", trackingNo);
      const response = await fetch(`${webQueryEndpoint}?${query.toString()}`, {
        method: "GET",
      });
      webData = (await response.json()) as Kuaidi100WebQueryResponse;
      if (!response.ok) {
        fail(res, 502, "INTERNAL_ERROR", `kuaidi100 web query failed: HTTP ${response.status}`);
        return;
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : "unknown error";
      fail(res, 502, "INTERNAL_ERROR", `kuaidi100 web query failed: ${text}`);
      return;
    }

    if (webData?.status !== "200") {
      fail(res, 400, "BAD_REQUEST", webData?.message ?? "kuaidi100 web query failed");
      return;
    }

    ok(res, {
      trackingNo: webData.nu ?? trackingNo,
      companyCode: webData.com ?? companyCode,
      statusCode: webData.state ?? "",
      statusText: mapKuaidi100State(webData.state),
      events: (webData.data ?? []).map((item) => ({
        time: item.ftime ?? item.time ?? "",
        content: item.context ?? "",
      })),
    });
  });

  app.get("/client/shipments/search", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;
    const trackingNo = req.query.trackingNo?.trim();
    const domesticTrackingNo = req.query.domesticTrackingNo?.trim();
    const itemName = req.query.itemName?.trim();
    const transportMode = req.query.transportMode?.trim();

    const rows = await prisma.shipment.findMany({
      where: {
        companyId: auth.companyId,
        parentTrackingNo: null,
        order: { clientId: auth.userId },
      },
      orderBy: { updatedAt: "desc" },
      include: {
        order: {
          select: { id: true, clientId: true, itemName: true, transportMode: true, orderNo: true },
        },
      },
    });

    // 加载产品行，用于展示多产品国内单号
    const orderIds = [...new Set(rows.map((r) => r.orderId))];
    let productMap = new Map<string, Array<{ itemName: string; domesticTrackingNo: string }>>();
    if (orderIds.length > 0) {
      const products = await prisma.orderProduct.findMany({
        where: { orderId: { in: orderIds }, companyId: auth.companyId },
        orderBy: { sortOrder: "asc" },
        select: { orderId: true, itemName: true, domesticTrackingNo: true },
      });
      for (const p of products) {
        const list = productMap.get(p.orderId) ?? [];
        list.push({ itemName: p.itemName, domesticTrackingNo: p.domesticTrackingNo });
        productMap.set(p.orderId, list);
      }
    }

    const items = rows
      .filter((r) => !trackingNo || r.trackingNo.includes(trackingNo))
      .filter((r) => {
        if (!domesticTrackingNo) return true;
        // 匹配运单级国内单号 或 任意产品行的国内单号
        if ((r.domesticTrackingNo ?? "").includes(domesticTrackingNo)) return true;
        const prods = productMap.get(r.orderId) ?? [];
        return prods.some((p) => p.domesticTrackingNo.includes(domesticTrackingNo));
      })
      .filter((r) => !itemName || r.order.itemName.includes(itemName))
      .filter((r) => !transportMode || r.order.transportMode === transportMode)
      .map((r) => ({
        id: r.id,
        orderId: r.orderId,
        orderNo: r.order.orderNo ?? undefined,
        trackingNo: r.trackingNo,
        batchNo: r.batchNo,
        currentStatus: r.currentStatus,
        currentLocation: r.currentLocation ?? undefined,
        updatedAt: r.updatedAt.toISOString(),
        weightKg: decToNumber(r.weightKg),
        volumeM3: decToNumber(r.volumeM3),
        packageCount: r.packageCount,
        packageUnit: r.packageUnit,
        domesticTrackingNo: r.domesticTrackingNo,
        // 多产品国内单号
        products: (productMap.get(r.orderId) ?? []).map((p) => ({
          itemName: p.itemName,
          domesticTrackingNo: p.domesticTrackingNo,
        })),
      }));

    ok(res, { items, page: 1, pageSize: items.length, total: items.length });
  });

  app.get("/staff/shipments", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const page = parseInt(req.query.page as string) || 1;
    const pageSize = Math.min(parseInt(req.query.pageSize as string) || 50, 500);
    const includeChildren = req.query.all === "1";
    const where: any = { companyId: auth.companyId };
    if (!includeChildren) where.parentTrackingNo = null;

    // 2026-08-06：按状态筛（逗号分隔，大小写不敏感）。**尾端派送就是因为没有它才漏货的**：
    // 页面原来拿「按更新时间排的前 500 条（所有状态混在一起）」回去自己筛，
    // 全库 1026 张运单里能派送的有 571 张，但排进前 500 的只有 126 张 —— 78% 根本没下发。
    // 不传这个参数时行为与以前完全一致，老调用方不受影响。
    const statusFilter = String(req.query.status ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (statusFilter.length > 0) {
      // 库里存的是 inWarehouseTH 这种驼峰写法，前端历史上一直用小写比对，
      // 这里用不区分大小写的等值匹配，两边怎么写都能对上
      where.OR = statusFilter.map((s) => ({ currentStatus: { equals: s, mode: "insensitive" } }));
    }

    const [total, rows] = await Promise.all([
      prisma.shipment.count({ where }),
      prisma.shipment.findMany({
        where,
        orderBy: { updatedAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          order: {
            include: {
              client: { select: { name: true } },
            },
          },
        },
      }),
    ]);

    const items = rows.map((r) => ({
      id: r.id,
      orderId: r.order?.id ?? undefined,
      orderNo: r.order?.orderNo ?? undefined,
      trackingNo: r.trackingNo,
      parentTrackingNo: r.parentTrackingNo ?? undefined,
      batchNo: r.batchNo,
      containerNo: r.containerNo ?? undefined,
      clientId: r.order?.clientId ?? undefined,
      clientName: r.order?.client?.name ?? undefined,
      itemName: r.order?.itemName ?? undefined,
      domesticTrackingNo: r.domesticTrackingNo ?? undefined,
      packageCount: r.packageCount ?? undefined,
      productQuantity: r.order?.productQuantity ?? undefined,
      weightKg: decToNumber(r.weightKg) ?? undefined,
      volumeM3: decToNumber(r.volumeM3) ?? undefined,
      arrivedAt: r.order?.shipDate ?? undefined,
      currentStatus: r.currentStatus,
      currentLocation: r.currentLocation ?? undefined,
      warehouseId: r.warehouseId,
      updatedAt: r.updatedAt.toISOString(),
      transportMode: r.order?.transportMode ?? undefined,
      shipDate: r.order?.shipDate ?? undefined,
      receiverAddressTh: r.order?.receiverAddressTh ?? undefined,
      receivableAmountCny: decToNumber(r.order?.receivableAmountCny ?? null) ?? undefined,
      receivableCurrency: r.order?.receivableCurrency ?? undefined,
      paymentStatus: (r.order?.paymentStatus === "paid" ? "paid" : "unpaid") as "paid" | "unpaid",
      packageUnit: ((r.order?.packageUnit === "bag" ? "bag" : "box") as "bag" | "box"),
      cargoType: r.order?.cargoType ?? "normal",
      canEdit: auth.role === "admin",
      remark: r.remark ?? undefined,
      productImages: undefined as any[] | undefined,
      products: undefined as any[] | undefined,
    }));

    // 批量加载产品明细 + 产品图
    const orderIds = [...new Set(items.map((i) => i.orderId).filter(Boolean) as string[])];
    if (orderIds.length > 0) {
      const [productRows, imageRows] = await Promise.all([
        prisma.orderProduct.findMany({
          where: { orderId: { in: orderIds } },
          orderBy: { sortOrder: "asc" },
        }),
        prisma.orderProductImage.findMany({
          where: { companyId: auth.companyId, orderId: { in: orderIds } },
          orderBy: { createdAt: "asc" },
        }),
      ]);
      const pmap = new Map<string, any[]>();
      for (const r of productRows) {
        const list = pmap.get(r.orderId) ?? [];
        list.push({ id: r.id, itemName: r.itemName, packageCount: r.packageCount, lengthCm: r.lengthCm, widthCm: r.widthCm, heightCm: r.heightCm, productQuantity: r.productQuantity, cargoType: r.cargoType, domesticTrackingNo: r.domesticTrackingNo, weightKg: r.weightKg });
        pmap.set(r.orderId, list);
      }
      const imap = new Map<string, any[]>();
      for (const r of imageRows) {
        const list = imap.get(r.orderId) ?? [];
        list.push({ id: r.id, fileName: r.fileName, mime: r.mime, imageUrl: r.filePath || undefined, createdAt: r.createdAt.toISOString() });
        imap.set(r.orderId, list);
      }
      for (const item of items) {
        if (item.orderId) {
          item.products = pmap.get(item.orderId);
          item.productImages = imap.get(item.orderId);
        }
      }
    }

    // 补充父运单总件数：父剩余 + 所有子运单件数
    const parentIds = items.filter(i => !i.parentTrackingNo).map(i => i.trackingNo);
    if (parentIds.length > 0) {
      const childRows = await prisma.shipment.findMany({
        where: { parentTrackingNo: { in: parentIds }, companyId: auth.companyId },
        select: { parentTrackingNo: true, packageCount: true },
      });
      const childSum = new Map<string, number>();
      for (const c of childRows) {
        childSum.set(c.parentTrackingNo!, (childSum.get(c.parentTrackingNo!) ?? 0) + (c.packageCount ?? 0));
      }
      for (const item of items) {
        if (!item.parentTrackingNo) {
          (item as any).totalPackageCount = (item.packageCount ?? 0) + (childSum.get(item.trackingNo) ?? 0);
        }
      }
    }

    ok(res, { items, page, pageSize, total });
  });

  // 按需加载单个订单的产品图
  app.get("/staff/shipments/images", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin", "client"]);
    if (!auth) return;
    const orderId = req.query.orderId?.trim();
    if (!orderId) { fail(res, 400, "BAD_REQUEST", "orderId required"); return; }
    // 客户端只能看自己名下订单的图片
    if (auth.role === "client") {
      const own = await prisma.order.findFirst({ where: { id: orderId, clientId: auth.userId, companyId: auth.companyId }, select: { id: true } });
      if (!own) { fail(res, 403, "FORBIDDEN", "无权查看该订单图片"); return; }
    }
    const imageMap = await loadProductImagesForOrders(auth.companyId, [orderId]);
    ok(res, { images: imageMap.get(orderId) ?? [] });
  });

  app.post("/staff/shipments/split", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      parentShipmentId?: string;
      splits?: Array<{
        trackingNo: string;
        batchNo: string;
        itemName: string;
        packageCount: number;
      }>;
    };

    const parentId = body.parentShipmentId?.trim();
    const splits = body.splits ?? [];
    if (!parentId || splits.length === 0) {
      fail(res, 400, "BAD_REQUEST", "parentShipmentId and at least one split are required");
      return;
    }
    if (splits.some((s) => !s.trackingNo?.trim())) {
      fail(res, 400, "BAD_REQUEST", "每一条分柜运单号均为必填");
      return;
    }
    // 检查分柜运单号是否重复
    const splitNos = splits.map((s) => s.trackingNo.trim());
    if (new Set(splitNos).size !== splitNos.length) {
      fail(res, 400, "BAD_REQUEST", "分柜运单号不可重复");
      return;
    }
    const existingNos = await prisma.shipment.findMany({
      where: { trackingNo: { in: splitNos }, companyId: auth.companyId },
      select: { trackingNo: true },
    });
    if (existingNos.length > 0) {
      fail(res, 409, "CONFLICT", `运单号 ${existingNos.map((s) => s.trackingNo).join(", ")} 已存在`);
      return;
    }

    const parent = await prisma.shipment.findUnique({
      where: { id: parentId },
      include: { order: { select: { id: true, companyId: true } } },
    });
    if (!parent || parent.companyId !== auth.companyId) {
      fail(res, 404, "NOT_FOUND", "parent shipment not found");
      return;
    }
    if (parent.parentTrackingNo) {
      fail(res, 400, "BAD_REQUEST", "cannot split a child shipment");
      return;
    }

    const totalSplitCount = splits.reduce((sum, s) => sum + s.packageCount, 0);
    if (totalSplitCount <= 0) {
      fail(res, 400, "BAD_REQUEST", "split total must be greater than zero");
      return;
    }
    const parentPackageCount = parent.packageCount ?? 0;
    if (totalSplitCount > parentPackageCount) {
      fail(res, 400, "BAD_REQUEST", `split total (${totalSplitCount}) exceeds parent package count (${parentPackageCount})`);
      return;
    }

    const results: Array<{ trackingNo: string; shipmentId: string }> = [];

    await prisma.$transaction(async (tx) => {
      // 行级锁：防止并发分柜
      await tx.$queryRaw`SELECT id FROM shipments WHERE id = ${parentId} FOR UPDATE`;

      // 重新读取父单件数（加锁后最新值）
      const locked = await tx.shipment.findUnique({
        where: { id: parentId },
        select: { packageCount: true, volumeM3: true },
      });
      const currentPkg = locked?.packageCount ?? 0;
      if (totalSplitCount > currentPkg) {
        throw new Error(`split total (${totalSplitCount}) exceeds current package count (${currentPkg})`);
      }

      // 更新父单：扣减件数
      await tx.shipment.update({
        where: { id: parent.id },
        data: {
          packageCount: currentPkg - totalSplitCount,
        },
      });

      // 创建子单
      const childMap = new Map<string, { id: string; packageCount: number }>();
      for (let i = 0; i < splits.length; i++) {
        const split = splits[i];
        const childId = `s_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 6)}`;
        const childTrackingNo = split.trackingNo.trim();

        await tx.shipment.create({
          data: {
            id: childId,
            companyId: auth.companyId,
            orderId: parent.orderId,
            trackingNo: childTrackingNo,
            parentTrackingNo: parent.trackingNo,
            batchNo: split.batchNo,
            itemName: split.itemName,
            currentStatus: parent.currentStatus,
            packageCount: split.packageCount,
            packageUnit: parent.packageUnit,
            transportMode: parent.transportMode,
            warehouseId: parent.warehouseId,
          },
        });

        childMap.set(childId, { id: childId, packageCount: split.packageCount });
        results.push({ trackingNo: childTrackingNo, shipmentId: childId });
      }

      // 同步柜内数据：按件数比例精确分配体积和件数
      const containerItems = await tx.shipmentContainerItem.findMany({
        where: { shipmentId: parent.id },
      });

      for (const item of containerItems) {
        const itemVol = Number(item.loadedVolumeM3);
        const itemPcs = item.loadedPieceCount;

        // 父单保留的件数比例
        const parentRatio = (currentPkg - totalSplitCount) / currentPkg;
        const parentVolume = Number((itemVol * parentRatio).toFixed(6));
        const parentPieces = Math.round(itemPcs * parentRatio);

        await tx.shipmentContainerItem.update({
          where: { id: item.id },
          data: {
            loadedVolumeM3: parentVolume,
            loadedPieceCount: parentPieces,
          },
        });

        // 为每个子单分配对应的柜内数据
        for (const [childId, child] of childMap) {
          const childRatio = child.packageCount / currentPkg;
          const childVolume = Number((itemVol * childRatio).toFixed(6));
          const childPieces = Math.round(itemPcs * childRatio);

          if (childPieces > 0) {
            await tx.shipmentContainerItem.create({
              data: {
                shipmentId: childId,
                containerId: item.containerId,
                loadedVolumeM3: childVolume,
                loadedPieceCount: childPieces,
              },
            });
          }
        }
      }
    });

    ok(res, { parentTrackingNo: parent.trackingNo, children: results });
  });

  /**
   * 历史「修复运单关联订单」接口：SQLite 时代的兼容补丁。
   * Postgres 数据通过 Prisma 严格管理，不再有悬空 order_id 问题，故停用。
   */
  app.post("/staff/shipments/repair-order-links", async (_req, res) => {
    ok(res, {
      ok: true,
      repairedCount: 0,
      repairedShipmentIds: [],
      skipped: [],
      note: "此功能在 Postgres 迁移后不再需要",
    });
  });

  /**
   * 删掉物流轨迹里写错的一条（员工和管理员都能用）。
   *
   * 2026-08-07 加的。柜子状态只能往前推，推错了既回不去也改不了 ——
   * 真实案例：运单 YW0001396 已开船之后被误推成「延迟运输」，
   * 客户看到的就是「运输中」突然变「延迟运输」。
   *
   * 删完把运单的当前状态退回到剩下的最后一条轨迹。
   * ⚠️ 如果一条都不剩，当前状态**保持不动** —— 生产库里有 219 张已签收的老运单
   * 压根没有轨迹记录，把它们重置成「已创建」比留着错状态更糟。
   */
  app.post("/staff/shipments/track/delete-log", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const logId = typeof body.logId === "string" ? body.logId.trim() : "";
    if (!logId) {
      fail(res, 400, "BAD_REQUEST", "logId is required");
      return;
    }

    const log = await prisma.statusLog.findFirst({
      where: { id: logId, companyId: auth.companyId },
      include: { shipment: { select: { id: true, trackingNo: true, currentStatus: true } } },
    });
    if (!log) {
      fail(res, 404, "NOT_FOUND", "这条轨迹不存在，可能已经被删掉了");
      return;
    }

    const result = await prisma.$transaction(async (tx) => {
      await tx.statusLog.delete({ where: { id: logId } });

      // 剩下的最后一条决定当前状态；一条不剩就不动它
      const latest = await tx.statusLog.findFirst({
        where: { shipmentId: log.shipmentId },
        orderBy: { changedAt: "desc" },
        select: { toStatus: true },
      });
      if (latest) {
        await tx.shipment.update({
          where: { id: log.shipmentId },
          data: { currentStatus: latest.toStatus, updatedAt: new Date() },
        });
      }
      return { newStatus: latest?.toStatus ?? log.shipment.currentStatus, hasLogsLeft: !!latest };
    });

    // 轨迹是给客户看的记录，谁删了什么必须留痕（只记状态和时间，不记客户信息）
    logger.warn("删除物流轨迹", {
      操作人: auth.userId,
      角色: auth.role,
      运单号: log.shipment.trackingNo,
      删掉的状态: log.toStatus,
      那条的时间: log.changedAt.toISOString(),
      删完当前状态: result.newStatus,
    });

    ok(res, {
      deleted: true,
      trackingNo: log.shipment.trackingNo,
      currentStatus: result.newStatus,
      hasLogsLeft: result.hasLogsLeft,
    });
  });

  /**
   * 顶部那排数字的统计（2026-08-09，A3 方案 §3.2）。
   * 2026-08-10 三端共用：员工端/管理员端数全公司，客户端只数自己的，
   * 差别只有传进来的 where —— 口径必须一模一样，否则三个端对不上数。
   *
   * ⚠️ 「在途」用**减法**算，不要列举状态名。理由见下面 /staff 那条注释。
   */
  async function countShipmentOverview(where: Record<string, unknown>) {
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    /** 延迟 / 需要盯的：延迟开船、海上延误、口岸滞留、海关查验、异常 */
    const ATTENTION = ["delayDeparted", "delayInTransit", "borderDelay", "customsInspect", "exception"];

    const [total, created, atWarehouse, delivering, done, attention, signedThisMonth] =
      await Promise.all([
        prisma.shipment.count({ where }),
        prisma.shipment.count({ where: { ...where, currentStatus: "created" } }),
        prisma.shipment.count({ where: { ...where, currentStatus: "inWarehouseTH" } }),
        prisma.shipment.count({ where: { ...where, currentStatus: "outForDelivery" } }),
        prisma.shipment.count({ where: { ...where, currentStatus: { in: [...COMPLETED_STATUSES] } } }),
        prisma.shipment.count({ where: { ...where, currentStatus: { in: ATTENTION } } }),
        prisma.shipment.count({
          where: { ...where, currentStatus: "delivered", updatedAt: { gte: startOfMonth } },
        }),
      ]);

    // 剩下的全算「在途」——任何没被上面四类认领的状态都不会凭空消失
    const inTransit = total - created - atWarehouse - delivering - done;

    return {
      inTransitCount: Math.max(0, inTransit),
      attentionCount: attention,
      atWarehouseCount: atWarehouse,
      signedThisMonthCount: signedThisMonth,
      // 下面这几个是给「四段相加等于总数」对账用的，界面上不显示
      totalCount: total,
      createdCount: created,
      deliveringCount: delivering,
      doneCount: done,
    };
  }

  /**
   * 客户端「我的订单」顶部那排数字（2026-08-10）。
   * where 比员工端多一条 `order.clientId = 自己`，其余口径完全一致 ——
   * 列表用的是 /client/shipments/search，那边的 where 也是这三条，改一边必须改另一边。
   */
  app.get("/client/shipments/overview", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;

    ok(res, await countShipmentOverview({
      companyId: auth.companyId,
      parentTrackingNo: null,
      order: { clientId: auth.userId },
    }));
  });

  /**
   * 员工端 / 管理员端运单列表顶部那排数字（2026-08-09，A3 方案 §3.2）。
   *
   * 用户选定要这四个：在途 / 延迟·查验 / 已到仓待派送 / 本月已签收。
   * 为什么值得做：有 7 张预报单从 8-01 挂到现在没人收货、有个柜子被误推成
   * 「延迟运输」也是事后才发现 —— 这排数字就是让这些一进来就看见。
   *
   * ⚠️ 「在途」用**减法**算，不要列举状态名。
   * 2026-08-08 管理员端柜子统计踩过：第一版列举在途状态，测试库 16 个柜子只数到 13 个，
   * 漏了两个老状态名，柜子凭空消失且没人发现。
   * 这里同理：精确认领「已创建 / 已到仓 / 派送中 / 已完成」四类，剩下的一律算在途，
   * 以后加了新状态也不会漏。返回里带上 total，四段相加应等于 total，一眼能看出有没有漏。
   */
  app.get("/staff/shipments/overview", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;

    // 只数父运单，跟列表口径一致（子运单是分柜拆出来的，会重复计数）
    ok(res, await countShipmentOverview({
      companyId: auth.companyId,
      parentTrackingNo: null,
    }));
  });
}
