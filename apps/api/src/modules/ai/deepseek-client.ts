import type { DeepSeekClient } from "./ai-types";
import { logger } from "../core/logger";

/**
 * 单次调用的超时（毫秒）。
 *
 * ⚠️ Node 的 fetch **默认不设超时**，也没有 AbortController ——
 * DeepSeek 那边网络卡住时这个请求会一直挂着（要等 Node 默认 300 秒才断），
 * 而一条客户消息要**串行调两次**（猜意图 + 润色）。
 * 客户等不到结果就去点重发，前一次的钱照付、新的一次再付一遍；
 * 几十个卡住的请求就能把单进程的 API 拖垮。
 *
 * 默认 12 秒是倒推出来的：前端 apiRequest 单次请求 30 秒超时（core-api.ts），
 * 两次调用 12+12=24 秒，留 6 秒给数据库和其他处理，刚好不会先被前端判超时。
 * **改大这个值前先想想前端那 30 秒**。
 */
const DEEPSEEK_TIMEOUT_MS = (() => {
  const raw = process.env.DEEPSEEK_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") return 12_000;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    logger.warn("[ai] 环境变量 DEEPSEEK_TIMEOUT_MS 不是正整数，改用默认值", { raw, fallback: 12_000 });
    return 12_000;
  }
  return value;
})();

interface DeepSeekResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

export class HttpDeepSeekClient implements DeepSeekClient {
  private readonly endpoint: string;
  private readonly model: string;
  private readonly apiKey?: string;

  constructor() {
    this.endpoint =
      process.env.DEEPSEEK_API_BASE_URL ?? "https://api.deepseek.com/chat/completions";
    this.model = process.env.DEEPSEEK_MODEL ?? "deepseek-chat";
    this.apiKey = process.env.DEEPSEEK_API_KEY;
  }

  async summarizeWithContext(input: {
    question: string;
    context: string;
  }): Promise<string> {
    // Fallback keeps V1 usable when key is not configured.
    if (!this.apiKey) {
      return "系统暂未配置 DeepSeek API Key。请联系管理员配置后使用 AI 客服功能。";
    }

    const payload = {
      model: this.model,
      temperature: 0.1,
      messages: [
        {
          role: "system",
          content:
            "你是湘泰物流AI客服助手。只能依据给定上下文回答，不允许编造。若信息不足，明确说明信息不足。",
        },
        {
          role: "user",
          content: `问题：${input.question}\n\n上下文：${input.context}`,
        },
      ],
    };

    // ⚠️ 计时器必须等**响应体读完**才清掉：signal 同时管着 body 的读取，
    // 提前 clearTimeout 的话，对方把头发回来后再挂住，照样能一直挂着。
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEEPSEEK_TIMEOUT_MS);
    let response: Response;
    let data: DeepSeekResponse & { error?: { message?: string }; message?: string };
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      // 出错时 DeepSeek 有两种回法：{error:{message}} 或者顶层直接一个 message，
      // 两种都要认（2026-08-27 把顶层 message 补进类型，之前 tsc 一直报错）
      data = (await response.json()) as DeepSeekResponse & {
        error?: { message?: string };
        message?: string;
      };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        logger.warn("[ai] DeepSeek 超时", { timeoutMs: DEEPSEEK_TIMEOUT_MS });
        throw new Error(`DeepSeek 请求超时（${DEEPSEEK_TIMEOUT_MS} 毫秒没有响应）。`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      const msg = data?.error?.message ?? data?.message ?? `HTTP ${response.status}`;
      if (response.status === 401) throw new Error("DeepSeek API Key 无效或已过期，请检查 .env 中的 DEEPSEEK_API_KEY。");
      if (response.status === 402) throw new Error("DeepSeek 账户余额不足或未开通计费，请到平台充值。");
      throw new Error(`DeepSeek 请求失败：${msg}`);
    }

    return data.choices?.[0]?.message?.content?.trim() ?? "未获取到有效回复。";
  }
}
