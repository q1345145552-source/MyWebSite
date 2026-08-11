/**
 * 对外（客户 / 免登录）下发数据前的脱敏。**唯一定义处。**
 *
 * 用户红线：**客户不能看到柜号。**
 *
 * 柜号会从三条缝里漏出去，堵一条不够：
 *   ① 字段：shipments.batchNo、containers[].containerNo —— 直接就是柜号
 *   ② 正文：装柜时写的轨迹备注是「装入柜子 SELU4640250（分装 30件）」，柜号藏在句子里
 *   ③ 免登录查轨迹：连账号都不用，只要运单号 + 手机后 4 位
 *
 * ⚠️ 2026-08-11 审出来的：①③ 两条一直没堵 ——
 *    /client/shipments/search 照发 batchNo（19 张运单 / 8 个客户），
 *    /public/track 照发 batchNo 且备注原样下发（136 张运单 / 21 个客户）。
 *    「前端不显示」不算堵住 —— 数据到了浏览器就是泄漏，开发者工具一开就能看到。
 *    **对外接口一律不下发，而不是让前端别显示。**
 */

/**
 * 把轨迹备注里的柜号抹掉，只留「已装柜」和后面的分装件数。
 *
 * 柜号后面可能紧跟「（分装 N件）」，中间没有空格，
 * 所以匹配到括号就停，别把后半句一起吃掉。
 *
 * @param remark 原始备注
 * @param hide   true=对外（客户/免登录），要抹；false=内部（员工/管理员），原样返回
 */
export function sanitizeRemarkForClient(remark: string, hide: boolean): string {
  return hide ? remark.replace(/装入柜子\s*[^\s（(]+/g, "已装柜") : remark;
}
