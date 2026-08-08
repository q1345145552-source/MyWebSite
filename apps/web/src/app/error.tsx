"use client";

export default function RootError({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <main style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--s-cool)" }}>
      <div style={{ textAlign: "center", maxWidth: 400, padding: 24 }}>
        <h2 style={{ margin: 0, fontSize: 18, color: "var(--t-heading)" }}>页面加载出错</h2>
        <p style={{ marginTop: 8, color: "var(--t-muted)", fontSize: 13 }}>{error.message || "发生了未知错误"}</p>
        <button
          onClick={reset}
          style={{
            marginTop: 16, border: "none", borderRadius: 8, padding: "8px 20px",
            background: "var(--c-green)", color: "var(--white)", fontWeight: 600, cursor: "pointer", fontSize: 14,
          }}
        >
          重试
        </button>
      </div>
    </main>
  );
}
