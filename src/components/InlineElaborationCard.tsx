import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CornerUpRight,
  LoaderCircle,
  MessageSquareMore,
  Play,
  RotateCcw,
  Square,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatDuration, generationDetails } from "../lib/generation";
import type {
  AnnotationTarget,
  AssistantEditGroup,
  InlineDefinition,
  InlineElaboration,
  Message,
  SelectionDraft,
} from "../types";
import { MarkdownMessage } from "./MarkdownMessage";

const NOOP = () => undefined;
const EMPTY_ITEMS: never[] = [];

interface InlineElaborationCardProps {
  elaboration: InlineElaboration;
  nodeId: string;
  definitions: InlineDefinition[];
  onSelect: (selection: SelectionDraft) => void;
  onOpenDefinition: (
    definitionId: string,
    rect: SelectionDraft["rect"],
    getAnchorRect?: () => SelectionDraft["rect"],
  ) => void;
  onGenerate: (elaborationId: string, hint: string) => void;
  onStop: (elaborationId: string) => void;
  onDelete: (elaborationId: string) => void;
  onElaborateFurther: (elaborationId: string) => void;
  editGroup?: AssistantEditGroup;
  onSwitchEdit: (elaborationId: string, variantId: string) => void;
  onAnnotationContextMenu?: (
    target: AnnotationTarget,
    point: { left: number; top: number },
  ) => void;
  onOpenFurtherElaboration: () => void;
  furtherElaborationState?: "pending" | "ready";
  readOnly?: boolean;
}

function WorkingStatus({ startedAt }: { startedAt: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <span className="inline-elaboration-card__working">
      <LoaderCircle size={13} /> Elaborating · {formatDuration(Math.max(0, now - Date.parse(startedAt)))}
    </span>
  );
}

export function InlineElaborationCard({
  elaboration,
  nodeId,
  definitions,
  onSelect,
  onOpenDefinition,
  onGenerate,
  onStop,
  onDelete,
  onElaborateFurther,
  editGroup,
  onSwitchEdit,
  onAnnotationContextMenu,
  onOpenFurtherElaboration,
  furtherElaborationState,
  readOnly = false,
}: InlineElaborationCardProps) {
  const [hint, setHint] = useState(elaboration.hint);
  const [collapsed, setCollapsed] = useState(false);
  const cardRef = useRef<HTMLElement>(null);
  const hintRef = useRef<HTMLInputElement>(null);
  const draft = !elaboration.pending && !elaboration.content && !elaboration.error;
  const activeEditIndex = editGroup
    ? Math.max(
        0,
        editGroup.variants.findIndex(
          (variant) => variant.id === editGroup.activeVariantId,
        ),
      )
    : 0;
  const contentMessage = useMemo<Message>(() => ({
    id: elaboration.id,
    role: "assistant",
    content: elaboration.content,
    createdAt: elaboration.createdAt,
    error: elaboration.error,
  }), [elaboration.content, elaboration.createdAt, elaboration.error, elaboration.id]);

  useEffect(() => setHint(elaboration.hint), [elaboration.id, elaboration.hint]);
  useEffect(() => {
    if (draft) hintRef.current?.focus({ preventScroll: true });
  }, [draft, elaboration.id]);
  useEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const expand = () => setCollapsed(false);
    card.addEventListener("locus:expand-inline-elaboration", expand);
    return () => card.removeEventListener("locus:expand-inline-elaboration", expand);
  }, [elaboration.id]);
  useEffect(() => {
    if (elaboration.pending) setCollapsed(false);
  }, [elaboration.pending]);

  const generate = () => onGenerate(elaboration.id, hint.trim());

  return (
    <section
      ref={cardRef}
      className={`inline-elaboration-card ${collapsed ? "inline-elaboration-card--collapsed" : ""}`}
      data-inline-elaboration-id={elaboration.id}
      aria-label="Inline elaboration"
    >
      <header>
        <span><MessageSquareMore size={14} /> Inline elaboration</span>
        <div>
          {!readOnly && editGroup && editGroup.variants.length > 1 && (
            <span
              className="inline-elaboration-card__edit-switcher"
              aria-label="Inline elaboration edit versions"
            >
              <button
                type="button"
                aria-label="Previous inline elaboration edit"
                disabled={elaboration.pending || activeEditIndex === 0}
                onClick={() => onSwitchEdit(
                  elaboration.id,
                  editGroup.variants[activeEditIndex - 1].id,
                )}
              >
                <ChevronLeft size={12} />
              </button>
              <span>{activeEditIndex + 1} / {editGroup.variants.length}</span>
              <button
                type="button"
                aria-label="Next inline elaboration edit"
                disabled={
                  elaboration.pending || activeEditIndex === editGroup.variants.length - 1
                }
                onClick={() => onSwitchEdit(
                  elaboration.id,
                  editGroup.variants[activeEditIndex + 1].id,
                )}
              >
                <ChevronRight size={12} />
              </button>
            </span>
          )}
          {!readOnly && !elaboration.pending && !draft && (
            <button
              type="button"
              aria-label="Regenerate inline elaboration"
              title="Regenerate"
              onClick={generate}
            >
              <RotateCcw size={13} />
            </button>
          )}
          {!readOnly && (
            <button
              type="button"
              aria-label="Delete inline elaboration"
              title="Delete"
              disabled={elaboration.pending}
              onClick={() => onDelete(elaboration.id)}
            >
              <Trash2 size={13} />
            </button>
          )}
          <button
            type="button"
            aria-label={collapsed ? "Expand inline elaboration" : "Collapse inline elaboration"}
            title={collapsed ? "Expand" : "Collapse"}
            aria-expanded={!collapsed}
            onClick={() => setCollapsed((value) => !value)}
          >
            {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          </button>
        </div>
      </header>

      {!collapsed && <>
        {!readOnly && (draft || elaboration.error) && (
          <div className="inline-elaboration-card__draft">
            <label htmlFor={`inline-elaboration-hint-${elaboration.id}`}>
              Guidance <small>optional</small>
            </label>
            <div>
              <input
                ref={hintRef}
                id={`inline-elaboration-hint-${elaboration.id}`}
                type="text"
                value={hint}
                maxLength={1_000}
                placeholder="e.g. Give a concrete example or clarify the intuition"
                onChange={(event) => setHint(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    generate();
                  }
                }}
              />
              <button type="button" onClick={generate}>
                {elaboration.error ? <RotateCcw size={13} /> : <Play size={13} />}
                {elaboration.error ? "Retry" : "Elaborate"}
              </button>
            </div>
          </div>
        )}

        {elaboration.pending && (
          <div className="inline-elaboration-card__progress" aria-live="polite">
            <WorkingStatus startedAt={elaboration.updatedAt} />
            {!readOnly && <button type="button" onClick={() => onStop(elaboration.id)}>
              <Square size={11} /> Stop
            </button>}
          </div>
        )}

        {!elaboration.pending && elaboration.content && (
          <div className={elaboration.error ? "inline-elaboration-card__error" : "inline-elaboration-card__content"}>
            <MarkdownMessage
              message={contentMessage}
              nodeId={nodeId}
              linkedAnchors={EMPTY_ITEMS}
              definitions={definitions}
              visualizations={EMPTY_ITEMS}
              inlineElaborations={EMPTY_ITEMS}
              onSelect={onSelect}
              onOpenElaboration={NOOP}
              onOpenDefinition={onOpenDefinition}
              onOpenVisualization={NOOP}
              onOpenInlineElaboration={NOOP}
              onAnnotationContextMenu={onAnnotationContextMenu}
              selectionSurface="inline-elaboration"
            />
          </div>
        )}

        {!elaboration.pending && !elaboration.error && elaboration.content && (
          <div className="inline-elaboration-card__further">
            {furtherElaborationState === "ready" ? (
              <button type="button" onClick={onOpenFurtherElaboration}>
                <CornerUpRight size={12} /> Further elaboration
              </button>
            ) : furtherElaborationState === "pending" ? (
              <button type="button" disabled>
                <LoaderCircle size={12} /> Elaborating further…
              </button>
            ) : !readOnly ? (
              <button type="button" onClick={() => onElaborateFurther(elaboration.id)}>
                <CornerUpRight size={12} /> Elaborate further
              </button>
            ) : null}
          </div>
        )}

        {!elaboration.pending && elaboration.generation && (
          <footer>{generationDetails(elaboration.generation)}</footer>
        )}
      </>}
    </section>
  );
}
