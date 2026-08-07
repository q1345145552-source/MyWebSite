/* ==========================================================================
   集货余额（2026-08-07）
   ------------------------------------------------------------------------
   「余额」现在**只服务两个集货板块**：仓库版集货拼柜、普通版集货拼柜。
   普通运单不再能用余额付款。只有人民币，泰铢已废弃。

   规矩：
     1. 扣款、退款、充值到账，都必须走这里的函数，别在业务代码里直接
        改 client_wallet_accounts —— 否则流水会漏记，客户对不上账。
     2. 三个函数都要求传入事务 tx：扣钱和改单据状态必须在同一个事务里，
        不然会出现「钱扣了单子没付上」或者反过来。
     3. 余额不足直接抛错，由调用方 catch 后转成 400 提示。
   ========================================================================== */

/** 集货余额只有人民币 */
export const CONSOLIDATION_CURRENCY = "CNY";

/** 余额不足时抛这个，调用方据此返回 400 而不是 500 */
export class InsufficientBalanceError extends Error {
  constructor(
    public readonly need: number,
    public readonly have: number,
  ) {
    super(`余额不足：本次需要 ¥${need.toFixed(2)}，当前集货余额 ¥${have.toFixed(2)}，还差 ¥${(need - have).toFixed(2)}`);
    this.name = "InsufficientBalanceError";
  }
}

type Tx = {
  clientWalletAccount: {
    findUnique: (args: any) => Promise<any>;
    upsert: (args: any) => Promise<any>;
    update: (args: any) => Promise<any>;
  };
  consolidationBalanceLedger: { create: (args: any) => Promise<any> };
};

/** 读当前集货余额（元）。没有账户当 0 处理。 */
export async function readBalance(tx: Tx, clientId: string): Promise<number> {
  const acc = await tx.clientWalletAccount.findUnique({
    where: { clientId_currency: { clientId, currency: CONSOLIDATION_CURRENCY } },
    select: { balance: true },
  });
  return Number(acc?.balance ?? 0);
}

interface MoveArgs {
  companyId: string;
  clientId: string;
  /** 正数，单位元 */
  amount: number;
  /** whr=仓库版预报单 | normal=普通版任务 | recharge=充值单 */
  refType: string;
  refId: string;
  /** 给客户看的单号 */
  refNo?: string | null;
  remark?: string | null;
  operatorId?: string | null;
  operatorName?: string | null;
}

/**
 * 集货付款扣钱。余额不够抛 InsufficientBalanceError，一分钱都不扣。
 * @returns 扣完之后的余额
 */
export async function chargeForConsolidation(tx: Tx, args: MoveArgs): Promise<number> {
  const amount = round2(args.amount);
  if (!(amount > 0)) throw new Error("扣款金额必须大于 0");

  const have = await readBalance(tx, args.clientId);
  if (have < amount) throw new InsufficientBalanceError(amount, have);

  const after = round2(have - amount);
  await tx.clientWalletAccount.update({
    where: { clientId_currency: { clientId: args.clientId, currency: CONSOLIDATION_CURRENCY } },
    data: { balance: after },
  });
  await writeLedger(tx, args, "pay", -amount, after);
  return after;
}

/**
 * 管理员撤销付款，把钱退回集货余额。
 * @returns 退完之后的余额
 */
export async function refundToConsolidation(tx: Tx, args: MoveArgs): Promise<number> {
  const amount = round2(args.amount);
  if (!(amount > 0)) throw new Error("退款金额必须大于 0");

  const have = await readBalance(tx, args.clientId);
  const after = round2(have + amount);
  await tx.clientWalletAccount.upsert({
    where: { clientId_currency: { clientId: args.clientId, currency: CONSOLIDATION_CURRENCY } },
    create: {
      clientId: args.clientId,
      companyId: args.companyId,
      currency: CONSOLIDATION_CURRENCY,
      balance: after,
    },
    update: { balance: after },
  });
  await writeLedger(tx, args, "refund", amount, after);
  return after;
}

/**
 * 充值审核通过、钱到账时记一笔流水。
 * 加钱本身由充值审核那边的 upsert 做，这里只负责把流水补上并回填余额。
 */
export async function recordRechargeCredit(tx: Tx, args: MoveArgs): Promise<number> {
  const amount = round2(args.amount);
  const after = await readBalance(tx, args.clientId);
  await writeLedger(tx, args, "recharge", amount, after);
  return after;
}

async function writeLedger(
  tx: Tx,
  args: MoveArgs,
  type: "pay" | "refund" | "recharge",
  signedAmount: number,
  balanceAfter: number,
): Promise<void> {
  await tx.consolidationBalanceLedger.create({
    data: {
      companyId: args.companyId,
      clientId: args.clientId,
      type,
      amount: signedAmount,
      balanceAfter,
      refType: args.refType,
      refId: args.refId,
      refNo: args.refNo ?? null,
      remark: args.remark ?? null,
      operatorId: args.operatorId ?? null,
      operatorName: args.operatorName ?? null,
    },
  });
}

/** 钱一律留两位小数，避免浮点误差一分一分地积累 */
function round2(n: number): number {
  return Math.round(Number(n) * 100) / 100;
}
