-- 2026-09-02 老板拍板：仓库版集货「同一个柜 + 同一个客户只许一行」
-- 只加唯一索引，不删不改任何已有数据。加之前已核对生产库（11 行）与测试库均无重复。
CREATE UNIQUE INDEX "whr_consolidation_plan_customers_plan_id_client_id_key"
  ON "whr_consolidation_plan_customers"("plan_id", "client_id");
