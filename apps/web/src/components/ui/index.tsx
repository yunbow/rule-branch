"use client";

import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { X } from "lucide-react";
import { getStatusLabel, type BadgeTone } from "../../lib/labels.ts";
import { getErrorMessage } from "../../lib/messages.ts";
import { isTagCommitKey, removeTagValue, resolveTagAddition } from "../../lib/tag-input.ts";
import "./tag-input.css";
import { Button as ShadcnButton } from "./Button.tsx";
import { Card as ShadcnCard } from "./Card.tsx";
import { Badge as ShadcnBadge } from "./Badge.tsx";

export function Button({
  variant = "primary",
  loading,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger" | "ghost";
  loading?: boolean;
}) {
  const mappedVariant = {
    primary: "default",
    secondary: "secondary",
    danger: "destructive",
    ghost: "ghost",
  } as const;
  return (
    <ShadcnButton variant={mappedVariant[variant]} disabled={loading || props.disabled} {...props}>
      {loading ? "処理中…" : children}
    </ShadcnButton>
  );
}

export function Badge({ tone = "gray", children }: { tone?: BadgeTone; children: ReactNode }) {
  const mappedTone = {
    gray: "default",
    green: "success",
    amber: "warning",
    blue: "info",
    red: "destructive",
    outline: "outline",
    "gray-outline": "outline",
    "red-outline": "destructiveOutline",
    spinner: "processing",
  } as const;
  return <ShadcnBadge variant={mappedTone[tone]}>{children}</ShadcnBadge>;
}

export function StatusBadge({ kind, value }: { kind: string; value: string }) {
  const status = getStatusLabel(kind, value);
  return <Badge tone={status.tone}>{status.label}</Badge>;
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <ShadcnCard className={className}>{children}</ShadcnCard>;
}

export function Table({ children, empty }: { children: ReactNode; empty?: ReactNode }) {
  return (
    <div className="tableWrap">
      <table>{children}</table>
      {empty}
    </div>
  );
}

export function Dialog({
  open,
  onClose,
  children,
  labelledBy,
  describedBy,
  size = "default",
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  labelledBy?: string;
  describedBy?: string;
  size?: "default" | "wide";
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      className={size === "wide" ? "appDialog appDialogWide" : "appDialog"}
      ref={ref}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={onClose}
    >
      {children}
    </dialog>
  );
}

export function ActionDialog({
  open,
  onClose,
  title,
  children,
  actions,
  error,
  size = "default",
  titleId,
  describedBy,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  error?: string | null;
  size?: "default" | "wide";
  titleId?: string;
  describedBy?: string;
}) {
  const generatedTitleId = useId();
  const resolvedTitleId = titleId ?? generatedTitleId;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      labelledBy={resolvedTitleId}
      describedBy={describedBy}
      size={size}
    >
      <div className="dialogBody">
        <h2 id={resolvedTitleId}>{title}</h2>
        {children}
        {error && <ErrorBanner code={error}/>}
        {actions}
      </div>
    </Dialog>
  );
}

export function DialogActions({
  onCancel,
  onConfirm,
  confirmLabel,
  cancelLabel = "キャンセル",
  loading = false,
  confirmDisabled = false,
  cancelDisabled,
  confirmVariant = "primary",
  cancelVariant = "secondary",
  confirmType = "button",
  className = "formActions",
}: {
  onCancel?: () => void;
  onConfirm?: () => void;
  confirmLabel: ReactNode;
  cancelLabel?: ReactNode;
  loading?: boolean;
  confirmDisabled?: boolean;
  cancelDisabled?: boolean;
  confirmVariant?: "primary" | "secondary" | "danger" | "ghost";
  cancelVariant?: "primary" | "secondary" | "danger" | "ghost";
  confirmType?: "button" | "submit";
  className?: string;
}) {
  return (
    <div className={className}>
      {onCancel && (
        <Button
          type="button"
          variant={cancelVariant}
          disabled={cancelDisabled ?? loading}
          onClick={onCancel}
        >
          {cancelLabel}
        </Button>
      )}
      <Button
        type={confirmType}
        variant={confirmVariant}
        loading={loading}
        disabled={loading || confirmDisabled}
        onClick={onConfirm}
      >
        {confirmLabel}
      </Button>
    </div>
  );
}

export function TextField({
  label,
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  const id = props.id ?? props.name;
  return (
    <label className="formField">
      <span>{label}</span>
      <input id={id} className={["formControl", className].filter(Boolean).join(" ")} {...props} />
    </label>
  );
}

export function TextArea({
  label,
  className,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string }) {
  const [localValue, setValue] = useState(String(props.defaultValue ?? ""));
  const value = props.value !== undefined ? String(props.value ?? "") : localValue;
  return (
    <label className="formField">
      <span>{label}</span>
      <textarea
        {...props}
        className={["formControl", className].filter(Boolean).join(" ")}
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          props.onChange?.(event);
        }}
      />
      <small className="formHint">{new TextEncoder().encode(value).length} bytes</small>
    </label>
  );
}

export function Select({
  label,
  children,
  className,
  ...props
}: { label: string; children: ReactNode } & SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <label className="formField">
      <span>{label}</span>
      <select className={["formControl", className].filter(Boolean).join(" ")} {...props}>
        {children}
      </select>
    </label>
  );
}

export function TagInput({
  value = [],
  onChange,
  label,
  inputLabel = "タグを入力",
  onDraftChange,
  placeholder = "入力して追加",
  maxItems,
  caseSensitive = false,
  showAddButton = false,
  variant = "default",
  commitKeys = ["Enter"],
  commitOnBlur = false,
  inputMaxLength,
}: {
  value?: string[];
  onChange?: (value: string[]) => void;
  label?: string;
  inputLabel?: string;
  onDraftChange?: (draft: string) => void;
  placeholder?: string;
  maxItems?: number;
  caseSensitive?: boolean;
  showAddButton?: boolean;
  variant?: "default" | "inline";
  commitKeys?: readonly string[];
  commitOnBlur?: boolean;
  inputMaxLength?: number;
}) {
  const [text, setText] = useState("");
  const inputId = useId();
  const inline = variant === "inline";
  const atLimit = maxItems !== undefined && value.length >= maxItems;
  const updateText = (next: string) => {
    setText(next);
    onDraftChange?.(next);
  };
  const addTag = () => {
    if (!text.trim()) return;
    const addition = resolveTagAddition(value, text, { maxItems, caseSensitive });
    if (addition.outcome === "limit" && !inline) return;
    if (addition.outcome === "added") onChange?.(addition.value);
    updateText("");
  };
  const inputHandlers = {
    id: inputId,
    value: text,
    maxLength: inputMaxLength,
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => updateText(event.target.value),
    onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (!isTagCommitKey(event.key, event.nativeEvent.isComposing, commitKeys)) return;
      event.preventDefault();
      addTag();
    },
    onBlur: () => { if (commitOnBlur && text.trim()) addTag(); },
  };
  if (inline) {
    return (
      <div className="tagInputInlineField">
        {label && <label htmlFor={inputId}>{label}</label>}
        <div className="tagInputInlineEditor">
          {value.map((item) =>
            <span className="tagInputInlineChip" key={item}>
              {item}
              <button type="button" aria-label={`${label ?? "タグ"}「${item}」を削除`}
                onClick={() => onChange?.(removeTagValue(value, item))}>
                <X size={13} aria-hidden="true"/>
              </button>
            </span>,
          )}
          <input {...inputHandlers} type="text" aria-label={label ? undefined : inputLabel}
            disabled={atLimit}
            placeholder={atLimit ? "上限に達しました" : placeholder}
          />
        </div>
        {maxItems !== undefined &&
          <small className="formHint">{value.length}/{maxItems}件。タグは右の×で削除できます。</small>}
      </div>
    );
  }
  return (
    <div className="tagInput">
      {label && <label htmlFor={inputId}>{label}</label>}
      <div className="tagInputChips">{value.map((item) =>
        <span className="tagInputChip" key={item}>
          {item}
          <button type="button" aria-label={"タグ「" + item + "」を削除"}
            onClick={() => onChange?.(removeTagValue(value, item))}>×</button>
        </span>,
      )}</div>
      <div className="tagInputEntry">
        <input {...inputHandlers} className="formControl" aria-label={label ? undefined : inputLabel} placeholder={placeholder}/>
        {showAddButton && <button type="button" className="button secondary tagInputAddButton"
          disabled={!text.trim() || atLimit} onClick={addTag}>追加</button>}
      </div>
      {atLimit
        ? <small className="formHint" role="status">登録上限の {maxItems}件に達しています。追加する場合は既存の項目を解除してください。</small>
        : text.trim()
          ? <small className="formHint" role="status">入力中です。{showAddButton ? "Enterまたは「追加」" : "Enter"}で登録してください。</small>
        : <small className="formHint">{showAddButton ? "Enterまたは「追加」" : "Enter"}で登録・×で解除できます。</small>}
    </div>
  );
}

export function Checkbox({ label, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return (
    <label className="choiceField">
      <input type="checkbox" {...props} />
      <span>{label}</span>
    </label>
  );
}

export function Radio({
  label,
  description,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; description?: string }) {
  return (
    <label className="choiceField">
      <input type="radio" {...props} />
      <span>
        {label}
        {description && <small>{description}</small>}
      </span>
    </label>
  );
}

type ToastItem = { id: number; message: string };
const ToastContext = createContext<{ add: (message: string) => void }>({ add: () => {} });

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const add = (message: string) => {
    const id = Date.now();
    setItems((current) => [...current, { id, message }]);
    setTimeout(() => setItems((current) => current.filter((item) => item.id !== id)), 4000);
  };
  return (
    <ToastContext.Provider value={{ add }}>
      {children}
      <div className="toasts" aria-live="polite">
        {items.map((item) => <div className="toast" key={item.id}>{item.message}</div>)}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

export function ErrorBanner({ code, details }: { code: string; details?: unknown }) {
  return (
    <p role="alert" className="error formError">
      {getErrorMessage(code)}
      {details ? ` ${String(details)}` : ""}
    </p>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="emptyState">{children}</div>;
}

export function Tabs({ tabs }: { tabs: { id: string; label: string; content: ReactNode }[] }) {
  const [id, setId] = useState(tabs[0]?.id);
  const tab = tabs.find((item) => item.id === id);
  return (
    <div>
      <div className="segmentedTabs" role="tablist">
        {tabs.map((item) => (
          <Button
            type="button"
            variant="ghost"
            className={item.id === id ? "active" : ""}
            aria-selected={item.id === id}
            key={item.id}
            onClick={() => setId(item.id)}
          >
            {item.label}
          </Button>
        ))}
      </div>
      {tab?.content}
    </div>
  );
}

export function Popover({ children, open }: { children: ReactNode; open?: boolean }) {
  return (
    <details className="popover" open={open}>
      <summary>詳細</summary>
      {children}
    </details>
  );
}

export function Spinner({ ariaLabel = "読み込み中" }: { ariaLabel?: string }) {
  return <span aria-label={ariaLabel} className="spinner" />;
}

export function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown">
      {children.split("\n").map((line, index) =>
        line.startsWith("### ") ? <h3 key={index}>{line.slice(4)}</h3> :
        line.startsWith("## ") ? <h2 key={index}>{line.slice(3)}</h2> :
        line.startsWith("# ") ? <h1 key={index}>{line.slice(2)}</h1> :
        line.startsWith("- ") ? <li key={index}>{line.slice(2)}</li> :
        line.startsWith("```") ? <code key={index}>{line.slice(3)}</code> :
        <p key={index}>{line}</p>,
      )}
    </div>
  );
}
