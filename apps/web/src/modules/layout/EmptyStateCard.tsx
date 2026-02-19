"use client";

type EmptyStateCardProps = {
  title: string;
  description: string;
};

export default function EmptyStateCard({ title, description }: EmptyStateCardProps) {
  return (
    <div className="empty-card">
      <div className="empty-ill" aria-hidden>
        <div className="empty-box" />
        <div className="empty-line short" />
        <div className="empty-line" />
      </div>
      <div className="empty-title">{title}</div>
      <div className="empty-desc">{description}</div>
    </div>
  );
}
