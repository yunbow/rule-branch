import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { headers } from "next/headers";
import { ArrowLeft } from "lucide-react";
import { SettingsClient, type PreferenceView } from "../../components/domain/SettingsClient.tsx";
import { getSessionUser } from "../../server/session.ts";
import { getRuntime } from "../../shared/runtime.ts";
import { loginPathForContinuation } from "../../shared/auth-navigation.ts";

export default async function SettingsPage() {
  const user = await getSessionUser();
  const preferences = getRuntime().preferences;
  if (!user) redirect(loginPathForContinuation((await headers()).get("x-rulebranch-request-target")));
  if (!preferences) notFound();

  const value = await preferences.get(String(user.id));

  return (
    <div className="accountPage">
      <header className="accountHeader">
        <Link className="accountBrand" href="/">
          <span className="appBrandMark">RB</span>
          <strong>RuleBranch</strong>
        </Link>
        <Link className="accountBackLink" href="/">
          <ArrowLeft size={14} />
          Workspaceへ戻る
        </Link>
        <span className="accountUserName">{String(user.displayName)}</span>
      </header>

      <SettingsClient
        initialPreferences={{
          locale: value.locale,
          explanationLevel: value.explanationLevel,
          reviewDisplay: value.reviewDisplay,
        } satisfies PreferenceView}
      />
    </div>
  );
}
