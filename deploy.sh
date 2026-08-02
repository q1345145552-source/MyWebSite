#!/bin/bash
# 湘泰物流网站部署（加固版 v3）
# - 显示本次变更内容
# - 先等 API 就绪再同步数据库（带重试）
# - 部署后检查图片文件完整性
# - 构建失败保留旧容器，不中断服务

# 先复制一份自己，用副本跑。
#
# 这个脚本跑到一半会 `git reset --hard`。如果这次部署的内容恰好也改了 deploy.sh 自己，
# 文件就在脚本还没跑完的时候被换掉了 —— bash 是按「读到第几个字节」往下读的，
# 会接着从新文件的那个位置继续读，执行出半截乱码命令（本地实测确认会）。
# 用副本跑，原文件怎么变都不影响正在跑的这一次。
if [ -z "$DEPLOY_SRC_DIR" ]; then
  export DEPLOY_SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
  SELF_COPY="$(mktemp /tmp/deploy-running-XXXXXX.sh)" || { echo "❌ 无法创建临时文件"; exit 1; }
  cp "$0" "$SELF_COPY" || { echo "❌ 复制部署脚本失败"; rm -f "$SELF_COPY"; exit 1; }
  bash "$SELF_COPY" "$@"
  DEPLOY_RC=$?
  rm -f "$SELF_COPY"
  exit $DEPLOY_RC
fi

echo "=== 湘泰物流网站部署 ==="
cd "$DEPLOY_SRC_DIR" || exit 1

# 收集本次部署出现的问题。
# 原来每一步出问题都只是打一行警告，然后照样往下走、最后照样显示「部署完成」——
# 不盯着屏幕看根本发现不了。现在统一记下来，结尾一次性摊开，并用退出码区分成败。
DEPLOY_ISSUES=()
note_issue() {
  DEPLOY_ISSUES+=("$1")
  echo "⚠️  $1"
}

# 1. 检查 .env
if ! grep -q "NEXT_PUBLIC_API_BASE_URL=" .env 2>/dev/null; then
  echo "❌ 缺少 .env 文件或 NEXT_PUBLIC_API_BASE_URL 未设置"
  exit 1
fi
source .env
echo "✅ API 地址: $NEXT_PUBLIC_API_BASE_URL"

# 2. 记录当前版本
OLD_COMMIT=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
echo "📌 当前版本: ${OLD_COMMIT:0:8}"

# 3. 拉代码
echo "📥 拉取最新代码..."
git fetch origin
NEW_COMMIT=$(git rev-parse origin/main)

if [ "$OLD_COMMIT" = "$NEW_COMMIT" ]; then
  echo "✅ 已是最新版本，无需部署"
  exit 0
fi

# 显示变更
echo ""
echo "========== 📋 本次部署包含的变更 =========="
git log --oneline ${OLD_COMMIT}..${NEW_COMMIT} 2>/dev/null || echo "(无法获取)"
echo "=============================================="
echo ""

git reset --hard origin/main

# 4. 检查关键环境变量
echo "🔍 环境检查..."
if ! grep -q "IMAGES_DIR" docker-compose.yml; then
  note_issue "docker-compose.yml 缺少 IMAGES_DIR 环境变量（图片可能无法访问）"
fi
if ! grep -q "127.0.0.1" docker-compose.yml; then
  note_issue "docker-compose.yml healthcheck 仍使用 localhost（可能导致 unhealthy）"
fi

# 5. 修复备份脚本权限
chmod +x scripts/backup-db.sh 2>/dev/null || true

# 6. 安装依赖
npm install --ignore-scripts 2>/dev/null || true

# 7. 确保旧容器在运行（构建期间服务不中断）
echo "🔧 确保旧服务运行中..."
docker compose up -d 2>/dev/null || true

# 8. 构建
echo "🔨 构建 Docker 镜像..."
BUILD_OK=false

if docker compose build web api 2>&1; then
  BUILD_OK=true
else
  echo "⚠️  增量构建失败，尝试全量构建..."
  if docker compose build --no-cache web api 2>&1; then
    BUILD_OK=true
  fi
fi

# 9. 构建成功才切换
if [ "$BUILD_OK" = true ]; then
  echo "✅ 构建成功，切换容器..."
  docker compose up -d
else
  echo "⛔ 构建失败，保留旧容器"
  docker compose up -d
  exit 1
fi

# 10. 等待 API 就绪（最多 60s）
echo "⏳ 等待 API 就绪..."
API_READY=false
for i in $(seq 1 20); do
  if curl -sf http://localhost:3001/ -o /dev/null 2>/dev/null; then
    API_READY=true
    echo "✅ API 已就绪"
    break
  fi
  sleep 3
done

if [ "$API_READY" = false ]; then
  note_issue "API 在 60 秒内没就绪，后续步骤可能不准"
fi

# 11a. 这次部署到底要不要动数据库？
#
# 绝大多数部署只改代码、根本不碰数据库结构，那次备份（约 9 秒 + 130MB 磁盘）是白花的。
# 所以先问一句 Prisma：还有没有没执行的迁移文件？
#   没有 → 跳过备份，也跳过迁移，直接进健康检查
#   有   → 老老实实备份再动，改结构出意外时那是唯一的退路
#
# 注意这里故意「问不出来就当作要动」：API 没起来、命令报错等情况一律走备份那条路。
# 宁可白备一次，也不能在该备的时候没备。
echo "🔍 检查这次部署要不要动数据库..."
NEED_DB_WORK=true
MIGRATE_STATUS=$(docker compose exec -T api npx prisma migrate status --schema=apps/api/prisma/schema.prisma 2>&1)
if echo "$MIGRATE_STATUS" | grep -q "Database schema is up to date"; then
  NEED_DB_WORK=false
  echo "✅ 没有待执行的迁移，这次不动数据库（跳过备份，省下约 9 秒和 130MB）"
else
  echo "📋 有待执行的迁移，这次要改数据库结构："
  echo "$MIGRATE_STATUS" | grep -iE "have not yet been applied|migration.*found|^  " | head -8
fi

# 11b. 要动数据库才备份
BACKUP_OK=false
if [ "$NEED_DB_WORK" = false ]; then
  BACKUP_OK=true   # 不动数据库，不需要退路
else
  echo "💾 改结构前备份数据库..."
  # 用 $DEPLOY_SRC_DIR 而不是 $(dirname "$0")：
  # 脚本是复制到 /tmp 跑的（见开头的自我复制保护），$0 指向 /tmp，
  # dirname 出来就是 /tmp，找不到 scripts/backup-db.sh。
  # 2026-08-02 部署时踩过这个坑：备份失败 → 连带跳过了数据库迁移。
  if BACKUP_LABEL="predeploy_$(date +%Y%m%d_%H%M%S)" bash "$DEPLOY_SRC_DIR/scripts/backup-db.sh"; then
    BACKUP_OK=true
  else
    note_issue "数据库备份失败 —— 已跳过数据库迁移"
  fi
fi

# 11c. 执行迁移文件（原来这里是 `prisma db push --accept-data-loss`）
#
# 为什么换掉 db push：它的职责是让数据库和 schema.prisma 长得一模一样 ——
# 设计图里没有的字段会被删掉；改字段名在它眼里是「删旧的、加一个新的空的」，
# 那一列数据全没。2026-07-31 部署时它真的删过一个带数据的字段。
# migrate deploy 只执行 apps/api/prisma/migrations/ 下写好的迁移文件，不自作主张，
# 也不会因为设计图里少写了什么就去删东西。
DB_SYNC_OK=false
if [ "$NEED_DB_WORK" = false ]; then
  DB_SYNC_OK=true
  echo "⏭️  跳过数据库迁移（没有待执行的迁移）"
elif [ "$BACKUP_OK" = false ]; then
  echo ""
  echo "⛔ 跳过数据库迁移 —— 因为备份没成功，此时改结构一旦出问题无法回退。"
  echo "   请先修好备份，再手动执行迁移。服务本身不受影响，代码已经上线。"
  echo ""
else
echo "🗄️  执行数据库迁移..."
for i in 1 2 3; do
  echo "  第${i}次尝试..."
  if docker compose exec -T api npx prisma migrate deploy --schema=apps/api/prisma/schema.prisma 2>&1; then
    DB_SYNC_OK=true
    break
  fi
  sleep 5
done
fi

if [ "$BACKUP_OK" = true ] && [ "$DB_SYNC_OK" = false ]; then
  note_issue "数据库迁移失败 —— 如果是某个迁移文件执行到一半失败，它会挡住以后所有迁移，必须先处理（先看上面的报错，再跑 prisma migrate status 确认）"
elif [ "$NEED_DB_WORK" = true ] && [ "$DB_SYNC_OK" = true ]; then
  # 只有真的改过结构才重启 API 让它重新认识数据库。
  # 没改结构还重启，纯粹是多一次没必要的服务中断。
  echo "✅ 数据库迁移完成"
  docker compose restart api 2>&1 | tail -1
  sleep 5
fi

# 11d. 数据库结构体检（纯只读，一个字都不改）
#
# 换成 migrate deploy 之后，就没有「谁改了设计图但忘了写迁移文件、db push 也能自动补上」
# 这个兜底了。所以每次部署都得体检一遍：设计图有、数据库没有的字段会被列出来。
# 不体检的话，缺字段要等客户点开页面弹「服务器繁忙」才发现（集货拼柜那次就是）。
echo "🔍 数据库结构体检..."
if [ ! -f scripts/check-schema-drift.sql ]; then
  note_issue "找不到 scripts/check-schema-drift.sql，这次没做结构体检"
else
  DRIFT_RAW=$(docker compose exec -T postgres sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -t -A -q -v ON_ERROR_STOP=1' < scripts/check-schema-drift.sql 2>&1)
  DRIFT_RC=$?
  if [ $DRIFT_RC -ne 0 ]; then
    echo "$DRIFT_RAW"
    note_issue "结构体检没跑起来（上面是原始输出）—— 这次部署没检查数据库结构"
  else
    DRIFT=$(echo "$DRIFT_RAW" | grep -v '^[[:space:]]*$')
    if [ -n "$DRIFT" ]; then
      echo "$DRIFT"
      DRIFT_COUNT=$(echo "$DRIFT" | wc -l | tr -d ' ')
      note_issue "数据库结构与设计图有 ${DRIFT_COUNT} 处对不上（见上面几行）：「A 缺失」是数据库少了字段，相关页面会报错，要补一个迁移文件；「B 多余」不影响使用，不用管"
    else
      echo "✅ 结构与设计图一致"
    fi
  fi
fi

# 12. 健康检查
echo "⏳ 等待服务就绪..."

wait_for_service() {
  local url=$1
  local name=$2
  local max_wait=90
  local elapsed=0
  while [ $elapsed -lt $max_wait ]; do
    if curl -sf "$url" -o /dev/null 2>/dev/null; then
      echo "✅ $name 正常"
      return 0
    fi
    sleep 3
    elapsed=$((elapsed + 3))
  done
  echo "❌ $name 未响应（等了 ${max_wait}s）"
  return 1
}

wait_for_service "http://localhost:3001" "API" || note_issue "API 健康检查未通过 —— 后台可能不可用"
wait_for_service "http://localhost:3000" "Web" || note_issue "Web 健康检查未通过 —— 前台可能打不开"

# 13. 图片完整性检查
echo "🖼️  图片文件检查..."
IMG_DB=$(docker compose exec -T postgres psql -t -A -U xiangtai -d xiangtai -c "SELECT count(*) FROM order_product_images WHERE file_path IS NOT NULL AND file_path != ''" 2>/dev/null | tr -d ' ' || echo "0")
IMG_DISK=$(docker compose exec -T api ls /images/ 2>/dev/null | wc -l | tr -d ' ' || echo "0")
echo "  数据库记录: $IMG_DB | 磁盘文件: $IMG_DISK"
if [ "$IMG_DB" -gt 0 ] 2>/dev/null && [ "$IMG_DISK" -lt "$IMG_DB" ] 2>/dev/null; then
  note_issue "磁盘图片($IMG_DISK)少于数据库记录($IMG_DB)，部分图片可能显示不出来"
fi

# 14. 重载 nginx
nginx -s reload 2>/dev/null || true

echo ""
echo "=============================================="
if [ ${#DEPLOY_ISSUES[@]} -eq 0 ]; then
  echo "=== ✅ 部署完成，一切正常 ==="
  echo "📌 新版本: $(git rev-parse --short HEAD)"
  echo "=============================================="
  exit 0
fi

# 走到这里说明中途有问题。原来这些问题只在过程中一闪而过，
# 结尾照样显示「部署完成」，很容易被当成成功。
echo "=== ⚠️  部署完成，但有 ${#DEPLOY_ISSUES[@]} 处问题需要处理 ==="
echo ""
i=1
for issue in "${DEPLOY_ISSUES[@]}"; do
  echo "  $i) $issue"
  i=$((i + 1))
done
echo ""
echo "📌 新版本: $(git rev-parse --short HEAD)"
echo "📌 上一版: ${OLD_COMMIT:0:8}"
echo ""
echo "需要回滚到上一版的话："
echo "  cd $(pwd) && git reset --hard ${OLD_COMMIT} && docker compose up -d --build"
echo ""
echo "数据库备份在 /root/db-backups/（本次的文件名以 predeploy_ 开头）"
echo "=============================================="
exit 1
