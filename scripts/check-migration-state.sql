-- 迁移记录状态检查（纯只读）
--
-- 用途：在把部署方式从 db push 换成 migrate deploy 之前，
-- 先搞清楚生产库里的迁移登记表是什么状况。
--
-- 关注三点：
--   1. 有没有 _prisma_migrations 这张表
--   2. 里面登记了哪些迁移，有没有「未完成」或重复的
--   3. 仓库里的 14 个迁移文件，哪些登记了、哪些没有

SELECT
  CASE WHEN to_regclass('public._prisma_migrations') IS NULL
       THEN '没有 _prisma_migrations 表 —— 说明从未用过 migrate，只用过 db push'
       ELSE '有 _prisma_migrations 表'
  END AS "第1项 登记表是否存在";

-- 表不存在时下面的查询会报错，属正常，看到上面那句就够了
SELECT
  migration_name AS "迁移名",
  to_char(started_at, 'YYYY-MM-DD HH24:MI') AS "开始时间",
  CASE WHEN finished_at IS NOT NULL THEN '已完成'
       WHEN rolled_back_at IS NOT NULL THEN '已回滚'
       ELSE '⚠️ 未完成（会挡住后续迁移）'
  END AS "状态",
  applied_steps_count AS "执行步数"
FROM _prisma_migrations
ORDER BY started_at;

-- 重复登记的（同一个迁移名出现多次，通常是失败重试留下的）
SELECT migration_name AS "重复登记的迁移", count(*)::text AS "出现次数"
FROM _prisma_migrations
GROUP BY migration_name
HAVING count(*) > 1
ORDER BY migration_name;
