// B-6: 已从 node:sqlite 迁移到 Prisma + PostgreSQL（2026-05-20）
import { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma";
import type { MinimalHttpApp } from "../../server";
import { fail, ok, requireRole } from "../core/http-utils";
import { CONSOLIDATION_CURRENCY, recordRechargeCredit } from "../wallet/consolidation-balance";
import { loadProductImagesForOrders } from "../orders/product-images";
import { loadOrderProducts } from "../orders/routes";
import { hashPassword } from "../auth/crypto-utils";
import { checkPasswordStrength } from "../auth/password-policy";

/** Decimal | null → number | null */
function decToNumber(value: Prisma.Decimal | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return Number(value.toString());
}

/**
 * 根据仓库ID返回允许的运单号前缀（兼容短前缀与历史长前缀）。
 */
function allowedTrackingPrefixesByWarehouse(warehouseId: string): string[] {
  if (warehouseId === "wh_yiwu_01") return ["YW", "YWXT"];
  if (warehouseId === "wh_dongguan_01") return ["DG", "DGXT"];
  if (warehouseId === "wh_guangzhou_01") return ["GZ", "GZXT"];
  return ["XT"];
}

/**
 * 校验运单号是否与仓库前缀一致。
 */
function isTrackingNoMatchedWarehouse(warehouseId: string, trackingNo: string): boolean {
  const normalized = trackingNo.trim().toUpperCase();
  return allowedTrackingPrefixesByWarehouse(warehouseId).some((prefix) => normalized.startsWith(prefix));
}

/**
 * 在给定订单数组上"贴"上配套运单（兼容历史悬空 order_id 数据）。
 * 优先级：order_id 命中 > domestic_tracking_no 命中 > batch_no 命中。
 */
async function attachLinkedShipments(
  companyId: string,
  orders: Array<{
    id: string;
    batchNo: string | null;
    domesticTrackingNo: string | null;
  }>,
): Promise<Map<string, { id: string; trackingNo: string; currentStatus: string; containerNo: string | null }>> {
  if (orders.length === 0) return new Map();

  const orderIds = orders.map((o) => o.id);
  const domesticNos = orders.map((o) => o.domesticTrackingNo).filter((v): v is string => Boolean(v));
  const batchNos = orders.map((o) => o.batchNo).filter((v): v is string => Boolean(v));

  // 一次性把可能匹配的运单全捞出来
  const candidates = await prisma.shipment.findMany({
    where: {
      companyId,
      OR: [
        { orderId: { in: orderIds } },
        ...(domesticNos.length > 0 ? [{ domesticTrackingNo: { in: domesticNos } }] : []),
        ...(batchNos.length > 0 ? [{ batchNo: { in: batchNos } }] : []),
      ],
    },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      orderId: true,
      trackingNo: true,
      currentStatus: true,
      containerNo: true,
      batchNo: true,
      domesticTrackingNo: true,
    },
  });

  const result = new Map<string, { id: string; trackingNo: string; currentStatus: string; containerNo: string | null }>();

  for (const order of orders) {
    // 优先级 1: order_id 命中
    const byOrderId = candidates.find((s) => s.orderId === order.id);
    if (byOrderId) {
      result.set(order.id, {
        id: byOrderId.id,
        trackingNo: byOrderId.trackingNo,
        currentStatus: byOrderId.currentStatus,
        containerNo: byOrderId.containerNo,
      });
      continue;
    }
    // 优先级 2: domestic_tracking_no 命中（且运单本身 order_id 为空）
    if (order.domesticTrackingNo) {
      const byDomestic = candidates.find(
        (s) => !s.orderId && s.domesticTrackingNo === order.domesticTrackingNo,
      );
      if (byDomestic) {
        result.set(order.id, {
          id: byDomestic.id,
          trackingNo: byDomestic.trackingNo,
          currentStatus: byDomestic.currentStatus,
          containerNo: byDomestic.containerNo,
        });
        continue;
      }
    }
    // 优先级 3: batch_no 命中
    if (order.batchNo) {
      const byBatch = candidates.find((s) => !s.orderId && s.batchNo === order.batchNo);
      if (byBatch) {
        result.set(order.id, {
          id: byBatch.id,
          trackingNo: byBatch.trackingNo,
          currentStatus: byBatch.currentStatus,
          containerNo: byBatch.containerNo,
        });
      }
    }
  }

  return result;
}

export function registerAdminRoutes(app: MinimalHttpApp): void {
  app.get("/admin/dashboard/overview", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const [staff, client, newOrder, inTransit, volumeAgg] = await Promise.all([
      prisma.user.count({ where: { companyId: auth.companyId, role: "staff" } }),
      prisma.user.count({ where: { companyId: auth.companyId, role: "client" } }),
      prisma.order.count({
        where: { companyId: auth.companyId, createdAt: { gte: startOfToday } },
      }),
      prisma.shipment.count({
        where: { companyId: auth.companyId, currentStatus: "inTransit" },
      }),
      prisma.shipment.aggregate({
        where: { companyId: auth.companyId, updatedAt: { gte: startOfToday } },
        _sum: { volumeM3: true },
      }),
    ]);

    const totalVolume = volumeAgg._sum.volumeM3 ? Number(volumeAgg._sum.volumeM3.toString()) : 0;

    ok(res, {
      staffAccountCount: staff,
      clientAccountCount: client,
      newOrderCountToday: newOrder,
      inTransitOrderCount: inTransit,
      receivedVolumeM3Today: Number(totalVolume.toFixed(3)),
    });
  });

  app.get("/admin/users", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;

    const role = typeof req.query?.role === "string" ? req.query.role : undefined;
    if (role !== "staff" && role !== "client") {
      // 无 role 过滤时返回所有 staff + client
      const allRows = await prisma.user.findMany({
        where: { companyId: auth.companyId, role: { in: ["staff", "client"] } },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          companyId: true,
          role: true,
          name: true,
          phone: true,
          status: true,
          createdAt: true,
          companyName: true,
          email: true,
        },
      });
      ok(res, { items: allRows });
      return;
    }

    const rows = await prisma.user.findMany({
      where: { companyId: auth.companyId, role },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        companyId: true,
        role: true,
        name: true,
        phone: true,
        status: true,
        createdAt: true,
        companyName: true,
        email: true,
      },
    });

    ok(res, {
      items: rows.map((r) => ({
        id: r.id,
        companyId: r.companyId,
        role: r.role,
        name: r.name,
        phone: r.phone,
        status: r.status,
        createdAt: r.createdAt.toISOString(),
        companyName: r.companyName ?? undefined,
        email: r.email ?? undefined,
      })),
    });
  });

  app.get("/admin/orders", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;

    const page = parseInt(req.query.page as string) || 1;
    const pageSize = Math.min(parseInt(req.query.pageSize as string) || 50, 500);
    const where = { companyId: auth.companyId, parentTrackingNo: null } as const;

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
      currentStatus: r.currentStatus,
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
      canEdit: true,
      approvalStatus: r.order?.approvalStatus ?? undefined,
      remark: r.remark ?? undefined,
      statusGroup: r.order?.statusGroup ?? undefined,
      paidAt: r.order?.paidAt ? r.order?.paidAt.toISOString() : undefined,
      paidBy: r.order?.paidBy ?? undefined,
      createdAt: r.order?.createdAt.toISOString() ?? r.createdAt.toISOString(),
      productImages: [] as any[],
      products: [] as any[],
    }));

    // 按需加载产品图和产品行
    const orderIds = [...new Set(items.map((i) => i.orderId).filter(Boolean) as string[])];
    const imageMap = await loadProductImagesForOrders(auth.companyId, orderIds);
    const productsMap = await loadOrderProducts(auth.companyId, orderIds);

    ok(res, {
      items: items.map((item) => ({
        ...item,
        productImages: item.orderId ? (imageMap.get(item.orderId) ?? []) : [],
        products: item.orderId ? (productsMap.get(item.orderId) ?? []) : [],
      })),
      page,
      pageSize,
      total,
    });
  });

  /**
   * 管理员更新客户端订单基础信息，并同步到关联运单的同名字段。
   */
  app.post("/admin/orders/update", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      orderId?: string;
      clientId?: string;
      itemName?: string;
      cargoType?: string;
      transportMode?: "sea" | "land";
      domesticTrackingNo?: string | null;
      productQuantity?: number;
      packageCount?: number;
      packageUnit?: "bag" | "box";
      weightKg?: number | null;
      volumeM3?: number | null;
      shipDate?: string | null;
      trackingNo?: string | null;
      batchNo?: string | null;
      warehouseId?: string;
      receiverAddressTh?: string;
      containerNo?: string | null;
      remark?: string | null;
      products?: Array<{
        /** 已有产品行的编号；不传表示这是新增的一行 */
        id?: string;
        itemName: string;
        packageCount: number;
        lengthCm?: number;
        widthCm?: number;
        heightCm?: number;
        productQuantity?: number;
        cargoType?: string;
        domesticTrackingNo?: string;
        weightKg?: number;
      }>;
    };

    const rawId = body.orderId?.trim();
    if (!rawId) {
      fail(res, 400, "BAD_REQUEST", "orderId is required");
      return;
    }

    // 支持传入运单ID（shipment id），自动查找关联订单
    let orderId = rawId;
    let exists = await prisma.order.findFirst({
      where: { id: orderId, companyId: auth.companyId },
      select: { id: true, warehouseId: true, batchNo: true, domesticTrackingNo: true, receiverAddressTh: true, paymentStatus: true },
    });
    if (!exists) {
      // 尝试通过运单ID查找
      const shipment = await prisma.shipment.findUnique({
        where: { id: rawId },
        select: { orderId: true, order: { select: { id: true, warehouseId: true, batchNo: true, domesticTrackingNo: true, receiverAddressTh: true, paymentStatus: true } } },
      });
      if (shipment?.order) {
        exists = shipment.order;
        orderId = shipment.order.id;
      }
    }
    if (!exists) {
      fail(res, 404, "NOT_FOUND", "order not found");
      return;
    }

    // 查关联运单（与列表逻辑相同的容错优先级）
    const shipmentMap = await attachLinkedShipments(auth.companyId, [{
      id: exists.id,
      batchNo: exists.batchNo,
      domesticTrackingNo: exists.domesticTrackingNo,
    }]);
    const linkedShipment = shipmentMap.get(exists.id) ?? null;

    // ────────────────────────────────────────────────────────────────
    // 增量更新：只处理本次真正提交上来的字段。
    // 没提交的字段一律不写，避免把别人在这期间的改动覆盖掉。
    // 注意：不能改成「没提交就写默认值/null」，那会静默清空数据。
    // ────────────────────────────────────────────────────────────────
    const has = (k: keyof typeof body) => body[k] !== undefined;

    const itemName = body.itemName?.trim();
    if (has("itemName") && !itemName) {
      fail(res, 400, "BAD_REQUEST", "itemName is required");
      return;
    }

    const productQuantity = has("productQuantity") ? Number(body.productQuantity) : undefined;
    const packageCount = has("packageCount") ? Number(body.packageCount) : undefined;
    if (productQuantity !== undefined && (!Number.isFinite(productQuantity) || productQuantity < 0)) {
      fail(res, 400, "BAD_REQUEST", "invalid productQuantity");
      return;
    }
    if (packageCount !== undefined && (!Number.isFinite(packageCount) || packageCount < 0)) {
      fail(res, 400, "BAD_REQUEST", "invalid packageCount");
      return;
    }

    const packageUnit = has("packageUnit") ? (body.packageUnit === "bag" ? "bag" : "box") : undefined;
    const transportMode = has("transportMode") ? (body.transportMode === "land" ? "land" : "sea") : undefined;
    const domesticTrackingNo = has("domesticTrackingNo") ? (body.domesticTrackingNo?.trim() || null) : undefined; // 传空字符串 = 主动清空
    const weightKg = has("weightKg") ? (body.weightKg === null ? null : Number(body.weightKg)) : undefined;
    const volumeM3 = has("volumeM3") ? (body.volumeM3 === null ? null : Number(body.volumeM3)) : undefined;
    if (weightKg !== undefined && weightKg !== null && !Number.isFinite(weightKg)) {
      fail(res, 400, "BAD_REQUEST", "invalid weightKg");
      return;
    }
    if (volumeM3 !== undefined && volumeM3 !== null && !Number.isFinite(volumeM3)) {
      fail(res, 400, "BAD_REQUEST", "invalid volumeM3");
      return;
    }

    /* 2026-08-07：运单不再涉及金额，应收金额/币种/付款状态不再接受修改。
       字段还留在表里（为了保住历史数据），但没有任何接口能再写它们。 */
    const warehouseId = has("warehouseId") ? (body.warehouseId?.trim() || exists.warehouseId) : undefined;
    const batchNo = has("batchNo") ? (body.batchNo?.trim() || null) : undefined;
    const receiverAddressTh = has("receiverAddressTh") ? (body.receiverAddressTh ?? "").trim() : undefined;
    // trackingNo 本次没提交就沿用现有值（查重仍要用到），但不会再写回运单
    const trackingNo = has("trackingNo") ? (body.trackingNo?.trim() || null) : (linkedShipment?.trackingNo ?? null);
    const containerNo = has("containerNo") ? (body.containerNo?.trim() || null) : undefined;
    if (!trackingNo) {
      fail(res, 400, "BAD_REQUEST", "trackingNo is required");
      return;
    }
    // 查重：排除当前订单下的所有运单
    const orderShipments = await prisma.shipment.findMany({
      where: { orderId: orderId, companyId: auth.companyId },
      select: { id: true },
    });
    const excludeIds = orderShipments.map(s => s.id);
    const conflict = await prisma.shipment.findFirst({
      where: {
        companyId: auth.companyId,
        trackingNo,
        ...(excludeIds.length > 0 ? { NOT: { id: { in: excludeIds } } } : {}),
      },
      select: { id: true },
    });
    if (conflict) {
      fail(res, 400, "BAD_REQUEST", "trackingNo already exists");
      return;
    }

    let shipDate: string | null | undefined = undefined;
    if (has("shipDate")) {
      const rawInput = body.shipDate === null ? "" : String(body.shipDate).trim();
      if (rawInput === "") {
        shipDate = null; // 传了空 = 主动清空
      } else {
        const raw = rawInput.slice(0, 10);
        const parsed = new Date(`${raw}T00:00:00`);
        if (Number.isNaN(parsed.getTime())) {
          fail(res, 400, "BAD_REQUEST", "invalid shipDate");
          return;
        }
        shipDate = raw;
      }
    }

    const now = new Date();

    const txOps: any[] = [
      prisma.order.update({
        where: { id: orderId },
        data: {
          warehouseId,
          batchNo,
          // clientId 在库里是必填，给 null 会直接抛错。
          // 传了非空值才改归属，传空串/不传就保持原样。
          ...(body.clientId?.trim() ? { clientId: body.clientId.trim() } : {}),
          itemName,
          cargoType: body.cargoType?.trim() || undefined,
          transportMode,
          domesticTrackingNo,
          productQuantity,
          packageCount,
          packageUnit,
          weightKg,
          volumeM3,
          receiverAddressTh,
          shipDate,
          updatedAt: now,
        },
      }),
      // 同步所有关联运单（按 order_id 关联的那些）
      // data 里凡是 undefined 的键，Prisma 会跳过不写 —— 也就是「本次没改就不碰」
      prisma.shipment.updateMany({
        where: { orderId, companyId: auth.companyId, parentTrackingNo: null },
        data: {
          warehouseId,
          ...(has("trackingNo") && trackingNo ? { trackingNo } : {}),
          batchNo,
          transportMode,
          domesticTrackingNo,
          packageCount,
          packageUnit,
          weightKg,
          volumeM3,
          containerNo,
          remark: body.remark !== undefined ? body.remark?.trim() || null : undefined,
          updatedAt: now,
        },
      }),
    ];
    // 产品行按行增量同步：带 id 的改、不带 id 的新增、本次没提交的才删。
    // 不再整批删除重建 —— 重建一旦漏字段（曾漏过 weightKg）就会静默丢数据。
    if (body.products && body.products.length > 0) {
      const keepIds = body.products
        .map((p) => p.id?.trim())
        .filter((v): v is string => Boolean(v));

      txOps.push(
        prisma.orderProduct.deleteMany({
          where: {
            orderId,
            companyId: auth.companyId,
            ...(keepIds.length > 0 ? { id: { notIn: keepIds } } : {}),
          },
        }),
      );

      body.products.forEach((p, i) => {
        const data = {
          itemName: p.itemName.trim(),
          packageCount: p.packageCount || 1,
          lengthCm: p.lengthCm ?? null,
          widthCm: p.widthCm ?? null,
          heightCm: p.heightCm ?? null,
          productQuantity: p.productQuantity ?? null,
          cargoType: p.cargoType?.trim() || "normal",
          domesticTrackingNo: p.domesticTrackingNo?.trim() || "货拉拉",
          weightKg: p.weightKg ?? null,
          sortOrder: i,
        };
        const rowId = p.id?.trim();
        if (rowId) {
          // 用 updateMany 而不是 update：where 里带上 orderId + companyId，
          // 传了别的订单的行号也只会匹配不到，不会被改动
          txOps.push(
            prisma.orderProduct.updateMany({
              where: { id: rowId, orderId, companyId: auth.companyId },
              data,
            }),
          );
        } else {
          txOps.push(
            prisma.orderProduct.create({
              data: { companyId: auth.companyId, orderId, ...data },
            }),
          );
        }
      });
    }
    // 事务：订单 + 关联运单 + 产品行一致更新
    await prisma.$transaction(txOps);

    ok(res, {
      orderId,
      updatedAt: now.toISOString(),
    });
  });

  app.post("/admin/users", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      id?: string;
      name?: string;
      phone?: string;
      password?: string;
      role?: string;
    };
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const phone = typeof body.phone === "string" ? body.phone.trim() : "";
    if (!name || !phone) {
      fail(res, 400, "BAD_REQUEST", "name and phone are required");
      return;
    }

    const rawId = typeof body.id === "string" ? body.id.trim() : "";
    const id = rawId || `u_${body.role === "client" ? "client" : "staff"}_${Date.now()}`;
    const targetRole = body.role === "client" ? "client" : "staff";
    const rawPassword = typeof body.password === "string" ? body.password.trim() : "";

    // 新开的员工账号不许用弱口令（客户账号不管，见 set-password 那里的说明）
    if (targetRole === "staff" && rawPassword) {
      const weakReason = checkPasswordStrength(rawPassword, undefined, id);
      if (weakReason) {
        fail(res, 400, "BAD_REQUEST", weakReason);
        return;
      }
    }
    const passwordHash = rawPassword ? hashPassword(rawPassword) : null;

    const existing = await prisma.user.findUnique({ where: { id }, select: { id: true } });
    if (existing) {
      fail(res, 400, "BAD_REQUEST", "user id already exists");
      return;
    }

    const created = await prisma.user.create({
      data: {
        id,
        companyId: auth.companyId,
        role: targetRole,
        name,
        phone,
        status: "active",
        warehouseIds: "[]",
        passwordHash,
      },
      select: { id: true, name: true, role: true, phone: true, createdAt: true },
    });

    ok(res, { id: created.id, name: created.name, phone: created.phone, createdAt: created.createdAt.toISOString() });
  });

  app.post("/admin/users/client", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      id?: string;
      name?: string;
      companyName?: string;
      phone?: string;
      email?: string;
      password?: string;
    };
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const phone = typeof body.phone === "string" ? body.phone.trim() : "";
    if (!name || !phone) {
      fail(res, 400, "BAD_REQUEST", "客户名字和电话号码为必填");
      return;
    }

    const rawId = typeof body.id === "string" ? body.id.trim() : "";
    const id = rawId || `u_client_${Date.now()}`;
    const companyName = typeof body.companyName === "string" ? body.companyName.trim() || null : null;
    const email = typeof body.email === "string" ? body.email.trim() || null : null;

    const existing = await prisma.user.findUnique({ where: { id }, select: { id: true } });
    if (existing) {
      fail(res, 400, "BAD_REQUEST", "该客户账号已存在");
      return;
    }

    const passwordHash = typeof body.password === "string" && body.password.trim()
      ? hashPassword(body.password.trim()) : null;

    const created = await prisma.user.create({
      data: {
        id,
        companyId: auth.companyId,
        role: "client",
        name,
        phone,
        status: "active",
        warehouseIds: "[]",
        passwordHash,
        companyName,
        email,
      },
      select: { id: true, name: true, companyName: true, phone: true, email: true, createdAt: true },
    });

    ok(res, {
      id: created.id,
      name: created.name,
      companyName: created.companyName,
      phone: created.phone,
      email: created.email,
      createdAt: created.createdAt.toISOString(),
    });
  });

  app.post("/admin/users/client/update", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      id?: string;
      name?: string;
      companyName?: string;
      phone?: string;
      email?: string;
      password?: string;
    };
    const id = typeof body.id === "string" ? body.id.trim() : "";
    if (!id) {
      fail(res, 400, "BAD_REQUEST", "客户ID为必填");
      return;
    }

    const existing = await prisma.user.findUnique({
      where: { id },
      select: { id: true, companyId: true, role: true },
    });
    if (!existing) {
      fail(res, 404, "NOT_FOUND", "客户不存在");
      return;
    }
    if (existing.companyId !== auth.companyId) {
      fail(res, 403, "FORBIDDEN", "无权修改其他公司的客户");
      return;
    }
    if (existing.role !== "client") {
      fail(res, 400, "BAD_REQUEST", "只能编辑客户账号");
      return;
    }

    const updateData: Record<string, unknown> = {};
    if (typeof body.name === "string" && body.name.trim()) {
      updateData.name = body.name.trim();
    }
    if (body.companyName !== undefined) {
      updateData.companyName = typeof body.companyName === "string" ? body.companyName.trim() || null : null;
    }
    if (typeof body.phone === "string" && body.phone.trim()) {
      updateData.phone = body.phone.trim();
    }
    if (body.email !== undefined) {
      updateData.email = typeof body.email === "string" ? body.email.trim() || null : null;
    }
    if (typeof body.password === "string" && body.password.trim()) {
      updateData.passwordHash = hashPassword(body.password.trim());
    }

    if (Object.keys(updateData).length === 0) {
      fail(res, 400, "BAD_REQUEST", "没有需要更新的字段");
      return;
    }

    const updated = await prisma.user.update({
      where: { id },
      data: updateData,
      select: { id: true, name: true, companyName: true, phone: true, email: true, createdAt: true },
    });

    ok(res, {
      id: updated.id,
      name: updated.name,
      companyName: updated.companyName,
      phone: updated.phone,
      email: updated.email,
      createdAt: updated.createdAt.toISOString(),
    });
  });

  /**
   * 删除账号 —— 已停用（2026-08-07，用户决定）。
   *
   * 这条路本来就走不通：数据库有 15 张表以 RESTRICT 认着账号
   * （orders / client_addresses / client_wallet_accounts / order_product_images /
   *   audit_logs / consolidation_* / invoices …），名下有任何一条记录就删不掉，
   * 报出来是英文的 500，用户只看到「删除失败」。71 个客户里 62 个有订单，
   * 员工 888888 有 60 张上传过的产品图 —— 实际上谁都删不掉。
   *
   * 用户要的只是「让这个账号登不进来」，那是封禁（/admin/users/toggle-ban）的事，
   * 而且单据、图片、流水全留着，随时能解封。前端入口已改成封禁。
   *
   * ⚠️ 这里保留路由并明确拒绝，而不是直接删掉 —— 万一还有别的调用方，
   * 让它得到一句看得懂的中文，而不是 404。
   */
  app.delete("/admin/users", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;
    fail(
      res,
      403,
      "FORBIDDEN",
      "账号不支持删除（名下的订单、图片、流水都认着它）。请改用「封禁」——账号立刻登不进来，数据全留着，随时可以解除。",
    );
  });

  app.post("/admin/users/set-password", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as { id?: string; password?: string };
    const id = typeof body.id === "string" ? body.id.trim() : "";
    if (!id) {
      fail(res, 400, "BAD_REQUEST", "user id is required");
      return;
    }

    const password = body.password?.trim();
    if (!password) {
      fail(res, 400, "BAD_REQUEST", "password is required");
      return;
    }

    const row = await prisma.user.findUnique({
      where: { id },
      select: { id: true, companyId: true, role: true },
    });
    if (!row) {
      fail(res, 404, "NOT_FOUND", "user not found");
      return;
    }
    if (row.companyId !== auth.companyId) {
      fail(res, 403, "FORBIDDEN", "cannot update user of another company");
      return;
    }
    if (row.role !== "staff" && row.role !== "client") {
      fail(res, 403, "FORBIDDEN", "only staff or client password can be set here");
      return;
    }

    // 2026-08-07：员工账号不许再设弱口令。当天普查出 3 个员工账号的密码
    // 是「888888」「跟账号名一样」这种，员工端能看到全部客户和运单，风险比客户账号大。
    // ⚠️ 客户账号沿用旧规则（不校验强度）—— 用户明确要求先不动客户那边，
    //    他们的密码普遍就是唛头本身，一刀切会让 66 个客户当场登不进去。
    if (row.role === "staff") {
      const weakReason = checkPasswordStrength(password, undefined, id);
      if (weakReason) {
        fail(res, 400, "BAD_REQUEST", weakReason);
        return;
      }
    }

    const passwordHash = hashPassword(password);
    await prisma.user.update({ where: { id }, data: { passwordHash } });
    ok(res, { updated: true, id });
  });

  /**
   * 禁用/启用用户（管理员）。
   */
  app.post("/admin/users/toggle-ban", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as { id?: string };
    const id = typeof body.id === "string" ? body.id.trim() : "";
    if (!id) {
      fail(res, 400, "BAD_REQUEST", "user id is required");
      return;
    }

    const row = await prisma.user.findUnique({
      where: { id },
      select: { id: true, companyId: true, status: true, role: true },
    });
    if (!row) {
      fail(res, 404, "NOT_FOUND", "user not found");
      return;
    }
    if (row.companyId !== auth.companyId) {
      fail(res, 403, "FORBIDDEN", "cannot toggle user of another company");
      return;
    }
    // 2026-08-07：封禁成了停用账号的唯一手段，这道保险更要紧了。
    // 全系统只有一个管理员账号，一旦把它封了就再也登不进后台，
    // 只能直接进数据库改状态才能救回来。管理员一律不许封。
    if (row.role === "admin") {
      fail(res, 403, "FORBIDDEN", "管理员账号不能封禁，否则会把自己锁在系统外面");
      return;
    }

    const newStatus = row.status === "active" ? "inactive" : "active";
    await prisma.user.update({ where: { id }, data: { status: newStatus } });
    ok(res, { id, status: newStatus });
  });

  /**
   * 管理员删除运单（级联删除状态日志、产品图、产品行、运单本身、订单）
   */
  app.post("/admin/orders/delete", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;

    const body = (req.body ?? {}) as { orderId?: string };
    const orderId = body.orderId?.trim();
    if (!orderId) {
      fail(res, 400, "BAD_REQUEST", "orderId is required");
      return;
    }

    const order = await prisma.order.findFirst({
      where: { id: orderId, companyId: auth.companyId },
      include: { shipments: { select: { id: true } } },
    });
    if (!order) {
      fail(res, 404, "NOT_FOUND", "order not found");
      return;
    }

    // 事务：级联清理所有关联记录后删除订单
    await prisma.$transaction(async (tx) => {
      for (const s of order.shipments) {
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

    ok(res, { deleted: true, orderId, itemName: order.itemName });
  });

  // ===== 管理员：充值审核列表 =====
  app.get("/admin/wallet/recharges", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;
    const statusFilter = (req.query?.status ?? "") as string;
    const where: any = { companyId: auth.companyId };
    if (statusFilter && ["PENDING", "APPROVED", "REJECTED"].includes(statusFilter)) {
      where.status = statusFilter;
    }
    const rows = await prisma.walletRecharge.findMany({
      where,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        clientId: true,
        currency: true,
        amount: true,
        paymentMethod: true,
        proofImage: true,
        status: true,
        remark: true,
        reviewRemark: true,
        reviewedBy: true,
        createdAt: true,
        updatedAt: true,
        client: { select: { name: true, companyName: true } },
        reviewer: { select: { name: true } },
      },
    });
    ok(res, {
      recharges: rows.map((r) => ({
        id: r.id,
        clientId: r.clientId,
        clientName: r.client.name,
        companyName: r.client.companyName,
        currency: r.currency,
        amount: Number(r.amount.toString()),
        paymentMethod: r.paymentMethod,
        proofImage: r.proofImage,
        status: r.status,
        remark: r.remark,
        reviewRemark: r.reviewRemark,
        reviewedBy: r.reviewedBy,
        reviewerName: r.reviewer?.name ?? null,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      })),
    });
  });

  // ===== 管理员：通过充值申请 =====
  app.post("/admin/wallet/recharges/approve", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;
    const body = (req.body ?? {}) as { id?: string };
    const id = body.id?.trim();
    if (!id) { fail(res, 400, "BAD_REQUEST", "缺少充值ID"); return; }

    const recharge = await prisma.walletRecharge.findFirst({
      where: { id, companyId: auth.companyId },
    });
    if (!recharge) { fail(res, 404, "NOT_FOUND", "充值记录不存在"); return; }
    if (recharge.status !== "PENDING") {
      fail(res, 400, "BAD_REQUEST", "该充值申请已处理过");
      return;
    }

    await prisma.$transaction(async (tx) => {
      // 更新充值状态
      await tx.walletRecharge.update({
        where: { id },
        data: { status: "APPROVED", reviewedBy: auth.userId },
      });
      // 增加客户端对应币种余额
      await tx.clientWalletAccount.upsert({
        where: {
          clientId_currency: {
            clientId: recharge.clientId,
            currency: recharge.currency,
          },
        },
        create: {
          clientId: recharge.clientId,
          companyId: recharge.companyId,
          currency: recharge.currency,
          balance: recharge.amount,
        },
        update: {
          balance: { increment: recharge.amount },
        },
      });
      // 2026-08-07：钱到账要记一行流水，客户才对得上账。
      // 只有人民币才是集货余额，历史遗留的其它币种不记流水。
      if (recharge.currency === CONSOLIDATION_CURRENCY) {
        await recordRechargeCredit(tx as any, {
          companyId: recharge.companyId,
          clientId: recharge.clientId,
          amount: Number(recharge.amount),
          refType: "recharge",
          refId: recharge.id,
          refNo: recharge.id,
          remark: "充值审核通过",
          operatorId: auth.userId,
          operatorName: auth.name || auth.userId,
        });
      }
    });

    ok(res, { approved: true, id });
  });

  // ===== 管理员：拒绝充值申请 =====
  app.post("/admin/wallet/recharges/reject", async (req, res) => {
    const auth = requireRole(req, res, ["admin"]);
    if (!auth) return;
    const body = (req.body ?? {}) as { id?: string; reviewRemark?: string };
    const id = body.id?.trim();
    if (!id) { fail(res, 400, "BAD_REQUEST", "缺少充值ID"); return; }
    const reviewRemark = (body.reviewRemark ?? "").trim();
    if (!reviewRemark) {
      fail(res, 400, "BAD_REQUEST", "请填写拒绝原因");
      return;
    }

    const recharge = await prisma.walletRecharge.findFirst({
      where: { id, companyId: auth.companyId },
    });
    if (!recharge) { fail(res, 404, "NOT_FOUND", "充值记录不存在"); return; }
    if (recharge.status !== "PENDING") {
      fail(res, 400, "BAD_REQUEST", "该充值申请已处理过");
      return;
    }

    await prisma.walletRecharge.update({
      where: { id },
      data: { status: "REJECTED", reviewRemark, reviewedBy: auth.userId },
    });

    ok(res, { rejected: true, id });
  });

  // ===== 员工端：查看所有客户余额 =====
  app.get("/staff/wallet/balances", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const accounts = await prisma.clientWalletAccount.findMany({
      where: { companyId: auth.companyId },
      orderBy: { clientId: "asc" },
      select: {
        clientId: true,
        currency: true,
        balance: true,
        updatedAt: true,
      },
    });
    // 查询客户姓名
    const clientIds = [...new Set(accounts.map((a) => a.clientId))];
    const users = await prisma.user.findMany({
      where: { id: { in: clientIds }, companyId: auth.companyId },
      select: { id: true, name: true, companyName: true },
    });
    const userMap = new Map(users.map((u) => [u.id, u]));

    // 按客户分组
    const map = new Map<string, { cny: number; thb: number }>();
    for (const a of accounts) {
      if (!map.has(a.clientId)) map.set(a.clientId, { cny: 0, thb: 0 });
      const entry = map.get(a.clientId)!;
      if (a.currency === "CNY") entry.cny = Number(a.balance.toString());
      if (a.currency === "THB") entry.thb = Number(a.balance.toString());
    }

    ok(res, {
      balances: [...map.entries()].map(([clientId, b]) => ({
        clientId,
        clientName: userMap.get(clientId)?.name ?? "",
        companyName: userMap.get(clientId)?.companyName ?? "",
        cny: b.cny,
        thb: b.thb,
      })),
    });
  });

  // ===== 管理员：线下付款审核列表 =====

  // ===== 管理员：通过线下付款 =====

  // ===== 管理员：拒绝线下付款 =====

}