#!/bin/bash
set -uo pipefail

# ============================================================================
# restic 去重备份：数据库 + 磁盘图片，永久保留
# ============================================================================
#
# 为什么需要这个脚本
# ------------------
# 1) backup-db.sh 每天导一份完整备份，压缩后约 110MB。要「永久保留」的话
#    一年就是 40GB，服务器磁盘只有 96GB —— 大约 15 个月就满，盘一满网站直接出问题。
#    restic 把数据切成小块、每块只存一次：今天和昨天 99% 是一样的，就只存那 1%。
#    而且**每一天的快照都能单独还原**，不像老式增量备份那样一环扣一环、断一环全废。
#
# 2) 磁盘 /root/MyWebSite/data/images 里的图片文件**从来没有被备份过** ——
#    pg_dump 只导数据库，不含磁盘上的文件。历史上已经因此丢过 279 张产品图。
#    （每天在跑的 backup-images.ts 备的是数据库里 base64 存的那批，
#      那批本来就在 pg_dump 里，属于重复备份，真正该备的这批反而漏了。）
#
# 保留策略：**永久**。本脚本不做任何 forget/prune，快照只增不减。
#
# 后路：backup-db.sh 仍然每月留一份独立的 .sql.gz（不依赖 restic，
#      万一 restic 仓库整个损坏，每月的档案还在）。两条腿走路，别只留一条。
#
# crontab:
#   0 1 * * * /root/MyWebSite/scripts/backup-restic.sh >> /root/db-backups/restic.log 2>&1
# ============================================================================

export RESTIC_REPOSITORY="${RESTIC_REPOSITORY:-/root/restic-repo}"
export RESTIC_PASSWORD_FILE="${RESTIC_PASSWORD_FILE:-/root/.restic-password}"

IMAGES_DIR="/root/MyWebSite/data/images"
TMP_DIR="/root/db-backups/.restic-tmp"
TMP_SQL="$TMP_DIR/xiangtai.sql"
MIN_SQL_MB=50           # 未压缩的库导出小于这个值就认为不正常
MIN_FREE_MB=2000        # 磁盘至少留 2GB 再动手

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"; }
FAILED=0

log "========== restic 备份开始 =========="

# ---- 0. 前置检查 ----------------------------------------------------------
if ! command -v restic > /dev/null 2>&1; then
  log "⛔ restic 没装，放弃（apt install restic）"
  exit 1
fi

# 密码文件是命根子：丢了所有快照都打不开，谁也救不回来
if [ ! -s "$RESTIC_PASSWORD_FILE" ]; then
  log "⛔ 找不到密码文件 $RESTIC_PASSWORD_FILE（或是空的），放弃"
  exit 1
fi

if ! restic snapshots > /dev/null 2>&1; then
  log "⛔ 打不开 restic 仓库 $RESTIC_REPOSITORY —— 密码不对或仓库没初始化，放弃"
  exit 1
fi

AVAIL=$(df -m "$RESTIC_REPOSITORY" | tail -1 | awk '{print $4}')
if [ "$AVAIL" -lt "$MIN_FREE_MB" ]; then
  log "⛔ 磁盘只剩 ${AVAIL}MB，低于 ${MIN_FREE_MB}MB，放弃备份"
  exit 1
fi

cd /root/MyWebSite || { log "⛔ 进不去 /root/MyWebSite"; exit 1; }

# ---- 1. 数据库 ------------------------------------------------------------
#
# 先导成一个**不压缩**的 .sql 临时文件，再交给 restic。
# 不能直接 pg_dump | gzip 之后再给 restic —— 压缩过的文件哪怕只改一个字节，
# 后面所有字节全变，去重就完全失效了。未压缩的 SQL 才切得出重复块。
# restic 自己会压缩，最终占用不会比 gz 大。
log "导出数据库…"
mkdir -p "$TMP_DIR"
rm -f "$TMP_SQL"

if ! docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' > "$TMP_SQL" 2>/dev/null; then
  log "⛔ pg_dump 失败，跳过数据库这部分"
  rm -f "$TMP_SQL"
  FAILED=1
else
  SQL_MB=$(( $(stat -c%s "$TMP_SQL") / 1024 / 1024 ))
  if [ "$SQL_MB" -lt "$MIN_SQL_MB" ]; then
    # 宁可这次不备，也不能把一个残缺的导出存进仓库冒充好备份
    log "⛔ 导出只有 ${SQL_MB}MB（低于 ${MIN_SQL_MB}MB），像是没导全，不存进仓库"
    rm -f "$TMP_SQL"
    FAILED=1
  else
    log "导出完成：${SQL_MB}MB，交给 restic…"
    if restic backup --tag db --host xiangtai "$TMP_SQL" 2>&1 | tail -4; then
      log "✅ 数据库已存入"
    else
      log "⛔ restic 存数据库失败"
      FAILED=1
    fi
    rm -f "$TMP_SQL"
  fi
fi

# ---- 2. 磁盘图片 ----------------------------------------------------------
log "备份磁盘图片 $IMAGES_DIR …"
if [ ! -d "$IMAGES_DIR" ]; then
  log "⚠️  图片目录不存在，跳过（挂载改过？对照 docker-compose.yml 的 ./data/images）"
  FAILED=1
elif restic backup --tag images --host xiangtai "$IMAGES_DIR" 2>&1 | tail -4; then
  log "✅ 图片已存入（$(ls "$IMAGES_DIR" 2>/dev/null | wc -l) 个文件）"
else
  log "⛔ restic 存图片失败"
  FAILED=1
fi

# ---- 3. 仓库自检 ----------------------------------------------------------
# 只查结构不逐块读数据（那个很慢）。去重仓库是共用数据块的，
# 一旦坏了可能不是坏一天而是坏一片，所以每次都查一下，早发现早处理。
log "仓库自检…"
if restic check --no-lock 2>&1 | tail -2; then
  log "✅ 仓库结构正常"
else
  log "⛔ 仓库自检不通过 —— 赶紧看，别等到要恢复的时候才发现"
  FAILED=1
fi

# ---- 4. 汇总 --------------------------------------------------------------
log "--- 当前占用 ---"
restic stats --mode raw-data 2>/dev/null | grep -iE "total size|snapshot" || true
log "快照数：$(restic snapshots --json 2>/dev/null | grep -o '"time"' | wc -l)"

if [ "$FAILED" -eq 0 ]; then
  log "========== ✅ restic 备份完成 =========="
  exit 0
fi
log "========== ⛔ restic 备份有问题，见上面 =========="
exit 1
