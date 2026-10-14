"use client";

import { useId, useState } from "react";
import { CircleCheck, CircleX } from "lucide-react";
import { AI_PROPOSAL_NOTICE } from "../../lib/messages.ts";
import { isApproveRejectValid, type ApproveRejectMode } from "../../lib/approve-reject.ts";
import { Dialog, DialogActions, ErrorBanner, TextArea } from "../ui/index.tsx";
import "./approve-reject-dialog.css";

export { isApproveRejectValid, type ApproveRejectMode } from "../../lib/approve-reject.ts";

export function ApproveRejectDialog({
  mode,
  open,
  loading,
  error,
  onClose,
  onSubmit,
}: {
  mode: ApproveRejectMode;
  open: boolean;
  loading: boolean;
  error?: string | null;
  onClose: () => void;
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = useState("");
  const titleId = useId();
  const descriptionId = useId();
  const approving = mode === "approve";
  const valid = isApproveRejectValid(mode, value);
  const close = () => {
    if (!loading) onClose();
  };

  return <Dialog open={open} onClose={close} labelledBy={titleId} describedBy={descriptionId}>
    <div className={"dialogBody approvalDecisionDialog " + (approving ? "isApproval" : "isRejection")}>
      <div className="approvalDecisionHeader">
        <span className="approvalDecisionIcon" aria-hidden="true">
          {approving ? <CircleCheck size={22}/> : <CircleX size={22}/>}
        </span>
        <div className="approvalDecisionHeaderCopy">
          <span className="approvalDecisionEyebrow">ルールのレビュー</span>
          <h2 id={titleId}>{approving ? "候補を承認" : "この版のみ却下"}</h2>
        </div>
      </div>

      <p id={descriptionId} className="approvalDecisionDescription">
        {approving
          ? "承認すると、このバージョンを人間の判断として確定します。"
          : "このバージョンを却下します。判断した理由を記録してください。"}
      </p>

      <div className={"noticeBanner approvalDecisionNotice" + (approving ? "" : " warning")} role="note">
        {approving ? AI_PROPOSAL_NOTICE : "却下すると、関連するDriftは未処理に戻ります。"}
      </div>

      <div className="approvalDecisionField">
        <TextArea
          label={approving ? "コメント（任意）" : "却下理由"}
          aria-required={!approving}
          required={!approving}
          rows={4}
          value={value}
          placeholder={approving ? "判断の補足があれば入力してください" : "却下する理由を入力してください"}
          onChange={(event) => setValue(event.target.value)}
        />
      </div>

      {error && <ErrorBanner code={error}/>}
      <DialogActions
        className="formActions approvalDecisionActions"
        onCancel={close}
        onConfirm={() => {
          if (!loading && valid) onSubmit(value);
        }}
        confirmLabel={approving ? "承認" : "却下"}
        confirmVariant={approving ? "primary" : "danger"}
        loading={loading}
        confirmDisabled={!valid}
      />
    </div>
  </Dialog>;
}
