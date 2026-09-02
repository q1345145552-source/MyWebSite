/**
 * ⚠️ 禁库硬闸：这个脚本不许连数据库。
 * 「不小心连上测试库」这个坑我已经踩过四次，靠记性不行。
 */
process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/never?connect_timeout=1";

/**
 * 「从柜子里卸货」的自测。
 *
 * 这两个 bug 都是上线后排查出来的、**上线前就存在的老毛病**：
 *
 * 1. **卸柜之后父单状态永远不再更新。**
 *    装柜时父单件数被扣到 0，它的状态就跟着子单走
 *    （parent-status.ts:132「父单自己没货了才接管它的状态」）。
 *    卸柜把件数还回去之后父单又「自己有货」了，那条规矩就不再接管它 ——
 *    **父单状态从此永远冻在卸柜之前那一刻**。
 *    最坏：货已经推到「已签收」，员工发现装错柜卸下来，
 *    客户还看到「已签收」，而货其实躺在仓库里。
 *
 * 2. **删除柜子会把子单变成孤儿。**
 *    删柜子原来只删柜子和柜内记录，子单原样留着（状态写着「已装柜」却不属于任何柜子），
 *    父单被扣走的件数/方数/重量永远回不来。
 *    而「建错柜子删掉重来」是员工很日常的动作。
 *
 * ⚠️ 用**假 tx** 真调那个函数 —— 扫源码证明不了行为，这条教训这个项目里栽过四次。
 */
import assert from "node:assert/strict";
import { unloadAllItemsOfContainer, unloadItemFully } from "../apps/api/src/modules/shipments/unload-item";

const failures: string[] = [];
// 2026-09-02 终审整改：项数动态数，别再写死「8」—— 加减项时收尾输出跟着走
let 总项数 = 0;
async function check(name: string, body: () => Promise<void>): Promise<void> {
  总项数 += 1;
  try { await body(); console.log(`  ✅ ${name}`); }
  catch (error) {
    failures.push(name);
    const m = error instanceof Error ? error.message : String(error);
    console.log(`  ❌ ${name}\n     ${m.split("\n").join("\n     ")}`);
  }
}

/** 假 tx：记下所有写操作，不连任何数据库 */
function makeTx(parent: any, items: any[] = []) {
  const 记录 = { 删掉的柜内记录: [] as string[], 删掉的运单: [] as string[], 父单更新: null as any, 轨迹: [] as any[] };
  return {
    记录,
    tx: {
      shipmentContainerItem: {
        delete: async ({ where }: any) => { 记录.删掉的柜内记录.push(where.id); },
        findMany: async () => items,
      },
      shipment: {
        findFirst: async () => parent,
        update: async ({ data }: any) => { 记录.父单更新 = data; return data; },
        delete: async ({ where }: any) => { 记录.删掉的运单.push(where.id); },
      },
      statusLog: { create: async ({ data }: any) => { 记录.轨迹.push(data); } },
      $queryRaw: async () => [],
    },
  };
}

const 子单 = (over: any = {}) => ({
  id: "s_child", parentTrackingNo: "YW0001", packageCount: 30, volumeM3: 1.5, weightKg: 120, ...over,
});

async function main(): Promise<void> {
  console.log("从柜子里卸货");

  await check("1) 卸柜：件数/方数/重量要全部还给父单", async () => {
    // ⚠️ 三个数字互不相同（父 0 件 / 子 30 件；父 0 方 / 子 1.5 方；父 0kg / 子 120kg）
    const { tx, 记录 } = makeTx({ id: "s_parent", packageCount: 0, volumeM3: 0, weightKg: 0, currentStatus: "delivered" });
    await unloadItemFully(tx as any, { id: "i_1", shipment: 子单() }, "c_1");
    assert.equal(记录.父单更新.packageCount, 30, "件数没还回父单");
    assert.equal(Number(记录.父单更新.volumeM3), 1.5, "方数没还回父单");
    assert.equal(Number(记录.父单更新.weightKg), 120, "重量没还回父单");
    assert.deepEqual(记录.删掉的柜内记录, ["i_1"], "柜内记录没删");
    assert.deepEqual(记录.删掉的运单, ["s_child"], "子单没删");
  });

  await check("2) 卸柜：父单状态要退回「已入库」，还要写一条客户看得懂的轨迹", async () => {
    /**
     * ⚠️ 这就是那个「状态永远冻住」的 bug。
     * 父单原来是 delivered（跟着子单走的），卸柜之后货回到国内仓，
     * 状态必须跟着退回来，否则客户一直看到「已签收」。
     * 2026-09-02：退回目标从「已创建」改成「已入库」（inWarehouseCN 进了流程）——
     * 货卸下来就在仓里，退到「已创建」反而说成还没入库。
     */
    const { tx, 记录 } = makeTx({ id: "s_parent", packageCount: 0, volumeM3: 0, weightKg: 0, currentStatus: "delivered" });
    await unloadItemFully(tx as any, { id: "i_1", shipment: 子单() }, "c_1");
    assert.equal(记录.父单更新.currentStatus, "inWarehouseCN", "父单状态没退回「已入库」—— 客户会一直看到「已签收」");
    assert.equal(记录.轨迹.length, 1, "没写轨迹 —— 客户会觉得状态莫名其妙变了");
    assert.equal(记录.轨迹[0].fromStatus, "delivered", "轨迹的起点状态不对");
    assert.equal(记录.轨迹[0].toStatus, "inWarehouseCN", "轨迹的终点状态不对");
    assert.ok(/退回国内仓/.test(记录.轨迹[0].remark), `轨迹备注看不懂：${记录.轨迹[0].remark}`);
  });

  await check("3) 父单还停在「已创建/已入库」时不许改状态、不许多写轨迹（别刷屏）", async () => {
    // 「已创建」的老单不回填（2026-09-02 拍板），「已入库」的状态本来就对 —— 两种都不动
    for (const cur of ["created", "inWarehouseCN"]) {
      const { tx, 记录 } = makeTx({ id: "s_parent", packageCount: 70, volumeM3: 3, weightKg: 200, currentStatus: cur });
      await unloadItemFully(tx as any, { id: "i_1", shipment: 子单() }, "c_1");
      assert.equal(记录.轨迹.length, 0, `父单是 ${cur} 时还写了轨迹`);
      assert.equal(记录.父单更新.packageCount, 100, "件数还是要还回去（70 + 30）");
      assert.equal(记录.父单更新.currentStatus, undefined, `父单是 ${cur} 时不该动它的状态`);
    }
  });

  await check("4) 没有父单的整票货：不删运单、按终态口径退状态、件数方数重量一个不许动", async () => {
    /**
     * ⚠️ 整票装柜（没分柜）时子单就是运单本身。
     * 这里要是跟着删，客户的运单就凭空没了。
     *
     * 2026-09-02 终审整改（P1）补断言，2026-09-02 复核整改跟上主管裁定的新口径：
     *   · delivered / exception / 一切运输中状态 → 退回「已入库」+ 写 sl_unld_ 轨迹
     *     （货物理上回仓了，挂着已签收/异常就是假话；卸柜是显式业务动作，
     *     不受「自动推进只往前」限制）；
     *   · returned / cancelled → 保持不动（业务已终止不能因卸柜复活），
     *     只写 fromStatus=toStatus 的备注轨迹；
     *   · ⚠️⚠️ 铁的护栏：件数/方数/重量三个字段**不许出现在 update 里**
     *     （排查第 3 条拍板：整票记录卸柜不许改运单数字）。
     */
    // 4a) 运输中 / 已签收 / 异常：都要退回「已入库」+ 写轨迹，数字一个不动
    for (const cur of ["departed", "delivered", "exception"]) {
      // makeTx 第一个参数在这条分支里当「运单自己」用（mock 的 findFirst 不分对象）
      const { tx, 记录 } = makeTx({ id: "s_child", currentStatus: cur });
      const r = await unloadItemFully(tx as any, { id: "i_1", shipment: 子单({ parentTrackingNo: null }) }, "c_1");
      assert.deepEqual(记录.删掉的柜内记录, ["i_1"], "柜内记录没删");
      assert.deepEqual(记录.删掉的运单, [], "把整票货的运单删掉了 —— 客户的单会凭空消失");
      assert.equal(r.删了子单, false);
      assert.ok(记录.父单更新, `整票卸柜后没有动运单（${cur}）—— 状态没退回`);
      assert.equal(记录.父单更新.currentStatus, "inWarehouseCN", `${cur} 的整票卸柜后状态没退回「已入库」—— 客户看到的还是假状态`);
      assert.ok(!("packageCount" in 记录.父单更新), "整票卸柜动了件数 —— 排查第 3 条拍板不许改");
      assert.ok(!("volumeM3" in 记录.父单更新), "整票卸柜动了方数 —— 排查第 3 条拍板不许改");
      assert.ok(!("weightKg" in 记录.父单更新), "整票卸柜动了重量 —— 排查第 3 条拍板不许改");
      assert.equal(记录.轨迹.length, 1, "没写轨迹 —— 客户会觉得状态莫名其妙变了");
      assert.ok(String(记录.轨迹[0].id).startsWith("sl_unld_"), `轨迹 id 前缀不是 sl_unld_：${记录.轨迹[0].id}`);
      assert.equal(记录.轨迹[0].fromStatus, cur, "轨迹的起点状态不对");
      assert.equal(记录.轨迹[0].toStatus, "inWarehouseCN", "轨迹的终点状态不对");
      assert.ok(/退回国内仓/.test(记录.轨迹[0].remark), `轨迹备注看不懂：${记录.轨迹[0].remark}`);
    }
    // 4b) 已退回 / 已取消：业务已终止，不许因卸柜复活；只留 fromStatus=toStatus 的备注轨迹
    for (const cur of ["returned", "cancelled"]) {
      const { tx, 记录 } = makeTx({ id: "s_child", currentStatus: cur });
      await unloadItemFully(tx as any, { id: "i_1", shipment: 子单({ parentTrackingNo: null }) }, "c_1");
      assert.equal(记录.父单更新, null, `${cur} 的整票运单被拽回了 —— 已终止的单不许复活`);
      assert.equal(记录.轨迹.length, 1, `${cur} 卸柜该留一条备注轨迹给排查用`);
      assert.equal(记录.轨迹[0].fromStatus, cur, "备注轨迹的起点状态不对");
      assert.equal(记录.轨迹[0].toStatus, cur, `${cur} 的备注轨迹不该改状态`);
      assert.ok(/已退回\/已取消，卸柜不改变其状态/.test(记录.轨迹[0].remark), `备注轨迹措辞不对：${记录.轨迹[0].remark}`);
    }
    // 4c) 还在国内仓（已创建/已入库/暂缓装柜）：状态不动、也不刷轨迹
    for (const cur of ["created", "inWarehouseCN", "holdLoading"]) {
      const { tx, 记录 } = makeTx({ id: "s_child", currentStatus: cur });
      await unloadItemFully(tx as any, { id: "i_1", shipment: 子单({ parentTrackingNo: null }) }, "c_1");
      assert.equal(记录.父单更新, null, `整票运单是 ${cur} 时不该动它的状态`);
      assert.equal(记录.轨迹.length, 0, `整票运单是 ${cur} 时还写了轨迹（刷屏）`);
    }
  });

  await check("5) 删柜子：柜里每一条都要卸，而且按 id 排序（锁序规矩）", async () => {
    /**
     * ⚠️ 这就是「删柜子把子单变孤儿」那个 bug。
     * 原来删柜子只 deleteMany 柜内记录，子单原样留着、父单数字回不来。
     * ⚠️ 用**乱序**的 id 喂进去，确认它按 id 排序处理 ——
     *    同一批行的加锁顺序必须固定，不然会跟别处死锁。
     */
    const items = [
      { id: "i_c", shipment: 子单({ id: "s_c" }) },
      { id: "i_a", shipment: 子单({ id: "s_a" }) },
      { id: "i_b", shipment: 子单({ id: "s_b" }) },
    ];
    const { tx, 记录 } = makeTx({ id: "s_parent", packageCount: 0, volumeM3: 0, weightKg: 0, currentStatus: "loaded" }, items);
    const n = await unloadAllItemsOfContainer(tx as any, "ct_1", "c_1");
    assert.equal(n, 3, "没有把柜里三条都卸掉");
    assert.deepEqual(记录.删掉的柜内记录, ["i_a", "i_b", "i_c"], "没有按 id 排序处理 —— 会跟别处反向加锁");
    assert.deepEqual(记录.删掉的运单, ["s_a", "s_b", "s_c"], "子单没删干净 —— 会变成孤儿");
  });

  await check("6) 空柜子直接删，不用做别的", async () => {
    const { tx, 记录 } = makeTx(null, []);
    const n = await unloadAllItemsOfContainer(tx as any, "ct_1", "c_1");
    assert.equal(n, 0);
    assert.deepEqual(记录.删掉的柜内记录, []);
  });

  await check("7) 两条路必须走同一份实现（改一处不能漏另一处）", async () => {
    /**
     * ⚠️ 这个项目里「N 个入口只修了 M 个」已经犯过五六次。
     * 这一项盯着：卸柜和删柜子都得调 unload-item 里那两个函数，不许自己再写一遍。
     * ⚠️ 只能证明「源码里写了」，证明不了运行时 —— 真正的守卫是上面 1~6 项。
     */
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const 剔注释 = (t: string): string =>
      t.split("\n").filter((l) => {
        const s2 = l.trim();
        return !s2.startsWith("*") && !s2.startsWith("//") && !s2.startsWith("/*");
      }).join("\n");
    const api = path.join(__dirname, "..", "apps", "api", "src", "modules");
    const 卸柜 = 剔注释(fs.readFileSync(path.join(api, "loading-manifests", "routes.ts"), "utf-8"));
    const 删柜 = 剔注释(fs.readFileSync(path.join(api, "containers", "routes.ts"), "utf-8"));
    assert.ok(/unloadItemFully\(/.test(卸柜), "卸柜没走共用实现");
    assert.ok(/unloadAllItemsOfContainer\(/.test(删柜), "删柜子没走共用实现");
    assert.ok(
      !/shipmentContainerItem\.deleteMany\(\s*\{\s*where:\s*\{\s*containerId/.test(删柜),
      "删柜子还留着直接 deleteMany 柜内记录的写法 —— 那就是子单变孤儿的病根",
    );
  });

  await check("8) 部分卸柜那份手抄的还货逻辑：退状态和写轨迹必须是活代码", async () => {
    /* 2026-09-02 复核补，2026-09-02 复核整改（P3）从「全文件 grep 字符串」升级成
       行为级别的源码检查（上一版被 Codex 终审点名假绿：别处出现那两个字符串也算过）。
       现在照 test-lock-order 的 isDeadLine / 死块跳过写法：
         · 用稳定锚点圈出 loading-manifests/routes.ts 里「部分卸柜还货」那一段；
         · 只在**那段范围内**找 inWarehouseCN 状态更新语句和 sl_unld_ 轨迹创建语句；
         · 注释行不算，被写死假条件（if(false) 之类）包住的死块整块跳过。
       变异自证（2026-09-02 真做过）：把那段包进 if (false) { ... } 后本项变红
       （两条断言都报「是死代码/被删了」），还原后恢复绿 —— 证明它真的在看那段代码。
       ⚠️ 扫源码仍然证明不了运行时行为，真正的行为守卫是上面 1~6 那些用假 tx 真调的项；
       这一项防的是「改一份漏一份」+「代码在但被注释/死块废掉」。 */
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const api = path.join(__dirname, "..", "apps", "api", "src", "modules");
    const 源码 = fs.readFileSync(path.join(api, "loading-manifests", "routes.ts"), "utf-8");
    const lines = 源码.split("\n");
    const 是注释行 = (l: string): boolean => {
      const t = l.trim();
      return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*");
    };

    /**
     * 稳定锚点定位「部分卸柜还货」那段：
     *   起点 = `if (reqPieces < totalLoaded) {` —— 部分卸柜分支的入口；
     *   终点 = 起点之后第一处活的 `unloadItemFully(` —— else 分支的全量卸柜调用，
     *          紧贴在部分卸柜段后面（第 7 项已经保证这个调用必须存在）。
     * 锚点找不到就直接红：说明那段被重构了，这一项要跟着搬家。
     */
    const start = lines.findIndex((l) => !是注释行(l) && /if\s*\(\s*reqPieces\s*<\s*totalLoaded\s*\)/.test(l));
    assert.ok(start >= 0, "找不到部分卸柜分支入口锚点 if (reqPieces < totalLoaded) —— 那段被重构了，这一项要跟着改");
    let end = -1;
    for (let j = start + 1; j < lines.length; j += 1) {
      if (!是注释行(lines[j]) && /unloadItemFully\s*\(/.test(lines[j])) { end = j; break; }
    }
    assert.ok(end > start, "找不到部分卸柜段的终点锚点 unloadItemFully( —— 那段被重构了，这一项要跟着改");

    // 照 test-lock-order 的写法：只认写死的假条件；正常的条件分支（要退状态 ? …）必须放行
    const isDeadLine = (line: string): boolean =>
      /\bif\s*\(\s*(false|0|!true|1\s*===\s*2|1\s*==\s*2)\s*\)/.test(line);
    // 死块范围（左闭右开）：块形式按大括号配对整块跳过，单行形式跳一行
    const deadBlockEnd = (i: number): number => {
      if (!/\{\s*$/.test(lines[i])) return i + 1;
      let depth = 0;
      for (let k = i; k < end; k += 1) {
        depth += (lines[k].match(/\{/g) ?? []).length;
        depth -= (lines[k].match(/\}/g) ?? []).length;
        if (depth <= 0 && k > i) return k + 1;
      }
      return end;
    };

    let 活的退状态 = false;
    let 活的轨迹 = false;
    let j = start;
    while (j < end) {
      const l = lines[j];
      if (是注释行(l)) { j += 1; continue; }
      if (isDeadLine(l)) { j = deadBlockEnd(j); continue; }
      if (/currentStatus:\s*"inWarehouseCN"/.test(l)) 活的退状态 = true;
      if (/sl_unld_/.test(l)) 活的轨迹 = true;
      j += 1;
    }
    assert.ok(活的退状态, "部分卸柜还货段里没有活的「退回已入库」状态更新 —— 被删了或成了注释/死代码");
    assert.ok(活的轨迹, "部分卸柜还货段里没有活的 sl_unld_ 轨迹创建 —— 被删了或成了注释/死代码");
  });

  if (failures.length > 0) {
    console.error(`\n${failures.length}/${总项数} 项不通过：${failures.join("；")}`);
    process.exit(1);
  }
  console.log(`从柜子里卸货：${总项数} 项全部通过`);
}

main().catch((e) => { console.error(e); process.exit(1); });
