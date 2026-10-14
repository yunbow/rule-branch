"use client";

import { useState, type FormEvent } from "react";
import { ArrowRight, KeyRound, LoaderCircle } from "lucide-react";

export function DemoLoginPanel() {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    const id = String(form.get("id") ?? "");
    const password = String(form.get("password") ?? "");
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/demo-login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Requested-With": "RuleBranch",
        },
        body: JSON.stringify({ id, password }),
      });
      if (!response.ok) {
        setError(response.status === 401
          ? "IDまたはパスワードが正しくありません。"
          : response.status === 429
            ? "ログイン試行が多すぎます。少し待ってからもう一度お試しください。"
            : "デモ環境へログインできませんでした。");
        return;
      }
      const result = await response.json() as { redirectTo?: string };
      window.location.assign(result.redirectTo ?? "/");
    } catch {
      setError("デモ環境へ接続できませんでした。");
    } finally {
      setPending(false);
    }
  };

  return <div className="loginDemo">
    <div className="loginDivider" aria-hidden="true"><span>または</span></div>
    {!open ? <button
      type="button"
      className="loginDemoButton"
      onClick={() => { setOpen(true); setError(null); }}
      aria-expanded={false}
    >
      <KeyRound size={19} aria-hidden="true"/>
      <span>デモを見る</span>
      <ArrowRight size={18} aria-hidden="true"/>
    </button> : <div className="loginDemoPanel">
      <div className="loginDemoHeading">
        <div>
          <span>審査用デモ</span>
          <strong>ID・パスワードでログイン</strong>
        </div>
        <button type="button" onClick={() => { if (!pending) setOpen(false); }} disabled={pending}>閉じる</button>
      </div>
      <p className="loginDemoDescription">
        審査専用の読み取りWorkspaceで、Drift検出からAI評価、Draft PRまでの流れを確認できます。
      </p>
      <form className="loginDemoForm" onSubmit={submit}>
        <label>
          <span>ID</span>
          <input name="id" type="text" autoComplete="username" required maxLength={128} disabled={pending}/>
        </label>
        <label>
          <span>パスワード</span>
          <input name="password" type="password" autoComplete="current-password" required maxLength={256} disabled={pending}/>
        </label>
        {error && <p className="loginDemoError" role="alert">{error}</p>}
        <button className="loginDemoSubmit" type="submit" disabled={pending} aria-busy={pending}>
          {pending ? <LoaderCircle className="loginButtonSpinner" size={18} aria-hidden="true"/> : <KeyRound size={18} aria-hidden="true"/>}
          <span>{pending ? "ログインしています…" : "デモWorkspaceに入る"}</span>
          {!pending && <ArrowRight size={18} aria-hidden="true"/>}
        </button>
      </form>
      <p className="loginDemoReadOnly">デモアカウントは閲覧専用です。通常Workspaceや他のGitHubリポジトリは変更できません。</p>
    </div>}
  </div>;
}
