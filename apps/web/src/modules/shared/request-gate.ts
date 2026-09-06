/**
 * 请求门闩（2026-09-01，Codex 竞态全扫后统一引入）。
 *
 * 治的病：「异步取数 → setState」期间用户换了上下文（切分组/翻页/换选中项/改搜索词），
 * 晚到的旧响应把新界面盖掉——老板实测抓到的「亮着在途、列表却是全量」就是这病，
 * 全系统同类入口有 24 处（见 docs/codex-竞态修复复查提示词-2026-09-01.md 那轮复核）。
 *
 * 用法一（列表/筛选类，「只认最新一次请求」）：
 *   const gate = useRef(createRequestGate()).current;
 *   const load = async () => {
 *     const ticket = gate.begin();          // 出发时领号
 *     try {
 *       const data = await fetchXxx(...);
 *       if (!gate.isCurrent(ticket)) return; // 回来发现号作废：数据、报错、loading 都不许碰
 *       setList(data);
 *     } catch (e) {
 *       if (!gate.isCurrent(ticket)) return; // ⚠️ 失败分支同样要挡（错误提示也不许安错地方）
 *       setMessage(...);
 *     } finally {
 *       if (gate.isCurrent(ticket)) setLoading(false); // ⚠️ 旧请求不许提前掐掉新请求的加载态
 *     }
 *   };
 *
 * 用法二（详情/弹窗类，「数据要认对主人」）：响应回来时比对「当前选中的 id」
 * 还是不是出发时那个（用 useRef 存最新选中值），不是就整段 return。
 * 两种可以叠加：先核号、再核主人。
 *
 * ⚠️ 用法一之前先认主人（2026-09-02 三审整改补）：过期上下文的刷新不许领号。
 *    加载函数带上下文参数（如 loadDetail(taskId)）时，进门第一行就要核对
 *    「参数 === 当前选中的 ref」，不是就整个 return——不领号、不开 loading、不清数据。
 *    否则旧上下文（比如任务 A 的操作完成回调）晚来的刷新一领号，就把新上下文 B
 *    还在路上的请求作废了，而它自己的响应又过不了主人核对被丢弃，B 页面就空白。
 *    先认主人再领号，旧上下文的刷新对新上下文零影响。
 *
 * ⚠️ 每一份独立的数据上下文用**自己**的门闩（列表一个、详情一个、图片一个），
 *    共用一个门闩会让不相关的请求互相作废。
 */
export interface RequestGate {
  /** 出发时领号：本次请求的号 */
  begin(): number;
  /** 响应落地时验号：还是最新一次吗？ */
  isCurrent(ticket: number): boolean;
  /** 作废在路上的全部请求（关弹窗 / 组件卸载时用）：之后回来的响应一律验号不过 */
  cancel(): void;
}

export function createRequestGate(): RequestGate {
  let seq = 0;
  return {
    begin: () => ++seq,
    isCurrent: (ticket: number) => ticket === seq,
    cancel: () => { seq += 1; },
  };
}
