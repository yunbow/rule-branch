"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch, ApiError } from "../../lib/api-client.ts";
import { Button, ErrorBanner, Radio, Select, TextArea, useToast } from "../ui/index.tsx";
import { PurgeRequestDialog } from "./PurgeRequestDialog.tsx";

export type PreferenceView = {
  locale: string;
  explanationLevel: "brief" | "normal" | "detailed";
  reviewDisplay: Record<string, unknown>;
};

export function SettingsClient({ initialPreferences }: { initialPreferences: PreferenceView }) {
  const router = useRouter();
  const { add: toast } = useToast();
  const [locale, setLocale] = useState(initialPreferences.locale);
  const [explanationLevel, setExplanationLevel] = useState<PreferenceView["explanationLevel"]>(
    initialPreferences.explanationLevel,
  );
  const [reviewDisplay, setReviewDisplay] = useState(JSON.stringify(initialPreferences.reviewDisplay, null, 2));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);

  const save = async () => {
    setLoading(true);
    setError(null);
    setParseError(null);

    let parsedReviewDisplay: Record<string, unknown>;
    try {
      parsedReviewDisplay = JSON.parse(reviewDisplay) as Record<string, unknown>;
    } catch {
      setParseError("レビュー表示設定のJSONが正しくありません。");
      setLoading(false);
      return;
    }

    try {
      await apiFetch<PreferenceView>("/api/user-preferences", {
        method: "PATCH",
        body: { locale, explanationLevel, reviewDisplay: parsedReviewDisplay },
      });
      toast("個人設定を保存しました");
      router.refresh();
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.code : "INTERNAL_ERROR");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="pageContainer pageContainerNarrow settingsPage">
      <section className="pageHeader">
        <div className="pageHeaderCopy">
          <p className="pageEyebrow">個人設定</p>
          <h1 className="pageTitle">個人設定</h1>
          <p className="pageLead">表示方法やレビュー画面の設定、アカウントデータの管理を行います。</p>
        </div>
      </section>

      <div className="settingsGrid">
        <section className="settingsSection">
          <h2>表示設定</h2>
          <p>RuleBranchで表示する情報量と、今後の言語切り替えに利用する設定を管理します。</p>

          <Select label="言語" value={locale} onChange={(event) => setLocale(event.target.value)}>
            <option value="ja">日本語</option>
            <option value="en">English</option>
          </Select>
          <p className="formHint">現在のUIは、選択内容にかかわらず日本語で表示されます。</p>

          <fieldset>
            <legend>説明の詳しさ</legend>
            <Radio
              name="explanationLevel"
              label="簡潔"
              description="要点のみを表示します。"
              value="brief"
              checked={explanationLevel === "brief"}
              onChange={() => setExplanationLevel("brief")}
            />
            <Radio
              name="explanationLevel"
              label="標準"
              description="必要な背景と要点を表示します。"
              value="normal"
              checked={explanationLevel === "normal"}
              onChange={() => setExplanationLevel("normal")}
            />
            <Radio
              name="explanationLevel"
              label="詳細"
              description="背景と補足を詳しく表示します。"
              value="detailed"
              checked={explanationLevel === "detailed"}
              onChange={() => setExplanationLevel("detailed")}
            />
          </fieldset>

          <TextArea
            label="レビュー表示設定（JSON）"
            value={reviewDisplay}
            placeholder={'{"showEvidence": true}'}
            onChange={(event) => setReviewDisplay(event.target.value)}
          />
          {parseError && <p role="alert" className="error formError">{parseError}</p>}
          {error && <ErrorBanner code={error} />}

          <div className="settingsActions">
            <Button type="button" onClick={() => void save()} loading={loading}>設定を保存</Button>
          </div>
        </section>

        <section className="settingsSection dangerZone">
          <h2>アカウントデータの削除</h2>
          <p>削除要求を送ると対象データの削除ジョブが実行されます。この操作は取り消せません。</p>
          <PurgeRequestDialog />
        </section>
      </div>
    </main>
  );
}
