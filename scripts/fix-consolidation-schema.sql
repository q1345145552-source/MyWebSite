-- 集货拼柜 表结构补齐（只增不减，可重复执行）
-- 生成自 apps/api/prisma/schema.prisma，未手写
-- 不含任何 DROP / DELETE / ALTER TYPE，对已有数据无影响

BEGIN;

-- ===== consolidation_tasks =====
CREATE TABLE IF NOT EXISTS "consolidation_tasks" (
    "id" TEXT NOT NULL,
    "task_no" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "destination_th" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'collecting',
    "max_volume_m3" DECIMAL(10,2) NOT NULL DEFAULT 68,
    "total_volume_m3" DECIMAL(10,3) NOT NULL DEFAULT 0,
    "total_packages" INTEGER NOT NULL DEFAULT 0,
    "total_prealerts" INTEGER NOT NULL DEFAULT 0,
    "booking_fee" DECIMAL(12,2),
    "customs_fee" DECIMAL(12,2),
    "loading_fee" DECIMAL(12,2),
    "total_fee" DECIMAL(12,2),
    "currency" TEXT NOT NULL DEFAULT 'CNY',
    "payment_status" TEXT NOT NULL DEFAULT 'unpaid',
    "paid_at" TIMESTAMP(3),
    "payment_proof_file_name" TEXT,
    "payment_proof_mime" TEXT,
    "payment_proof_base64" TEXT,
    "payment_proof_uploaded_at" TIMESTAMP(3),
    "payment_reviewed_at" TIMESTAMP(3),
    "payment_reviewed_by" TEXT,
    "payment_reject_reason" TEXT,
    "container_no" TEXT,
    "loading_date" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "consolidation_tasks_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "consolidation_tasks" ADD COLUMN IF NOT EXISTS "id" TEXT;
ALTER TABLE "consolidation_tasks" ADD COLUMN IF NOT EXISTS "task_no" TEXT;
ALTER TABLE "consolidation_tasks" ADD COLUMN IF NOT EXISTS "company_id" TEXT;
ALTER TABLE "consolidation_tasks" ADD COLUMN IF NOT EXISTS "client_id" TEXT;
ALTER TABLE "consolidation_tasks" ADD COLUMN IF NOT EXISTS "destination_th" TEXT;
ALTER TABLE "consolidation_tasks" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'collecting';
ALTER TABLE "consolidation_tasks" ADD COLUMN IF NOT EXISTS "max_volume_m3" DECIMAL(10,2) NOT NULL DEFAULT 68;
ALTER TABLE "consolidation_tasks" ADD COLUMN IF NOT EXISTS "total_volume_m3" DECIMAL(10,3) NOT NULL DEFAULT 0;
ALTER TABLE "consolidation_tasks" ADD COLUMN IF NOT EXISTS "total_packages" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "consolidation_tasks" ADD COLUMN IF NOT EXISTS "total_prealerts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "consolidation_tasks" ADD COLUMN IF NOT EXISTS "booking_fee" DECIMAL(12,2);
ALTER TABLE "consolidation_tasks" ADD COLUMN IF NOT EXISTS "customs_fee" DECIMAL(12,2);
ALTER TABLE "consolidation_tasks" ADD COLUMN IF NOT EXISTS "loading_fee" DECIMAL(12,2);
ALTER TABLE "consolidation_tasks" ADD COLUMN IF NOT EXISTS "total_fee" DECIMAL(12,2);
ALTER TABLE "consolidation_tasks" ADD COLUMN IF NOT EXISTS "currency" TEXT NOT NULL DEFAULT 'CNY';
ALTER TABLE "consolidation_tasks" ADD COLUMN IF NOT EXISTS "payment_status" TEXT NOT NULL DEFAULT 'unpaid';
ALTER TABLE "consolidation_tasks" ADD COLUMN IF NOT EXISTS "paid_at" TIMESTAMP(3);
ALTER TABLE "consolidation_tasks" ADD COLUMN IF NOT EXISTS "payment_proof_file_name" TEXT;
ALTER TABLE "consolidation_tasks" ADD COLUMN IF NOT EXISTS "payment_proof_mime" TEXT;
ALTER TABLE "consolidation_tasks" ADD COLUMN IF NOT EXISTS "payment_proof_base64" TEXT;
ALTER TABLE "consolidation_tasks" ADD COLUMN IF NOT EXISTS "payment_proof_uploaded_at" TIMESTAMP(3);
ALTER TABLE "consolidation_tasks" ADD COLUMN IF NOT EXISTS "payment_reviewed_at" TIMESTAMP(3);
ALTER TABLE "consolidation_tasks" ADD COLUMN IF NOT EXISTS "payment_reviewed_by" TEXT;
ALTER TABLE "consolidation_tasks" ADD COLUMN IF NOT EXISTS "payment_reject_reason" TEXT;
ALTER TABLE "consolidation_tasks" ADD COLUMN IF NOT EXISTS "container_no" TEXT;
ALTER TABLE "consolidation_tasks" ADD COLUMN IF NOT EXISTS "loading_date" TEXT;
ALTER TABLE "consolidation_tasks" ADD COLUMN IF NOT EXISTS "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "consolidation_tasks" ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMP(3);

-- ===== consolidation_prealerts =====
CREATE TABLE IF NOT EXISTS "consolidation_prealerts" (
    "id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "tracking_no" TEXT NOT NULL,
    "express_no" TEXT,
    "mark" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "signed_at" TIMESTAMP(3),
    "received_proof_file_name" TEXT,
    "received_proof_mime" TEXT,
    "received_proof_base64" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "consolidation_prealerts_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "consolidation_prealerts" ADD COLUMN IF NOT EXISTS "id" TEXT;
ALTER TABLE "consolidation_prealerts" ADD COLUMN IF NOT EXISTS "task_id" TEXT;
ALTER TABLE "consolidation_prealerts" ADD COLUMN IF NOT EXISTS "company_id" TEXT;
ALTER TABLE "consolidation_prealerts" ADD COLUMN IF NOT EXISTS "client_id" TEXT;
ALTER TABLE "consolidation_prealerts" ADD COLUMN IF NOT EXISTS "tracking_no" TEXT;
ALTER TABLE "consolidation_prealerts" ADD COLUMN IF NOT EXISTS "express_no" TEXT;
ALTER TABLE "consolidation_prealerts" ADD COLUMN IF NOT EXISTS "mark" TEXT;
ALTER TABLE "consolidation_prealerts" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE "consolidation_prealerts" ADD COLUMN IF NOT EXISTS "signed_at" TIMESTAMP(3);
ALTER TABLE "consolidation_prealerts" ADD COLUMN IF NOT EXISTS "received_proof_file_name" TEXT;
ALTER TABLE "consolidation_prealerts" ADD COLUMN IF NOT EXISTS "received_proof_mime" TEXT;
ALTER TABLE "consolidation_prealerts" ADD COLUMN IF NOT EXISTS "received_proof_base64" TEXT;
ALTER TABLE "consolidation_prealerts" ADD COLUMN IF NOT EXISTS "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "consolidation_prealerts" ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMP(3);

-- ===== consolidation_prealert_products =====
CREATE TABLE IF NOT EXISTS "consolidation_prealert_products" (
    "id" TEXT NOT NULL,
    "prealert_id" TEXT NOT NULL,
    "product_name" TEXT NOT NULL,
    "package_count" INTEGER NOT NULL,
    "quantity_per_box" INTEGER NOT NULL DEFAULT 1,
    "total_quantity" INTEGER NOT NULL DEFAULT 0,
    "unit_weight" DECIMAL(10,2),
    "total_weight" DECIMAL(10,2),
    "length_cm" DECIMAL(10,2),
    "width_cm" DECIMAL(10,2),
    "height_cm" DECIMAL(10,2),
    "volume_m3" DECIMAL(10,6),
    "material" TEXT NOT NULL,
    "cargo_value" TEXT NOT NULL,
    "product_image_file_name" TEXT,
    "product_image_mime" TEXT,
    "product_image_base64" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consolidation_prealert_products_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "consolidation_prealert_products" ADD COLUMN IF NOT EXISTS "id" TEXT;
ALTER TABLE "consolidation_prealert_products" ADD COLUMN IF NOT EXISTS "prealert_id" TEXT;
ALTER TABLE "consolidation_prealert_products" ADD COLUMN IF NOT EXISTS "product_name" TEXT;
ALTER TABLE "consolidation_prealert_products" ADD COLUMN IF NOT EXISTS "package_count" INTEGER;
ALTER TABLE "consolidation_prealert_products" ADD COLUMN IF NOT EXISTS "quantity_per_box" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "consolidation_prealert_products" ADD COLUMN IF NOT EXISTS "total_quantity" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "consolidation_prealert_products" ADD COLUMN IF NOT EXISTS "unit_weight" DECIMAL(10,2);
ALTER TABLE "consolidation_prealert_products" ADD COLUMN IF NOT EXISTS "total_weight" DECIMAL(10,2);
ALTER TABLE "consolidation_prealert_products" ADD COLUMN IF NOT EXISTS "length_cm" DECIMAL(10,2);
ALTER TABLE "consolidation_prealert_products" ADD COLUMN IF NOT EXISTS "width_cm" DECIMAL(10,2);
ALTER TABLE "consolidation_prealert_products" ADD COLUMN IF NOT EXISTS "height_cm" DECIMAL(10,2);
ALTER TABLE "consolidation_prealert_products" ADD COLUMN IF NOT EXISTS "volume_m3" DECIMAL(10,6);
ALTER TABLE "consolidation_prealert_products" ADD COLUMN IF NOT EXISTS "material" TEXT;
ALTER TABLE "consolidation_prealert_products" ADD COLUMN IF NOT EXISTS "cargo_value" TEXT;
ALTER TABLE "consolidation_prealert_products" ADD COLUMN IF NOT EXISTS "product_image_file_name" TEXT;
ALTER TABLE "consolidation_prealert_products" ADD COLUMN IF NOT EXISTS "product_image_mime" TEXT;
ALTER TABLE "consolidation_prealert_products" ADD COLUMN IF NOT EXISTS "product_image_base64" TEXT;
ALTER TABLE "consolidation_prealert_products" ADD COLUMN IF NOT EXISTS "sort_order" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "consolidation_prealert_products" ADD COLUMN IF NOT EXISTS "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- ===== consolidation_status_logs =====
CREATE TABLE IF NOT EXISTS "consolidation_status_logs" (
    "id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "operator_role" TEXT NOT NULL,
    "operator_name" TEXT NOT NULL,
    "from_status" TEXT NOT NULL,
    "to_status" TEXT NOT NULL,
    "remark" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consolidation_status_logs_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "consolidation_status_logs" ADD COLUMN IF NOT EXISTS "id" TEXT;
ALTER TABLE "consolidation_status_logs" ADD COLUMN IF NOT EXISTS "task_id" TEXT;
ALTER TABLE "consolidation_status_logs" ADD COLUMN IF NOT EXISTS "company_id" TEXT;
ALTER TABLE "consolidation_status_logs" ADD COLUMN IF NOT EXISTS "operator_id" TEXT;
ALTER TABLE "consolidation_status_logs" ADD COLUMN IF NOT EXISTS "operator_role" TEXT;
ALTER TABLE "consolidation_status_logs" ADD COLUMN IF NOT EXISTS "operator_name" TEXT;
ALTER TABLE "consolidation_status_logs" ADD COLUMN IF NOT EXISTS "from_status" TEXT;
ALTER TABLE "consolidation_status_logs" ADD COLUMN IF NOT EXISTS "to_status" TEXT;
ALTER TABLE "consolidation_status_logs" ADD COLUMN IF NOT EXISTS "remark" TEXT;
ALTER TABLE "consolidation_status_logs" ADD COLUMN IF NOT EXISTS "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- ===== whr_consolidation_plans =====
CREATE TABLE IF NOT EXISTS "whr_consolidation_plans" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "plan_no" TEXT NOT NULL,
    "warehouse" TEXT NOT NULL DEFAULT '义乌',
    "container_type" TEXT NOT NULL DEFAULT '40HQ',
    "destination_th" TEXT NOT NULL,
    "total_volume_m3" DECIMAL(10,2) NOT NULL DEFAULT 68,
    "status" TEXT NOT NULL DEFAULT 'planning',
    "created_by" TEXT NOT NULL,
    "creator_name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whr_consolidation_plans_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "whr_consolidation_plans" ADD COLUMN IF NOT EXISTS "id" TEXT;
ALTER TABLE "whr_consolidation_plans" ADD COLUMN IF NOT EXISTS "company_id" TEXT;
ALTER TABLE "whr_consolidation_plans" ADD COLUMN IF NOT EXISTS "plan_no" TEXT;
ALTER TABLE "whr_consolidation_plans" ADD COLUMN IF NOT EXISTS "warehouse" TEXT NOT NULL DEFAULT '义乌';
ALTER TABLE "whr_consolidation_plans" ADD COLUMN IF NOT EXISTS "container_type" TEXT NOT NULL DEFAULT '40HQ';
ALTER TABLE "whr_consolidation_plans" ADD COLUMN IF NOT EXISTS "destination_th" TEXT;
ALTER TABLE "whr_consolidation_plans" ADD COLUMN IF NOT EXISTS "total_volume_m3" DECIMAL(10,2) NOT NULL DEFAULT 68;
ALTER TABLE "whr_consolidation_plans" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'planning';
ALTER TABLE "whr_consolidation_plans" ADD COLUMN IF NOT EXISTS "created_by" TEXT;
ALTER TABLE "whr_consolidation_plans" ADD COLUMN IF NOT EXISTS "creator_name" TEXT;
ALTER TABLE "whr_consolidation_plans" ADD COLUMN IF NOT EXISTS "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "whr_consolidation_plans" ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMP(3);

-- ===== whr_consolidation_plan_customers =====
CREATE TABLE IF NOT EXISTS "whr_consolidation_plan_customers" (
    "id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "unit_price_normal" DECIMAL(10,2) NOT NULL,
    "unit_price_inspection" DECIMAL(10,2) NOT NULL,
    "unit_price_sensitive" DECIMAL(10,2) NOT NULL,
    "total_volume_m3" DECIMAL(10,3) NOT NULL DEFAULT 0,
    "total_fee" DECIMAL(12,2),
    "delivery_address" TEXT,
    "total_prealerts" INTEGER NOT NULL DEFAULT 0,
    "total_packages" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whr_consolidation_plan_customers_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "whr_consolidation_plan_customers" ADD COLUMN IF NOT EXISTS "id" TEXT;
ALTER TABLE "whr_consolidation_plan_customers" ADD COLUMN IF NOT EXISTS "plan_id" TEXT;
ALTER TABLE "whr_consolidation_plan_customers" ADD COLUMN IF NOT EXISTS "company_id" TEXT;
ALTER TABLE "whr_consolidation_plan_customers" ADD COLUMN IF NOT EXISTS "client_id" TEXT;
ALTER TABLE "whr_consolidation_plan_customers" ADD COLUMN IF NOT EXISTS "unit_price_normal" DECIMAL(10,2);
ALTER TABLE "whr_consolidation_plan_customers" ADD COLUMN IF NOT EXISTS "unit_price_inspection" DECIMAL(10,2);
ALTER TABLE "whr_consolidation_plan_customers" ADD COLUMN IF NOT EXISTS "unit_price_sensitive" DECIMAL(10,2);
ALTER TABLE "whr_consolidation_plan_customers" ADD COLUMN IF NOT EXISTS "total_volume_m3" DECIMAL(10,3) NOT NULL DEFAULT 0;
ALTER TABLE "whr_consolidation_plan_customers" ADD COLUMN IF NOT EXISTS "total_fee" DECIMAL(12,2);
ALTER TABLE "whr_consolidation_plan_customers" ADD COLUMN IF NOT EXISTS "delivery_address" TEXT;
ALTER TABLE "whr_consolidation_plan_customers" ADD COLUMN IF NOT EXISTS "total_prealerts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "whr_consolidation_plan_customers" ADD COLUMN IF NOT EXISTS "total_packages" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "whr_consolidation_plan_customers" ADD COLUMN IF NOT EXISTS "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "whr_consolidation_plan_customers" ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMP(3);

-- ===== whr_consolidation_prealerts =====
CREATE TABLE IF NOT EXISTS "whr_consolidation_prealerts" (
    "id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "tracking_no" TEXT NOT NULL,
    "express_no" TEXT,
    "mark" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "received_at" TIMESTAMP(3),
    "signed_at" TIMESTAMP(3),
    "warehouse_receipt_proofs" JSONB NOT NULL DEFAULT '[]',
    "payment_proofs" JSONB NOT NULL DEFAULT '[]',
    "payment_proof_uploaded_at" TIMESTAMP(3),
    "total_fee" DECIMAL(12,2),
    "payment_reviewed_at" TIMESTAMP(3),
    "payment_reviewed_by" TEXT,
    "payment_reject_reason" TEXT,
    "thailand_receipt_proofs" JSONB NOT NULL DEFAULT '[]',
    "thailand_received_at" TIMESTAMP(3),
    "cancel_reason" TEXT,
    "cancelled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whr_consolidation_prealerts_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "whr_consolidation_prealerts" ADD COLUMN IF NOT EXISTS "id" TEXT;
ALTER TABLE "whr_consolidation_prealerts" ADD COLUMN IF NOT EXISTS "customer_id" TEXT;
ALTER TABLE "whr_consolidation_prealerts" ADD COLUMN IF NOT EXISTS "company_id" TEXT;
ALTER TABLE "whr_consolidation_prealerts" ADD COLUMN IF NOT EXISTS "tracking_no" TEXT;
ALTER TABLE "whr_consolidation_prealerts" ADD COLUMN IF NOT EXISTS "express_no" TEXT;
ALTER TABLE "whr_consolidation_prealerts" ADD COLUMN IF NOT EXISTS "mark" TEXT;
ALTER TABLE "whr_consolidation_prealerts" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE "whr_consolidation_prealerts" ADD COLUMN IF NOT EXISTS "received_at" TIMESTAMP(3);
ALTER TABLE "whr_consolidation_prealerts" ADD COLUMN IF NOT EXISTS "signed_at" TIMESTAMP(3);
ALTER TABLE "whr_consolidation_prealerts" ADD COLUMN IF NOT EXISTS "warehouse_receipt_proofs" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "whr_consolidation_prealerts" ADD COLUMN IF NOT EXISTS "payment_proofs" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "whr_consolidation_prealerts" ADD COLUMN IF NOT EXISTS "payment_proof_uploaded_at" TIMESTAMP(3);
ALTER TABLE "whr_consolidation_prealerts" ADD COLUMN IF NOT EXISTS "total_fee" DECIMAL(12,2);
ALTER TABLE "whr_consolidation_prealerts" ADD COLUMN IF NOT EXISTS "payment_reviewed_at" TIMESTAMP(3);
ALTER TABLE "whr_consolidation_prealerts" ADD COLUMN IF NOT EXISTS "payment_reviewed_by" TEXT;
ALTER TABLE "whr_consolidation_prealerts" ADD COLUMN IF NOT EXISTS "payment_reject_reason" TEXT;
ALTER TABLE "whr_consolidation_prealerts" ADD COLUMN IF NOT EXISTS "thailand_receipt_proofs" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "whr_consolidation_prealerts" ADD COLUMN IF NOT EXISTS "thailand_received_at" TIMESTAMP(3);
ALTER TABLE "whr_consolidation_prealerts" ADD COLUMN IF NOT EXISTS "cancel_reason" TEXT;
ALTER TABLE "whr_consolidation_prealerts" ADD COLUMN IF NOT EXISTS "cancelled_at" TIMESTAMP(3);
ALTER TABLE "whr_consolidation_prealerts" ADD COLUMN IF NOT EXISTS "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "whr_consolidation_prealerts" ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMP(3);

-- ===== whr_consolidation_prealert_items =====
CREATE TABLE IF NOT EXISTS "whr_consolidation_prealert_items" (
    "id" TEXT NOT NULL,
    "prealert_id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "product_name" TEXT NOT NULL,
    "package_count" INTEGER NOT NULL,
    "quantity_per_box" INTEGER NOT NULL DEFAULT 1,
    "total_quantity" INTEGER NOT NULL DEFAULT 0,
    "length_cm" DECIMAL(10,2),
    "width_cm" DECIMAL(10,2),
    "height_cm" DECIMAL(10,2),
    "unit_weight_kg" DECIMAL(10,2),
    "total_weight_kg" DECIMAL(10,2),
    "volume_m3" DECIMAL(10,6),
    "material" TEXT NOT NULL,
    "cargo_value" TEXT NOT NULL,
    "cargo_type" TEXT NOT NULL DEFAULT 'normal',
    "product_image_file_name" TEXT,
    "product_image_mime" TEXT,
    "product_image_base64" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whr_consolidation_prealert_items_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "whr_consolidation_prealert_items" ADD COLUMN IF NOT EXISTS "id" TEXT;
ALTER TABLE "whr_consolidation_prealert_items" ADD COLUMN IF NOT EXISTS "prealert_id" TEXT;
ALTER TABLE "whr_consolidation_prealert_items" ADD COLUMN IF NOT EXISTS "company_id" TEXT;
ALTER TABLE "whr_consolidation_prealert_items" ADD COLUMN IF NOT EXISTS "product_name" TEXT;
ALTER TABLE "whr_consolidation_prealert_items" ADD COLUMN IF NOT EXISTS "package_count" INTEGER;
ALTER TABLE "whr_consolidation_prealert_items" ADD COLUMN IF NOT EXISTS "quantity_per_box" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "whr_consolidation_prealert_items" ADD COLUMN IF NOT EXISTS "total_quantity" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "whr_consolidation_prealert_items" ADD COLUMN IF NOT EXISTS "length_cm" DECIMAL(10,2);
ALTER TABLE "whr_consolidation_prealert_items" ADD COLUMN IF NOT EXISTS "width_cm" DECIMAL(10,2);
ALTER TABLE "whr_consolidation_prealert_items" ADD COLUMN IF NOT EXISTS "height_cm" DECIMAL(10,2);
ALTER TABLE "whr_consolidation_prealert_items" ADD COLUMN IF NOT EXISTS "unit_weight_kg" DECIMAL(10,2);
ALTER TABLE "whr_consolidation_prealert_items" ADD COLUMN IF NOT EXISTS "total_weight_kg" DECIMAL(10,2);
ALTER TABLE "whr_consolidation_prealert_items" ADD COLUMN IF NOT EXISTS "volume_m3" DECIMAL(10,6);
ALTER TABLE "whr_consolidation_prealert_items" ADD COLUMN IF NOT EXISTS "material" TEXT;
ALTER TABLE "whr_consolidation_prealert_items" ADD COLUMN IF NOT EXISTS "cargo_value" TEXT;
ALTER TABLE "whr_consolidation_prealert_items" ADD COLUMN IF NOT EXISTS "cargo_type" TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE "whr_consolidation_prealert_items" ADD COLUMN IF NOT EXISTS "product_image_file_name" TEXT;
ALTER TABLE "whr_consolidation_prealert_items" ADD COLUMN IF NOT EXISTS "product_image_mime" TEXT;
ALTER TABLE "whr_consolidation_prealert_items" ADD COLUMN IF NOT EXISTS "product_image_base64" TEXT;
ALTER TABLE "whr_consolidation_prealert_items" ADD COLUMN IF NOT EXISTS "sort_order" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "whr_consolidation_prealert_items" ADD COLUMN IF NOT EXISTS "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- ===== whr_consolidation_status_logs =====
CREATE TABLE IF NOT EXISTS "whr_consolidation_status_logs" (
    "id" TEXT NOT NULL,
    "prealert_id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "operator_role" TEXT NOT NULL,
    "operator_name" TEXT NOT NULL,
    "from_status" TEXT NOT NULL,
    "to_status" TEXT NOT NULL,
    "remark" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whr_consolidation_status_logs_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "whr_consolidation_status_logs" ADD COLUMN IF NOT EXISTS "id" TEXT;
ALTER TABLE "whr_consolidation_status_logs" ADD COLUMN IF NOT EXISTS "prealert_id" TEXT;
ALTER TABLE "whr_consolidation_status_logs" ADD COLUMN IF NOT EXISTS "company_id" TEXT;
ALTER TABLE "whr_consolidation_status_logs" ADD COLUMN IF NOT EXISTS "operator_id" TEXT;
ALTER TABLE "whr_consolidation_status_logs" ADD COLUMN IF NOT EXISTS "operator_role" TEXT;
ALTER TABLE "whr_consolidation_status_logs" ADD COLUMN IF NOT EXISTS "operator_name" TEXT;
ALTER TABLE "whr_consolidation_status_logs" ADD COLUMN IF NOT EXISTS "from_status" TEXT;
ALTER TABLE "whr_consolidation_status_logs" ADD COLUMN IF NOT EXISTS "to_status" TEXT;
ALTER TABLE "whr_consolidation_status_logs" ADD COLUMN IF NOT EXISTS "remark" TEXT;
ALTER TABLE "whr_consolidation_status_logs" ADD COLUMN IF NOT EXISTS "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE UNIQUE INDEX IF NOT EXISTS "consolidation_tasks_task_no_key" ON "consolidation_tasks"("task_no");
CREATE INDEX IF NOT EXISTS "consolidation_tasks_company_id_client_id_idx" ON "consolidation_tasks"("company_id", "client_id");
CREATE INDEX IF NOT EXISTS "consolidation_tasks_company_id_status_idx" ON "consolidation_tasks"("company_id", "status");
CREATE UNIQUE INDEX IF NOT EXISTS "consolidation_prealerts_tracking_no_key" ON "consolidation_prealerts"("tracking_no");
CREATE INDEX IF NOT EXISTS "consolidation_prealerts_task_id_idx" ON "consolidation_prealerts"("task_id");
CREATE INDEX IF NOT EXISTS "consolidation_prealerts_company_id_task_id_idx" ON "consolidation_prealerts"("company_id", "task_id");
CREATE INDEX IF NOT EXISTS "consolidation_prealert_products_prealert_id_sort_order_idx" ON "consolidation_prealert_products"("prealert_id", "sort_order");
CREATE INDEX IF NOT EXISTS "consolidation_status_logs_task_id_created_at_idx" ON "consolidation_status_logs"("task_id", "created_at" DESC);
CREATE UNIQUE INDEX IF NOT EXISTS "whr_consolidation_plans_plan_no_key" ON "whr_consolidation_plans"("plan_no");
CREATE INDEX IF NOT EXISTS "whr_consolidation_plans_company_id_status_idx" ON "whr_consolidation_plans"("company_id", "status");
CREATE INDEX IF NOT EXISTS "whr_consolidation_plans_company_id_plan_no_idx" ON "whr_consolidation_plans"("company_id", "plan_no");
CREATE INDEX IF NOT EXISTS "whr_consolidation_plan_customers_company_id_client_id_idx" ON "whr_consolidation_plan_customers"("company_id", "client_id");
CREATE INDEX IF NOT EXISTS "whr_consolidation_plan_customers_company_id_plan_id_idx" ON "whr_consolidation_plan_customers"("company_id", "plan_id");
CREATE UNIQUE INDEX IF NOT EXISTS "whr_consolidation_prealerts_tracking_no_key" ON "whr_consolidation_prealerts"("tracking_no");
CREATE INDEX IF NOT EXISTS "whr_consolidation_prealerts_customer_id_idx" ON "whr_consolidation_prealerts"("customer_id");
CREATE INDEX IF NOT EXISTS "whr_consolidation_prealerts_company_id_customer_id_idx" ON "whr_consolidation_prealerts"("company_id", "customer_id");
CREATE INDEX IF NOT EXISTS "whr_consolidation_prealerts_status_idx" ON "whr_consolidation_prealerts"("status");
CREATE INDEX IF NOT EXISTS "whr_consolidation_prealert_items_prealert_id_sort_order_idx" ON "whr_consolidation_prealert_items"("prealert_id", "sort_order");
CREATE INDEX IF NOT EXISTS "whr_consolidation_status_logs_prealert_id_created_at_idx" ON "whr_consolidation_status_logs"("prealert_id", "created_at" DESC);

COMMIT;
