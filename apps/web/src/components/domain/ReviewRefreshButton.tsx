"use client";

import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";

export function ReviewRefreshButton() {
  const router = useRouter();
  return <button className="button secondary" type="button" onClick={() => router.refresh()}>
    <RefreshCw size={14} aria-hidden="true"/>
    一覧を更新
  </button>;
}
