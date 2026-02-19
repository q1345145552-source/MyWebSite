import type { DeepSeekClient } from "./ai-types";

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
      return `系统暂未配置 DeepSeek API Key。基于业务数据给出结果：${input.context}`;
    }

    const payload = {
      model: this.model,
      temperature: 0.1,
      messages: [
        {
          role: "system",
          content:
            "你是物流客服助手。只能依据给定上下文回答，不允许编造。若信息不足，明确说明信息不足。",
        },
        {
          role: "user",
          content: `问题：${input.question}\n\n上下文：${input.context}`,
        },
      ],
    };

    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`DeepSeek request failed: ${response.status}`);
    }

    const data = (await response.json()) as DeepSeekResponse;
    return data.choices?.[0]?.message?.content?.trim() ?? "未获取到有效回复。";
  }
}
