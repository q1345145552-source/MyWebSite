-- 给柜子加「运输方式」（海运 / 陆运）
--
-- 背景：装柜功能一直只有海运一套说法，柜子身上没有运输方式这个概念。
-- 但陆运的货一直在装：2026-08-05 生产库实测 88 个柜子里，17 个装过陆运货、
-- 共 118 张陆运运单，还有 5 个柜是海陆混装。员工只能靠自己在柜号前面打 "L"
-- （L2608049047、LL2607269620…）来区分，系统不认。
--
-- 这个迁移只做两件事：加一列 + 回填能判断的老柜子。**只增不减，不删任何东西。**
--
-- ① 加列（可空）
--    可空是有意的：判不出来的柜子留 null，列表里显示「—」，让员工自己点，
--    好过默认成海运把陆运柜误标了。
ALTER TABLE containers ADD COLUMN IF NOT EXISTS transport_mode TEXT;

-- ② 回填：按柜子里装的货反推
--    2026-08-05 在生产库预演过，命中数如下：
--      67 个柜里全是海运的货  → 标成 sea
--      12 个柜里全是陆运的货  → 标成 land
--       5 个海陆混装          → 保持 null（判不出来）
--       4 个空柜（没装货）    → 保持 null
--    条件里的 COUNT(DISTINCT transport_mode) = 1 就是「柜里只有一种运输方式」，
--    混装柜天然被排除；空柜因为 INNER JOIN 不产生行，也进不来。
--    加 transport_mode IS NULL 是为了幂等：重复执行不会覆盖员工手工改过的值。
UPDATE containers c
SET transport_mode = sub.mode
FROM (
  SELECT sci.container_id,
         MIN(s.transport_mode) AS mode
  FROM shipment_container_items sci
  JOIN shipments s ON s.id = sci.shipment_id
  WHERE s.transport_mode IN ('sea', 'land')
  GROUP BY sci.container_id
  HAVING COUNT(DISTINCT s.transport_mode) = 1
) AS sub
WHERE c.id = sub.container_id
  AND c.transport_mode IS NULL;
