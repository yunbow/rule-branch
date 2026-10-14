import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (relativePath: string) =>
  readFileSync(new URL(`../src/${relativePath}`, import.meta.url), "utf8");

test("shared native dialog is centered and constrained to the viewport", () => {
  const css = source("globals.css");
  const modalRule = css.match(/dialog\.appDialog\s*\{([^}]*)\}/s)?.[1];
  assert.ok(modalRule, "shared appDialog selector must exist");
  for (const declaration of [
    "position:fixed",
    "inset:auto",
    "top:50%",
    "left:50%",
    "transform:translate(-50%,-50%)",
    "max-height:calc(100dvh - 28px)",
    "overflow-y:auto",
  ]) {
    assert.ok(modalRule.includes(declaration), `missing modal declaration: ${declaration}`);
  }
  assert.match(css, /dialog\.appDialogWide\s*\{width:min\(900px/);
  assert.match(css, /dialog\.appDialog::backdrop/);
});

test("action dialogs use the shared accessible shell and grouped footer actions", () => {
  const files = [
    "domain/SupersedeDialog.tsx",
    "domain/DeprecateDialog.tsx",
    "domain/ArchiveDialog.tsx",
    "domain/RestoreDialog.tsx",
    "domain/ApproveDialog.tsx",
    "domain/RejectDialog.tsx",
    "domain/RepositoryAddDialog.tsx",
    "domain/PurgeRequestDialog.tsx",
    "domain/CandidateReviewPanel.tsx",
    "domain/ProposalGenerateButton.tsx",
    "domain/RecompileButton.tsx",
    "domain/RepositoryTable.tsx",
    "domain/FindingRow.tsx",
    "domain/RelationForm.tsx",
  ];
  for (const file of files) {
    const component = source(`components/${file}`);
    assert.match(component, /<ActionDialog/, `${file} must use the shared action dialog`);
    assert.match(component, /<DialogActions/, `${file} must use the shared dialog actions`);
  }
  const ui = source("components/ui/index.tsx");
  assert.match(ui, /<div className="dialogBody">/);
  assert.match(ui, /<h2 id=\{resolvedTitleId\}>\{title\}<\/h2>/);
  assert.match(ui, /className = "formActions"/);
  assert.match(ui, /disabled=\{loading \|\| confirmDisabled\}/);
});

test("large and specialized dialogs preserve their custom layouts", () => {
  const css = source("globals.css");
  assert.match(css, /\.dialogBody\{width:100%;min-width:0;padding:24px\}/);
  assert.match(css, /\.memberConfirmDialog\{width:100%;padding:24px\}/);
  assert.match(css, /\.inviteMemberDialog\{width:100%;padding:24px\}/);
  const metadata = source("components/domain/RuleMetaEditDialog.tsx");
  assert.match(metadata, /size="wide"/);
  assert.match(metadata, /<ActionDialog/);
  assert.match(source("components/domain/ApproveRejectDialog.tsx"), /className=\{"dialogBody approvalDecisionDialog/);
  assert.match(source("components/domain/ApproveRejectDialog.tsx"), /className="formActions approvalDecisionActions"/);
  assert.match(source("components/domain/MemberTable.tsx"), /className="memberDialogActions"/);
  assert.match(source("components/domain/InviteDialog.tsx"), /className="inviteDialogActions"/);
});
