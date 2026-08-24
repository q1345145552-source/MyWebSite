-- 回退：把 2026-08-23 那次「分柜体积重量旧数据修正」改回去
--
-- 起因：2026-08-22 修了分柜算法（父单分柜时同步扣减体积和重量）。
-- 但生产库里有 3 张父单是**旧语义**写下的 —— 父单的体积/重量字段仍是整票原始值、
-- 从没扣过。新代码把这个字段当「剩余量」用，再分柜一次就会重复计算。
-- 另外旧代码把整票重量原样复制给了每个子单，所以子单重量也是错的。
--
-- 本次改动：按「件数比例」重新分配这 3 组父子单的体积和重量。
-- 子单体积本来就是对的（第一次分柜不会错），所以只改父单体积 + 全部重量。
--
-- 用法：
--   ssh root@76.13.181.104 'docker exec -i xiangtai-postgres sh -c "psql -U \$POSTGRES_USER -d \$POSTGRES_DB"' < 本文件
BEGIN;
UPDATE shipments SET volume_m3=1.994, weight_kg=684.00 WHERE tracking_no='YW0001342' AND company_id='c_001';
UPDATE shipments SET volume_m3=0.592, weight_kg=684.00 WHERE tracking_no='YW0001342-1' AND company_id='c_001';
UPDATE shipments SET volume_m3=2.333, weight_kg=1900.00 WHERE tracking_no='YW0001474' AND company_id='c_001';
UPDATE shipments SET volume_m3=1.283, weight_kg=1900.00 WHERE tracking_no='YW0001474-1' AND company_id='c_001';
UPDATE shipments SET volume_m3=4.909, weight_kg=900.00 WHERE tracking_no='YW0001489' AND company_id='c_001';
UPDATE shipments SET volume_m3=3.354, weight_kg=900.00 WHERE tracking_no='YW0001489-1' AND company_id='c_001';
COMMIT;
