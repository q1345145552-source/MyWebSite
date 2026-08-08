#!/usr/bin/env bash
#
# 给 nginx 的湘泰站点加上传体积上限 client_max_body_size。
#
# 为什么要有这个脚本
# ------------------
# 2026-08-08 线上事故：员工在「集货拼柜(仓库版)」点签收、上传入库照片，浏览器报 413。
# 原因是 nginx 全局一条 client_max_body_size 都没配，用的是默认值 1MB，
# 几张手机照片转成 base64 就超了，请求被 nginx 挡在门外，压根没进到后端，
# 所以 `docker compose logs api` 里一条记录都没有。
#
# nginx 配置不在 git 里 —— deploy.sh 的 git reset 不会动它，
# 但重装/迁移服务器也不会自动恢复。这个脚本就是那份「可重放的记录」。
# 同类前例：/etc/systemd/system/xt-block-db-ports.service（防火墙规则）。
#
# 用法（在服务器上跑）：
#   bash /root/MyWebSite/scripts/nginx-upload-limit.sh
#
# 这个脚本是幂等的：已经配好了就什么都不做，可以重复跑。
# 校验失败会自动把配置还原，不会把站点搞挂。

set -euo pipefail

CONF="/etc/nginx/sites-available/xianlianth.com"

# 为什么是 10m 而不是跟后端 maxBytes 一样的 20m
# ------------------------------------------------
# 浏览器发的请求走的是 nginx → 前端(3000, Next.js) → 后端(3001) 三跳，
# 中间 Next.js 的转发自己有一条 10 MiB 的硬上限（2026-08-08 本地实测：
# 10,400,113 字节还是 401，10,800,113 字节就变成 500，边界正好是 10 MiB）。
# 所以 nginx 设得再大也没用 —— 超过 10 MiB 的请求只会从「413 请求过大」
# 变成 Next.js 甩出来的一句光秃秃的 500 Internal Server Error，更难查。
# 设成 10m 让 nginx 卡在真实天花板上，超了就给一个明确的 413。
LIMIT="10m"

if [[ ! -f "$CONF" ]]; then
  echo "找不到 nginx 配置：$CONF" >&2
  exit 1
fi

if grep -q "client_max_body_size" "$CONF"; then
  echo "已经配过 client_max_body_size，无需改动："
  grep -n "client_max_body_size" "$CONF"
  exit 0
fi

BACKUP="${CONF}.bak.$(date +%Y%m%d%H%M%S)"
cp -a "$CONF" "$BACKUP"
echo "已备份原配置到：$BACKUP"

# 在每个 server { 后面插一行。四个 server 块里有两个只做 301 跳转，
# 对它们加这行没有副作用，但这样写最不容易插错地方。
TMP="$(mktemp)"
awk -v limit="$LIMIT" '
  { print }
  /^[[:space:]]*server[[:space:]]*\{[[:space:]]*$/ {
    print "    client_max_body_size " limit ";    # 上传入库照片用，见 scripts/nginx-upload-limit.sh"
  }
' "$CONF" > "$TMP"
cat "$TMP" > "$CONF"
rm -f "$TMP"

echo "--- 改动如下 ---"
diff "$BACKUP" "$CONF" || true
echo "----------------"

if ! nginx -t; then
  echo "nginx 配置校验失败，已还原" >&2
  cp -a "$BACKUP" "$CONF"
  exit 1
fi

systemctl reload nginx
echo "已生效。当前配置："
grep -n "client_max_body_size" "$CONF"
