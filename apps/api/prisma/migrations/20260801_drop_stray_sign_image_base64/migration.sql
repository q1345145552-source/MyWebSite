-- 删掉 admin_lastmile_orders 表里多出来的空字段 sign_image_base64
--
-- 它是 20260627_sync_schema_mismatches 第 48 行误加的：
--   ALTER TABLE admin_lastmile_orders ADD COLUMN IF NOT EXISTS sign_image_base64 TEXT;
-- 但代码实际读写的是 sign_product_image_base64
--   （schema.prisma:439 → signImageBase64 String? @map("sign_product_image_base64")）
-- 那次迁移在测试库演练时这列碰巧已存在被跳过，没暴露出来；生产库执行后就真多了一个空列。
--
-- 2026-08-01 在生产库核对过，确认删了不丢任何东西：
--   admin_lastmile_orders 共 193 行
--   sign_image_base64          有值 0 行   ← 要删的这个
--   sign_product_image_base64  有值 192 行 ← 签收照片实际存在这里，不动
-- 另外全项目 grep 过 sign_image_base64 / signImageBase64，没有一处读写这个列名。
--
-- 留着它的唯一后果是每次部署的结构体检都报一行「B 多余」，久了会把真问题淹掉。

ALTER TABLE admin_lastmile_orders DROP COLUMN IF EXISTS sign_image_base64;
