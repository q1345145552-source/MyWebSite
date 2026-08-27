/* ==========================================================================
   业务错误 —— 抛出来就会变成 400，不会变成 500（2026-08-27）
   --------------------------------------------------------------------------
   ⚠️ 为什么要有这个：

   「整柜已取消不许收钱」那几道闸门是抛异常实现的。第一版靠每个路由自己
   try/catch 转成 400 —— 结果四个管理员接口全忘了接，抛上去变成
   `500 / INTERNAL_ERROR`，员工看到「服务器繁忙」，完全不知道是柜被取消了
   （外部复审实测复现）。

   加四段 try/catch 治标不治本 —— 下次再加一道闸门，还是会有人忘。
   所以改成：**继承这个类的错误，最外层统一转成对应状态码**，忘不了。
   ========================================================================== */

import type { ErrorCode } from "./http-utils";

export class BusinessError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number = 400,
    public readonly code: ErrorCode = "BAD_REQUEST",
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** 最外层用它判断：是业务错误就按业务错误回，不要一律 500 */
export function isBusinessError(e: unknown): e is BusinessError {
  return e instanceof BusinessError;
}
