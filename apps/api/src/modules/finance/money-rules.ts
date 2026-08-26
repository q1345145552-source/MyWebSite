/* ==========================================================================
   集货收款口径 —— 唯一定义处（2026-08-27）
   --------------------------------------------------------------------------
   ⚠️ **财务管理页和柜子收款页必须用同一份规则，别再各写一遍。**

   第一版就是因为两个页面各判断各的，飘出 3 个 P1：
     ① 柜子收款把仓库版「等收货」算进了待收款（财务页没算）
     ② 柜子收款没排除已取消的柜（财务页排除了）
     ③ 财务页把普通版「已满待报价」算成了待收款（它其实还没报价）

   老板口径（2026-08-26/27）：钱只跟集货那两个功能有关，运单不计价。
   ========================================================================== */

/** 钱已经收到 —— 仓库版预报单到了这几个状态就说明客户付过了 */
const WHR_PAID = new Set(["paid", "loading", "shipped", "thailand_received"]);

/** 还没到该收钱的环节 —— 仓库版货都还没到仓，报的价只是预估 */
const WHR_NOT_YET = new Set(["pending"]);

/** 普通版：还没报价的阶段。「已满待报价」也算 —— 名字里就写着还没报价 */
const TASK_NOT_YET = new Set(["collecting", "full_confirmed"]);

/** 一律不算数的状态（黑名单，CLAUDE.md 第 13 条：别用白名单） */
export function isDead(status: string): boolean {
  return status === "cancelled";
}

export type Bucket = "received" | "receivable" | "notYet" | "dead";

/** 仓库版一张预报单归到哪一档 */
export function whrBucket(status: string): Bucket {
  if (isDead(status)) return "dead";
  if (WHR_PAID.has(status)) return "received";
  if (WHR_NOT_YET.has(status)) return "notYet";
  return "receivable";
}

/**
 * 普通版一个任务归到哪一档。
 * ⚠️ 普通版的付款状态单独存在 paymentStatus，不在 status 里。
 */
export function taskBucket(status: string, paymentStatus: string, hasFee: boolean): Bucket {
  if (isDead(status)) return "dead";
  if (paymentStatus === "paid") return "received";
  if (TASK_NOT_YET.has(status) || !hasFee) return "notYet";
  return "receivable";
}
