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

  await check("4) 没有父单的整票货：不删运单、状态退回已入库、件数方数重量一个不许动", async () => {
    /**
     * ⚠️ 整票装柜（没分柜）时子单就是运单本身。
     * 这里要是跟着删，客户的运单就凭空没了。
     *
     * 2026-09-02 终审整改（P1）补断言：整票全量卸柜原来只删柜内记录就走人，
     * 运单状态停在「运输中/已签收」不退回。现在必须：
     *   · 状态退回「已入库」+ 写 sl_unld_ 轨迹；
     *   · ⚠️⚠️ 铁的护栏：件数/方数/重量三个字段**不许出现在 update 里**
     *     （排查第 3 条拍板：整票记录卸柜不许改运单数字）。
     */
    // 4a) 状态已前进（运输中）：退回「已入库」+ 写轨迹，数字一个不动
    {
      // makeTx 第一个参数在这条分支里当「运单自己」用（mock 的 findFirst 不分对象）
      const { tx, 记录 } = makeTx({ id: "s_child", currentStatus: "departed" });
      const r = await unloadItemFully(tx as any, { id: "i_1", shipment: 子单({ parentTrackingNo: null }) }, "c_1");
      assert.deepEqual(记录.删掉的柜内记录, ["i_1"], "柜内记录没删");
      assert.deepEqual(记录.删掉的运单, [], "把整票货的运单删掉了 —— 客户的单会凭空消失");
      assert.equal(r.删了子单, false);
      assert.ok(记录.父单更新, "整票卸柜后没有动运单 —— 状态没退回");
      assert.equal(记录.父单更新.currentStatus, "inWarehouseCN", "整票卸柜后状态没退回「已入库」—— 客户会一直看到「运输中」");
      assert.ok(!("packageCount" in 记录.父单更新), "整票卸柜动了件数 —— 排查第 3 条拍板不许改");
      assert.ok(!("volumeM3" in 记录.父单更新), "整票卸柜动了方数 —— 排查第 3 条拍板不许改");
      assert.ok(!("weightKg" in 记录.父单更新), "整票卸柜动了重量 —— 排查第 3 条拍板不许改");
      assert.equal(记录.轨迹.length, 1, "没写轨迹 —— 客户会觉得状态莫名其妙变了");
      assert.ok(String(记录.轨迹[0].id).startsWith("sl_unld_"), `轨迹 id 前缀不是 sl_unld_：${记录.轨迹[0].id}`);
      assert.equal(记录.轨迹[0].fromStatus, "departed", "轨迹的起点状态不对");
      assert.equal(记录.轨迹[0].toStatus, "inWarehouseCN", "轨迹的终点状态不对");
      assert.ok(/退回国内仓/.test(记录.轨迹[0].remark), `轨迹备注看不懂：${记录.轨迹[0].remark}`);
    }
    // 4b) 终态（已签收等）不许拽回：状态不动，只在轨迹里记一条备注
    {
      const { tx, 记录 } = makeTx({ id: "s_child", currentStatus: "delivered" });
      await unloadItemFully(tx as any, { id: "i_1", shipment: 子单({ parentTrackingNo: null }) }, "c_1");
      assert.equal(记录.父单更新, null, "终态的整票运单被拽回了 —— 终态不许动");
      assert.equal(记录.轨迹.length, 1, "终态卸柜该留一条备注轨迹给排查用");
      assert.equal(记录.轨迹[0].toStatus, "delivered", "终态的备注轨迹不该改状态");
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

  await check("8) 部分卸柜那份手抄的还货逻辑，退的状态和轨迹前缀必须跟共用实现一致", async () => {
    /* 2026-09-02 复核补，2026-09-02 终审整改（P3）把话说老实：
       ⚠️ 这一项**只是源码对表，不是行为测试** —— 它只 grep 整个 routes.ts 里
       有没有出现 inWarehouseCN 和 sl_unld_ 这两个字符串，别处出现也算过，
       证明不了部分卸柜那段真的退状态、真的写轨迹（Codex 终审点名它是假绿）。
       它防的只有一件事：「改一份漏一份」—— loading-manifests 的部分卸柜还货
       是 unloadItemFully 的手抄同款，哪天有人把那边的 inWarehouseCN / sl_unld_
       整个删掉，这里能响一声。真正的行为守卫是上面 1~6 那些用假 tx 真调的项。 */
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const api = path.join(__dirname, "..", "apps", "api", "src", "modules");
    const 部分卸柜 = fs.readFileSync(path.join(api, "loading-manifests", "routes.ts"), "utf-8");
    assert.ok(/inWarehouseCN/.test(部分卸柜), "部分卸柜还货没退回「已入库」—— 跟 unload-item.ts 那份走岔了");
    assert.ok(/sl_unld_/.test(部分卸柜), "部分卸柜还货没写 sl_unld_ 轨迹 —— 跟 unload-item.ts 那份走岔了");
  });

  if (failures.length > 0) {
    console.error(`\n${failures.length}/${总项数} 项不通过：${failures.join("；")}`);
    process.exit(1);
  }
  console.log(`从柜子里卸货：${总项数} 项全部通过`);
}

main().catch((e) => { console.error(e); process.exit(1); });
