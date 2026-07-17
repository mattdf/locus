import { ArrowUp, CornerDownLeft } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ModelPicker } from "./ModelPicker";
import { applyMarkdownShortcut, isSendShortcut, sendShortcutLabel } from "../lib/textarea";
import type { ReasoningEffort, SendShortcut } from "../types";

interface ComposerProps {
  onSend: (message: string) => void;
  disabled?: boolean;
  compact?: boolean;
  placeholder?: string;
  submitLabel?: string;
  initialValue?: string;
  insertion?: { id: string; value: string };
  onInsertionApplied?: (id: string) => void;
  model: string;
  onModelChange: (model: string) => void;
  reasoningEffort: ReasoningEffort;
  onReasoningEffortChange: (effort: ReasoningEffort) => void;
  sendShortcut: SendShortcut;
}

export function Composer({
  onSend,
  disabled,
  compact,
  placeholder = "Ask a follow-up…",
  submitLabel = "Send",
  initialValue = "",
  insertion,
  onInsertionApplied,
  model,
  onModelChange,
  reasoningEffort,
  onReasoningEffortChange,
  sendShortcut,
}: ComposerProps) {
  const [value, setValue] = useState(initialValue);
  const ref = useRef<HTMLTextAreaElement>(null);
  const pendingInsertionId = useRef<string | null>(null);

  useEffect(() => {
    if (initialValue) ref.current?.focus();
  }, [initialValue]);

  useEffect(() => {
    if (!insertion) return;
    pendingInsertionId.current = insertion.id;
    setValue((current) => {
      const separator = !current
        ? ""
        : current.endsWith("\n\n")
          ? ""
          : current.endsWith("\n")
            ? "\n"
            : "\n\n";
      return `${current}${separator}${insertion.value}`;
    });
  }, [insertion?.id]);

  useLayoutEffect(() => {
    const textarea = ref.current;
    if (!textarea) return;

    textarea.style.height = "auto";
    const configuredMaximum = Number.parseFloat(
      window.getComputedStyle(textarea).maxHeight,
    );
    const maximumHeight = Number.isFinite(configuredMaximum) ? configuredMaximum : 180;
    const contentHeight = textarea.scrollHeight;
    textarea.style.height = `${Math.min(contentHeight, maximumHeight)}px`;
    textarea.style.overflowY = contentHeight > maximumHeight ? "auto" : "hidden";

    const insertionId = pendingInsertionId.current;
    if (insertionId) {
      pendingInsertionId.current = null;
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      textarea.scrollTop = textarea.scrollHeight;
      onInsertionApplied?.(insertionId);
    }
  }, [compact, value]);

  const submit = () => {
    if (!value.trim() || disabled) return;
    onSend(value.trim());
    setValue("");
  };

  return (
    <div className={`composer ${compact ? "composer--compact" : ""}`}>
      <textarea
        ref={ref}
        rows={compact ? 3 : 2}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (applyMarkdownShortcut(event, value, setValue)) return;
          if (isSendShortcut(event, sendShortcut)) {
            event.preventDefault();
            submit();
          }
        }}
      />
      <div className="composer__footer">
        <ModelPicker
          className="composer__model-picker"
          value={model}
          onChange={onModelChange}
          reasoningEffort={reasoningEffort}
          onReasoningEffortChange={onReasoningEffortChange}
          ariaLabel="Model for the next response"
          reasoningAriaLabel="Reasoning effort for the next response"
        />
        <span className="composer__hint">
          <CornerDownLeft size={12} /> {sendShortcutLabel(sendShortcut)}
        </span>
        <button
          className="send-button"
          type="button"
          disabled={disabled || !value.trim()}
          aria-label={submitLabel}
          onClick={submit}
        >
          <ArrowUp size={16} />
        </button>
      </div>
    </div>
  );
}
