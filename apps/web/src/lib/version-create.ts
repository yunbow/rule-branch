import { utf8ByteLength } from "./rule-form.ts";

export const MAX_VERSION_CONTENT_BYTES = 32768;
export const MAX_VERSION_RATIONALE_BYTES = 8192;
export const MAX_VERSION_EVIDENCE = 20;

export type CompatibilityParse =
  | { value: Record<string, unknown>; error: null }
  | { value: null; error: string };

export function parseCompatibilityJson(text: string): CompatibilityParse {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { value: null, error: "互換性情報はJSONオブジェクトで指定してください。" };
    }
    return { value: parsed as Record<string, unknown>, error: null };
  } catch {
    return { value: null, error: "互換性情報のJSON構文が正しくありません。" };
  }
}

export function uniqueEvidenceIds(ids: readonly string[]): string[] {
  return [...new Set(ids.map((item) => item.trim()).filter(Boolean))];
}

export function parseEvidenceIdInput(value: string): string[] {
  return uniqueEvidenceIds(value.split(/[,\n]/));
}

export type VersionCreateValidation = {
  contentError: string | null;
  rationaleError: string | null;
  evidenceError: string | null;
  compatibilityError: string | null;
  sourceError: string | null;
  compatibilityValue: Record<string, unknown> | null;
  valid: boolean;
};

export function validateVersionCreate(input: {
  content: string;
  rationale: string;
  evidenceIds: string[];
  compatibilityJson: string;
  sourceStatus?: string;
}): VersionCreateValidation {
  const contentBytes = utf8ByteLength(input.content);
  const rationaleBytes = utf8ByteLength(input.rationale);
  const compatibility = parseCompatibilityJson(input.compatibilityJson);
  const contentError = !input.content.trim()
    ? "ルール本文を入力してください。"
    : contentBytes > MAX_VERSION_CONTENT_BYTES
      ? "ルール本文が32,768 bytesを超えています。"
      : null;
  const rationaleError = !input.rationale.trim()
    ? "今回の変更理由を入力してください。"
    : rationaleBytes > MAX_VERSION_RATIONALE_BYTES
      ? "変更理由が8,192 bytesを超えています。"
      : null;
  const evidenceError = uniqueEvidenceIds(input.evidenceIds).length > MAX_VERSION_EVIDENCE
    ? "根拠は最大20件まで指定できます。"
    : null;
  const sourceError = input.sourceStatus && input.sourceStatus !== "proposed"
    ? "元の提案が提案中ではありません。状態を確認してください。"
    : null;
  return {
    contentError,
    rationaleError,
    evidenceError,
    compatibilityError: compatibility.error,
    sourceError,
    compatibilityValue: compatibility.value,
    valid: !contentError && !rationaleError && !evidenceError && !compatibility.error && !sourceError,
  };
}

export function createVersionErrorMessage(code: string): string | null {
  if (code === "SUPERSEDES_INVALID") {
    return "元の提案が承認・却下・取下げなどにより変更されています。入力内容は保持しています。元の提案の最新状態を確認してください。";
  }
  if (code === "RULE_STATUS_INVALID") {
    return "ルールの状態が変更され、現在は新しいバージョンを作成できません。入力内容は保持しています。";
  }
  if (code === "INVALID_NEXT_VERSION") {
    return "他の編集によってバージョン番号が変更されました。入力内容を保持しています。";
  }
  return null;
}

export const CHANGE_TYPE_DESCRIPTION: Record<string, string> = {
  initial: "新しいルールの初回バージョンを提案します。",
  clarify: "ルールの意図を変えず、曖昧な表現や適用条件を明確にします。",
  tighten: "必須条件や制約を追加・強化します。",
  relax: "既存の制約を緩和します。",
  refactor: "意図を変えずに構成や表現を整理します。",
  deprecate: "ルールを廃止する変更を提案します。",
};
