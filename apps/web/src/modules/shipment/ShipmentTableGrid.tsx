/* ==========================================================================
   运单列表的表格排版（员工端 / 管理员端 / 客户端共用）
   ------------------------------------------------------------------------
   问题：品名、箱数、长宽高这些列都是「一个产品一行」，生产库里最多的一张运单
   有 43 个产品，整行会被撑成 43 行高；各列行高又不完全一样，越往下越错位。

   做法：
     1. 跟着产品走的那几列合并成一个跨列格子，里面放一张固定列宽的小表，
        整块一起滚 —— 分开写就会各滚各的，滚两下就对不上了；
     2. 这一块固定高度（DETAIL_VISIBLE_ROWS 行），所有运单行高度一致；
     3. 外层表格用 table-layout: fixed + colgroup，外层列宽和小表列宽用同一组
        数字，两边永远对齐；
     4. 留一列不写宽度当「弹性列」，屏幕比表格宽时多出来的空间全给它，
        其余列宽度就永远是写死的那几个数，小表才对得死。

   ⚠️ 三端都从这里取样式。要改排版就改这个文件，别在各自页面里另写一套。
   ========================================================================== */

import type { OrderProductItem } from "../../services/business-api";

/** 小表每行的高度；和可见行数一起决定每张运单占多高 */
export const DETAIL_ROW_HEIGHT = 24;
/** 不点开时露几行产品 */
export const DETAIL_VISIBLE_ROWS = 3;

const GRID_LINE = "1px solid #e2e8f0";

/** 表头格子：四边都有框线 */
export const gridThStyle = {
  padding: "10px 8px",
  whiteSpace: "nowrap",
  border: GRID_LINE,
  overflow: "hidden",
  textOverflow: "ellipsis",
} as const;

/** 数据格子：一单只有一个值的列，上下居中 */
export const gridTdStyle = {
  padding: "8px 6px",
  whiteSpace: "nowrap",
  border: GRID_LINE,
  verticalAlign: "middle",
  overflow: "hidden",
  textOverflow: "ellipsis",
} as const;

/** 小表的格子：每行高度写死，各列才对得齐；超长用省略号，鼠标停上去看全 */
const detailCellStyle = {
  padding: "2px 6px",
  height: DETAIL_ROW_HEIGHT,
  boxSizing: "border-box",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  borderRight: GRID_LINE,
  borderBottom: "1px solid #f1f5f9",
  color: "#000000",
} as const;

const detailLastCellStyle = { ...detailCellStyle, borderRight: "none" } as const;

/**
 * 表格的列宽定义。
 * @param widths 每一列的宽度，个数必须等于表头 th 的个数
 * @param flexIndex 哪一列当弹性列（不写宽度，吃掉多余空间）
 */
export function GridColgroup({ widths, flexIndex }: { widths: readonly number[]; flexIndex: number }) {
  return (
    <colgroup>
      {widths.map((w, i) => (
        <col key={i} style={i === flexIndex ? undefined : { width: w }} />
      ))}
    </colgroup>
  );
}

/**
 * 跟着产品走的那几列：合并成一个格子，固定高度，整块一起滚。
 * @param widths 这几列的宽度，必须和外层 colgroup 里对应位置的数字完全一致
 * @param rows 每个产品一行，一行里每一列一个字符串
 */
export function ProductDetailCell({ widths, rows }: { widths: readonly number[]; rows: readonly string[][] }) {
  // 宽度写死成各列之和，不用 100%：Windows 的滚动条占宽度，
  // 用 100% 会被滚动条挤窄，列就和表头对不上了
  const totalWidth = widths.reduce((a, b) => a + b, 0);
  return (
    <td colSpan={widths.length} style={{ padding: 0, border: GRID_LINE, verticalAlign: "top" }}>
      <div style={{ height: DETAIL_ROW_HEIGHT * DETAIL_VISIBLE_ROWS, overflowY: "auto", overflowX: "hidden" }}>
        <table style={{ width: totalWidth, borderCollapse: "collapse", tableLayout: "fixed", fontSize: 13 }}>
          <colgroup>
            {widths.map((w, i) => <col key={i} style={{ width: w }} />)}
          </colgroup>
          <tbody>
            {rows.map((cells, i) => (
              <tr key={i}>
                {cells.map((v, j) => (
                  <td key={j} title={v} style={j === cells.length - 1 ? detailLastCellStyle : detailCellStyle}>
                    {v}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </td>
  );
}

/** 货型的中文名，三端口径一致 */
export function cargoTypeLabelOf(value?: string | null) {
  const v = (value ?? "normal").toLowerCase();
  return v === "inspection" ? "商检" : v === "sensitive" ? "敏感" : "普货";
}

/* -------------------------------------------------------------------------
   员工端和管理员端的明细列完全一样：品名 / 箱数 / 单箱数量 / 长宽高 / 国内单号 / 货型
   ------------------------------------------------------------------------- */

export const PRODUCT_DETAIL_COL_WIDTHS = [180, 70, 90, 150, 150, 70] as const;
export const PRODUCT_DETAIL_HEADS = ["品名", "箱数", "单箱数量", "长宽高(cm)", "国内单号", "货型"] as const;

type ProductCarrier = {
  products?: OrderProductItem[];
  itemName?: string | null;
  domesticTrackingNo?: string | null;
  cargoType?: string | null;
};

/** 摊成小表的行；没有产品行的老运单退回用运单自己的字段，显示口径和改版前一致 */
export function buildProductDetailRows(item: ProductCarrier): string[][] {
  const products = item.products ?? [];
  if (products.length > 0) {
    return products.map((p) => [
      p.itemName ?? "—",
      p.packageCount != null ? `${p.packageCount}箱` : "—",
      p.productQuantity ? `${p.productQuantity}个/箱` : "—",
      p.lengthCm ? `${p.lengthCm}×${p.widthCm}×${p.heightCm}cm` : "—",
      p.domesticTrackingNo || "货拉拉",
      cargoTypeLabelOf(p.cargoType),
    ]);
  }
  return [[
    item.itemName ?? "—",
    "—",
    "—",
    "—",
    item.domesticTrackingNo || "—",
    cargoTypeLabelOf(item.cargoType),
  ]];
}
