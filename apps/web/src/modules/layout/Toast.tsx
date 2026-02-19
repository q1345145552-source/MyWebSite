"use client";

type ToastProps = {
  open: boolean;
  message: string;
  tone?: "success" | "error";
};

export default function Toast({ open, message, tone = "success" }: ToastProps) {
  if (!open) return null;
  return <div className={`biz-toast ${tone === "error" ? "biz-toast-error" : "biz-toast-success"}`}>{message}</div>;
}
