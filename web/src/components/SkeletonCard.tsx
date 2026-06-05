"use client";

interface SkeletonCardProps {
  height?: string;
  width?: string;
}

export function SkeletonCard({ height = "60px", width = "100%" }: SkeletonCardProps) {
  return (
    <div
      className="animate-pulse bg-slate-700 rounded-lg"
      style={{ height, width }}
    />
  );
}
