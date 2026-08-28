/**
 * 普通版集货「还能不能删」这把尺子的自测（不连数据库、不连网络）。
 *
 * 为什么要有这个：2026-08-28 复核发现「删整张预报单」这条路
 * **一道检查都没有** —— 任务已付款也照删，而且是级联删除（货物明细一起没），
 * 钱一分不退；货删光之后「撤销付款」还会 400，退款的口子也跟着封死。
 * 而「删单件货物」那条反而有检查 —— 杀伤力更大的那条没人管。
 *
 * 这个脚本只测那把尺子（checkConsolidationDeletable）。
 * 「锁住 → 重查 → 判断」那部分要连数据库，测不动，只能靠读代码核对：
 *   · 三条路径都在 $transaction 里先 `SELECT ... FOR UPDATE` 锁任务行；
 *   · 判断用的是**锁之后重查**出来的 status / paymentStatus，不是事务外那份快照；
 *   · recalcTaskTotals 传的是事务客户端，删和重算在同一个事务里。
 */
import assert from "node:assert/strict";
import { checkConsolidationDeletable } from "../apps/api/src/modules/consolidation/routes";

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

console.log("普通版集货：删除前的付款/状态检查");

check("1) 还没交钱、任务在收货中 → 可以删", () => {
  const r = checkConsolidationDeletable({ paymentStatus: "unpaid", taskStatus: "collecting" });
  assert.equal(r.ok, true, "该放行却拦住了");
});

check("2) 已付款 → 不许删（这条就是「钱没退货没了」的根子）", () => {
  const r = checkConsolidationDeletable({ paymentStatus: "paid", taskStatus: "collecting" });
  assert.equal(r.ok, false, "已付款还让删");
  assert.ok(!r.ok && r.message.includes("撤销付款"), `提示语要告诉他怎么办：${!r.ok ? r.message : ""}`);
});

check("3) 交了凭证等审核（pending_review）→ 也不许删", () => {
  // 钱已经在路上了，这时候删货，审核通过就成了「付了钱没有货」
  const r = checkConsolidationDeletable({ paymentStatus: "pending_review", taskStatus: "collecting" });
  assert.equal(r.ok, false, "待审核付款还让删");
});

check("4) 已进入装柜及以后 → 不许删", () => {
  for (const status of ["loading", "in_transit", "customs", "delivering", "completed", "cancelled"]) {
    const r = checkConsolidationDeletable({ paymentStatus: "unpaid", taskStatus: status });
    assert.equal(r.ok, false, `${status} 还让删`);
  }
});

check("5) 装柜之前的几档 → 没付款就能删（别把好人也拦了）", () => {
  for (const status of ["collecting", "full_confirmed", "quoted"]) {
    const r = checkConsolidationDeletable({ paymentStatus: "unpaid", taskStatus: status });
    assert.equal(r.ok, true, `${status} 明明还没付款却删不了`);
  }
});

check("6) 付款状态优先于任务状态：已付款 + 收货中，仍然不许删", () => {
  // 两道条件的先后顺序写反的话，这一条会漏
  const r = checkConsolidationDeletable({ paymentStatus: "paid", taskStatus: "collecting" });
  assert.equal(r.ok, false, "付款那道被状态那道挤掉了");
  assert.ok(!r.ok && !r.message.includes("装柜"), "拦是拦住了，但理由报错了（说成装柜流程）");
});

check("7) 冒出没见过的新状态时，默认允许删（黑名单口径，跟原注释一致）", () => {
  // 原代码有意用黑名单而不是白名单：白名单漏写一档，就会让「明明还没付款却删不了」
  const r = checkConsolidationDeletable({ paymentStatus: "unpaid", taskStatus: "某个以后新增的状态" });
  assert.equal(r.ok, true, "新状态被默认拦住了，跟黑名单口径不符");
});


check("8) 三个调用点都真的**用了**这个函数的结论，不是调了就扔", () => {
  /**
   * ⚠️ 复核连着两轮报同一件事：这个脚本只测纯函数
   * `checkConsolidationDeletable`，**没人问「它的返回值有没有被用」**。
   * 实测变异：三条删除路由拿到 verdict 之后直接忽略 → 7/7 照样全绿。
   * 脚本自己开头还写着「接线那部分测不动，只能靠读代码核对」——
   * 那就是承认这 7 项守不住接线。
   *
   * ⚠️ 这一项**只能证明「源码里写了」，证明不了「运行时真会拦」** ——
   * 扫源码的通病（包进 `if (false)` 就抓不到）。
   * 真正的行为测试要连数据库（那三条路都在事务里、先查一堆状态），本地跑不动。
   * 所以这一项是**退而求其次**，比什么都没有强，别当成保险箱。
   */
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  const src = fs
    .readFileSync(
      path.join(__dirname, "..", "apps", "api", "src", "modules", "consolidation", "routes.ts"),
      "utf-8",
    )
    .split("\n");

  // ⚠️ 先剔注释 —— 这个项目里「自己写的注释骗了自己的扫描器」已经发生过两次
  const isComment = (l: string): boolean => {
    const t = l.trim();
    return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*");
  };

  const callSites: number[] = [];
  src.forEach((l, i) => {
    if (!isComment(l) && /checkConsolidationDeletable\(/.test(l) && !/^export function/.test(l.trim())) {
      callSites.push(i);
    }
  });
  assert.ok(
    callSites.length >= 3,
    `只找到 ${callSites.length} 个调用点，比预期少 —— 是不是有删除路由绕过了这道闸？`,
  );

  const bad: string[] = [];
  for (const i of callSites) {
    // 往后看 8 行：拿到的 verdict 必须被判断并抛错，不能调了就扔
    const near = src.slice(i, i + 8).filter((l) => !isComment(l)).join("\n");
    if (!/!\s*verdict\.ok/.test(near) || !/throw|fail\(/.test(near)) {
      bad.push(`consolidation/routes.ts:${i + 1} 调了这个函数，但没有「!verdict.ok → 抛错」`);
    }
  }
  assert.deepEqual(
    bad,
    [],
    "下面这些地方调了删除守卫却没用它的结论 —— 等于这道闸没接上：\n     " + bad.join("\n     "),
  );
});

if (failures.length > 0) {
  console.error(`\n${failures.length}/8 项不通过：${failures.join("；")}`);
  process.exit(1);
}
console.log("普通版集货删除检查：8 项全部通过");
