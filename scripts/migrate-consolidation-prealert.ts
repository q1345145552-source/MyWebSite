/**
 * 一次性数据迁移脚本：集货拼柜仓库版
 * 把旧数据从客户级别（WhrConsolidationPlanCustomer）搬到预报单级别（WhrConsolidationPrealert）
 *
 * 运行方式：npx tsx scripts/migrate-consolidation-prealert.ts
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// 客户状态 → 预报单状态映射
const CUSTOMER_STATUS_TO_PREALERT: Record<string, string> = {
  filling: "pending",
  received_pending_payment: "received_pending_payment",
  paid: "paid",
  loading: "loading",
  shipped: "shipped",
  thailand_received: "thailand_received",
  cancelled: "cancelled",
};

async function main() {
  console.log("=== 开始数据迁移：客户级别 → 预报单级别 ===\n");

  // ==========================================================================
  // 检查旧列是否还存在
  // ==========================================================================
  const colCheck: any[] = await prisma.$queryRawUnsafe(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'whr_consolidation_plan_customers'
      AND column_name = 'status'
  `);

  if (colCheck.length === 0) {
    console.log("旧流程字段（status 等）已被删除，无需从客户表迁移。");
  } else {
    // ========================================================================
    // 第一步：用 raw SQL 读取 PlanCustomer 表中的旧流程字段
    // ========================================================================
    const oldRows: any[] = await prisma.$queryRawUnsafe(`
      SELECT
        id, plan_id, company_id, status,
        signed_at, total_fee,
        warehouse_receipt_file_name, warehouse_receipt_mime, warehouse_receipt_base64,
        payment_proofs, payment_proof_uploaded_at, payment_reviewed_at,
        payment_reviewed_by, payment_reject_reason,
        thailand_receipt_file_name, thailand_receipt_mime, thailand_receipt_base64,
        thailand_received_at,
        cancel_reason, cancelled_at
      FROM whr_consolidation_plan_customers
      WHERE status IS NOT NULL
    `);

    const customersWithData = oldRows.filter(
      (r: any) => r.status && r.status !== "filling"
    );

    console.log(
      `找到 ${oldRows.length} 个客户记录，其中 ${customersWithData.length} 个有流程状态需要迁移\n`
    );

    if (customersWithData.length === 0) {
      console.log("没有需要迁移的客户数据。");
    } else {
      // 显示预览
      console.log("--- 迁移预览 ---");
      for (const c of customersWithData) {
        const newStatus = CUSTOMER_STATUS_TO_PREALERT[c.status] ?? c.status;
        const prealerts = await prisma.whrConsolidationPrealert.findMany({
          where: { customerId: c.id },
          orderBy: { createdAt: "asc" },
          select: { id: true, trackingNo: true, status: true },
        });
        console.log(
          `  客户ID: ${c.id} | 旧状态: ${c.status} → 新状态: ${newStatus} | 预报单: ${prealerts.length}`
        );
        for (const pa of prealerts) {
          console.log(
            `    └ ${pa.trackingNo} 当前: ${pa.status} → ${newStatus}`
          );
        }
      }

      // 确认
      const readline = await import("readline");
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      console.log("\n确认执行？按回车继续，Ctrl+C 取消");
      await new Promise<void>((resolve) => {
        rl.question("", () => { rl.close(); resolve(); });
      });

      // 执行
      console.log("\n开始迁移客户数据...\n");
      let migratedCount = 0;

      for (const c of customersWithData) {
        const oldStatus: string = c.status;
        const newStatus = CUSTOMER_STATUS_TO_PREALERT[oldStatus] ?? oldStatus;

        const prealerts = await prisma.whrConsolidationPrealert.findMany({
          where: { customerId: c.id },
          orderBy: { createdAt: "asc" },
        });

        if (prealerts.length === 0) continue;

        const prealertUpdateData: any = { status: newStatus };

        if (["received_pending_payment","paid","loading","shipped","thailand_received","cancelled"].includes(oldStatus)) {
          if (c.signed_at) prealertUpdateData.signedAt = new Date(c.signed_at);
          if (c.total_fee != null) prealertUpdateData.totalFee = c.total_fee;
          if (c.warehouse_receipt_file_name) prealertUpdateData.warehouseReceiptFileName = c.warehouse_receipt_file_name;
          if (c.warehouse_receipt_mime) prealertUpdateData.warehouseReceiptMime = c.warehouse_receipt_mime;
          if (c.warehouse_receipt_base64) prealertUpdateData.warehouseReceiptBase64 = c.warehouse_receipt_base64;
        }

        if (["paid","loading","shipped","thailand_received"].includes(oldStatus)) {
          if (c.payment_proofs) {
            prealertUpdateData.paymentProofs =
              typeof c.payment_proofs === "string" ? JSON.parse(c.payment_proofs) : c.payment_proofs;
          }
          if (c.payment_proof_uploaded_at) prealertUpdateData.paymentProofUploadedAt = new Date(c.payment_proof_uploaded_at);
          if (c.payment_reviewed_at) prealertUpdateData.paymentReviewedAt = new Date(c.payment_reviewed_at);
          if (c.payment_reviewed_by) prealertUpdateData.paymentReviewedBy = c.payment_reviewed_by;
        }

        if (oldStatus === "thailand_received") {
          if (c.thailand_receipt_file_name) prealertUpdateData.thailandReceiptFileName = c.thailand_receipt_file_name;
          if (c.thailand_receipt_mime) prealertUpdateData.thailandReceiptMime = c.thailand_receipt_mime;
          if (c.thailand_receipt_base64) prealertUpdateData.thailandReceiptBase64 = c.thailand_receipt_base64;
          if (c.thailand_received_at) prealertUpdateData.thailandReceivedAt = new Date(c.thailand_received_at);
        }

        if (oldStatus === "cancelled") {
          if (c.cancel_reason) prealertUpdateData.cancelReason = c.cancel_reason;
          if (c.cancelled_at) prealertUpdateData.cancelledAt = new Date(c.cancelled_at);
        }

        for (const pa of prealerts) {
          const fromStatus = pa.status;
          await prisma.$transaction(async (tx) => {
            await tx.whrConsolidationPrealert.update({
              where: { id: pa.id },
              data: prealertUpdateData,
            });
            await tx.whrConsolidationStatusLog.create({
              data: {
                prealertId: pa.id,
                companyId: c.company_id,
                operatorId: "system",
                operatorRole: "admin",
                operatorName: "系统数据迁移",
                fromStatus,
                toStatus: newStatus,
                remark: `数据迁移自客户级别（客户状态: ${oldStatus}）`,
              },
            });
          });
          console.log(`  ✅ ${pa.trackingNo}: ${fromStatus} → ${newStatus}`);
          migratedCount++;
        }
      }

      console.log(`\n客户数据迁移完成，共迁移 ${migratedCount} 个预报单。`);
    }
  }

  // ==========================================================================
  // 另外：修复旧 status 值 "received" → "received_pending_payment"
  // （schema 改版前的残留数据）
  // ==========================================================================
  const stalePrealerts = await prisma.whrConsolidationPrealert.findMany({
    where: { status: "received" },
    select: { id: true, trackingNo: true, status: true },
  });

  if (stalePrealerts.length > 0) {
    console.log(
      `\n--- 修复旧状态值 "received" → "received_pending_payment" (${stalePrealerts.length} 个) ---`
    );
    for (const pa of stalePrealerts) {
      await prisma.$transaction(async (tx) => {
        await tx.whrConsolidationPrealert.update({
          where: { id: pa.id },
          data: { status: "received_pending_payment" },
        });
        await tx.whrConsolidationStatusLog.create({
          data: {
            prealertId: pa.id,
            companyId: "",
            operatorId: "system",
            operatorRole: "admin",
            operatorName: "系统数据迁移",
            fromStatus: "received",
            toStatus: "received_pending_payment",
            remark: "数据迁移：旧状态值 received 修正为 received_pending_payment",
          },
        });
      });
      console.log(`  ✅ ${pa.trackingNo}: received → received_pending_payment`);
    }
  } else {
    console.log("\n无需修复旧状态值。");
  }

  // ==========================================================================
  // 清理旧的 "received" 状态日志（关联到 statusLog 的外键问题）
  // 用 raw SQL 修正 status_log 中残留的旧状态值
  // ==========================================================================
  const oldLogCount: any[] = await prisma.$queryRawUnsafe(`
    SELECT COUNT(*) AS cnt
    FROM whr_consolidation_status_logs
    WHERE from_status = 'received' OR to_status = 'received'
  `);
  if (oldLogCount[0]?.cnt > 0) {
    console.log(`\n修复 ${oldLogCount[0].cnt} 条旧状态日志...`);
    await prisma.$executeRawUnsafe(`
      UPDATE whr_consolidation_status_logs
      SET from_status = 'received_pending_payment'
      WHERE from_status = 'received'
    `);
    await prisma.$executeRawUnsafe(`
      UPDATE whr_consolidation_status_logs
      SET to_status = 'received_pending_payment'
      WHERE to_status = 'received'
    `);
    console.log("  ✅ 状态日志修复完成");
  }

  console.log("\n========================================");
  console.log("  迁移脚本执行完毕");
  console.log("========================================");

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("迁移脚本执行失败：", e);
  process.exit(1);
});
