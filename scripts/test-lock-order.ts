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
  /**
   * ⚠️ 这个 helper 第一件事就是 `SELECT ... FROM shipments ... FOR UPDATE`
   * 锁住父单（parent-status.ts:105）。2026-08-29 之前它没登记在这里 ——
   * 于是「把父单锁改成反序」这个变异，7 项照样全绿。
   * 新增间接加锁的 helper 一定要登记，不然这个脚本就是睁眼瞎。
   */
  syncParentStatusFromChildren: ["shipments"],
};

const WRITE_RE = /\btx\.\w+\.(create|update|updateMany|delete|deleteMany|upsert|createMany)\b/;
/**
 * ⚠️ **raw SQL 写入也是写**（2026-08-29 补）。
 * 独立变异实测：在第一把锁前面塞一句 `tx.$executeRaw\`UPDATE ...\``，
 * 上面那条正则只认 `tx.模型.方法`，**一个都抓不到，5 项照样全绿**。
 * 注意别把 `SELECT ... FOR UPDATE` 当成写 —— 它里面也有 UPDATE 这个词，
 * 所以必须匹配到 `UPDATE 表名 SET` 这种完整形状。
 */
const RAW_WRITE_RE = /\btx\.\$(executeRaw|executeRawUnsafe|queryRaw|queryRawUnsafe)\b/;
const RAW_WRITE_SQL_RE = /\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|TRUNCATE)\b/i;
function isWriteLine(line: string): boolean {
  if (WRITE_RE.test(line)) return true;
  return RAW_WRITE_RE.test(line) && RAW_WRITE_SQL_RE.test(line);
}
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
        if (firstWriteLine === null && isWriteLine(l)) firstWriteLine = j + 1;
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
 * 第 7 项的豁免：**新建**一行热表数据不需要先锁它（那行还不存在，锁不到）。
 * ⚠️ 只放「纯 create」，凡是 update / delete 一律不许进这张表。
 */
const WRITE_WITHOUT_LOCK_OK: string[] = [
  // 建派送单：`adminLastmileOrder.create` 插的是**全新的一行**，那行还不存在、锁不到。
  // 这个事务已经按排序锁完了全部运单（同文件 ~626 行），并发那面是护住的。
  "admin-ops/routes.ts:663",
];

/**
 * 已知没加锁、但还没修的路径。
 *
 * **2026-08-29 已经空了** —— 原来挂在这里的三条
 *   · /admin/orders/delete    删订单
 *   · /admin/lastmile/status  签收
 *   · /admin/lastmile/orders  删派送单
 * 当天全部补上了锁（第六轮复核点名要修签收那条）。
 *
 * 这张表**只许变短、不许变长**（见第 5 项）：
 * 往里加东西 = 承认自己写了一条没锁的写库路径，要老板拍板，不许偷偷放行。
 * 新写的接口漏了锁会立刻被第 1 项逮住。
 */
const KNOWN_UNFIXED: string[] = [];

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

check("6) 循环里取锁的，必须锁在**排过序**的清单上", () => {
  /**
   * 独立变异实测（2026-08-29）：把撤销柜子那处的父单锁改成反序，**5 项照样全绿** ——
   * 因为前面几项只看「锁了哪几张表、谁先谁后」，看不见**同一张表内部**的取锁顺序。
   *
   * 一批运单 / 一批父单，两个事务一个 A→B、一个 B→A，就是最经典的反向等待。
   * 所以规矩定死：**取锁的循环，迭代的那个表达式里必须看得见 `.sort(`**。
   * 不接受「SQL 里 orderBy 了所以是有序的」—— 那种得翻到别处才看得出来，
   * 下一个改代码的人看不见，等于没有。要排序就排在眼前这一行。
   */
  const bad: string[] = [];
  let lockLoopsSeen = 0;
  for (const file of walk(ROOT)) {
    const lines = fs.readFileSync(file, "utf-8").split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      /**
       * ⚠️ 这里第一版写的是 `of\s+([^)]+)\)` —— 迭代的表达式里只要有一对括号
       * （`[...ids].sort()` 就是）就匹配不上，**一个循环都没扫到，照样全绿**。
       * 我自己新写的检查，自己又假绿了一次。所以下面还加了「至少要扫到几个」的自检。
       * 用贪婪的 `(.+)` 吃到行尾最后一个 `)`。
       */
      const m = /for\s*\(\s*const\s+\w+\s+of\s+(.+)\)\s*\{\s*$/.exec(lines[i]);
      if (!m) continue;
      // 往下看几行：这个循环体里有没有取锁
      let locks = false;
      for (let j = i + 1; j < Math.min(i + 7, lines.length); j += 1) {
        const t = lines[j].trim();
        if (t.startsWith("}")) break;
        if (t.startsWith("*") || t.startsWith("//")) continue;
        if (t.includes("FOR UPDATE") || Object.keys(LOCK_HELPERS).some((h) => t.includes(`${h}(`))) {
          locks = true;
          break;
        }
      }
      if (!locks) continue;
      lockLoopsSeen += 1;
      if (m[1].includes(".sort(")) continue;
      bad.push(`${rel(file)}:${i + 1}  for (... of ${m[1].trim()})`);
    }
  }
  assert.deepEqual(
    bad,
    [],
    "下面这些循环在给一批行加锁，但迭代的清单没排序 —— 两个事务顺序相反就死锁：\n     " +
      bad.join("\n     "),
  );
  // ⚠️ 自检：一个都没扫到就说明正则又写窄了，上面那个 deepEqual 的绿灯不作数
  assert.ok(
    lockLoopsSeen >= 6,
    `只扫到 ${lockLoopsSeen} 个「循环里取锁」的地方，比预期少 —— 正则可能又写窄了，这一项的绿灯不作数`,
  );
});

/**
 * 「写哪张表，就必须先锁哪张表」—— 只管下面这几张**真出过事**的热表。
 * 别的表大多是子表（轨迹、产品行、图片），锁住父行就够了，全都要求反而全是噪音。
 */
const HOT_TABLES: Record<string, string> = {
  shipment: "shipments",
  container: "containers",
  order: "orders",
  adminLastmileOrder: "admin_lastmile_orders",
};

check("7) 改了运单/柜子/订单/派送单的事务，必须先锁住同一张表", () => {
  /**
   * 独立变异实测（2026-08-29）：把「推进柜子状态」里新加的**逐票运单锁**整段删掉，
   * **5 项照样全绿** —— 因为前面几项只查「已有的锁排得对不对」，
   * 不查「该有的锁在不在」。删掉一把锁反而没人管，这是最要命的一种假绿。
   *
   * 这一项反过来查：事务里 `tx.shipment.update(...)` 了，
   * 那它就必须在**这条写语句之前**锁过 shipments。
   */
  const bad: string[] = [];
  for (const file of walk(ROOT)) {
    const lines = fs.readFileSync(file, "utf-8").split("\n");
    for (const b of scanFile(file)) {
      // 这个事务块的范围：从 b.line 到下一个块（scanFile 已经切好，这里重扫一遍拿写的表）
      let j = b.line; // b.line 是 1-based 的 $transaction 那一行
      const held = new Set<string>();
      while (j < lines.length) {
        const l = lines[j];
        if (l.includes("$transaction") || /app\.(post|get|delete)\("/.test(l)) break;
        const t = l.trim();
        if (t.startsWith("*") || t.startsWith("//") || t.startsWith("/*")) { j += 1; continue; }
        // 先记下这一行拿到的锁
        const helper = Object.keys(LOCK_HELPERS).find((h) => l.includes(`${h}(`));
        if (helper) for (const tb of LOCK_HELPERS[helper]) held.add(tb);
        if (l.includes("FOR UPDATE")) {
          const tb = /FROM\s+(\w+)/.exec(l)?.[1];
          if (tb) held.add(tb);
        }
        // 再看这一行有没有写热表
        for (const [model, table] of Object.entries(HOT_TABLES)) {
          const re = new RegExp(`\\btx\\.${model}\\.(create|update|updateMany|delete|deleteMany|upsert|createMany)\\b`);
          if (re.test(l) && !held.has(table)) {
            bad.push(`${rel(file)}:${j + 1} ${b.route}（改了 ${table}，但之前没锁过它）`);
          }
        }
        j += 1;
      }
    }
  }
  const filtered = [...new Set(bad)].filter(
    (line) => !WRITE_WITHOUT_LOCK_OK.some((k) => line.includes(k)),
  );
  assert.deepEqual(
    filtered,
    [],
    "下面这些地方改了热表却没先锁住它：\n     " + filtered.join("\n     "),
  );
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
  console.error(`\n${failures.length}/7 项不通过：${failures.join("；")}`);
  process.exit(1);
}
console.log(`加锁顺序：7 项全部通过（扫了 ${allBlocks.length} 个会写数据的事务）`);
