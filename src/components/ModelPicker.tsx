import { BrainCircuit, Sparkles } from "lucide-react";
import { useId } from "react";
import { providerLabel } from "../lib/providers";
import type {
  ProviderId,
  ProviderModelOption,
  ReasoningEffort,
} from "../types";

export const MODEL_OPTIONS = [
  { value: "gpt-5.6-sol", label: "GPT-5.6 Sol", note: "Frontier" },
  { value: "gpt-5.6-terra", label: "GPT-5.6 Terra", note: "Balanced" },
  { value: "gpt-5.4-mini", label: "GPT-5.4 mini", note: "Fast" },
  { value: "gpt-5.4", label: "GPT-5.4", note: "Deep" },
] as const;

const REASONING_OPTIONS: Array<{ value: ReasoningEffort; label: string }> = [
  { value: "none", label: "None" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra high" },
  { value: "max", label: "Max" },
];

interface ModelPickerProps {
  provider: ProviderId;
  modelOptions?: ProviderModelOption[];
  value: string;
  onChange: (model: string) => void;
  reasoningEffort: ReasoningEffort;
  onReasoningEffortChange: (effort: ReasoningEffort) => void;
  ariaLabel?: string;
  reasoningAriaLabel?: string;
  className?: string;
}

export function ModelPicker({
  provider,
  modelOptions = [],
  value,
  onChange,
  reasoningEffort,
  onReasoningEffortChange,
  ariaLabel = "Model",
  reasoningAriaLabel = "Reasoning effort",
  className = "",
}: ModelPickerProps) {
  const modelListId = useId();
  const supportsMax = provider !== "openai" || value.startsWith("gpt-5.6");
  return (
    <div className={`model-controls ${className}`.trim()}>
      <label className="model-picker">
        <Sparkles size={12} />
        <span>{provider === "openai" ? "Model" : providerLabel(provider)}</span>
        {provider === "openai" ? (
          <select
            aria-label={ariaLabel}
            value={value}
            onChange={(event) => onChange(event.target.value)}
          >
            {MODEL_OPTIONS.map((model) => (
              <option value={model.value} key={model.value}>
                {model.label} · {model.note}
              </option>
            ))}
          </select>
        ) : (
          <>
            <input
              aria-label={ariaLabel}
              value={value}
              onChange={(event) => onChange(event.target.value)}
              list={modelListId}
              placeholder={provider === "openrouter" ? "provider/model" : "Model ID"}
              spellCheck={false}
            />
            <datalist id={modelListId}>
              {modelOptions.map((model) => (
                <option value={model.id} key={model.id}>
                  {model.name ?? model.id}
                </option>
              ))}
            </datalist>
          </>
        )}
      </label>
      <label className="model-picker model-picker--reasoning">
        <BrainCircuit size={12} />
        <span>Reasoning</span>
        <select
          aria-label={reasoningAriaLabel}
          value={reasoningEffort}
          onChange={(event) =>
            onReasoningEffortChange(event.target.value as ReasoningEffort)
          }
        >
          {REASONING_OPTIONS.map((effort) => (
            <option
              value={effort.value}
              key={effort.value}
              disabled={effort.value === "max" && !supportsMax}
            >
              {effort.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
