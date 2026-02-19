"use client";

import { useEffect, useState } from "react";
import type { AiKnowledgeItem, StatusLabelConfig } from "../../../../../packages/shared-types/entities";
import { DEFAULT_SESSIONS, getMockSession, type MockSession } from "../../auth/mock-session";
import CountUpNumber from "../../modules/layout/CountUpNumber";
import EmptyStateCard from "../../modules/layout/EmptyStateCard";
import RoleShell from "../../modules/layout/RoleShell";
import StepGuide from "../../modules/layout/StepGuide";
import Toast from "../../modules/layout/Toast";
import { fetchAdminOverview, type AdminOverview } from "../../services/business-api";
import {
  createKnowledgeItem,
  deleteKnowledgeItem,
  fetchKnowledgeList,
  fetchStatusLabels,
  resetStatusLabels,
  updateStatusLabels,
} from "../../services/admin-ai";

export default function AdminHomePage() {
  const [session, setSession] = useState<MockSession>(DEFAULT_SESSIONS.client);
  const [loading, setLoading] = useState(false);
  const [overviewFlash, setOverviewFlash] = useState(false);
  const [statusItems, setStatusItems] = useState<StatusLabelConfig[]>([]);
  const [knowledgeItems, setKnowledgeItems] = useState<AiKnowledgeItem[]>([]);
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [message, setMessage] = useState("");
  const [toast, setToast] = useState("");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [statusStepDone, setStatusStepDone] = useState(false);
  const [knowledgeStepDone, setKnowledgeStepDone] = useState(false);

  const loadAll = async (currentSession: MockSession = session) => {
    setLoading(true);
    setMessage("");
    try {
      const [labels, knowledge] = await Promise.all([
        fetchStatusLabels(),
        fetchKnowledgeList(currentSession.companyId),
      ]);
      setStatusItems(labels);
      setKnowledgeItems(knowledge);
      const stats = await fetchAdminOverview();
      setOverview(stats);
    } catch (error) {
      const text = error instanceof Error ? error.message : "加载失败";
      setMessage(`加载失败：${text}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const next = getMockSession();
    setSession(next);
    void loadAll(next);
  }, []);

  useEffect(() => {
    if (!overview) return;
    setOverviewFlash(true);
    const timer = window.setTimeout(() => setOverviewFlash(false), 620);
    return () => window.clearTimeout(timer);
  }, [overview]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const saveStatusLabels = async () => {
    setLoading(true);
    setMessage("");
    try {
      const result = await updateStatusLabels(statusItems);
      setStatusStepDone(true);
      setToast("状态映射保存成功");
      setMessage(`状态映射已保存，更新 ${result.updated} 条。`);
    } catch (error) {
      const text = error instanceof Error ? error.message : "保存失败";
      setMessage(`保存失败：${text}`);
    } finally {
      setLoading(false);
    }
  };

  const resetLabelsToDefault = async () => {
    setLoading(true);
    setMessage("");
    try {
      const result = await resetStatusLabels();
      const latest = await fetchStatusLabels();
      setStatusItems(latest);
      setStatusStepDone(true);
      setToast("已恢复默认状态映射");
      setMessage(`已恢复默认映射，共 ${result.total} 条。`);
    } catch (error) {
      const text = error instanceof Error ? error.message : "恢复失败";
      setMessage(`恢复失败：${text}`);
    } finally {
      setLoading(false);
    }
  };

  const submitKnowledge = async () => {
    if (!title.trim() || !content.trim()) {
      setMessage("请先填写知识标题和内容。");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      await createKnowledgeItem({
        title: title.trim(),
        content: content.trim(),
        companyId: session.companyId,
      });
      setTitle("");
      setContent("");
      setKnowledgeStepDone(true);
      setToast("知识投喂成功");
      setMessage("知识投喂成功。");
      const list = await fetchKnowledgeList(session.companyId);
      setKnowledgeItems(list);
    } catch (error) {
      const text = error instanceof Error ? error.message : "投喂失败";
      setMessage(`投喂失败：${text}`);
    } finally {
      setLoading(false);
    }
  };

  const removeKnowledge = async (id: string) => {
    setLoading(true);
    setMessage("");
    try {
      await deleteKnowledgeItem(id, session.companyId);
      const list = await fetchKnowledgeList(session.companyId);
      setKnowledgeItems(list);
      setToast("知识条目删除成功");
      setMessage("知识条目已删除。");
    } catch (error) {
      const text = error instanceof Error ? error.message : "删除失败";
      setMessage(`删除失败：${text}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <RoleShell allowedRole="admin" title="管理员工作台">
      <section style={{ marginBottom: 20, border: "1px solid #e5e7eb", borderRadius: 12, padding: 16 }}>
        <h2 style={{ marginTop: 0 }}>运营看板</h2>
        <StepGuide steps={["读取看板指标", "自动滚动显示", "辅助运营决策"]} />
        {overview ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10 }}>
            <div className={`kpi-card ${overviewFlash ? "kpi-flash" : ""}`}>
              <div style={{ color: "#6b7280", fontSize: 12 }}>员工账号</div>
              <div style={{ fontSize: 22, fontWeight: 700 }}>
                <CountUpNumber value={overview.staffAccountCount} />
              </div>
            </div>
            <div className={`kpi-card ${overviewFlash ? "kpi-flash" : ""}`}>
              <div style={{ color: "#6b7280", fontSize: 12 }}>客户账号</div>
              <div style={{ fontSize: 22, fontWeight: 700 }}>
                <CountUpNumber value={overview.clientAccountCount} />
              </div>
            </div>
            <div className={`kpi-card ${overviewFlash ? "kpi-flash" : ""}`}>
              <div style={{ color: "#6b7280", fontSize: 12 }}>今日新增订单</div>
              <div style={{ fontSize: 22, fontWeight: 700 }}>
                <CountUpNumber value={overview.newOrderCountToday} />
              </div>
            </div>
            <div className={`kpi-card ${overviewFlash ? "kpi-flash" : ""}`}>
              <div style={{ color: "#6b7280", fontSize: 12 }}>在途订单</div>
              <div style={{ fontSize: 22, fontWeight: 700 }}>
                <CountUpNumber value={overview.inTransitOrderCount} />
              </div>
            </div>
            <div className={`kpi-card ${overviewFlash ? "kpi-flash" : ""}`}>
              <div style={{ color: "#6b7280", fontSize: 12 }}>当日收货总方数</div>
              <div style={{ fontSize: 22, fontWeight: 700 }}>
                <CountUpNumber value={overview.receivedVolumeM3Today} decimals={1} />
              </div>
            </div>
          </div>
        ) : (
          <p style={{ color: "#6b7280" }}>看板数据加载中...</p>
        )}
      </section>

      <section style={{ marginBottom: 20, border: "1px solid #e5e7eb", borderRadius: 12, padding: 16 }}>
        <h2 style={{ marginTop: 0 }}>状态中文映射配置</h2>
        <StepGuide
          steps={["维护状态字典", "保存后实时生效", "支持一键恢复默认"]}
          completedSteps={statusStepDone ? [0, 1, 2] : []}
        />
        <p style={{ color: "#6b7280" }}>
          在这里维护 AI 回答中展示的状态中文文案，保存后实时生效。
        </p>
        <div style={{ display: "grid", gap: 8, maxWidth: 720 }}>
          {statusItems.map((item, idx) => (
            <div key={item.status} style={{ display: "grid", gridTemplateColumns: "180px 1fr", gap: 8 }}>
              <input
                value={item.status}
                readOnly
                style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px", background: "#f8fafc" }}
              />
              <input
                value={item.labelZh}
                onChange={(e) => {
                  const next = [...statusItems];
                  next[idx] = { ...next[idx], labelZh: e.target.value };
                  setStatusItems(next);
                }}
                style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }}
              />
            </div>
          ))}
        </div>
        <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
          <button
            type="button"
            onClick={() => void saveStatusLabels()}
            disabled={loading}
            style={{ border: "none", borderRadius: 8, padding: "8px 14px", color: "#fff", background: "#2563eb", cursor: "pointer" }}
          >
            保存状态映射
          </button>
          <button
            type="button"
            onClick={() => void loadAll()}
            disabled={loading}
            style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 14px", background: "#fff", cursor: "pointer" }}
          >
            刷新
          </button>
          <button
            type="button"
            onClick={() => void resetLabelsToDefault()}
            disabled={loading}
            style={{ border: "1px solid #f59e0b", color: "#92400e", borderRadius: 8, padding: "8px 14px", background: "#fffbeb", cursor: "pointer" }}
          >
            恢复默认映射
          </button>
        </div>
      </section>

      <section style={{ marginBottom: 20, border: "1px solid #e5e7eb", borderRadius: 12, padding: 16 }}>
        <h2 style={{ marginTop: 0 }}>AI 知识投喂</h2>
        <StepGuide
          steps={["填写业务知识", "提交到公司知识库", "聊天问答自动引用"]}
          completedSteps={knowledgeStepDone ? [0, 1, 2] : []}
        />
        <p style={{ color: "#6b7280" }}>
          填写业务规则、时效说明、清关说明等内容，AI 会作为上下文参考。
        </p>
        <div style={{ display: "grid", gap: 8, maxWidth: 720 }}>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="知识标题（例如：海运时效说明）"
            style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px" }}
          />
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="知识内容（支持长文本）"
            rows={5}
            style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px", resize: "vertical" }}
          />
        </div>
        <div style={{ marginTop: 12 }}>
          <button
            type="button"
            onClick={() => void submitKnowledge()}
            disabled={loading}
            style={{ border: "none", borderRadius: 8, padding: "8px 14px", color: "#fff", background: "#059669", cursor: "pointer" }}
          >
            提交知识
          </button>
        </div>
      </section>

      <section style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 16 }}>
        <h2 style={{ marginTop: 0 }}>已投喂知识列表</h2>
        {knowledgeItems.length === 0 ? (
          <EmptyStateCard title="暂无知识条目" description="可先投喂运输时效、清关规则等内容，让 AI 回答更专业。" />
        ) : (
          <div style={{ display: "grid", gap: 10 }}>
            {knowledgeItems.map((item) => (
              <div key={item.id} style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 10 }}>
                <div style={{ fontWeight: 600 }}>{item.title}</div>
                <div style={{ marginTop: 6, whiteSpace: "pre-wrap", color: "#374151" }}>{item.content}</div>
                <div style={{ marginTop: 6, color: "#6b7280", fontSize: 12 }}>
                  {item.createdAt} / by {item.createdBy}
                </div>
                <div style={{ marginTop: 8 }}>
                  <button
                    type="button"
                    onClick={() => void removeKnowledge(item.id)}
                    disabled={loading}
                    style={{
                      border: "1px solid #ef4444",
                      color: "#b91c1c",
                      borderRadius: 8,
                      padding: "6px 10px",
                      background: "#fef2f2",
                      cursor: "pointer",
                    }}
                  >
                    删除该条知识
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {message ? (
        <p style={{ marginTop: 12, color: message.includes("失败") ? "#b91c1c" : "#065f46" }}>{message}</p>
      ) : null}
      <Toast open={toast.length > 0} message={toast} />
    </RoleShell>
  );
}
