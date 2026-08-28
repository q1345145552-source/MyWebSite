/**
 * 加锁顺序的自测（只读源码，不连数据库）。
 *
 * 为什么要有这个：2026-08-28 我用正则扫「每个事务里 FOR UPDATE 的先后」，
 * 得出「17 条路径锁序统一」——**那个结论是错的**。
 * 正则只看得见加锁语句，看不见**锁之前已经写了什么**：
 * 管理员强改预报单实际是「先删改产品行 → 才加锁」，等于没锁。
 * 复核实测把这条揪了出来。
 *
 * 所以这个脚本查两件事，缺一不可：
 *   ① **第一条写语句必须排在第一把锁后面**（不然锁等于白加）；
 *   ② 同一模块里所有事务的**加锁顺序必须一致**（方向相反会死锁）。
 *
 * ⚠️ 这是**静态检查**，认不出通过函数间接加的锁（比如 plan-guard 里那几个 helper）。
 * 所以下面对那些 helper 做了显式映射；新增 helper 要记得加进来，
 * 否则这个脚本会把它当成「没加锁就写」而误报 —— 误报比漏报好。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..", "apps", "api", "src", "modules");

/** 间接加锁的 helper：调用它 = 锁了这些表（按顺序） */
const LOCK_HELPERS: Record<string, string[]> = {
  lockPlanAliveById: ["whr_consolidation_plans"],
  lockPlanAliveByPrealert: ["whr_consolidation_plans"],
  lockPlanByPrealert: ["whr_consolidation_plans"],
  lockPrealertExpecting: ["whr_consolidation_prealerts"],
};

const WRITE_RE = /\btx\.\w+\.(create|update|updateMany|delete|deleteMany|upsert|createMany)\b/;
const RAW_LOCK_RE = /FROM\s+(\w+)\s+WHERE[\s\S]*FOR UPDATE|FOR UPDATE/;

interface TxBlock {
  file: string;
  route: string;
  line: number;
  locks: string[];
  firstLockLine: number | null;
  firstWriteLine: number | null;
}

function scanFile(file: string): TxBlock[] {
  const lines = fs.readFileSync(file, "utf-8").split("\n");
  const blocks: TxBlock[] = [];
  let route = "(文件顶层)";
  let i = 0;
  while (i < lines.length) {
    const routeMatch = /app\.(post|get|delete)\("([^"]+)"/.exec(lines[i]);
    if (routeMatch) route = routeMatch[2];
    if (lines[i].includes("$transaction")) {
      const start = i;
      const locks: string[] = [];
      let firstLockLine: number | null = null;
      let firstWriteLine: number | null = null;
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j];
        if (l.includes("$transaction") || /app\.(post|get|delete)\("/.test(l)) break;
        /**
         * ⚠️ **注释行要跳过**（2026-08-29 修）。
         * 第一版没跳，结果我在源码里写的那句
         *   「以后判断锁序不能只看 FOR UPDATE 的位置」
         * 被当成了一把真锁 —— 把加锁语句删掉做变异，测试照样全绿。
         * 我自己的注释把我自己的测试骗了，跟这个脚本要防的是同一类毛病。
         */
        const trimmed = l.trim();
        if (trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*")) {
          j += 1;
          continue;
        }
        const helper = Object.keys(LOCK_HELPERS).find((h) => l.includes(`${h}(`));
        if (helper) {
          for (const t of LOCK_HELPERS[helper]) if (locks[locks.length - 1] !== t) locks.push(t);
          if (firstLockLine === null) firstLockLine = j + 1;
        } else if (RAW_LOCK_RE.test(l) && l.includes("FOR UPDATE")) {
          const t = /FROM\s+(\w+)/.exec(l)?.[1];
          if (t && locks[locks.length - 1] !== t) locks.push(t);
          if (firstLockLine === null) firstLockLine = j + 1;
        }
        if (firstWriteLine === null && WRITE_RE.test(l)) firstWriteLine = j + 1;
        j += 1;
      }
      blocks.push({ file, route, line: start + 1, locks, firstLockLine, firstWriteLine });
      i = j;
      continue;
    }
    i += 1;
  }
  return blocks;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

const allBlocks = walk(ROOT).flatMap(scanFile).filter((b) => b.firstWriteLine !== null);

const failures: string[] = [];
function check(name: string, body: () => void): void {
  try {
    body();
    console.log(`  ✅ ${name}`);
  } catch (error) {
    failures.push(name);
    const message = error instanceof Error ? error.message : String(error);
    console.log(`  ❌ ${name}\n     ${message.split("\n").join("\n     ")}`);
  }
}

const rel = (f: string): string => path.relative(ROOT, f);

console.log("加锁顺序");

/**
 * 不需要加锁的事务：只往里插全新的行、不依赖「先读再判」的。
 * ⚠️ 往这张表里加东西前先问一句：这个事务有没有「读一个值 → 拿它做决定 → 再写」？
 * 有的话就必须加锁，不能放进白名单。
 */
const NO_LOCK_NEEDED: Array<[string, string]> = [
  ["client-addresses/routes.ts", "新建收货地址：纯插入一行新数据，不依赖任何已有状态"],
  ["whr-consolidation/routes.ts:161", "新建拼柜计划：纯插入，计划这时候还不存在"],
  [
    "whr-consolidation/routes.ts:1110",
    "改货型：只改这一行的货型 + 写一条日志。用户 2026-08-15 拍板「全部手动报价」，" +
      "这条路故意不重算金额，也不动方数件数，没有共享的合计要护",
  ],
];

/**
 * ⚠️ **已知没加锁、但还没修**的三条（2026-08-29 这个脚本刚写出来时就扫到的）。
 *
 * 它们**是真问题**，不是白名单 —— 跟上面 NO_LOCK_NEEDED 完全两回事：
 *   · /admin/orders/delete        删订单，会连带影响运单和柜内记录
 *   · /admin/lastmile/status      改尾端派送状态，是状态机
 *   · /admin/lastmile/orders      建/改尾端派送单
 * 都不在这轮复核的范围里，改之前要先把它们各自的并发场景理清楚，
 * 所以先挂在这里、等老板拍板再动，而不是偷偷放行。
 *
 * 这张表**只许变短、不许变长**（见第 5 项）—— 新写的接口漏了锁会立刻被第 1 项逮住。
 */
const KNOWN_UNFIXED = [
  "admin/routes.ts:1168",
  "admin-ops/routes.ts:706",
  "admin-ops/routes.ts:760",
];

check("1) 每个会写数据的事务，第一条写语句都排在第一把锁后面", () => {
  /**
   * 这一项就是复核抓到我那次的：管理员强改先删改产品行、再加锁 ——
   * 正则看「FOR UPDATE 的先后」是看不出来的，必须比「第一次写」和「第一把锁」的行号。
   */
  const bad = allBlocks
    .filter((b) => b.firstLockLine === null || b.firstWriteLine! < b.firstLockLine)
    .filter((b) => !NO_LOCK_NEEDED.some(([key]) => `${rel(b.file)}:${b.line}`.includes(key)))
    .filter((b) => !KNOWN_UNFIXED.includes(`${rel(b.file)}:${b.line}`))
    .map((b) => `${rel(b.file)}:${b.line} ${b.route}（首次写 ${b.firstWriteLine}，首把锁 ${b.firstLockLine ?? "无"}）`);
  assert.deepEqual(bad, [], "下面这些事务在拿到锁之前就写数据了，锁等于白加：\n     " + bad.join("\n     "));
});

check("2) 集货：所有事务都按【任务 → 预报单】的顺序加锁", () => {
  const seen = allBlocks
    .filter((b) => b.file.includes("/consolidation/") && !b.file.includes("whr-"))
    .map((b) => ({ b, seq: b.locks.filter((t) => t.startsWith("consolidation_")) }))
    .filter((x) => x.seq.length > 1);
  const bad = seen
    .filter((x) => {
      const t = x.seq.indexOf("consolidation_tasks");
      const p = x.seq.indexOf("consolidation_prealerts");
      return t >= 0 && p >= 0 && p < t;
    })
    .map((x) => `${rel(x.b.file)}:${x.b.line} ${x.b.route}（${x.seq.join(" → ")}）`);
  assert.deepEqual(bad, [], "下面这些先锁预报单后锁任务，跟别处反着，会死锁：\n     " + bad.join("\n     "));
});

check("3) 柜子：所有事务都按【柜 → 柜内记录 → 运单】的顺序加锁", () => {
  const ORDER = ["containers", "shipment_container_items", "shipments"];
  const bad = allBlocks
    .filter((b) => b.file.includes("/containers/") || b.file.includes("/loading-manifests/"))
    .map((b) => ({ b, seq: b.locks.filter((t) => ORDER.includes(t)) }))
    .filter((x) => x.seq.length > 1)
    .filter((x) => {
      const idx = x.seq.map((t) => ORDER.indexOf(t));
      return idx.some((v, i) => i > 0 && v < idx[i - 1]);
    })
    .map((x) => `${rel(x.b.file)}:${x.b.line} ${x.b.route}（${x.seq.join(" → ")}）`);
  assert.deepEqual(bad, [], "下面这些柜子相关事务的锁序跟别处反着，会死锁：\n     " + bad.join("\n     "));
});

check("4) 扫到的事务数量不能突然变少（防止我把正则写窄了自己骗自己）", () => {
  // 这个数字是 2026-08-29 实际扫出来的。以后加接口只会变多；
  // 变少说明正则漏掉了一批，那时候上面三项的「全绿」就不作数了。
  assert.ok(
    allBlocks.length >= 30,
    `只扫到 ${allBlocks.length} 个会写数据的事务，比预期少 —— 正则可能漏了一批，上面三项的绿灯不作数`,
  );
});

check("5) 「已知没加锁」那张表只许变短，不许变长", () => {
  const stillBroken = allBlocks
    .filter((b) => b.firstLockLine === null || b.firstWriteLine! < b.firstLockLine)
    .map((b) => `${rel(b.file)}:${b.line}`);
  const stale = KNOWN_UNFIXED.filter((k) => !stillBroken.includes(k));
  assert.deepEqual(
    stale,
    [],
    "这几条已经修好了，请把它们从 KNOWN_UNFIXED 里删掉，别让这张表越留越旧：\n     " + stale.join("\n     "),
  );
});

if (failures.length > 0) {
  console.error(`\n${failures.length}/5 项不通过：${failures.join("；")}`);
  process.exit(1);
}
console.log(`加锁顺序：5 项全部通过（扫了 ${allBlocks.length} 个会写数据的事务）`);
