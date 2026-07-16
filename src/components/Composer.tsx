import { ArrowUp, CornerDownLeft } from "lucide-react";
import { useEffect, useRef, useState } from "react";

interface ComposerProps {
  onSend: (message: string) => void;
  disabled?: boolean;
  compact?: boolean;
  placeholder?: string;
  submitLabel?: string;
  initialValue?: string;
  insertion?: { id: string; value: string };
  onInsertionApplied?: (id: string) => void;
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
}: ComposerProps) {
  const [value, setValue] = useState(initialValue);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (initialValue) ref.current?.focus();
  }, [initialValue]);

  useEffect(() => {
    if (!insertion) return;
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
    const frame = window.requestAnimationFrame(() => {
      const textarea = ref.current;
      if (textarea) {
        textarea.focus();
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      }
      onInsertionApplied?.(insertion.id);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [insertion?.id]);

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
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
        }}
      />
      <div className="composer__footer">
        <span className="composer__hint">
          <CornerDownLeft size={12} /> Enter to send
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
