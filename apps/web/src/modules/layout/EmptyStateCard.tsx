"use client";

type EmptyStateCardProps = {
  title: string;
  description: string;
};

export default function EmptyStateCard({ title, description }: EmptyStateCardProps) {
  return (
    <div className="empty-card">
      <div className="empty-title">{title}</div>
      <div className="empty-desc">{description}</div>
    </div>
  );
}
