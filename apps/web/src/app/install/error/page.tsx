import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { getErrorMessage } from "../../../lib/messages.ts";

export default async function InstallErrorPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string }>;
}) {
  const { code } = await searchParams;
  return <main className="screenError">
    <section className="screenErrorCard">
      <div className="noticeBanner danger"><AlertTriangle size={19}/> GitHub Appの接続を完了できませんでした。</div>
      <h1>GitHub Appのインストールに失敗しました</h1>
      <p role="alert">{getErrorMessage(code ?? "INTERNAL_ERROR")}</p>
      <Link className="button primary" href="/">Workspaceへ戻る</Link>
    </section>
  </main>;
}
