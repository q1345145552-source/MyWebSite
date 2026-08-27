-- 给「尾端派送单」和「海关案件」补 company_id 索引（2026-08-27）
--
-- 为什么要补：这两张表的列表页查的是「按公司筛 + 按更新时间倒序」，
-- 但它们原有的索引建在别的字段上（派送单是 delivery_no / shipment_id，
-- 案件是 status），没有一个覆盖得上。数据少的时候看不出来，
-- 一旦上万条，每开一次页面数据库都要把整张表翻一遍再排序。
-- 对照：orders 和 containers 这两张表本来就有 company_id 索引，所以不用动。
--
-- 安全性：
--   · 只加索引，不改任何列、不动任何数据，删了也能重建，可回滚。
--   · 用 IF NOT EXISTS，重复执行不会报错。
--   · 建索引期间这张表会短暂挡住写入。按目前的数据量是毫秒级；
--     如果哪天这两张表涨到几十万行，改用 CREATE INDEX CONCURRENTLY 手工建
--     （注意 CONCURRENTLY 不能放在迁移文件里，Prisma 的迁移是在事务里跑的）。

CREATE INDEX IF NOT EXISTS "admin_lastmile_orders_company_id_updated_at_idx"
  ON "admin_lastmile_orders" ("company_id", "updated_at" DESC);

CREATE INDEX IF NOT EXISTS "admin_customs_cases_company_id_updated_at_idx"
  ON "admin_customs_cases" ("company_id", "updated_at" DESC);
