-- 让「一车多单」真的能用：派送单号不再唯一
--
-- 问题：admin_lastmile_orders.delivery_no 上有唯一索引，但业务上这个号代表「一车」，
-- 一车拉多个运单时代码是**每个运单存一行、共用同一个号**（admin-ops/routes.ts 的
-- for 循环）。所以只要选 2 个及以上运单，第 2 行必定报
--   Unique constraint failed on the fields: (`delivery_no`)
-- 而第 1 行已经在自己那个事务里提交了、对应运单的状态也已经改成 outForDelivery，
-- 于是留下「状态是派送中、却查不到任何派送单」的孤儿运单。
--
-- 2026-08-06 生产库实测：
--   派送中的运单 5 张，其中真有派送单的只有 2 张 —— 3 张是这么漏出来的
--   （YW0001381 / 11223344-1 / YW0001244）
--   198 张派送单里，delivery_no 全部互不相同 —— 说明「一车多单」从上线起就没成功过一次
--   界面上却一直写着「创建派送单（一车多单，逗号分隔）」
--
-- 改法：删掉 delivery_no 的唯一索引，改成 (delivery_no, shipment_id) 唯一 ——
-- 一车可以拉多票货，但同一票货在同一张派送单里不能出现两次（防重复点击）。
--
-- 安全性：生产现有 198 行 delivery_no 全不重复、(delivery_no, shipment_id) 组合也全不重复，
-- 所以删索引不会失败、建新唯一索引也不会失败，**一行数据都不会动**。
-- 查询不受影响：代码里查 deliveryNo 用的都是 findFirst（不是 findUnique），
-- 而且 (delivery_no, updated_at) 那个联合索引还在，按号查依然走索引。

DROP INDEX IF EXISTS admin_lastmile_orders_delivery_no_key;

CREATE UNIQUE INDEX IF NOT EXISTS admin_lastmile_orders_delivery_no_shipment_id_key
  ON admin_lastmile_orders (delivery_no, shipment_id);
