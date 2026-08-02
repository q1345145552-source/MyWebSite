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
# 3) 服务器配置（.env / nginx / HTTPS 证书 / 定时任务清单）也从来没备过。
#    数据备得再全，这些没了照样要重配一整天才能把网站搭回来。
#
# 4) 异地：每天同步到阿里云 OSS（泰国曼谷），换公司也换国家。
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

# ---- 3. 服务器配置 --------------------------------------------------------
#
# 光有数据还起不来网站。nginx 配置、HTTPS 证书、.env 里的各种密钥，
# 都是服务器重装后重新搭起来时缺一不可的东西 —— 以前一样都没备。
# 真出事的话数据一条不丢，但要重新配一整天，而且 .env 里的第三方 API 密钥
# 丢了得去各家平台重新申请。
#
# 这些加起来才几 MB。
#
# 安全性：.env 里是密码和密钥，但 restic 仓库整个是加密的（就是那个密码文件在加密），
# 备份里的 .env 同样是加密状态，不会明文躺在磁盘上。
log "备份服务器配置…"
CFG_TMP="$TMP_DIR/config"
rm -rf "$CFG_TMP"; mkdir -p "$CFG_TMP"

# 定时任务清单本身也要备 —— 它不是文件，得先导出来
crontab -l > "$CFG_TMP/crontab.txt" 2>/dev/null || echo "(读不到 crontab)" > "$CFG_TMP/crontab.txt"

CFG_PATHS=("$CFG_TMP")
[ -f /root/MyWebSite/.env ]  && CFG_PATHS+=(/root/MyWebSite/.env)
[ -f /root/MyWebSite/docker-compose.yml ] && CFG_PATHS+=(/root/MyWebSite/docker-compose.yml)
[ -d /etc/nginx ]            && CFG_PATHS+=(/etc/nginx)
[ -d /etc/letsencrypt ]      && CFG_PATHS+=(/etc/letsencrypt)

if restic backup --tag config --host xiangtai "${CFG_PATHS[@]}" 2>&1 | tail -3; then
  log "✅ 配置已存入（${#CFG_PATHS[@]} 项）"
else
  log "⛔ restic 存配置失败"
  FAILED=1
fi
rm -rf "$CFG_TMP"

# ---- 4. 同步到阿里云（异地备份）-------------------------------------------
#
# 上面三步备的东西全在 /root/restic-repo，还是在这一台机器上。
# 硬盘坏、机房出事、服务商停机 —— 数据和备份一起没，等于没备。
# 所以再往阿里云 OSS（泰国曼谷）复制一份：换了公司，也换了国家。
#
# 用 restic copy 而不是简单地把目录同步上去：
#   目录同步会把本地的损坏一并同步过去，而 copy 是往云上那个独立仓库里
#   重新写快照，云端能单独 check、单独恢复，本地烂掉不影响它。
#
# 加密：数据在服务器上就加密好了才上传，阿里云收到的是看不懂的密文，
#      他们自己也打不开。唯一的钥匙是 /root/.restic-password。
#
# 云端凭据放在 /root/.oss-credentials（600 权限）。没有这个文件就跳过，
# 不让缺凭据把整个备份判为失败 —— 本地那份已经好了。
OSS_CRED=/root/.oss-credentials
OSS_REPO='s3:https://oss-ap-southeast-7.aliyuncs.com/wuliuxitongshuju'

if [ ! -s "$OSS_CRED" ]; then
  log "⚠️  找不到 $OSS_CRED，跳过异地同步（本地备份不受影响）"
else
  log "同步到阿里云曼谷…"
  # 凭据只在这个子 shell 里生效，不污染后面的步骤。
  # 脚本开头有 pipefail，所以 restic 失败时整条管道（含 tail）就是失败，
  # 子 shell 的退出码能如实反映出来。
  if (
    set -a; . "$OSS_CRED"; set +a
    restic -r "$OSS_REPO" copy \
      --password-file "$RESTIC_PASSWORD_FILE" \
      --from-repo "$RESTIC_REPOSITORY" \
      --from-password-file "$RESTIC_PASSWORD_FILE" 2>&1 | tail -3
  ); then
    log "✅ 已同步到阿里云"
  else
    # 异地这份没成不至于让整次备份算失败（本地那份是好的），
    # 但必须报出来 —— 连续几天同步不上就等于没有异地备份。
    log "⛔ 同步到阿里云失败 —— 本地备份是好的，但异地这份没更新，尽快查"
    FAILED=1
  fi
fi

# ---- 5. 仓库自检 ----------------------------------------------------------
# 只查结构不逐块读数据（那个很慢）。去重仓库是共用数据块的，
# 一旦坏了可能不是坏一天而是坏一片，所以每次都查一下，早发现早处理。
log "仓库自检…"
if restic check --no-lock 2>&1 | tail -2; then
  log "✅ 仓库结构正常"
else
  log "⛔ 仓库自检不通过 —— 赶紧看，别等到要恢复的时候才发现"
  FAILED=1
fi

# ---- 6. 汇总 --------------------------------------------------------------
log "--- 当前占用 ---"
restic stats --mode raw-data 2>/dev/null | grep -iE "total size|snapshot" || true
log "快照数：$(restic snapshots --json 2>/dev/null | grep -o '"time"' | wc -l)"

if [ "$FAILED" -eq 0 ]; then
  log "========== ✅ restic 备份完成 =========="
  exit 0
fi
log "========== ⛔ restic 备份有问题，见上面 =========="
exit 1
