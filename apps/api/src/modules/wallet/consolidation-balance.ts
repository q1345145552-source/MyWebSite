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
  /** 加行锁用。调用方传进来的都是真事务，这个方法一定有 */
  $queryRaw: (strings: TemplateStringsArray, ...values: any[]) => Promise<any>;
  clientWalletAccount: {
    findUnique: (args: any) => Promise<any>;
    upsert: (args: any) => Promise<any>;
    update: (args: any) => Promise<any>;
  };
  consolidationBalanceLedger: { create: (args: any) => Promise<any> };
};

/** 单据已经被别的请求付掉了 / 状态变了，调用方据此返回 400 */
export class PaymentConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentConflictError";
  }
}

/**
 * 锁住这个客户的钱包行（2026-08-25 新增）。**改余额之前必须先调这个。**
 *
 * ## 不锁会少扣钱
 *
 * 原来三个函数都是「先读余额、算一个新数、再把这个数写回去」。
 * 两笔付款同时进来就会互相覆盖：
 * ```
 *   请求A 读到 12000 → 算出 11000
 *   请求B 读到 12000 → 算出 11000   （A 还没提交，B 读到的还是旧值）
 *   两个都写 11000，流水各记一笔 -1000
 *   结果：账上只少了 1000，流水显示少了 2000 —— 公司白亏 1000
 * ```
 * 生产已有 ¥12,450 真实余额、¥27,700 已付款业务，触发条件是真实存在的。
 *
 * 加了 FOR UPDATE 之后，B 会卡在这一行等 A 提交完，然后读到 11000，算出 10000。
 *
 * ⚠️ 账户行还不存在时（客户从没有过余额），这里锁不到任何东西 ——
 *    扣款那条路不受影响（读出来是 0，直接报余额不足）；
 *    退款/充值那条路走 upsert 新建，极端情况下两个并发新建会撞唯一约束报错，
 *    **报错总比静默算错强**，而且要同时满足「客户零余额 + 两笔退款同秒发生」，实际碰不到。
 */
async function lockAccount(tx: Tx, clientId: string): Promise<void> {
  // ⚠️ 列名是 "clientId" 不是 client_id ——
  // 这张表的 clientId 字段在 schema.prisma 里**没写 @map**，所以数据库里就是驼峰的，
  // 而同一张表的 company_id / updated_at 又是下划线的。手写 SQL 前必须逐列确认，
  // 大小写混合的列名在 PostgreSQL 里还必须加双引号，否则会被当成全小写。
  // （2026-08-25 第一版就是写成 client_id，测试库一跑直接报 column does not exist。）
  await tx.$queryRaw`
    SELECT "clientId" FROM client_wallet_accounts
    WHERE "clientId" = ${clientId} AND currency = ${CONSOLIDATION_CURRENCY}
    FOR UPDATE
  `;
}

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

  await lockAccount(tx, args.clientId);
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

  await lockAccount(tx, args.clientId);
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
  // 充值的加钱动作在审核那边做，这里只补流水；但 balanceAfter 要读准，
  // 所以同样先锁 —— 不锁的话并发时这个数会记成别人扣款前的旧值。
  await lockAccount(tx, args.clientId);
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

/* --------------------------------------------------------------------------
   删除单据时的退款（2026-08-08）
   ------------------------------------------------------------------------
   背景：管理员端新加的「删除集货任务 / 删除集货计划」是级联删除，
   单子删掉之后，客户已经付的钱本来会一直挂在他账上不见 —— 实测确认过：
   付了 8.5 元，强删之后余额没变，单子却没了，客户来问都查不到。

   这里的两个函数就是补这个洞：删之前先算出「这张单实际净扣了多少」，
   照「撤销付款」那条路原样退回客户的集货余额，并记一笔流水说明是删除退款。

   净额算法跟「撤销付款」保持一致：把这张单的 pay(负数) 和 refund(正数)
   加起来再取反 —— 已经退过的不会重复退。
   -------------------------------------------------------------------------- */

/** 某个客户在某张单上实际还欠退的金额 */
export interface PendingRefund {
  clientId: string;
  /** 正数，单位元 */
  amount: number;
  /** 给客户看的单号，取流水里记着的那个 */
  refNo: string | null;
}

type LedgerReader = {
  consolidationBalanceLedger: {
    findMany: (args: any) => Promise<any[]>;
  };
};

/**
 * 算出一批单据上还需要退给客户的钱，按客户分组。
 *
 * 一张单可能涉及多个客户（仓库版一个计划下有多个客户各付各的），
 * 所以按 clientId 分开算，一个客户一笔退款。
 *
 * @param refs 要查的单据，如 [{ refType: "whr", refId: "预报单id" }, ...]
 */
export async function computePendingRefunds(
  db: LedgerReader,
  refs: { refType: string; refId: string }[],
): Promise<PendingRefund[]> {
  if (refs.length === 0) return [];

  const rows = await db.consolidationBalanceLedger.findMany({
    where: { OR: refs.map((r) => ({ refType: r.refType, refId: r.refId })) },
    select: { clientId: true, amount: true, refNo: true },
  });

  const byClient = new Map<string, { sum: number; refNo: string | null }>();
  for (const row of rows) {
    const prev = byClient.get(row.clientId) ?? { sum: 0, refNo: null };
    byClient.set(row.clientId, {
      sum: prev.sum + Number(row.amount),
      refNo: prev.refNo ?? row.refNo ?? null,
    });
  }

  const result: PendingRefund[] = [];
  for (const [clientId, v] of byClient) {
    // pay 是负数，取反才是「已经净扣走的钱」
    const amount = round2(-v.sum);
    if (amount > 0) result.push({ clientId, amount, refNo: v.refNo });
  }
  return result;
}

/**
 * 把上面算出来的钱真退回去。必须和删除操作在同一个事务里，
 * 否则会出现「钱退了单子没删」或者反过来。
 *
 * @returns 实际退出去的总金额
 */
export async function refundPendingOnDelete(
  tx: Tx,
  args: {
    companyId: string;
    refType: string;
    /** 记在退款流水上的单据 id，用哪个都行，取被删的那张主单最直观 */
    refId: string;
    refunds: PendingRefund[];
    remark: string;
    operatorId?: string | null;
    operatorName?: string | null;
  },
): Promise<number> {
  let total = 0;
  // ⚠️ 按 clientId 排序再退：一个计划下有多个客户时会依次锁多行，
  // 两个并发的删除操作如果加锁顺序相反，PostgreSQL 会判定死锁、掐掉其中一个。
  // 固定成同一个顺序就不会打架。
  const ordered = [...args.refunds].sort((a, b) => a.clientId.localeCompare(b.clientId));
  for (const r of ordered) {
    await refundToConsolidation(tx, {
      companyId: args.companyId,
      clientId: r.clientId,
      amount: r.amount,
      refType: args.refType,
      refId: args.refId,
      refNo: r.refNo,
      remark: args.remark,
      operatorId: args.operatorId ?? null,
      operatorName: args.operatorName ?? null,
    });
    total = round2(total + r.amount);
  }
  return total;
}
