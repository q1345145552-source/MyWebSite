export interface StaffBatchProduct {
  itemName: string;
  packageCount: number;
  lengthCm?: number;
  widthCm?: number;
  heightCm?: number;
  productQuantity?: number;
  weightKg?: number;
  cargoType?: string;
  domesticTrackingNo?: string;
}

export interface StaffBatchOrder {
  clientId: string;
  trackingNo: string;
  warehouseId: string;
  itemName: string;
  packageCount: number;
  packageUnit: "bag" | "box";
  weightKg?: number;
  volumeM3?: number;
  arrivedAt: string;
  transportMode: "sea" | "land";
  domesticTrackingNo?: string;
  productQuantity?: number;
  products: StaffBatchProduct[];
  sourceRows: number[];
}

export interface StaffBatchIssue {
  rowNumber?: number;
  trackingNo?: string;
  clientId?: string;
  message: string;
}

export interface StaffBatchParseResult {
  sourceRowCount: number;
  orders: StaffBatchOrder[];
  issues: StaffBatchIssue[];
}

/** 批量创建的每条错误都同时标出运单号和客户唛头。 */
export function formatStaffBatchErrorLocation(
  rowLabel: string,
  trackingNo?: string,
  clientId?: string,
): string {
  return `${rowLabel}（运单号 ${trackingNo?.trim() || "—"}，唛头 ${clientId?.trim() || "—"}）`;
}

interface GroupDraft {
  trackingNo: string;
  clientId?: string;
  warehouseId?: string;
  arrivedAt?: string;
  transportMode?: "sea" | "land";
  packageUnit?: "bag" | "box";
  products: StaffBatchProduct[];
  sourceRows: number[];
  issues: StaffBatchIssue[];
}

const WAREHOUSE_NAME_MAP: Record<string, string> = {
  义乌仓: "wh_yiwu_01",
  广州仓: "wh_guangzhou_01",
  东莞仓: "wh_dongguan_01",
  深圳仓: "wh_shenzhen_01",
};

function findValue(row: Record<string, unknown>, keywords: string[]): unknown {
  const key = Object.keys(row).find((candidate) => keywords.some((keyword) => candidate.includes(keyword)));
  return key ? row[key] : undefined;
}

function textValue(row: Record<string, unknown>, keywords: string[]): string {
  return String(findValue(row, keywords) ?? "").trim();
}

function numericValue(row: Record<string, unknown>, keywords: string[]): { value?: number; invalid: boolean } {
  const raw = findValue(row, keywords);
  if (raw === undefined || raw === null || String(raw).trim() === "") return { invalid: false };
  if (typeof raw === "number") return Number.isFinite(raw) ? { value: raw, invalid: false } : { invalid: true };
  const cleaned = String(raw).replace(/[^0-9.\-]/g, "");
  if (!cleaned) return { invalid: true };
  const value = Number(cleaned);
  return Number.isFinite(value) ? { value, invalid: false } : { invalid: true };
}

function normalizeDate(raw: string): string {
  if (!raw) return "";
  if (/^\d{5}$/.test(raw)) {
    const date = new Date((Number(raw) - 25569) * 86_400_000);
    return Number.isNaN(date.getTime()) ? raw : date.toISOString().slice(0, 10);
  }
  return raw;
}

function normalizeTransport(raw: string): "sea" | "land" | undefined {
  const value = raw.toLowerCase();
  if (value.includes("海运") || value === "sea") return "sea";
  if (value.includes("陆运") || value === "land") return "land";
  return undefined;
}

function normalizePackageUnit(raw: string): "bag" | "box" | undefined {
  const value = raw.toLowerCase();
  if (value.includes("袋") || value === "bag") return "bag";
  if (value.includes("箱") || value === "box") return "box";
  return undefined;
}

function setSharedField<K extends "clientId" | "warehouseId" | "arrivedAt" | "transportMode" | "packageUnit">(
  draft: GroupDraft,
  key: K,
  rawValue: GroupDraft[K] | undefined,
  label: string,
  rowNumber: number,
): void {
  if (rawValue === undefined || rawValue === "") return;
  const existing = draft[key];
  if (existing !== undefined && existing !== rawValue) {
    draft.issues.push({ rowNumber, trackingNo: draft.trackingNo, message: `同一运单的${label}不一致` });
    return;
  }
  (draft[key] as GroupDraft[K]) = rawValue;
}

function positiveNumber(
  draft: GroupDraft,
  rowNumber: number,
  label: string,
  parsed: { value?: number; invalid: boolean },
  options: { required?: boolean; integer?: boolean } = {},
): number | undefined {
  if (parsed.invalid || (parsed.value !== undefined && parsed.value <= 0) || (options.integer && parsed.value !== undefined && !Number.isInteger(parsed.value))) {
    draft.issues.push({ rowNumber, trackingNo: draft.trackingNo, message: `${label}必须是${options.integer ? "正整数" : "正数"}` });
    return undefined;
  }
  if (options.required && parsed.value === undefined) {
    draft.issues.push({ rowNumber, trackingNo: draft.trackingNo, message: `${label}为必填` });
  }
  return parsed.value;
}

/**
 * Excel 一行代表一种产品规格；同一运单号的多行会合并成一张订单。
 * 连续明细行可省略运单号及公共字段，解析时继承上一行所属运单的数据。
 */
export function parseStaffBatchRows(rows: Record<string, unknown>[]): StaffBatchParseResult {
  const groups = new Map<string, GroupDraft>();
  const looseIssues: StaffBatchIssue[] = [];
  let previousTrackingNo = "";

  rows.forEach((row, index) => {
    const rowNumber = index + 2;
    const rawClientId = textValue(row, ["唛头"]);
    const explicitTrackingNo = textValue(row, ["运单号"]);
    const trackingNo = explicitTrackingNo || previousTrackingNo;
    if (explicitTrackingNo) previousTrackingNo = explicitTrackingNo;
    if (!trackingNo) {
      looseIssues.push({
        rowNumber,
        clientId: rawClientId || undefined,
        message: "运单号为必填；后续明细行可留空并继承上一行",
      });
      return;
    }

    const draft = groups.get(trackingNo) ?? {
      trackingNo,
      products: [],
      sourceRows: [],
      issues: [],
    };
    groups.set(trackingNo, draft);
    draft.sourceRows.push(rowNumber);

    const rawWarehouse = textValue(row, ["仓库"]);
    const rawArrivedAt = textValue(row, ["到仓日期"]);
    const rawTransport = textValue(row, ["运输方式"]);
    const rawPackageUnit = textValue(row, ["包装类型"]);

    setSharedField(draft, "clientId", rawClientId || undefined, "唛头", rowNumber);
    setSharedField(draft, "warehouseId", rawWarehouse ? (WAREHOUSE_NAME_MAP[rawWarehouse] || rawWarehouse) : undefined, "仓库", rowNumber);
    setSharedField(draft, "arrivedAt", rawArrivedAt ? normalizeDate(rawArrivedAt) : undefined, "到仓日期", rowNumber);
    if (rawTransport) {
      const transportMode = normalizeTransport(rawTransport);
      if (transportMode) setSharedField(draft, "transportMode", transportMode, "运输方式", rowNumber);
      else draft.issues.push({ rowNumber, trackingNo, message: "运输方式必须是海运或陆运" });
    }
    if (rawPackageUnit) {
      const packageUnit = normalizePackageUnit(rawPackageUnit);
      if (packageUnit) setSharedField(draft, "packageUnit", packageUnit, "包装类型", rowNumber);
      else draft.issues.push({ rowNumber, trackingNo, message: "包装类型必须是箱或袋" });
    } else if (!draft.packageUnit) {
      // 模板约定空值默认“箱”；第一条明细一旦采用默认值，后续显式填“袋”应当报冲突，
      // 不能把前面已经按箱填写的行静默改成袋。
      draft.packageUnit = "box";
    }

    const itemName = textValue(row, ["品名"]);
    if (!itemName) draft.issues.push({ rowNumber, trackingNo, message: "品名为必填" });
    const packageCount = positiveNumber(draft, rowNumber, "箱数", numericValue(row, ["箱数"]), { required: true, integer: true });
    const lengthCm = positiveNumber(draft, rowNumber, "长cm", numericValue(row, ["长cm", "长"]));
    const widthCm = positiveNumber(draft, rowNumber, "宽cm", numericValue(row, ["宽cm", "宽"]));
    const heightCm = positiveNumber(draft, rowNumber, "高cm", numericValue(row, ["高cm", "高"]));
    const weightKg = positiveNumber(draft, rowNumber, "单箱重量kg", numericValue(row, ["单箱重量"]));
    /**
     * ⚠️ 两个表头都要认。
     * 模板原来这一列叫「产品数量」，跟旁边的「**单箱**重量kg」口径不一致，
     * 员工很容易当成「这一行一共几个」来填 —— 而代码要的是「每箱几个」。
     * 2026-08-28 把模板表头改成「每箱几个」，
     * 但**老模板下载过、正在用的文件还认「产品数量」**，两个都得收。
     */
    /**
     * ⚠️ 两个表头要**分两次查**，不能写成 `["单箱数量","产品数量"]` 一次查。
     * findValue 是「按列顺序找第一个包含任一关键词的列」——
     * 表里同时存在旧列「产品数量」和新列「每箱几个」时，
     * 取哪一列**取决于列的先后顺序**。2026-08-28 复核实测：同一份数据
     * 因为列序不同能算出 10 或 200，**有报大风险**。
     * 现在固定「新列优先，没有新列才回落到旧列」，跟列顺序无关。
     *
     * ⚠️⚠️ 新表头**绝对不能**叫「单箱数量」：那四个字里含有「箱数」，
     * 而表头是包含匹配，`numericValue(row, ["箱数"])` 会把这一列认成**箱数**列。
     * 实测：5 箱、每箱 7 个，箱数被读成 7，总数算出 49 而不是 35。
     * 所以定成「每箱几个」—— 跟现有任何一个表头都不含相同子串。
     */
    const perBoxRaw = numericValue(row, ["每箱几个"]);
    const legacyRaw = numericValue(row, ["产品数量"]);
    const quantityRaw = perBoxRaw.value !== undefined || perBoxRaw.invalid ? perBoxRaw : legacyRaw;
    const productQuantity = positiveNumber(draft, rowNumber, "每箱几个", quantityRaw, { integer: true });
    const dimensionCount = [lengthCm, widthCm, heightCm].filter((value) => value !== undefined).length;
    if (dimensionCount > 0 && dimensionCount < 3) {
      draft.issues.push({ rowNumber, trackingNo, message: "长、宽、高需要同时填写" });
    }

    if (itemName && packageCount !== undefined) {
      draft.products.push({
        itemName,
        packageCount,
        lengthCm,
        widthCm,
        heightCm,
        productQuantity,
        weightKg,
        cargoType: "normal",
        domesticTrackingNo: textValue(row, ["国内单号"]) || undefined,
      });
    }
  });

  const orders: StaffBatchOrder[] = [];
  const issues: StaffBatchIssue[] = [...looseIssues];
  for (const draft of groups.values()) {
    if (!draft.clientId) draft.issues.push({ trackingNo: draft.trackingNo, message: "唛头为必填" });
    if (!draft.warehouseId) draft.issues.push({ trackingNo: draft.trackingNo, message: "仓库为必填" });
    if (!draft.arrivedAt) draft.issues.push({ trackingNo: draft.trackingNo, message: "到仓日期为必填" });
    if (!draft.transportMode) draft.issues.push({ trackingNo: draft.trackingNo, message: "运输方式为必填" });
    if (draft.products.length === 0) draft.issues.push({ trackingNo: draft.trackingNo, message: "至少需要一条有效产品明细" });

    const weights = draft.products.map((product) => product.weightKg);
    const dimensions = draft.products.map((product) => product.lengthCm !== undefined && product.widthCm !== undefined && product.heightCm !== undefined);
    if (weights.some((weight) => weight !== undefined) && weights.some((weight) => weight === undefined)) {
      draft.issues.push({ trackingNo: draft.trackingNo, message: "同一运单的产品单箱重量需要全部填写或全部留空" });
    }
    if (dimensions.some(Boolean) && dimensions.some((complete) => !complete)) {
      draft.issues.push({ trackingNo: draft.trackingNo, message: "同一运单的产品尺寸需要全部填写或全部留空" });
    }
    /**
     * ⚠️ 「要么全填、要么全空」——跟上面单箱重量、尺寸同一个规矩（2026-08-28 补）。
     * 原来只要有**一行**填了数量，其余空行就按 0 静默计入，总数偏小而且没人知道。
     * 数字算错比导入失败严重得多，宁可拦住让他补齐。
     */
    const quantities = draft.products.map((product) => product.productQuantity);
    if (quantities.some((q) => q !== undefined) && quantities.some((q) => q === undefined)) {
      draft.issues.push({
        trackingNo: draft.trackingNo,
        message: "同一运单的每箱几个需要全部填写或全部留空",
      });
    }
    if (draft.issues.length > 0) {
      issues.push(...draft.issues.map((issue) => ({
        ...issue,
        trackingNo: issue.trackingNo ?? draft.trackingNo,
        clientId: issue.clientId ?? draft.clientId,
      })));
      continue;
    }

    const packageCount = draft.products.reduce((sum, product) => sum + product.packageCount, 0);
    const weightKg = weights.every((weight) => weight !== undefined)
      ? draft.products.reduce((sum, product) => sum + (product.weightKg ?? 0) * product.packageCount, 0)
      : undefined;
    const volumeM3 = dimensions.every(Boolean)
      ? draft.products.reduce((sum, product) => sum + ((product.lengthCm ?? 0) * (product.widthCm ?? 0) * (product.heightCm ?? 0) * product.packageCount) / 1_000_000, 0)
      : undefined;
    /**
     * ⚠️ 产品数量必须**乘箱数**：这一列填的是「单箱几个」，不是这一行的总数。
     *
     * 2026-08-28 老板在真页面上实测：三行明细各填 2/3/4 箱、每箱 2/3/4 个，
     * 正确总数是 2×2 + 3×3 + 4×4 = 29，系统报的是 9（= 2+3+4）。
     * 口径见 apps/api/src/modules/orders/routes.ts:833 的注释：
     * 同一个字段名在产品行上是「单箱数量」、在订单上才是「总数」。
     * 上面重量和体积两行都乘了 packageCount，唯独这一行漏了。
     *
     * ⚠️ 那条注释里还写着「批量导入那条路不受影响，解析器本来就会把合计算好」——
     * **那句话是错的**，就是这里没算对。注释已一并更正。
     */
    const hasProductQuantity = draft.products.some((product) => product.productQuantity !== undefined);
    const productQuantity = hasProductQuantity
      ? draft.products.reduce(
          (sum, product) => sum + (product.productQuantity ?? 0) * product.packageCount,
          0,
        )
      : undefined;
    const itemNames = Array.from(new Set(draft.products.map((product) => product.itemName)));
    const domesticTrackingNos = Array.from(new Set(draft.products.map((product) => product.domesticTrackingNo).filter((value): value is string => Boolean(value))));

    orders.push({
      clientId: draft.clientId!,
      trackingNo: draft.trackingNo,
      warehouseId: draft.warehouseId!,
      itemName: itemNames.join(" / "),
      packageCount,
      packageUnit: draft.packageUnit ?? "box",
      weightKg,
      volumeM3,
      arrivedAt: draft.arrivedAt!,
      transportMode: draft.transportMode!,
      domesticTrackingNo: domesticTrackingNos.length > 0 ? domesticTrackingNos.join(" / ") : undefined,
      productQuantity,
      products: draft.products,
      sourceRows: draft.sourceRows,
    });
  }

  return { sourceRowCount: rows.length, orders, issues };
}
