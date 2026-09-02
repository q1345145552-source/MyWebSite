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
async function check(name: string, body: () => Promise<void>): Promise<void> {
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

  await check("4) 没有父单的整票货：只删柜内记录，**不许删运单**", async () => {
    /**
     * ⚠️ 整票装柜（没分柜）时子单就是运单本身。
     * 这里要是跟着删，客户的运单就凭空没了。
     */
    const { tx, 记录 } = makeTx(null);
    const r = await unloadItemFully(tx as any, { id: "i_1", shipment: 子单({ parentTrackingNo: null }) }, "c_1");
    assert.deepEqual(记录.删掉的柜内记录, ["i_1"], "柜内记录没删");
    assert.deepEqual(记录.删掉的运单, [], "把整票货的运单删掉了 —— 客户的单会凭空消失");
    assert.equal(r.删了子单, false);
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
    /* 2026-09-02 复核补：loading-manifests 的部分卸柜还货是 unloadItemFully 的手抄同款，
       两份今天一致、明天就可能只改一份（本项目「N 个入口只修 M 个」栽过多次）。
       这里做源码级对表：部分卸柜那段必须也退回 inWarehouseCN、也写 sl_unld_ 轨迹。 */
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const api = path.join(__dirname, "..", "apps", "api", "src", "modules");
    const 部分卸柜 = fs.readFileSync(path.join(api, "loading-manifests", "routes.ts"), "utf-8");
    assert.ok(/inWarehouseCN/.test(部分卸柜), "部分卸柜还货没退回「已入库」—— 跟 unload-item.ts 那份走岔了");
    assert.ok(/sl_unld_/.test(部分卸柜), "部分卸柜还货没写 sl_unld_ 轨迹 —— 跟 unload-item.ts 那份走岔了");
  });

  if (failures.length > 0) {
    console.error(`\n${failures.length}/8 项不通过：${failures.join("；")}`);
    process.exit(1);
  }
  console.log("从柜子里卸货：8 项全部通过");
}

main().catch((e) => { console.error(e); process.exit(1); });
