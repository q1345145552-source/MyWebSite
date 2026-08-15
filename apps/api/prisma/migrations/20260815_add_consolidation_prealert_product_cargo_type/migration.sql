-- 普通版集货货物明细：加一列「货型」（2026-08-15）
-- 只加列，不删不改任何现有字段和数据。已有行自动填 'normal'（普货）。
-- 取值：normal | inspection | sensitive，与仓库版 whr_consolidation_prealert_items.cargo_type 一致。
ALTER TABLE "consolidation_prealert_products"
  ADD COLUMN IF NOT EXISTS "cargo_type" TEXT NOT NULL DEFAULT 'normal';
