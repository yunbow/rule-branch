import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { Children, createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const runtimeRequire = createRequire(import.meta.url);

function loadUiModule(): Record<string, (...args: never[]) => unknown> {
  const filename = new URL("../src/components/ui/index.tsx", import.meta.url);
  const source = readFileSync(filename, "utf8");
  const compiled = ts.transpileModule(source, {
    fileName: filename.pathname,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  }).outputText;
  const Button = (props: Record<string, unknown>) => createElement("button", props);
  const module = { exports: {} as Record<string, (...args: never[]) => unknown> };
  const localRequire = (id: string) => {
    if (id === "react" || id === "react/jsx-runtime") return runtimeRequire(id);
    if (id === "lucide-react") return { X: () => null };
    if (id === "../../lib/labels.ts") {
      return { getStatusLabel: (_kind: string, value: string) => ({ label: value, tone: "gray" }) };
    }
    if (id === "../../lib/messages.ts") return { getErrorMessage: (code: string) => `message:${code}` };
    if (id === "../../lib/tag-input.ts") {
      return { isTagCommitKey: () => false, removeTagValue: () => [], resolveTagAddition: () => ({ value: [] }) };
    }
    if (id === "./tag-input.css") return {};
    if (id === "./Button.tsx") return { Button };
    if (id === "./Card.tsx") return { Card: ({ children }: { children?: ReactNode }) => createElement("section", null, children) };
    if (id === "./Badge.tsx") return { Badge: ({ children }: { children?: ReactNode }) => createElement("span", null, children) };
    throw new Error(`Unexpected UI dependency: ${id}`);
  };
  new Function("require", "module", "exports", compiled)(localRequire, module, module.exports);
  return module.exports;
}

const ui = loadUiModule();
const ActionDialog = ui.ActionDialog as unknown as (props: Record<string, unknown>) => ReactNode;
const DialogActions = ui.DialogActions as unknown as (props: Record<string, unknown>) => {
  props: { className: string; children: ReactNode };
};

test("DialogActions disables both actions while pending and keeps callbacks and variants", () => {
  let cancelled = 0;
  let confirmed = 0;
  const result = DialogActions({
    onCancel: () => { cancelled += 1; },
    onConfirm: () => { confirmed += 1; },
    confirmLabel: "削除",
    confirmVariant: "danger",
    loading: true,
  });
  const [cancel, confirm] = Children.toArray(result.props.children) as Array<{
    props: Record<string, unknown>;
  }>;

  assert.equal(result.props.className, "formActions");
  assert.equal(cancel.props.disabled, true);
  assert.equal(cancel.props.variant, "secondary");
  assert.equal(confirm.props.disabled, true);
  assert.equal(confirm.props.loading, true);
  assert.equal(confirm.props.variant, "danger");
  (cancel.props.onClick as () => void)();
  (confirm.props.onClick as () => void)();
  assert.deepEqual({ cancelled, confirmed }, { cancelled: 1, confirmed: 1 });
});

test("DialogActions preserves cancel overrides and validation and submit guards", () => {
  const result = DialogActions({
    className: "inviteDialogActions",
    onCancel: () => {},
    confirmLabel: "招待を送信",
    confirmType: "submit",
    loading: true,
    cancelDisabled: false,
    confirmDisabled: false,
  });
  const [cancel, confirm] = Children.toArray(result.props.children) as Array<{
    props: Record<string, unknown>;
  }>;

  assert.equal(result.props.className, "inviteDialogActions");
  assert.equal(cancel.props.disabled, false);
  assert.equal(confirm.props.type, "submit");
  assert.equal(confirm.props.disabled, true);

  const validation = DialogActions({
    onCancel: () => {},
    confirmLabel: "復活",
    confirmDisabled: true,
  });
  const validationButtons = Children.toArray(validation.props.children) as Array<{
    props: Record<string, unknown>;
  }>;
  assert.equal(validationButtons[0].props.disabled, false);
  assert.equal(validationButtons[1].props.disabled, true);
});

test("ActionDialog connects its title and renders content, localized error, then actions", () => {
  const html = renderToStaticMarkup(createElement(ActionDialog, {
    open: true,
    onClose: () => {},
    title: "確認タイトル",
    error: "FAILED",
    children: createElement("p", null, "説明"),
    actions: createElement("span", { "data-actions": true }, "操作"),
  }));
  const labelledBy = html.match(/aria-labelledby="([^"]+)"/)?.[1];

  assert.ok(labelledBy);
  assert.match(html, new RegExp(`<h2 id="${labelledBy}">確認タイトル</h2>`));
  assert.match(html, /class="dialogBody"/);
  assert.match(html, /role="alert" class="error formError">message:FAILED/);
  assert.ok(html.indexOf("説明") < html.indexOf("message:FAILED"));
  assert.ok(html.indexOf("message:FAILED") < html.indexOf("data-actions"));
});
