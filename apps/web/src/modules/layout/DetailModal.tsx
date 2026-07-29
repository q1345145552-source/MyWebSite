"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

/**
 * 全屏详情弹窗。
 *
 * 关闭动画必须由组件自己管：CSS 动画只在元素挂载时会播，
 * 一旦 React 把节点摘掉就没机会播退场动画了。
 * 所以这里点关闭时先切到 closing 状态放动画，等动画放完再真正调 onClose。
 */
export default function DetailModal(props: {
  title: string;
  /** 标题下方的小字，一般放运单号 */
  subtitle?: string | null;
  onClose: () => void;
  /** 表单类弹窗传 false：填表时误按 ESC 会丢掉已输入的内容 */
  closeOnEsc?: boolean;
  children: ReactNode;
}) {
  const { title, subtitle, onClose, closeOnEsc = true, children } = props;
  const [closing, setClosing] = useState(false);
  const closedRef = useRef(false);

  const requestClose = useCallback(() => {
    if (closedRef.current) return;
    closedRef.current = true;
    setClosing(true);
    // 必须和 globals.css 里 pageTurnOut / overlayFadeOut 的时长一致，
    // 短了会在动画放完前就把节点摘掉，看起来像"闪一下没了"
    window.setTimeout(onClose, 200);
  }, [onClose]);

  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (closeOnEsc && e.key === "Escape") requestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [closeOnEsc, requestClose]);

  return (
    <div className={`detail-overlay${closing ? " is-closing" : ""}`}>
      <div className="detail-panel">
        <div className="detail-head">
          <div>
            <div className="detail-title">{title}</div>
            {subtitle ? <div className="detail-sub">{subtitle}</div> : null}
          </div>
          <button type="button" className="detail-close" onClick={requestClose} aria-label="关闭">
            ✕
          </button>
        </div>
        <div style={{ padding: "18px 24px 28px" }}>{children}</div>
      </div>
    </div>
  );
}
