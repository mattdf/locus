import { Check, LoaderCircle, Pencil, RotateCcw, Sparkles, Square, X } from "lucide-react";
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { normalizeMathDelimiters } from "../lib/markdown";
import { applyMarkdownShortcut } from "../lib/textarea";

export type SourceRewriteMode = "model" | "manual";

function MarkdownPreview({ source }: { source: string }) {
  return (
    <div className="source-rewrite-preview__markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { strict: false }], rehypeHighlight]}
      >
        {normalizeMathDelimiters(source, true)}
      </ReactMarkdown>
    </div>
  );
}

export function SourceRewriteModal({
  original,
  proposed,
  initialMode,
  wholeDocument,
  model,
  generating,
  error,
  reviewCount,
  onGenerate,
  onStop,
  onApprove,
  onDismiss,
}: {
  original: string;
  proposed: string | null;
  initialMode: SourceRewriteMode;
  wholeDocument: boolean;
  model: string;
  generating: boolean;
  error: string;
  reviewCount: number;
  onGenerate: (mode: SourceRewriteMode, value: string) => void;
  onStop: () => void;
  onApprove: () => void;
  onDismiss: () => void;
}) {
  const [mode, setMode] = useState<SourceRewriteMode>(initialMode);
  const [hint, setHint] = useState("");
  const [manualSource, setManualSource] = useState(original);

  useEffect(() => {
    setMode(initialMode);
    setHint("");
    setManualSource(original);
  }, [initialMode, original]);

  return (
    <div className="source-rewrite-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !generating) onDismiss();
    }}>
      <section className="source-rewrite-modal" role="dialog" aria-modal="true" aria-labelledby="source-rewrite-title">
        <header>
          <div>
            <span>{wholeDocument ? "Imported source" : "Selected Markdown blocks"}</span>
            <h2 id="source-rewrite-title">{wholeDocument ? "Edit source" : "Rewrite selection"}</h2>
          </div>
          <button type="button" aria-label="Close rewrite" disabled={generating} onClick={onDismiss}>
            <X size={16} />
          </button>
        </header>

        {!proposed && (
          <>
            {!wholeDocument && (
              <div className="source-rewrite-modes" role="tablist" aria-label="Rewrite method">
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === "model"}
                  className={mode === "model" ? "active" : ""}
                  disabled={generating}
                  onClick={() => setMode("model")}
                >
                  <Sparkles size={14} /> Prompt model
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === "manual"}
                  className={mode === "manual" ? "active" : ""}
                  disabled={generating}
                  onClick={() => setMode("manual")}
                >
                  <Pencil size={14} /> Edit raw Markdown
                </button>
              </div>
            )}

            {mode === "model" && !wholeDocument ? (
              <div className="source-rewrite-input">
                <label htmlFor="source-rewrite-hint">Rewrite instruction</label>
                <textarea
                  id="source-rewrite-hint"
                  autoFocus
                  value={hint}
                  disabled={generating}
                  placeholder="For example: make this derivation clearer while preserving its notation."
                  onChange={(event) => setHint(event.target.value)}
                  onKeyDown={(event) => applyMarkdownShortcut(event, hint, setHint)}
                />
                <p>The complete containing Markdown block is rewritten with {model}; the rest of the document is not sent for replacement.</p>
              </div>
            ) : (
              <div className="source-rewrite-input source-rewrite-input--manual">
                <label htmlFor="source-rewrite-markdown">Raw Markdown</label>
                <textarea
                  id="source-rewrite-markdown"
                  autoFocus
                  value={manualSource}
                  disabled={generating}
                  onChange={(event) => setManualSource(event.target.value)}
                  onKeyDown={(event) => applyMarkdownShortcut(event, manualSource, setManualSource)}
                />
                {!wholeDocument && <p>The editor includes the complete containing block so partial Markdown syntax is not left behind.</p>}
              </div>
            )}

            <details className="source-rewrite-original">
              <summary>Original rendered section</summary>
              <MarkdownPreview source={original} />
            </details>
          </>
        )}

        {proposed !== null && (
          <div className="source-rewrite-preview">
            <section>
              <h3>Before</h3>
              <MarkdownPreview source={original} />
            </section>
            <section>
              <h3>After</h3>
              <MarkdownPreview source={proposed} />
            </section>
          </div>
        )}

        {error && <p className="source-rewrite-error">{error}</p>}
        {proposed !== null && reviewCount > 0 && (
          <p className="source-rewrite-warning">
            {reviewCount} annotation{reviewCount === 1 ? "" : "s"} changed with this section and
            were position-mapped through the edit. Their content is preserved; check their
            highlighted placement after approval while the one-click revert remains available.
          </p>
        )}

        <footer>
          {generating ? (
            <>
              <span><LoaderCircle className="spin" size={14} /> Rewriting…</span>
              <button type="button" onClick={onStop}><Square size={11} fill="currentColor" /> Stop</button>
            </>
          ) : proposed !== null ? (
            <>
              <button type="button" onClick={onDismiss}><RotateCcw size={14} /> Revert</button>
              <button className="primary-button" type="button" onClick={onApprove}><Check size={14} /> Approve rewrite</button>
            </>
          ) : (
            <>
              <button type="button" onClick={onDismiss}>Cancel</button>
              <button
                className="primary-button"
                type="button"
                disabled={mode === "model" ? !hint.trim() : manualSource === original}
                onClick={() => onGenerate(mode, mode === "model" ? hint.trim() : manualSource)}
              >
                {mode === "model" ? <Sparkles size={14} /> : <Pencil size={14} />}
                Preview
              </button>
            </>
          )}
        </footer>
      </section>
    </div>
  );
}
