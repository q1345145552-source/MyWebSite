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
import fs from "node:fs";
import path from "node:path";
// ⚠️ jszip 只装在 apps/web 下（前端依赖），根目录没有 —— 必须走相对路径引，
// 否则脚本从仓库根目录跑起来会 MODULE_NOT_FOUND。
import JSZip from "../apps/web/node_modules/jszip";
import {
  buildLastmileTemplateWorkbook,
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
    // ⚠️ scope 必须是 "container"：buildLastmileTemplateWorkbook 靠它决定走整柜模板
    // 还是客户签收模板，不设的话会去客户模板那条路，报「缺少中文或泰文工作表」
    scope: "container",
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

/** 异步版的 check：真模板那几项要解压 zip */
async function checkAsync(name: string, body: () => Promise<void>): Promise<void> {
  try {
    await body();
    console.log(`  ✅ ${name}`);
  } catch (error) {
    failures.push(name);
    const message = error instanceof Error ? error.message : String(error);
    console.log(`  ❌ ${name}\n     ${message.split("\n").join("\n     ")}`);
  }
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


// ══════════════════════════════════════════════════════════════════════
// 下面这几项走**完整链路**：真模板 xlsx → buildLastmileTemplateWorkbook → 解压读 XML。
//
// ⚠️ 上一版是自己造一张最小工作表 XML 喂给内部函数。复核实测证明那样**太干净**：
// 把「写值时保留样式属性」删掉，9 项照样全绿 —— 因为我造的格子本来就没样式。
// 而且那样测不到模板自带的东西（比如 G35/H35/I35 那三个 SUM），
// 正是那三个 SUM 让导出文件里印出了三个 0。
// 现在直接用 apps/web/public/templates 里的真文件，不再为测试导出内部类。
// ══════════════════════════════════════════════════════════════════════

const TEMPLATE = path.join(
  __dirname,
  "..",
  "apps",
  "web",
  "public",
  "templates",
  "lastmile",
  "internal-dispatch-template.xlsx",
);

async function renderRealWorkbook(dims: {
  lengthCm: number | string | null;
  widthCm: number | string | null;
  heightCm: number | string | null;
}): Promise<{ sheet: string; shared: string }> {
  const bytes = await buildLastmileTemplateWorkbook(buildData(dims), fs.readFileSync(TEMPLATE));
  const zip = await JSZip.loadAsync(bytes);
  const sheetName = Object.keys(zip.files).find((n) => /^xl\/worksheets\/sheet1\.xml$/.test(n));
  assert.ok(sheetName, `解压后找不到工作表：${Object.keys(zip.files).join(", ")}`);
  const sheet = await zip.file(sheetName)!.async("string");
  const sharedFile = zip.file("xl/sharedStrings.xml");
  const shared = sharedFile ? await sharedFile.async("string") : "";
  return { sheet, shared };
}

/** 把某个格子的 XML 抠出来（非贪婪，否则会一口气吃到下一个 </c>） */
function cellXml(xml: string, ref: string): string {
  const m = xml.match(new RegExp(`<c\\b[^>]*?\\br="${ref}"[^>]*?(?:/>|>[\\s\\S]*?</c>)`));
  assert.ok(m, `找不到单元格 ${ref}`);
  return m[0];
}

/** 按共享字符串下标把文字捞出来，确认客户在 Excel 里看到的就是这个 */
function sharedText(shared: string, index: number): string {
  const items = [...shared.matchAll(/<si>\s*<t[^>]*>([\s\S]*?)<\/t>\s*<\/si>/g)].map((m) => m[1]);
  return items[index] ?? "";
}

async function main(): Promise<void> {
  await checkAsync("6) 真模板：单一尺寸写成**数字格**，值就是那个数", async () => {
    const { sheet } = await renderRealWorkbook({ lengthCm: 60, widthCm: 40, heightCm: 30 });
    for (const [ref, val] of [["G10", "60"], ["H10", "40"], ["I10", "30"]] as Array<[string, string]>) {
      const cell = cellXml(sheet, ref);
      assert.ok(!/t="s"/.test(cell), `${ref} 被写成了文本格：${cell}`);
      assert.ok(cell.includes(`<v>${val}</v>`), `${ref} 的值不对：${cell}`);
    }
  });

  await checkAsync("7) 真模板：多尺寸写成**文本格**，Excel 里真能读出「60/50」", async () => {
    const { sheet, shared } = await renderRealWorkbook({
      lengthCm: "60/50",
      widthCm: "40/35",
      heightCm: "30/25",
    });
    for (const [ref, text] of [["G10", "60/50"], ["H10", "40/35"], ["I10", "30/25"]] as Array<[string, string]>) {
      const cell = cellXml(sheet, ref);
      assert.ok(/t="s"/.test(cell), `${ref} 不是文本格，字符串塞进数字格会被写成 0：${cell}`);
      const idx = cell.match(/<v>(\d+)<\/v>/)?.[1];
      assert.ok(idx !== undefined, `${ref} 没有共享字符串下标：${cell}`);
      assert.equal(sharedText(shared, Number(idx)), text, `${ref} 在 Excel 里显示的不是「${text}」`);
    }
  });

  await checkAsync("8) 真模板：写值时**保留原有样式**（上一版的假绿就出在这）", async () => {
    // 复核变异：把写值时的样式属性删掉，旧测试照样全绿 —— 因为自造的 fixture 本来就没样式。
    // 真模板的格子是带 s="..." 的，这一项能抓住。
    const { sheet } = await renderRealWorkbook({ lengthCm: 60, widthCm: 40, heightCm: 30 });
    const styled = ["G10", "H10", "I10", "B10", "D10"].filter((ref) => /\bs="\d+"/.test(cellXml(sheet, ref)));
    assert.ok(
      styled.length > 0,
      "写完值之后一个带样式的格子都没有了 —— 样式属性被写值那一步吃掉了，导出文件会掉格式",
    );
  });

  await checkAsync("9) 真模板：长宽高那三个合计格必须被清掉，不能留 SUM", async () => {
    /**
     * 模板自带 G35=SUM(G10:G34) / H35 / I35。多尺寸时长宽高是文本，
     * SUM 对文本求和就是 0 —— 客户签收单上印出三个 0，是实打实的错数。
     * 而且就算全是数字，把各行的长加起来（60+50=110cm）也是个没意义的数。
     */
    const { sheet } = await renderRealWorkbook({ lengthCm: "60/50", widthCm: "40/35", heightCm: "30/25" });
    for (const ref of ["G35", "H35", "I35"]) {
      const cell = cellXml(sheet, ref);
      assert.ok(!/<f>/.test(cell), `${ref} 还留着合计公式：${cell}`);
      assert.ok(!/<v>/.test(cell), `${ref} 还留着一个值：${cell}`);
    }
    // 件数/方数/重量的合计**必须还在**，别把该有的也清了
    assert.ok(cellXml(sheet, "E35").includes("SUM(E10:E34)"), "方数合计公式丢了");
    assert.ok(cellXml(sheet, "F35").includes("SUM(F10:F34)"), "重量合计公式丢了");
    assert.ok(cellXml(sheet, "E35").includes("<v>1.928</v>"), "方数合计被尺寸重算改掉了");
  });
}

main()
  .then(() => {
    if (failures.length > 0) {
      console.error(`\n${failures.length}/9 项不通过：${failures.join("；")}`);
      process.exit(1);
    }
    console.log("整柜拆柜派送清单导出：9 项全部通过");
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
