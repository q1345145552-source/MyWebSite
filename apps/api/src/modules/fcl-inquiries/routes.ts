import { prisma } from "../../db/prisma";
import type { MinimalHttpApp } from "../../server";
import { fail, ok, requireRole } from "../core/http-utils";

export function registerFclInquiryRoutes(app: MinimalHttpApp): void {
  // 客户端提交整柜询价
  app.post("/client/fcl-inquiries", async (req, res) => {
    const auth = requireRole(req, res, ["client"]);
    if (!auth) return;
    const body = (req.body ?? {}) as {
      productName?: string; cargoValue?: string; cargoWeight?: string;
      address?: string; containerType?: string; serviceType?: string;
      loadingDate?: string; certFileName?: string; certFileBase64?: string;
      productImages?: string;
    };
    if (!body.productName?.trim() || !body.address?.trim()) {
      fail(res, 400, "BAD_REQUEST", "品名和地址为必填");
      return;
    }
    const created = await prisma.fclInquiry.create({
      data: {
        companyId: auth.companyId,
        clientId: auth.userId,
        createdBy: auth.userId,
        createdByRole: "client",
        productName: body.productName.trim(),
        cargoValue: body.cargoValue?.trim() || "",
        cargoWeight: body.cargoWeight?.trim() || "",
        address: body.address.trim(),
        containerType: body.containerType?.trim() || "1*40HQ",
        serviceType: body.serviceType?.trim() || "清提派",
        loadingDate: body.loadingDate?.trim() || null,
        certFileName: body.certFileName?.trim() || null,
        certFileBase64: body.certFileBase64?.trim() || null,
        productImages: body.productImages?.trim() || null,
        status: "pending",
      },
    });
    ok(res, { id: created.id, createdAt: created.createdAt.toISOString() });
  });

  // 客户端查看自己的询价
  app.get("/client/fcl-inquiries", async (req, res) => {
    const auth = requireRole(req, res, ["client", "staff", "admin"]);
    if (!auth) return;
    const isClient = auth.role === "client";
    const where: any = { companyId: auth.companyId };
    if (isClient) where.clientId = auth.userId;
    /* 2026-08-31（Codex 二轮）：列表加真分页，默认 50、上限 200，total 是真实总数。
       原来一次全量返回，还把认证文件 Base64 和产品图片整包下发——
       页面表格根本不显示这些，纯浪费流量。大字段挪到下面的 detail 接口按需取。 */
    const page = Math.max(parseInt(req.query.page as string) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize as string) || 50, 1), 200);
    const [total, items] = await Promise.all([
      prisma.fclInquiry.count({ where }),
      prisma.fclInquiry.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        // 只取表格要用的小字段，certFileBase64 / productImages 连库都不读
        select: {
          id: true, clientId: true, productName: true,
          cargoValue: true, cargoWeight: true, address: true,
          containerType: true, serviceType: true, loadingDate: true,
          certFileName: true, status: true, remark: true,
          createdByRole: true, createdAt: true,
        },
      }),
    ]);
    ok(res, {
      items: items.map((r) => ({
        id: r.id, clientId: r.clientId, productName: r.productName,
        cargoValue: r.cargoValue, cargoWeight: r.cargoWeight,
        address: r.address, containerType: r.containerType,
        serviceType: r.serviceType, loadingDate: r.loadingDate,
        certFileName: r.certFileName,
        status: r.status,
        // 2026-08-31（Codex 二轮）：remark 是管理员内部备注（可能写着利润），
        // 客户角色一律不给——照 containers 那边 isClient 摘字段的写法
        remark: isClient ? undefined : r.remark,
        createdByRole: r.createdByRole,
        createdAt: r.createdAt.toISOString(),
      })),
      page,
      pageSize,
      total,
    });
  });

  // 按 id 取单条详情（大字段只在这里给）——2026-08-31（Codex 二轮）新增
  app.get("/client/fcl-inquiries/detail", async (req, res) => {
    const auth = requireRole(req, res, ["client", "staff", "admin"]);
    if (!auth) return;
    const id = req.query.id?.trim();
    if (!id) { fail(res, 400, "BAD_REQUEST", "缺少询价单 id"); return; }
    const isClient = auth.role === "client";
    const where: any = { id, companyId: auth.companyId };
    if (isClient) where.clientId = auth.userId; // 客户只能看自己的
    const r = await prisma.fclInquiry.findFirst({ where });
    if (!r) { fail(res, 404, "NOT_FOUND", "询价记录不存在"); return; }
    ok(res, {
      id: r.id, clientId: r.clientId, productName: r.productName,
      cargoValue: r.cargoValue, cargoWeight: r.cargoWeight,
      address: r.address, containerType: r.containerType,
      serviceType: r.serviceType, loadingDate: r.loadingDate,
      certFileName: r.certFileName,
      certFileBase64: r.certFileBase64,
      productImages: (() => { try { return r.productImages ? JSON.parse(r.productImages) : []; } catch { return []; } })(),
      status: r.status,
      // 同列表：内部备注不给客户
      remark: isClient ? undefined : r.remark,
      createdByRole: r.createdByRole,
      createdAt: r.createdAt.toISOString(),
    });
  });

  // 员工端提交（可指定客户）
  app.post("/staff/fcl-inquiries", async (req, res) => {
    const auth = requireRole(req, res, ["staff", "admin"]);
    if (!auth) return;
    const body = (req.body ?? {}) as {
      clientId?: string; productName?: string; cargoValue?: string;
      cargoWeight?: string; address?: string; containerType?: string;
      serviceType?: string; loadingDate?: string;
      certFileName?: string; certFileBase64?: string; productImages?: string;
    };
    if (!body.clientId?.trim() || !body.productName?.trim() || !body.address?.trim()) {
      fail(res, 400, "BAD_REQUEST", "客户、品名和地址为必填");
      return;
    }
    // 2026-08-31（Codex 二轮）：先核对客户是不是本公司的（照抄 client-compliance 的写法）。
    // 原来员工随便填个别家公司的客户编号也能建询价，将来接了第二家公司就串了。
    const client = await prisma.user.findFirst({
      where: { id: body.clientId.trim(), companyId: auth.companyId, role: "client" },
      select: { id: true },
    });
    if (!client) { fail(res, 404, "NOT_FOUND", "客户不存在或不属于本公司"); return; }
    const created = await prisma.fclInquiry.create({
      data: {
        companyId: auth.companyId,
        clientId: body.clientId.trim(),
        createdBy: auth.userId,
        createdByRole: "staff",
        productName: body.productName.trim(),
        cargoValue: body.cargoValue?.trim() || "",
        cargoWeight: body.cargoWeight?.trim() || "",
        address: body.address.trim(),
        containerType: body.containerType?.trim() || "1*40HQ",
        serviceType: body.serviceType?.trim() || "清提派",
        loadingDate: body.loadingDate?.trim() || null,
        certFileName: body.certFileName?.trim() || null,
        certFileBase64: body.certFileBase64?.trim() || null,
        productImages: body.productImages?.trim() || null,
        status: "pending",
      },
    });
    ok(res, { id: created.id, createdAt: created.createdAt.toISOString() });
  });
}
