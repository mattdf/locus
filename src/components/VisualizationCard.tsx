import {
  Check,
  Code2,
  Download,
  Image as ImageIcon,
  LoaderCircle,
  Maximize2,
  Pencil,
  Play,
  RotateCcw,
  Square,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { formatDuration, generationDetails } from "../lib/generation";
import { applyMarkdownShortcut, isSendShortcut } from "../lib/textarea";
import type { InlineVisualization, SendShortcut } from "../types";
import { MathBlock } from "./MathText";

interface VisualizationCardProps {
  visualization: InlineVisualization;
  sendShortcut: SendShortcut;
  onGenerate: (visualizationId: string, hint: string) => void;
  onFix: (visualizationId: string, instruction: string) => void;
  onCompile: (visualizationId: string, source: string) => void;
  onStop: (visualizationId: string) => void;
  onDelete: (visualizationId: string) => void;
  readOnly?: boolean;
}

function downloadText(contents: string, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function WorkingStatus({ label, startedAt }: { label: string; startedAt: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <span className="visualization-card__working">
      <LoaderCircle size={13} /> {label} · {formatDuration(Math.max(0, now - Date.parse(startedAt)))}
    </span>
  );
}

export function VisualizationCard({
  visualization,
  sendShortcut,
  onGenerate,
  onFix,
  onCompile,
  onStop,
  onDelete,
  readOnly = false,
}: VisualizationCardProps) {
  const [hint, setHint] = useState(visualization.hint);
  const [source, setSource] = useState(visualization.metapostSource ?? "");
  const [editingSource, setEditingSource] = useState(false);
  const [fixing, setFixing] = useState(false);
  const [fixInstruction, setFixInstruction] = useState("");
  const [showLog, setShowLog] = useState(false);
  const [copied, setCopied] = useState(false);
  const [enlarged, setEnlarged] = useState(false);
  const hintRef = useRef<HTMLTextAreaElement>(null);
  const fixInstructionRef = useRef<HTMLTextAreaElement>(null);
  const enlargeButtonRef = useRef<HTMLButtonElement>(null);
  const closeEnlargedButtonRef = useRef<HTMLButtonElement>(null);
  const svgUrl = useMemo(
    () =>
      visualization.svg
        ? URL.createObjectURL(new Blob([visualization.svg], { type: "image/svg+xml" }))
        : null,
    [visualization.svg],
  );

  useEffect(() => () => {
    if (svgUrl) URL.revokeObjectURL(svgUrl);
  }, [svgUrl]);
  useEffect(() => setHint(visualization.hint), [visualization.id, visualization.hint]);
  useEffect(() => setSource(visualization.metapostSource ?? ""), [visualization.id, visualization.metapostSource]);
  useLayoutEffect(() => {
    if (visualization.status === "draft") {
      hintRef.current?.focus({ preventScroll: true });
    }
  }, [visualization.id, visualization.status]);
  useLayoutEffect(() => {
    if (enlarged) closeEnlargedButtonRef.current?.focus({ preventScroll: true });
  }, [enlarged]);
  useLayoutEffect(() => {
    if (fixing) fixInstructionRef.current?.focus({ preventScroll: true });
  }, [fixing]);
  useEffect(() => {
    if (!enlarged) return;
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setEnlarged(false);
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
      enlargeButtonRef.current?.focus({ preventScroll: true });
    };
  }, [enlarged]);

  const busy = visualization.status === "generating" || visualization.status === "compiling";
  const generate = () => onGenerate(visualization.id, hint.trim());
  const applyFix = () => {
    const instruction = fixInstruction.trim();
    if (!instruction) return;
    onFix(visualization.id, instruction);
    setFixing(false);
    setFixInstruction("");
  };
  const compile = () => {
    if (!source.trim()) return;
    onCompile(visualization.id, source.trim());
    setEditingSource(false);
  };

  return (
    <section
      className={`visualization-card visualization-card--${visualization.status}`}
      data-visualization-id={visualization.id}
      aria-label="Inline equation visualization"
    >
      <header>
        <span><ImageIcon size={14} /> MetaPost visualization</span>
        <div>
          {visualization.svg && svgUrl && !editingSource && (
            <button
              ref={enlargeButtonRef}
              type="button"
              aria-label="Enlarge visualization"
              title="Enlarge visualization"
              onClick={() => setEnlarged(true)}
            >
              <Maximize2 size={13} />
            </button>
          )}
          {!readOnly && visualization.metapostSource && !busy && (
            <button
              type="button"
              aria-label={fixing ? "Close visualization fix instructions" : "Fix visualization with AI"}
              title={fixing ? "Close fix instructions" : "Fix with AI"}
              onClick={() => {
                setEditingSource(false);
                setFixing((open) => !open);
              }}
            >
              {fixing ? <X size={13} /> : <><Wrench size={12} /> Fix</>}
            </button>
          )}
          {!readOnly && visualization.metapostSource && !busy && (
            <button
              type="button"
              aria-label={editingSource ? "Close MetaPost source editor" : "Edit MetaPost source"}
              title={editingSource ? "Close source editor" : "Edit source"}
              onClick={() => {
                setFixing(false);
                setEditingSource((open) => !open);
              }}
            >
              {editingSource ? <X size={13} /> : <Pencil size={13} />}
            </button>
          )}
          {!readOnly && <button
            type="button"
            aria-label="Delete visualization"
            title="Delete visualization"
            disabled={busy}
            onClick={() => onDelete(visualization.id)}
          >
            <Trash2 size={13} />
          </button>}
        </div>
      </header>

      <details className="visualization-card__selection">
        <summary>Visualizing this selection</summary>
        <MathBlock source={visualization.anchor.quote} />
      </details>

      {!readOnly && fixing && !busy && (
        <div className="visualization-card__fix">
          <label htmlFor={`visualization-fix-${visualization.id}`}>What should change?</label>
          <textarea
            ref={fixInstructionRef}
            id={`visualization-fix-${visualization.id}`}
            rows={3}
            value={fixInstruction}
            placeholder="e.g. Move the obscured equation above the diagram and make the labels clearer…"
            onChange={(event) => setFixInstruction(event.target.value)}
            onKeyDown={(event) => {
              if (applyMarkdownShortcut(event, fixInstruction, setFixInstruction)) return;
              if (isSendShortcut(event, sendShortcut)) {
                event.preventDefault();
                applyFix();
              }
            }}
          />
          <div>
            <button type="button" onClick={() => setFixing(false)}>Cancel</button>
            <button
              className="visualization-card__primary"
              type="button"
              disabled={!fixInstruction.trim()}
              onClick={applyFix}
            >
              <Wrench size={12} /> Apply fix
            </button>
          </div>
        </div>
      )}

      {!readOnly && visualization.status === "draft" && (
        <div className="visualization-card__draft">
          <label htmlFor={`visualization-hint-${visualization.id}`}>Visualization hint <small>optional</small></label>
          <textarea
            ref={hintRef}
            id={`visualization-hint-${visualization.id}`}
            rows={3}
            value={hint}
            placeholder="e.g. Show the geometric interpretation and label the eigendirections…"
            onChange={(event) => setHint(event.target.value)}
            onKeyDown={(event) => {
              if (applyMarkdownShortcut(event, hint, setHint)) return;
              if (isSendShortcut(event, sendShortcut)) {
                event.preventDefault();
                generate();
              }
            }}
          />
          <button className="visualization-card__primary" type="button" onClick={generate}>
            <Play size={14} /> Generate visualization
          </button>
        </div>
      )}

      {!readOnly && busy && (
        <div className="visualization-card__progress">
          <WorkingStatus
            label={visualization.status === "generating" ? "Writing MetaPost" : "Compiling in sandbox"}
            startedAt={visualization.updatedAt}
          />
          {visualization.status === "generating" && (
            <button type="button" onClick={() => onStop(visualization.id)}>
              <Square size={11} /> Stop
            </button>
          )}
        </div>
      )}

      {visualization.svg && svgUrl && !editingSource && (
        <figure className="visualization-card__figure">
          <img src={svgUrl} alt={visualization.hint || "Generated mathematical visualization"} />
          {visualization.hint && <figcaption>{visualization.hint}</figcaption>}
        </figure>
      )}

      {!readOnly && editingSource && (
        <div className="visualization-card__source-editor">
          <label htmlFor={`metapost-source-${visualization.id}`}>MetaPost figure body</label>
          <textarea
            id={`metapost-source-${visualization.id}`}
            value={source}
            rows={12}
            spellCheck={false}
            onChange={(event) => setSource(event.target.value)}
            onKeyDown={(event) => {
              if (isSendShortcut(event, sendShortcut)) {
                event.preventDefault();
                compile();
              }
            }}
          />
          <div>
            <button type="button" onClick={() => setEditingSource(false)}>Cancel</button>
            <button className="visualization-card__primary" type="button" disabled={!source.trim()} onClick={compile}>
              <Play size={13} /> Compile
            </button>
          </div>
        </div>
      )}

      {!readOnly && visualization.status === "error" && (
        <div className="visualization-card__error" role="alert">
          <strong>{visualization.errorStage === "compile" ? "Compilation failed" : "Generation failed"}</strong>
          <p>{visualization.errorMessage}</p>
          <div>
            {visualization.compilerLog && (
              <button type="button" onClick={() => setShowLog((open) => !open)}>
                <Code2 size={12} /> {showLog ? "Hide compiler log" : "Compiler log"}
              </button>
            )}
            {visualization.errorStage === "compile" && source.trim() && (
              <button type="button" onClick={compile}>
                <Play size={12} /> Retry compile
              </button>
            )}
            <button type="button" onClick={generate}><RotateCcw size={12} /> Regenerate</button>
          </div>
          {showLog && visualization.compilerLog && <pre>{visualization.compilerLog}</pre>}
        </div>
      )}

      {!readOnly && (visualization.status === "ready" || visualization.status === "error") && visualization.metapostSource && (
        <footer>
          <span>
            {visualization.generation ? generationDetails(visualization.generation) : "Generated source"}
            {visualization.compileDurationMs != null && ` · compiled in ${formatDuration(visualization.compileDurationMs)}`}
          </span>
          <div>
            <button
              type="button"
              onClick={async () => {
                await navigator.clipboard.writeText(visualization.metapostSource ?? "");
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1400);
              }}
            >
              {copied ? <Check size={12} /> : <Code2 size={12} />} {copied ? "Copied" : "Copy source"}
            </button>
            <button type="button" onClick={() => downloadText(visualization.metapostSource ?? "", "visualization.mp", "text/plain") }>
              <Download size={12} /> MP
            </button>
            {visualization.svg && (
              <button type="button" onClick={() => downloadText(visualization.svg ?? "", "visualization.svg", "image/svg+xml") }>
                <Download size={12} /> SVG
              </button>
            )}
          </div>
        </footer>
      )}
      {enlarged && visualization.svg && svgUrl && createPortal(
        <div
          className="visualization-lightbox"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setEnlarged(false);
          }}
        >
          <section
            className="visualization-lightbox__dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby={`visualization-lightbox-title-${visualization.id}`}
          >
            <header>
              <span id={`visualization-lightbox-title-${visualization.id}`}>
                <ImageIcon size={15} /> MetaPost visualization
              </span>
              <button
                ref={closeEnlargedButtonRef}
                type="button"
                aria-label="Close enlarged visualization"
                title="Close"
                onClick={() => setEnlarged(false)}
              >
                <X size={17} />
              </button>
            </header>
            <figure>
              <img
                src={svgUrl}
                alt={visualization.hint || "Generated mathematical visualization"}
              />
              {visualization.hint && <figcaption>{visualization.hint}</figcaption>}
            </figure>
          </section>
        </div>,
        document.body,
      )}
    </section>
  );
}
