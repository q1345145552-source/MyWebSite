/**
 * 整柜拆柜派送清单导出的自测（不连数据库、不连网络、不写文件）。
 *
 * 为什么要有这个：2026-08-28 老板实测发现「多尺寸的单子，Excel 长宽高三格全是空白」，
 * 而单尺寸的能导出来 —— 这个模块**一个测试都没有**，所以没人发现。
 *
 * 根因链条（三环，缺一环这三列就是空的）：
 *   ① 后端 loading-manifests/routes.ts:397 给每票货的 products 恒定是空数组
 *      （柜内多是分柜子单，展开产品行会把件数重复算回整票）；
 *   ② 于是前端只能用**运单级**的长宽高，而后端把一票货里的多个尺寸合并成
 *      「60/50」这种字符串（orders/routes.ts:1657）；
 *   ③ 前端原来「只认数字」，字符串一律丢成 null → 三格空白。
 *
 * 这个脚本只测第 ③ 环（前端这一层是纯计算，测得动）。
 */
import assert from "node:assert/strict";
import {
  expandTemplateLines,
  type LastmileExportData,
} from "../apps/web/src/modules/lastmile/exportDispatchWorkbooks";

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

/** 造一份跟后端 /loading-manifests 返回结构一致的数据（products 恒为空，跟真实一致） */
function buildData(dims: {
  lengthCm: number | string | null;
  widthCm: number | string | null;
  heightCm: number | string | null;
}): LastmileExportData {
  return {
    containerNo: "CN2026001",
    origin: "义乌",
    destination: "曼谷",
    carrierInfo: "",
    customers: [
      {
        clientId: "TESTCLIENT",
        clientName: "测试客户",
        contactName: "张三",
        contactPhone: "0800000000",
        address: "曼谷某路 1 号",
        shipments: [
          {
            lastmileOrderId: "lm_1",
            trackingNo: "SZ260801388",
            parentTrackingNo: "",
            itemName: "耳机",
            packageCount: 7,
            packageUnit: "箱",
            weightKg: 88,
            volumeM3: 1.928,
            ...dims,
            remark: "",
            status: "loaded",
            containerNos: ["CN2026001"],
            receiverName: "李四",
            receiverPhone: "0811111111",
            receiverAddress: "曼谷某路 2 号",
            // ⚠️ 后端就是恒定空数组，测试必须照着真实情况来，不能自己填一份产品行
            products: [],
          },
        ],
      },
    ],
  } as unknown as LastmileExportData;
}

console.log("整柜拆柜派送清单导出");

check("1) 单一尺寸：长宽高照常带出来（这条本来就是好的，防改坏）", () => {
  const [line] = expandTemplateLines(buildData({ lengthCm: 60, widthCm: 40, heightCm: 30 }));
  assert.ok(line, "没生成明细行");
  assert.equal(line.lengthCm, 60, "长不对");
  assert.equal(line.widthCm, 40, "宽不对");
  assert.equal(line.heightCm, 30, "高不对");
});

check("2) 多尺寸「60/50」：不许再变成空白", () => {
  // 三个方向都用互不相同的值，串了一眼就看得出来
  const [line] = expandTemplateLines(
    buildData({ lengthCm: "60/50", widthCm: "40/35", heightCm: "30/25" }),
  );
  assert.ok(line, "没生成明细行");
  assert.equal(line.lengthCm, "60/50", `长被丢掉了（拿到 ${JSON.stringify(line.lengthCm)}）`);
  assert.equal(line.widthCm, "40/35", `宽被丢掉了（拿到 ${JSON.stringify(line.widthCm)}）`);
  assert.equal(line.heightCm, "30/25", `高被丢掉了（拿到 ${JSON.stringify(line.heightCm)}）`);
});

check("3) 多尺寸时方数仍按后端给的实际装柜体积，不拿字符串去算", () => {
  // 「60/50」拿去做乘法会得到 NaN，印在客户签收单上就是一个假数
  const [line] = expandTemplateLines(
    buildData({ lengthCm: "60/50", widthCm: "40/35", heightCm: "30/25" }),
  );
  assert.equal(line.volumeM3, 1.928, `方数不对（拿到 ${line.volumeM3}）`);
  assert.ok(!Number.isNaN(Number(line.volumeM3)), "方数算成了 NaN");
  assert.equal(line.weightKg, 88, `重量不对（拿到 ${line.weightKg}）`);
});

check("4) 没填尺寸时仍然留空，不许印成 0", () => {
  const [line] = expandTemplateLines(buildData({ lengthCm: null, widthCm: null, heightCm: null }));
  assert.equal(line.lengthCm, null, "空尺寸被填成了别的值");
  assert.equal(line.widthCm, null, "空尺寸被填成了别的值");
  assert.equal(line.heightCm, null, "空尺寸被填成了别的值");
});

check("5) 空字符串按「没填」处理，不许写成一个空格子里的空串", () => {
  const [line] = expandTemplateLines(buildData({ lengthCm: "  ", widthCm: "", heightCm: null }));
  assert.equal(line.lengthCm, null, "只有空格的尺寸没当成没填");
  assert.equal(line.widthCm, null, "空串没当成没填");
});

if (failures.length > 0) {
  console.error(`\n${failures.length}/5 项不通过：${failures.join("；")}`);
  process.exit(1);
}
console.log("整柜拆柜派送清单导出：5 项全部通过");
