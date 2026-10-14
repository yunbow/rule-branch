"use client";

import Link from "next/link";
import { LogOut, UserRound } from "lucide-react";
import { apiFetch } from "../../lib/api-client.ts";
import { Button } from "../ui/index.tsx";

export function UserMenu({ name, pending = 0 }: { name: string; pending?: number }) {
  const logout = async () => {
    await apiFetch("/api/auth/logout", { method: "POST" });
    window.location.assign("/login");
  };

  return <>
    <span className="appUserDesktop">
      <Link href="/invitations">{name}{pending > 0 && <span className="badge blue" aria-label={`招待 ${pending} 件`}>{pending}</span>}</Link>
      <Link href="/settings">個人設定</Link>
      <Button variant="ghost" type="button" onClick={() => void logout()}>ログアウト</Button>
    </span>
    <details className="appUserMobile">
      <summary aria-label="アカウントメニュー">
        <UserRound size={19} aria-hidden="true"/>
        {pending > 0 && <span className="appUserNotification" aria-label={`招待 ${pending} 件`}>{pending}</span>}
      </summary>
      <div className="appUserMobileDropdown">
        <strong title={name}>{name}</strong>
        <Link href="/invitations">招待を確認 {pending > 0 && `(${pending})`}</Link>
        <Link href="/settings">個人設定</Link>
        <button type="button" onClick={() => void logout()}><LogOut size={16} aria-hidden="true"/>ログアウト</button>
      </div>
    </details>
  </>;
}
export default UserMenu;
