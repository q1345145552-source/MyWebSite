-- 待执行迁移 20260627_sync_schema_mismatches 的影响预估（纯只读）
--
-- 该迁移绝大部分是 IF NOT EXISTS 保护的结构语句（已存在就跳过），
-- 但有两句会真正写业务数据。执行前先看清会动多少行。

SELECT '① 派送单号为空、会被填上 id 的行数' AS "检查项",
       count(*)::text AS "受影响行数"
FROM admin_lastmile_orders
WHERE delivery_no IS NULL OR delivery_no = ''
UNION ALL
SELECT '   （该表总行数，作对照）',
       (SELECT count(*)::text FROM admin_lastmile_orders)
UNION ALL
SELECT '② 货型含大写、会被转小写的运单数',
       (SELECT count(*)::text FROM orders WHERE cargo_type IS NOT NULL AND cargo_type <> lower(cargo_type))
UNION ALL
SELECT '   （运单表总行数，作对照）',
       (SELECT count(*)::text FROM orders)
UNION ALL
SELECT '③ 货型含大写、会被转小写的商品行数',
       (SELECT count(*)::text FROM order_products WHERE cargo_type IS NOT NULL AND cargo_type <> lower(cargo_type))
UNION ALL
SELECT '   （商品表总行数，作对照）',
       (SELECT count(*)::text FROM order_products);

-- 结构类语句会不会真的动手（已存在=跳过，不存在=会新建）
SELECT '结构检查：以下为 是否已存在' AS "项目", '' AS "结果"
UNION ALL SELECT 'pricing_rules.transport_mode',
  CASE WHEN EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='pricing_rules' AND column_name='transport_mode') THEN '已存在，会跳过' ELSE '⚠️ 不存在，会新建' END
UNION ALL SELECT 'pricing_rules.unit_price_usd（旧名，若存在会被改名）',
  CASE WHEN EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='pricing_rules' AND column_name='unit_price_usd') THEN '⚠️ 仍存在，会被改名为 unit_price_cny' ELSE '不存在，改名语句不会触发' END
UNION ALL SELECT 'client_notes 表',
  CASE WHEN to_regclass('public.client_notes') IS NOT NULL THEN '已存在，会跳过' ELSE '⚠️ 不存在，会新建' END
UNION ALL SELECT 'status_logs.operator_name',
  CASE WHEN EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='status_logs' AND column_name='operator_name') THEN '已存在，会跳过' ELSE '⚠️ 不存在，会新建' END;
