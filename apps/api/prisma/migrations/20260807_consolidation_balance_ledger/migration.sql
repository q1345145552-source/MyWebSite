-- 集货余额流水表（2026-08-07）
-- 只增不减：新建一张表，不动任何已有表和数据。
CREATE TABLE IF NOT EXISTS "consolidation_balance_ledger" (
  "id"            TEXT NOT NULL,
  "company_id"    TEXT NOT NULL,
  "client_id"     TEXT NOT NULL,
  "type"          TEXT NOT NULL,
  "amount"        DECIMAL(14,2) NOT NULL,
  "balance_after" DECIMAL(14,2) NOT NULL,
  "ref_type"      TEXT,
  "ref_id"        TEXT,
  "ref_no"        TEXT,
  "remark"        TEXT,
  "operator_id"   TEXT,
  "operator_name" TEXT,
  "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "consolidation_balance_ledger_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "consolidation_balance_ledger_company_client_time_idx"
  ON "consolidation_balance_ledger" ("company_id", "client_id", "created_at");
CREATE INDEX IF NOT EXISTS "consolidation_balance_ledger_ref_idx"
  ON "consolidation_balance_ledger" ("ref_type", "ref_id");

ALTER TABLE "consolidation_balance_ledger"
  ADD CONSTRAINT "consolidation_balance_ledger_client_id_fkey"
  FOREIGN KEY ("client_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
