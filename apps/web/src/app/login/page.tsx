import type { Metadata } from "next";
import { ArrowRight, ShieldCheck } from "lucide-react";
import { ErrorBanner } from "../../components/ui/index.tsx";
import { GithubLoginLink } from "./GithubLoginLink.tsx";
import { DemoLoginPanel } from "./DemoLoginPanel.tsx";
import { isJudgeDemoLoginEnabled } from "../../shared/demo-auth.ts";
import { safeRelativeUrl } from "../../shared/auth-navigation.ts";
import { metadataBase, SITE_DESCRIPTION, socialMetadata } from "../../lib/site-metadata.ts";

export const metadata: Metadata = {
  title: "ログイン | RuleBranch",
  description: SITE_DESCRIPTION,
  ...socialMetadata("/login", "ログイン | RuleBranch"),
  ...(metadataBase ? {
    alternates: { canonical: "/login" },
  } : {}),
};

export default async function Login({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const { error, next } = await searchParams;
  const continueTo = safeRelativeUrl(next);
  const loginHref = continueTo
    ? `/api/auth/github?next=${encodeURIComponent(continueTo)}`
    : "/api/auth/github";
  const demoLoginEnabled = isJudgeDemoLoginEnabled();

  return (
    <main className="login loginPage">
      <div className="loginShell">
        <section className="loginHero" aria-labelledby="login-heading">
          <div className="loginBrand">
            <img className="loginBrandMark" src="/brand/icon-192.png" alt="" width="34" height="34" />
            <span>RuleBranch</span>
          </div>
          <p className="loginEyebrow">コードとともに育つ開発ルール</p>
          <h1 id="login-heading">コードが変われば、<br />ルールも育つ。</h1>
          <p className="loginLead">
            コードと開発ルールのずれを見つけ、AIが根拠とともに更新案を提示。
            変更を確認・承認し、次の開発へつなげます。
          </p>
        </section>

        <section className="loginDetails" aria-label="RuleBranchでできること">
          <ol className="loginSteps" aria-label="利用の流れ">
            <li><span className="loginStepNumber">01</span><strong>変化を検知</strong></li>
            <li><span className="loginStepNumber">02</span><strong>更新案を確認</strong></li>
            <li><span className="loginStepNumber">03</span><strong>承認して活用</strong></li>
          </ol>

          <article className="loginExample" aria-labelledby="login-example-heading">
            <header className="loginExampleHeader">
              <span className="loginExampleLabel">使い方の例</span>
              <h2 id="login-example-heading">コードの変更が、次の開発ルールにつながる</h2>
            </header>
            <p className="loginExampleIntro">
              例えば認証モジュールの移動を検知したら、古い参照先を見直すルール更新案を提示します。
            </p>
            <div className="loginExampleChange" aria-label="参照パスの更新例">
              <div className="loginExamplePath">
                <span>更新前</span>
                <code>src/lib/auth.ts</code>
              </div>
              <ArrowRight className="loginExampleArrow" size={18} aria-hidden="true" />
              <div className="loginExamplePath loginExamplePathAfter">
                <span>更新後</span>
                <code>src/server/auth.ts</code>
              </div>
            </div>
            <div className="loginExampleOutcome">
              <ShieldCheck size={20} aria-hidden="true" />
              <p>差分と根拠を確認して承認。必要な反映を行い、次の開発で新しいルールを参照します。</p>
            </div>
            <p className="loginExampleFootnote">※ 内容は説明用の例です。承認だけで開発環境へ自動反映されるものではありません。</p>
          </article>
        </section>

        <section className="loginCard" aria-labelledby="login-card-title">
          <h2 id="login-card-title">RuleBranchにログイン</h2>
          <p className="loginCardLead">通常利用はGitHub認証、審査用デモは専用ID・パスワードで確認できます。</p>

          {error && <div className="loginError"><ErrorBanner code={error} /></div>}

          <GithubLoginLink href={loginHref} />
          {demoLoginEnabled && <DemoLoginPanel />}
          <p className="loginTrustLine">
            <ShieldCheck size={19} aria-hidden="true" />
            <span>GitHubログインでは、ログインするだけでリポジトリは連携されません。連携先はログイン後に選べます。</span>
          </p>

          <details className="loginPermissionDetails">
            <summary>GitHubログイン時に参照する情報</summary>
            <div>
              <p><code>read:user</code> GitHubプロフィールの参照</p>
              <p><code>user:email</code> メールアドレスの参照</p>
            </div>
          </details>
        </section>
      </div>
    </main>
  );
}
