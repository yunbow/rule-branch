import { toReviewScore } from "../../lib/review-score.ts";
const reasonCatalog: Record<string, { label: string; group: "policy" | "evidence" | "security" | "evaluation" | "system"; description: string }> = {
  NON_MAINTENANCE_CHANGE: { label: "保守変更外", group: "policy", description: "ルールの強化・緩和・廃止など、明確化やリファクタ以外の変更は人間が判断します。" },
  PROTECTED_RULE: { label: "保護ルール", group: "policy", description: "組織方針・高リスクルールなど、自動承認の対象外です。" },
  INITIAL_OR_INACTIVE_RULE: { label: "初回 / 非Active", group: "policy", description: "初回のルール採用、または有効でないルールには人間の承認が必要です。" },
  EXECUTABLE_CHECKS_REQUIRE_HUMAN: { label: "実行チェックあり", group: "policy", description: "実行可能な検査を伴うルールは人間が確認してください。" },
  WORKSPACE_NOT_ENABLED: { label: "自動承認未委任", group: "policy", description: "このWorkspaceには自動承認が委任されていません。" },
  AI_DATA_CONSENT_REQUIRED: { label: "AI利用同意", group: "policy", description: "WorkspaceのAIデータ利用同意が必要です。" },
  WORKSPACE_INACTIVE: { label: "Workspace非Active", group: "policy", description: "Workspaceが有効ではありません。" },
  PROJECT_INACTIVE: { label: "Project非Active", group: "policy", description: "Projectが有効ではありません。" },
  EVIDENCE_MISSING: { label: "Evidence不足", group: "evidence", description: "根拠データが不足しています。" },
  EVIDENCE_UNVERIFIABLE: { label: "Evidence未検証", group: "evidence", description: "根拠の内容・ハッシュ・コミットを確認できません。" },
  UNTRUSTED_OR_INCOMPLETE_INPUT: { label: "入力不完全", group: "security", description: "入力の切り詰め、生成ジョブの未完了、または安全性の警告があります。" },
  FINDING_CHANGED: { label: "Drift変更済み", group: "evidence", description: "Driftの状態または対象版が変更されています。" },
  CONTEXT_CHANGED: { label: "Context変更", group: "evidence", description: "評価中にルールや根拠が変更されました。" },
  MODEL_ARMOR_BLOCKED_OR_INCOMPLETE: { label: "Model Armor", group: "security", description: "Model Armorで警告、検査失敗、または検査スキップが発生しました。" },
  MODEL_ARMOR_BLOCKED: { label: "Model Armor Block", group: "security", description: "Model Armorの検査を通過していません。" },
  GEMINI_REQUIRES_HUMAN: { label: "Gemini要確認", group: "evaluation", description: "Geminiが低リスクでの採用に同意していません。" },
  JUDGE_SCORE_LOW: { label: "Judge score低", group: "evaluation", description: "Vertex AIの評価スコアが設定基準に達していません。" },
  GROUNDING_INSUFFICIENT: { label: "Grounding不足", group: "evaluation", description: "根拠への整合性またはその確信度が不足しています。" },
  GOOGLE_APPROVAL_NOT_CONFIGURED: { label: "Google設定不足", group: "system", description: "Googleの評価用設定が不足しています。" },
  GOOGLE_API_ERROR: { label: "Google APIエラー", group: "system", description: "Google APIがエラーを返しました。" },
  GOOGLE_API_UNAVAILABLE: { label: "Google API接続不可", group: "system", description: "Google APIへの接続または認証に失敗しました。" },
  EVALUATION_UNAVAILABLE: { label: "評価結果不足", group: "system", description: "必要な評価結果が揃っていません。" },
  EVALUATION_FAILED: { label: "評価失敗", group: "system", description: "評価処理に失敗しました。" },
  CONTEXT_UNAVAILABLE: { label: "Context取得不可", group: "system", description: "評価に必要なデータを読み取れませんでした。" },
  REVIEW_INPUT_TOO_LARGE: { label: "入力上限超過", group: "system", description: "入力が上限を超えています。根拠を省略して自動承認することはありません。" },
  CONTEXT_LIMIT_EXCEEDED: { label: "Context上限超過", group: "system", description: "関連ルールなどが安全に確認できる件数の上限を超えています。" },
  REVIEW_INTERRUPTED: { label: "評価中断", group: "system", description: "評価が中断されたため人間へ引き継ぎました。" },
  REVIEW_EXPIRED: { label: "評価期限切れ", group: "system", description: "評価結果の有効時間を超過しました。" },
  SHADOW_MODE: { label: "Shadow mode", group: "policy", description: "検証モードのため、評価結果に関係なく人間が承認します。" },
  MANUAL_MODE: { label: "Manual mode", group: "policy", description: "手動承認モードです。" },
  INVALID_PROVIDER_RESPONSE: { label: "Provider応答不正", group: "system", description: "評価APIの応答が不正です。" },
  INVALID_GEMINI_RESPONSE: { label: "Gemini応答不正", group: "system", description: "Geminiの応答を検証できません。" },
  GEMINI_BLOCKED: { label: "Gemini blocked", group: "security", description: "Geminiの安全性フィルタが応答を停止しました。" },
  GEMINI_INCOMPLETE: { label: "Gemini未完了", group: "system", description: "Geminiの応答が完了していません。" },
  INVALID_EVALUATION_RESPONSE: { label: "評価応答不正", group: "system", description: "Vertex AIの評価結果を検証できません。" },
  RELATED_RULE_VERSION_MISSING: { label: "関連Rule不足", group: "evidence", description: "関連ルールの現行版が見つかりません。" },
  INVALID_PROPOSAL: { label: "提案不正", group: "system", description: "提案の本文または理由が不正です。" },
  RULE_VERSION_MISMATCH: { label: "Version不整合", group: "evidence", description: "ルールと版の関連が一致しません。" },
  PROPOSAL_INACTIVE: { label: "提案非Active", group: "policy", description: "提案が有効ではありません。" },
};

export function getApprovalReasonLabel(code: string) {
  return reasonCatalog[code]?.label ?? code;
}

export function getApprovalReasonDescription(code: string) {
  return reasonCatalog[code]?.description ?? `確認理由: ${code}`;
}

export function getApprovalReasonGroup(code: string) {
  return reasonCatalog[code]?.group ?? "system";
}

function Score({ label, value }: { label: string; value: unknown }) {
  const score = toReviewScore(value);
  return <div className="reviewScore">
    <div className="reviewScoreHeader"><span>{label}</span><strong>{score == null ? "—" : score.toFixed(2)}</strong></div>
    <div className="reviewScoreTrack" aria-hidden="true"><span style={{ width: score == null ? "0%" : `${Math.round(score * 100)}%` }}/></div>
  </div>;
}

export function ApprovalReviewSummary(props: {
  version: { status?: unknown; approvedBy?: unknown; approvalReview?: unknown };
  workspaceId?: string;
}) {
  const review = props.version.approvalReview as Record<string, unknown> | undefined;
  if (!review) {
    return <div className="reviewEvaluationSummary reviewEvaluationPending">
      <p>自動評価結果はまだありません。手動承認モード、または評価開始前の提案です。</p>
    </div>;
  }

  const signals = review.signals as Record<string, unknown> | undefined;
  const codes = Array.isArray(review.reasonCodes) ? review.reasonCodes.map(String) : [];
  const humanApproved = props.version.status === "approved" && Boolean(props.version.approvedBy);

  return <div className="reviewEvaluationSummary" aria-label="自動評価結果">
    {codes.length > 0 && <div className="reviewReasonBlock">
      <span className="reviewSummaryLabel">人間確認になった理由</span>
      <div className="reviewReasonBadges">
        {codes.map((code) => <span className={`reviewReasonBadge ${getApprovalReasonGroup(code)}`} key={code}>{getApprovalReasonLabel(code)}</span>)}
      </div>
      <details className="reviewReasonDetails">
        <summary>確認理由の詳細</summary>
        <ul>{codes.map((code) => <li key={code}>{getApprovalReasonDescription(code)}</li>)}</ul>
      </details>
    </div>}

    {signals && <div className="reviewScores">
      <span className="reviewSummaryLabel">AI評価</span>
      <div className="reviewScoreGrid">
        <Score label="Judge score" value={signals.judgeScore}/>
        <Score label="Groundedness" value={signals.groundednessScore}/>
        <Score label="Confidence" value={signals.groundednessConfidence}/>
      </div>
    </div>}

    {review.wouldAutoApprove === true && review.mode === "shadow" && <div className="reviewShadowResult">
      <span>SHADOW RESULT</span>
      <strong>自動承認候補</strong>
      <p>現在は検証モードのため、実際の承認は人間に委ねられています。</p>
    </div>}

    {review.compilePending === true && <p className="reviewInlineNotice">生成ファイルの更新処理は送信待ちです。失敗した送信は再試行されます。</p>}
    {review.state === "auto_approved" && <p className="reviewInlineNotice">Rule DBの承認とGitHubへの反映は別です。Draft PRのマージは人間が行います。</p>}
    {humanApproved && <p className="reviewInlineNotice success">この版は人間によって承認済みです。</p>}
  </div>;
}
