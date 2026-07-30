#!/bin/bash
set -euo pipefail

# ============================================================================
# 集货拼柜 表结构补齐 —— 在服务器上执行
#
# 背景：生产库缺 whr_consolidation_prealerts.payment_proofs 等列，
#       导致「集货拼柜(仓库版)」点开计划时接口 500，前端弹「服务器繁忙」。
#       根因是这些表当初用 db push 推到测试库，从未生成迁移文件，
#       所以生产库永远拿不到。
#
# 本脚本做三件事：备份 → 补齐表结构 → 核对结果
# 所用 SQL 只有 CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS /
# CREATE INDEX IF NOT EXISTS，不含任何 DROP / DELETE / ALTER COLUMN，
# 对已有数据无影响，且可以重复执行。
# ============================================================================

CONTAINER="xiangtai-postgres"
SQL_FILE="$(cd "$(dirname "$0")" && pwd)/fix-consolidation-schema.sql"

echo "=========== 集货拼柜表结构补齐 ==========="
echo

# --- 0. 前置检查 -------------------------------------------------------------
if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "❌ 找不到正在运行的容器 $CONTAINER，脚本中止"
  exit 1
fi
if [ ! -f "$SQL_FILE" ]; then
  echo "❌ 找不到 SQL 文件：$SQL_FILE"
  exit 1
fi
if grep -viE '^\s*--' "$SQL_FILE" | grep -qiE '\b(drop|delete|truncate)\b'; then
  echo "❌ SQL 文件里发现破坏性语句，拒绝执行"
  exit 1
fi
echo "✓ 前置检查通过（容器在跑、SQL 文件存在且无破坏性语句）"
echo

# --- 1. 备份 -----------------------------------------------------------------
echo "--- 第1步：备份数据库 ---"
if [ -x "$(dirname "$0")/backup-db.sh" ]; then
  bash "$(dirname "$0")/backup-db.sh"
else
  mkdir -p /root/db-backups
  OUT="/root/db-backups/before_consolidation_fix_$(date +%Y%m%d_%H%M%S).sql.gz"
  docker exec "$CONTAINER" sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' | gzip > "$OUT"
  echo "备份已写入 $OUT（$(du -h "$OUT" | cut -f1)）"
fi
echo

# --- 2. 补齐表结构 -----------------------------------------------------------
echo "--- 第2步：补齐表结构 ---"
# ON_ERROR_STOP=1：任何一条出错就整体失败；SQL 自身带 BEGIN/COMMIT，会整体回滚
docker exec -i "$CONTAINER" sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -q' < "$SQL_FILE"
echo "✓ 执行完成"
echo

# --- 3. 核对结果 -------------------------------------------------------------
echo "--- 第3步：核对关键列是否补上 ---"
docker exec "$CONTAINER" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
SELECT table_name, column_name
FROM information_schema.columns
WHERE table_name LIKE '\''%consolidation%'\''
  AND column_name IN ('\''payment_proofs'\'', '\''warehouse_receipt_proofs'\'', '\''thailand_receipt_proofs'\'')
ORDER BY table_name, column_name;"'

echo
echo "=========== 完成 ==========="
echo "上面应当列出 whr_consolidation_prealerts 的三个 proofs 列。"
echo "接着请重启 api 让连接池刷新："
echo "  cd /root/MyWebSite && docker compose restart api"
echo "然后在管理员端打开「集货拼柜(仓库版)」，点开一个计划确认不再报「服务器繁忙」。"
