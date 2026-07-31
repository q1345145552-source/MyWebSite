-- 遗留字段有没有真实数据（纯只读）
--
-- 背景：集货拼柜仓库版在提交 07b7870 里做过一次重构，
-- 付款/签收信息从「计划客户」层挪到了「预报单」层，旧字段留在库里没删。
-- 这些字段现在代码已经不用了，但 prisma db push 会把它们连同数据一并删除。
--
-- 本查询统计每个遗留字段里有多少行是有值的，用来判断能不能安全删除。
-- 有值的行数 = 0  → 空字段，删掉无所谓
-- 有值的行数 > 0  → 里面有历史数据，删之前必须先导出

SELECT '客户表 总行数' AS "字段", count(*)::text AS "有值的行数"
FROM whr_consolidation_plan_customers
UNION ALL SELECT '— 以下为遗留字段 —', ''
UNION ALL SELECT 'signed_at 签收时间',            count(signed_at)::text                  FROM whr_consolidation_plan_customers
UNION ALL SELECT 'status 状态',                   count(status)::text                     FROM whr_consolidation_plan_customers
UNION ALL SELECT 'warehouse_receipt_base64 收货凭证图', count(warehouse_receipt_base64)::text FROM whr_consolidation_plan_customers
UNION ALL SELECT 'warehouse_receipt_file_name',   count(warehouse_receipt_file_name)::text FROM whr_consolidation_plan_customers
UNION ALL SELECT 'warehouse_receipt_mime',        count(warehouse_receipt_mime)::text      FROM whr_consolidation_plan_customers
UNION ALL SELECT 'payment_proof_base64 付款凭证图',    count(payment_proof_base64)::text     FROM whr_consolidation_plan_customers
UNION ALL SELECT 'payment_proof_file_name',       count(payment_proof_file_name)::text     FROM whr_consolidation_plan_customers
UNION ALL SELECT 'payment_proof_mime',            count(payment_proof_mime)::text          FROM whr_consolidation_plan_customers
UNION ALL SELECT 'payment_proof_uploaded_at',     count(payment_proof_uploaded_at)::text   FROM whr_consolidation_plan_customers
UNION ALL SELECT 'payment_reviewed_at',           count(payment_reviewed_at)::text         FROM whr_consolidation_plan_customers
UNION ALL SELECT 'payment_reviewed_by',           count(payment_reviewed_by)::text         FROM whr_consolidation_plan_customers
UNION ALL SELECT 'payment_reject_reason',         count(payment_reject_reason)::text       FROM whr_consolidation_plan_customers
UNION ALL SELECT 'thailand_receipt_base64 泰国签收图',  count(thailand_receipt_base64)::text  FROM whr_consolidation_plan_customers
UNION ALL SELECT 'thailand_receipt_file_name',    count(thailand_receipt_file_name)::text  FROM whr_consolidation_plan_customers
UNION ALL SELECT 'thailand_receipt_mime',         count(thailand_receipt_mime)::text       FROM whr_consolidation_plan_customers
UNION ALL SELECT 'thailand_received_at',          count(thailand_received_at)::text        FROM whr_consolidation_plan_customers
UNION ALL SELECT 'cancel_reason',                 count(cancel_reason)::text               FROM whr_consolidation_plan_customers
UNION ALL SELECT 'cancelled_at',                  count(cancelled_at)::text                FROM whr_consolidation_plan_customers
UNION ALL SELECT '', ''
UNION ALL SELECT '状态日志 总行数',               count(*)::text                           FROM whr_consolidation_status_logs
UNION ALL SELECT 'customer_id 有值(旧记录)',      count(customer_id)::text                 FROM whr_consolidation_status_logs
UNION ALL SELECT 'prealert_id 有值(新记录)',      count(prealert_id)::text                 FROM whr_consolidation_status_logs;
