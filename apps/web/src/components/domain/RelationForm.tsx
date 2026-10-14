"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ApiError, apiFetch } from "../../lib/api-client.ts";
import {
  childRelationRules,
  parentRelationRules,
  relationRationaleError,
  type RelationRule,
  type RelationType,
} from "../../lib/relation-form.ts";
import { canWrite, type WorkspaceKind, type WorkspaceRole } from "../../shared/permissions.ts";
import { ActionDialog, Button, DialogActions, ErrorBanner, Select, TextArea, TextField } from "../ui/index.tsx";

type RuleOption = RelationRule & { projectName?: string };

export function RelationForm({
  workspaceId,
  rules,
  workspaceKind,
  role,
}: {
  workspaceId: string;
  rules: RuleOption[];
  workspaceKind: WorkspaceKind;
  role: WorkspaceRole;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [parentRuleId, setParentRuleId] = useState("");
  const [childRuleId, setChildRuleId] = useState("");
  const [relationType, setRelationType] = useState<RelationType>("override");
  const [rationale, setRationale] = useState("");
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const writable = canWrite(workspaceKind, role);
  const matches = (rule: RuleOption) =>
    !query || `${rule.title} ${rule.projectName ?? ""}`.toLocaleLowerCase().includes(query.toLocaleLowerCase());
  const parents = parentRelationRules(rules).filter(matches);
  const children = childRelationRules(rules).filter(matches);

  const close = () => {
    if (!loading) {
      setOpen(false);
      setError(null);
    }
  };
  const submit = async () => {
    const validationError = relationRationaleError(relationType, rationale);
    if (!parentRuleId || !childRuleId) { setError("INVALID_RULE_ID"); return; }
    if (validationError) { setError(validationError); return; }
    setLoading(true);
    setError(null);
    try {
      await apiFetch("/api/rule-relations", {
        method: "POST",
        workspaceId,
        body: {
          parentRuleId,
          childRuleId,
          relationType,
          rationale: relationType === "deny" ? rationale : null,
        },
      });
      setOpen(false);
      setParentRuleId("");
      setChildRuleId("");
      setRationale("");
      router.refresh();
    } catch (reason) {
      setError(
        reason instanceof ApiError && reason.code === "UNIQUE_VIOLATION"
          ? "RELATION_DUPLICATE"
          : reason instanceof ApiError ? reason.code : "INTERNAL_ERROR",
      );
    } finally {
      setLoading(false);
    }
  };

  if (!writable) return null;

  return <>
    <Button type="button" onClick={() => setOpen(true)}>関係を作成</Button>
    {open && <ActionDialog
      open={open}
      onClose={close}
      title="ルールの関係を作成"
      actions={<DialogActions
        onCancel={close}
        onConfirm={() => void submit()}
        confirmLabel="関係を作成"
        loading={loading}
        confirmDisabled={!parentRuleId || !childRuleId || Boolean(relationRationaleError(relationType, rationale))}
        cancelVariant="ghost"
      />}
    >
      <p>親ルールと子ルールを選択し、適用関係を定義します。</p>
      <div className="formStack">
        <TextField label="ルールを検索" value={query} onChange={(event) => setQuery(event.target.value)}/>
        <Select label="親ルール" value={parentRuleId} onChange={(event) => setParentRuleId(event.target.value)}>
          <option value="">選択してください</option>
          {parents.map((rule) => <option key={rule.id} value={rule.id}>{rule.title}</option>)}
        </Select>
        <Select label="子ルール" value={childRuleId} onChange={(event) => setChildRuleId(event.target.value)}>
          <option value="">選択してください</option>
          {children.map((rule) =>
            <option key={rule.id} value={rule.id}>{rule.title}{rule.projectName ? ` (${rule.projectName})` : ""}</option>
          )}
        </Select>
        <Select
          label="関係の種類"
          value={relationType}
          onChange={(event) => setRelationType(event.target.value as RelationType)}
        >
          <option value="override">置換</option>
          <option value="extend">追加（強化）</option>
          <option value="deny">不適用</option>
        </Select>
        {relationType === "deny" && <TextArea
          label="不適用にする理由"
          value={rationale}
          maxLength={2000}
          required
          aria-required="true"
          onChange={(event) => setRationale(event.target.value)}
        />}
        {error && <ErrorBanner code={error}/>}
      </div>
    </ActionDialog>}
  </>;
}
