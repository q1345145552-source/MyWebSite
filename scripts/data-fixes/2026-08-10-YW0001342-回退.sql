-- 回退：把 YW0001342 的「还剩没装」改回原值 0
-- 改动时间 2026-08-10，改动内容：0 → 71（101 整单 − 30 已装走）
UPDATE shipments SET package_count = 0 WHERE tracking_no = 'YW0001342' AND parent_tracking_no IS NULL;
