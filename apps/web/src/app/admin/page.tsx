"use client";

import { useCallback, useEffect, useState } from "react";
import * as XLSX from "xlsx";
import type { AiKnowledgeItem } from "../../../../../packages/shared-types/entities";
import { DEFAULT_SESSIONS, getMockSession, type MockSession } from "../../auth/mock-session";
import CountUpNumber from "../../modules/layout/CountUpNumber";
import EmptyStateCard from "../../modules/layout/EmptyStateCard";
import RoleShell from "../../modules/layout/RoleShell";
import Toast from "../../modules/layout/Toast";
import {
  fetchAdminOverview,
  fetchAdminStaff,
  fetchAdminClients,
  fetchAdminOrders,
  createAdminStaff,
  createAdminClient,
  deleteAdminStaff,
  setAdminStaffPassword,
  type AdminOverview,
  type AdminUserItem,
  type AdminOrderItem,
} from "../../services/business-api";
import {
  createKnowledgeItem,
  deleteKnowledgeItem,
  fetchKnowledgeList,
} from "../../services/admin-ai";

const SECTION_IDS = [
  "overview",
  "staff",
  "clients",
  "orders",
  "knowledge-feed",
  "knowledge-list",
] as const;

const SECTION_LABELS: Record<(typeof SECTION_IDS)[number], string> = {
  overview: "运营看板",
  staff: "员工管理",
  clients: "客户管理",
  orders: "订单数据管理",
  "knowledge-feed": "AI知识投喂",
  "knowledge-list": "已投喂的知识列表",
};

const sectionStyle = {
  marginBottom: 24,
  border: "1px solid #e5e7eb",
  borderRadius: 12,
  padding: 20,
  background: "#fff",
};

const cardStyle = {
  border: "1px solid #e5e7eb",
  borderRadius: 8,
  padding: "10px 12px",
  background: "#f8fafc",
  fontSize: 14,
};

export default function AdminHomePage() {
  const [session, setSession] = useState<MockSession>(DEFAULT_SESSIONS.client);
  const [loading, setLoading] = useState(false);
  const [overviewFlash, setOverviewFlash] = useState(false);
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [staffList, setStaffList] = useState<AdminUserItem[]>([]);
  const [clientList, setClientList] = useState<AdminUserItem[]>([]);
  const [orderList, setOrderList] = useState<AdminOrderItem[]>([]);
  const [knowledgeItems, setKnowledgeItems] = useState<AiKnowledgeItem[]>([]);
  const [message, setMessage] = useState("");
  const [toast, setToast] = useState("");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [staffPanelCollapsed, setStaffPanelCollapsed] = useState(false);
  const [ordersPanelCollapsed, setOrdersPanelCollapsed] = useState(false);
  const [staffForm, setStaffForm] = useState({ id: "", name: "", phone: "", password: "" });
  const [clientForm, setClientForm] = useState({ id: "", name: "", companyName: "", phone: "", email: "" });
  const [settingPasswordFor, setSettingPasswordFor] = useState<string | null>(null);
  const [settingPasswordValue, setSettingPasswordValue] = useState("");

  const loadOverview = useCallback(async () => {
    const stats = await fetchAdminOverview();
    setOverview(stats);
  }, []);

  const loadStaff = useCallback(async () => {
    const list = await fetchAdminStaff();
    setStaffList(list);
  }, []);

  const loadClients = useCallback(async () => {
    const list = await fetchAdminClients();
    setClientList(list);
  }, []);

  const loadOrders = useCallback(async () => {
    const list = await fetchAdminOrders();
    setOrderList(list);
  }, []);

  const loadKnowledge = useCallback(async () => {
    const list = await fetchKnowledgeList(session.companyId);
    setKnowledgeItems(list);
  }, [session.companyId]);

  const loadAll = useCallback(
    async (currentSession: MockSession = session) => {
      setLoading(true);
      setMessage("");
      try {
        await Promise.all([
          loadOverview(),
          loadStaff(),
          loadClients(),
          loadOrders(),
          fetchKnowledgeList(currentSession.companyId).then(setKnowledgeItems),
        ]);
      } catch (error) {
        const text = error instanceof Error ? error.message : "加载失败";
        setMessage(`加载失败：${text}`);
      } finally {
        setLoading(false);
      }
    },
    [session, loadOverview, loadStaff, loadClients, loadOrders],
  );

  useEffect(() => {
    const next = getMockSession();
    setSession(next);
    void loadAll(next);
  }, []);

  useEffect(() => {
    if (!overview) return;
    setOverviewFlash(true);
    const t = window.setTimeout(() => setOverviewFlash(false), 620);
    return () => window.clearTimeout(t);
  }, [overview]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(""), 2200);
    return () => window.clearTimeout(t);
  }, [toast]);

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
      setToast("知识投喂成功");
      await loadKnowledge();
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
      await loadKnowledge();
      setToast("知识条目删除成功");
    } catch (error) {
      const text = error instanceof Error ? error.message : "删除失败";
      setMessage(`删除失败：${text}`);
    } finally {
      setLoading(false);
    }
  };

  const submitAddStaff = async () => {
    if (!staffForm.name.trim() || !staffForm.phone.trim()) {
      setMessage("请填写员工姓名和手机号。");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      await createAdminStaff({
        id: staffForm.id.trim() || undefined,
        name: staffForm.name.trim(),
        phone: staffForm.phone.trim(),
        password: staffForm.password.trim() || undefined,
      });
      setStaffForm({ id: "", name: "", phone: "", password: "" });
      setToast("员工添加成功");
      setMessage("");
      await Promise.all([loadStaff(), loadOverview()]);
    } catch (error) {
      const text = error instanceof Error ? error.message : "添加失败";
      if (text.includes("permission") || text.includes("FORBIDDEN") || text.includes("403")) {
        setMessage("添加失败：请使用管理员身份登录（在首页选择 admin 并进入工作台）后再试。");
      } else {
        setMessage(`添加失败：${text}`);
      }
    } finally {
      setLoading(false);
    }
  };

  const confirmDeleteStaff = async (userId: string, userName: string) => {
    if (!window.confirm(`确定要删除员工「${userName}」吗？删除后该账号将无法登录。`)) return;
    setLoading(true);
    setMessage("");
    try {
      await deleteAdminStaff(userId);
      setToast("员工已删除");
      await Promise.all([loadStaff(), loadOverview()]);
    } catch (error) {
      const text = error instanceof Error ? error.message : "删除失败";
      setMessage(`删除失败：${text}`);
    } finally {
      setLoading(false);
    }
  };

  const submitSetPassword = async (userId: string) => {
    if (!settingPasswordValue.trim()) {
      setMessage("请输入新密码。");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      await setAdminStaffPassword(userId, settingPasswordValue.trim());
      setSettingPasswordFor(null);
      setSettingPasswordValue("");
      setToast("密码已更新");
    } catch (error) {
      const text = error instanceof Error ? error.message : "设置失败";
      setMessage(`设置失败：${text}`);
    } finally {
      setLoading(false);
    }
  };

  const submitAddClient = async () => {
    if (!clientForm.name.trim() || !clientForm.phone.trim()) {
      setMessage("请填写客户名字和电话号码。");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      await createAdminClient({
        id: clientForm.id.trim() || undefined,
        name: clientForm.name.trim(),
        companyName: clientForm.companyName.trim() || undefined,
        phone: clientForm.phone.trim(),
        email: clientForm.email.trim() || undefined,
      });
      setClientForm({ id: "", name: "", companyName: "", phone: "", email: "" });
      setToast("客户添加成功");
      setMessage("");
      await Promise.all([loadClients(), loadOverview()]);
    } catch (error) {
      const text = error instanceof Error ? error.message : "添加失败";
      if (text.includes("permission") || text.includes("FORBIDDEN") || text.includes("403")) {
        setMessage("添加失败：请使用管理员身份登录后再试。");
      } else {
        setMessage(`添加失败：${text}`);
      }
    } finally {
      setLoading(false);
    }
  };

  const exportOrdersToExcel = () => {
    if (orderList.length === 0) {
      setMessage("当前没有可导出的订单数据。");
      return;
    }
    const rows = orderList.map((o) => ({
      订单号: o.id,
      客户: o.clientName ?? o.clientId ?? "-",
      品名: o.itemName,
      运输方式: o.transportMode,
      国内单号: o.domesticTrackingNo ?? "-",
      柜号: o.batchNo ?? "-",
      审批状态: o.approvalStatus,
      产品数量: o.productQuantity ?? "-",
      包裹数量: o.packageCount ?? "-",
      重量kg: o.weightKg ?? "-",
      体积m3: o.volumeM3 ?? "-",
      到仓日期: o.shipDate ?? "-",
      状态组: o.statusGroup ?? "-",
      创建时间: o.createdAt ?? "-",
      更新时间: o.updatedAt ?? "-",
    }));
    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "订单列表");
    const today = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(workbook, `订单数据_${today}.xlsx`);
    setToast("导出Excel成功");
  };

  const scrollToSection = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
  };

  return (
    <RoleShell allowedRole="admin" title="管理员工作台">
      <nav
        style={{
          position: "sticky",
          top: 0,
          zIndex: 10,
          background: "#f8fafc",
          border: "1px solid #e2e8f0",
          borderRadius: 10,
          padding: "10px 14px",
          marginBottom: 20,
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
        }}
      >
        {SECTION_IDS.map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => scrollToSection(id)}
            style={{
              border: "1px solid #cbd5e1",
              borderRadius: 8,
              padding: "6px 12px",
              background: "#fff",
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            {SECTION_LABELS[id]}
          </button>
        ))}
        <button
          type="button"
          onClick={() => void loadAll()}
          disabled={loading}
          style={{
            marginLeft: "auto",
            border: "1px solid #2563eb",
            borderRadius: 8,
            padding: "6px 12px",
            background: "#eff6ff",
            color: "#2563eb",
            fontWeight: 600,
            cursor: loading ? "not-allowed" : "pointer",
          }}
        >
          {loading ? "加载中…" : "刷新全部"}
        </button>
      </nav>

      {/* 1. 运营看板 */}
      <section id="overview" style={sectionStyle}>
        <h2 style={{ marginTop: 0, marginBottom: 16, fontSize: 18 }}>{SECTION_LABELS.overview}</h2>
        {overview ? (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
              gap: 12,
            }}
          >
            <div className={overviewFlash ? "kpi-flash" : ""} style={cardStyle}>
              <div style={{ color: "#64748b", fontSize: 12 }}>员工账号总人数</div>
              <div style={{ fontSize: 22, fontWeight: 700 }}>
                <CountUpNumber value={overview.staffAccountCount} />
              </div>
            </div>
            <div className={overviewFlash ? "kpi-flash" : ""} style={cardStyle}>
              <div style={{ color: "#64748b", fontSize: 12 }}>客户账号</div>
              <div style={{ fontSize: 22, fontWeight: 700 }}>
                <CountUpNumber value={overview.clientAccountCount} />
              </div>
            </div>
            <div className={overviewFlash ? "kpi-flash" : ""} style={cardStyle}>
              <div style={{ color: "#64748b", fontSize: 12 }}>今日新增订单</div>
              <div style={{ fontSize: 22, fontWeight: 700 }}>
                <CountUpNumber value={overview.newOrderCountToday} />
              </div>
            </div>
            <div className={overviewFlash ? "kpi-flash" : ""} style={cardStyle}>
              <div style={{ color: "#64748b", fontSize: 12 }}>在途订单</div>
              <div style={{ fontSize: 22, fontWeight: 700 }}>
                <CountUpNumber value={overview.inTransitOrderCount} />
              </div>
            </div>
            <div className={overviewFlash ? "kpi-flash" : ""} style={cardStyle}>
              <div style={{ color: "#64748b", fontSize: 12 }}>当日收货总方数</div>
              <div style={{ fontSize: 22, fontWeight: 700 }}>
                <CountUpNumber value={overview.receivedVolumeM3Today} decimals={1} />
              </div>
            </div>
          </div>
        ) : (
          <p style={{ color: "#64748b" }}>看板数据加载中…</p>
        )}
      </section>

      {/* 2. 员工管理 */}
      <section id="staff" style={sectionStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>{SECTION_LABELS.staff}</h2>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button
              type="button"
              onClick={() => setStaffPanelCollapsed((v) => !v)}
              style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "6px 10px", background: "#fff", fontWeight: 600, cursor: "pointer" }}
            >
              {staffPanelCollapsed ? "展开" : "折叠"}
            </button>
            <button
              type="button"
              onClick={() => void loadStaff()}
              disabled={loading}
              style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "6px 12px", background: "#fff", cursor: "pointer" }}
            >
              刷新
            </button>
          </div>
        </div>
        {staffPanelCollapsed ? (
          <p style={{ color: "#64748b", fontSize: 13, margin: 0 }}>已折叠，可防止误删。点击「展开」后显示添加员工与员工列表（含设置密码、删除等操作）。</p>
        ) : (
          <>
        <div style={{ marginBottom: 16, padding: 12, background: "#f8fafc", borderRadius: 8, border: "1px solid #e2e8f0" }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>添加员工</div>
          <div style={{ fontSize: 12, color: "#64748b", marginBottom: 8 }}>需使用管理员身份登录；姓名、手机为必填，账号与密码可选（不填账号将自动生成）。</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 8, alignItems: "end" }}>
            <div>
              <label style={{ fontSize: 12, color: "#64748b", display: "block", marginBottom: 4 }}>账号（选填，不填则自动生成）</label>
              <input
                value={staffForm.id}
                onChange={(e) => setStaffForm((f) => ({ ...f, id: e.target.value }))}
                placeholder="如 u_staff_002"
                style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px", width: "100%" }}
              />
            </div>
            <div>
              <label style={{ fontSize: 12, color: "#64748b", display: "block", marginBottom: 4 }}>姓名 *</label>
              <input
                value={staffForm.name}
                onChange={(e) => setStaffForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="员工姓名"
                style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px", width: "100%" }}
              />
            </div>
            <div>
              <label style={{ fontSize: 12, color: "#64748b", display: "block", marginBottom: 4 }}>手机 *</label>
              <input
                value={staffForm.phone}
                onChange={(e) => setStaffForm((f) => ({ ...f, phone: e.target.value }))}
                placeholder="手机号"
                style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px", width: "100%" }}
              />
            </div>
            <div>
              <label style={{ fontSize: 12, color: "#64748b", display: "block", marginBottom: 4 }}>登录密码（选填，可稍后设置）</label>
              <input
                type="password"
                value={staffForm.password}
                onChange={(e) => setStaffForm((f) => ({ ...f, password: e.target.value }))}
                placeholder="密码"
                style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px", width: "100%" }}
              />
            </div>
            <button
              type="button"
              onClick={() => void submitAddStaff()}
              disabled={loading}
              style={{ border: "none", borderRadius: 8, padding: "8px 14px", background: "#2563eb", color: "#fff", fontWeight: 600, cursor: "pointer" }}
            >
              添加员工
            </button>
          </div>
        </div>
        {staffList.length === 0 ? (
          <EmptyStateCard title="暂无员工" description="请在上方添加员工账号。" />
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            {staffList.map((u) => (
              <div key={u.id} style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 12, background: "#fff" }}>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 8, alignItems: "center" }}>
                  <span><strong>账号</strong> {u.id}</span>
                  <span><strong>姓名</strong> {u.name}</span>
                  <span><strong>手机</strong> {u.phone}</span>
                  <span><strong>状态</strong> {u.status}</span>
                  <span style={{ color: "#64748b", fontSize: 12 }}>{u.createdAt.slice(0, 10)}</span>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button
                      type="button"
                      onClick={() => setSettingPasswordFor(settingPasswordFor === u.id ? null : u.id)}
                      disabled={loading}
                      style={{ border: "1px solid #059669", color: "#059669", borderRadius: 8, padding: "6px 10px", background: "#f0fdf4", cursor: "pointer", fontSize: 13 }}
                    >
                      {settingPasswordFor === u.id ? "取消" : "设置密码"}
                    </button>
                    <button
                      type="button"
                      onClick={() => void confirmDeleteStaff(u.id, u.name)}
                      disabled={loading}
                      style={{ border: "1px solid #dc2626", color: "#dc2626", borderRadius: 8, padding: "6px 10px", background: "#fef2f2", cursor: "pointer", fontSize: 13 }}
                    >
                      删除
                    </button>
                  </div>
                </div>
                {settingPasswordFor === u.id ? (
                  <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid #e5e7eb", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <input
                      type="password"
                      value={settingPasswordValue}
                      onChange={(e) => setSettingPasswordValue(e.target.value)}
                      placeholder="输入新密码"
                      style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "6px 10px", width: 180 }}
                    />
                    <button
                      type="button"
                      onClick={() => void submitSetPassword(u.id)}
                      disabled={loading || !settingPasswordValue.trim()}
                      style={{ border: "none", borderRadius: 8, padding: "6px 12px", background: "#059669", color: "#fff", cursor: "pointer" }}
                    >
                      确认
                    </button>
                    <button
                      type="button"
                      onClick={() => { setSettingPasswordFor(null); setSettingPasswordValue(""); }}
                      style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "6px 12px", background: "#fff", cursor: "pointer" }}
                    >
                      取消
                    </button>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
          </>
        )}
      </section>

      {/* 3. 客户管理 */}
      <section id="clients" style={sectionStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>{SECTION_LABELS.clients}</h2>
          <button
            type="button"
            onClick={() => void loadClients()}
            disabled={loading}
            style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "6px 12px", background: "#fff", cursor: "pointer" }}
          >
            刷新
          </button>
        </div>
        <div style={{ marginBottom: 16, padding: 12, background: "#f8fafc", borderRadius: 8, border: "1px solid #e2e8f0" }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>添加客户</div>
          <div style={{ fontSize: 12, color: "#64748b", marginBottom: 8 }}>客户名字、电话号码为必填；公司名字、邮箱选填。账号不填则自动生成。</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 8, alignItems: "end" }}>
            <div>
              <label style={{ fontSize: 12, color: "#64748b", display: "block", marginBottom: 4 }}>账号（选填）</label>
              <input
                value={clientForm.id}
                onChange={(e) => setClientForm((f) => ({ ...f, id: e.target.value }))}
                placeholder="如 u_client_002"
                style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px", width: "100%" }}
              />
            </div>
            <div>
              <label style={{ fontSize: 12, color: "#64748b", display: "block", marginBottom: 4 }}>客户名字 *</label>
              <input
                value={clientForm.name}
                onChange={(e) => setClientForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="客户姓名"
                style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px", width: "100%" }}
              />
            </div>
            <div>
              <label style={{ fontSize: 12, color: "#64748b", display: "block", marginBottom: 4 }}>公司名字</label>
              <input
                value={clientForm.companyName}
                onChange={(e) => setClientForm((f) => ({ ...f, companyName: e.target.value }))}
                placeholder="公司名称"
                style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px", width: "100%" }}
              />
            </div>
            <div>
              <label style={{ fontSize: 12, color: "#64748b", display: "block", marginBottom: 4 }}>电话号码 *</label>
              <input
                value={clientForm.phone}
                onChange={(e) => setClientForm((f) => ({ ...f, phone: e.target.value }))}
                placeholder="手机号"
                style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px", width: "100%" }}
              />
            </div>
            <div>
              <label style={{ fontSize: 12, color: "#64748b", display: "block", marginBottom: 4 }}>邮箱</label>
              <input
                type="email"
                value={clientForm.email}
                onChange={(e) => setClientForm((f) => ({ ...f, email: e.target.value }))}
                placeholder="email@example.com"
                style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 10px", width: "100%" }}
              />
            </div>
            <button
              type="button"
              onClick={() => void submitAddClient()}
              disabled={loading}
              style={{ border: "none", borderRadius: 8, padding: "8px 14px", background: "#2563eb", color: "#fff", fontWeight: 600, cursor: "pointer" }}
            >
              添加客户
            </button>
          </div>
        </div>
        {clientList.length === 0 ? (
          <EmptyStateCard title="暂无客户" description="请在上方添加客户。" />
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            {clientList.map((u) => (
              <div
                key={u.id}
                style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 8, ...cardStyle }}
              >
                <span><strong>账号</strong> {u.id}</span>
                <span><strong>客户名字</strong> {u.name}</span>
                <span><strong>公司名字</strong> {u.companyName ?? "-"}</span>
                <span><strong>电话</strong> {u.phone}</span>
                <span><strong>邮箱</strong> {u.email ?? "-"}</span>
                <span><strong>状态</strong> {u.status}</span>
                <span style={{ color: "#64748b", fontSize: 12 }}>{u.createdAt.slice(0, 10)}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 4. 订单数据管理 */}
      <section id="orders" style={sectionStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>{SECTION_LABELS.orders}</h2>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button
              type="button"
              onClick={() => setOrdersPanelCollapsed((v) => !v)}
              style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "6px 10px", background: "#fff", fontWeight: 600, cursor: "pointer" }}
            >
              {ordersPanelCollapsed ? "展开" : "折叠"}
            </button>
            <button
              type="button"
              onClick={exportOrdersToExcel}
              disabled={orderList.length === 0}
              style={{
                border: "none",
                borderRadius: 8,
                padding: "6px 12px",
                color: "#fff",
                background: orderList.length === 0 ? "#94a3b8" : "#2563eb",
                cursor: orderList.length === 0 ? "not-allowed" : "pointer",
              }}
            >
              导出Excel
            </button>
            <button
              type="button"
              onClick={() => void loadOrders()}
              disabled={loading}
              style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: "6px 12px", background: "#fff", cursor: "pointer" }}
            >
              刷新
            </button>
          </div>
        </div>
        {ordersPanelCollapsed ? (
          <p style={{ color: "#64748b", fontSize: 13, margin: 0 }}>已折叠。点击「展开」可查看订单列表并导出 Excel。</p>
        ) : orderList.length === 0 ? (
          <EmptyStateCard title="暂无订单" description="当前公司下暂无订单数据。" />
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: "2px solid #e2e8f0", textAlign: "left" }}>
                  <th style={{ padding: "8px 6px" }}>订单号</th>
                  <th style={{ padding: "8px 6px" }}>客户</th>
                  <th style={{ padding: "8px 6px" }}>品名</th>
                  <th style={{ padding: "8px 6px" }}>运输方式</th>
                  <th style={{ padding: "8px 6px" }}>审批状态</th>
                  <th style={{ padding: "8px 6px" }}>创建时间</th>
                </tr>
              </thead>
              <tbody>
                {orderList.map((o) => (
                  <tr key={o.id} style={{ borderBottom: "1px solid #e2e8f0" }}>
                    <td style={{ padding: "8px 6px" }}>{o.id}</td>
                    <td style={{ padding: "8px 6px" }}>{o.clientName ?? o.clientId}</td>
                    <td style={{ padding: "8px 6px" }}>{o.itemName}</td>
                    <td style={{ padding: "8px 6px" }}>{o.transportMode}</td>
                    <td style={{ padding: "8px 6px" }}>{o.approvalStatus}</td>
                    <td style={{ padding: "8px 6px", color: "#64748b" }}>{o.createdAt.slice(0, 16)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 5. AI知识投喂 */}
      <section id="knowledge-feed" style={sectionStyle}>
        <h2 style={{ marginTop: 0, marginBottom: 12, fontSize: 18 }}>{SECTION_LABELS["knowledge-feed"]}</h2>
        <p style={{ color: "#64748b", marginBottom: 12, fontSize: 14 }}>
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

      {/* 6. 已投喂的知识列表 */}
      <section id="knowledge-list" style={sectionStyle}>
        <h2 style={{ marginTop: 0, marginBottom: 12, fontSize: 18 }}>{SECTION_LABELS["knowledge-list"]}</h2>
        {knowledgeItems.length === 0 ? (
          <EmptyStateCard title="暂无知识条目" description="可先投喂运输时效、清关规则等内容，让 AI 回答更专业。" />
        ) : (
          <div style={{ display: "grid", gap: 10 }}>
            {knowledgeItems.map((item) => (
              <div key={item.id} style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12 }}>
                <div style={{ fontWeight: 600 }}>{item.title}</div>
                <div style={{ marginTop: 6, whiteSpace: "pre-wrap", color: "#374151", fontSize: 14 }}>{item.content}</div>
                <div style={{ marginTop: 6, color: "#64748b", fontSize: 12 }}>
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
