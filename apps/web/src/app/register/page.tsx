// 开户说明页（原来是一整套自助注册表单）。
//
// 2026-08-04 改：后端 /auth/register 是硬拒绝的（函数第一行就返回 403「自助注册已关闭」），
// 但这个页面还留着完整的注册表单，登录页也还挂着「还没有账号？去注册」的链接。
// 结果是真实客户点进来、认真填完七个字段、点提交，才收到「自助注册已关闭」——
// 白填一遍，而且看起来像系统坏了。
//
// 安全上本来就没问题（接口不开），这里改成直接说明「开户请联系我们」。
// 会点进这个页面的多半是潜在客户，别把人晾在那儿。
//
// ⚠️ 不要在这里加回任何注册表单：账号只能由管理员在后台创建
//    （/admin/users 与 /admin/users/client，两个都要 admin 权限）。

/** 客服联系方式。只改这里，页面会同步；留空的项不会显示。 */
const CONTACT = {
  phone: "",   // 例：+66 12 345 6789
  wechat: "",  // 微信号
  line: "",    // Line ID
  email: "",   // 邮箱
};

export default function RegisterPage() {
  const items = [
    { label: "电话", value: CONTACT.phone },
    { label: "微信", value: CONTACT.wechat },
    { label: "Line", value: CONTACT.line },
    { label: "邮箱", value: CONTACT.email },
  ].filter((i) => i.value.trim().length > 0);

  return (
    <div className="auth-shell">
      <div className="auth-visual">
        <div className="auth-visual-text">
          <h2>湘泰物流</h2>
          <p>中泰跨境物流管理系统<br />预报 · 装柜 · 清关 · 派送 · 签收，全程可查</p>
        </div>
      </div>

      <div className="auth-panel">
        <div className="auth-form">
          <h1>开通账号</h1>
          <p className="auth-sub">本系统不支持自助注册，账号由我们为您开通。</p>

          <div className="auth-field">
            <label>怎么开通</label>
            <p style={{ margin: 0, fontSize: 13, lineHeight: 1.9, color: "#334155" }}>
              请通过下方方式联系我们，说明您的<strong>公司名称</strong>、<strong>联系人</strong>
              和<strong>手机号</strong>，我们会为您创建账号并发送登录信息。
            </p>
          </div>

          {items.length > 0 ? (
            <div className="auth-field">
              <label>联系方式</label>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {items.map((i) => (
                  <div key={i.label} style={{ display: "flex", gap: 12, fontSize: 13 }}>
                    <span style={{ color: "#64748b", minWidth: 40 }}>{i.label}</span>
                    <span style={{ color: "#0f172a", fontWeight: 500, whiteSpace: "nowrap" }}>{i.value}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="auth-field">
              <label>联系方式</label>
              <p style={{ margin: 0, fontSize: 13, color: "#64748b" }}>
                请联系您的业务对接人开通账号。
              </p>
            </div>
          )}

          <a
            href="/login"
            className="auth-btn"
            style={{ display: "block", textAlign: "center", textDecoration: "none" }}
          >
            返回登录
          </a>

          <div className="auth-foot">
            已有账号？<a href="/login">去登录</a>
          </div>
        </div>
      </div>
    </div>
  );
}
