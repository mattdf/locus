import {
  Activity,
  AlertTriangle,
  BookOpen,
  Braces,
  ChartNoAxesCombined,
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  GitBranch,
  Hammer,
  LoaderCircle,
  Map,
  MessageSquareText,
  RotateCcw,
  Square,
  X,
} from "lucide-react";
import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import type { AnnotationTarget, ChatTree, HighlightAnchor } from "../types";
import type {
  AnnotationIntegrityItem,
  WorkspaceJob,
} from "../lib/study";
import { generationDetails } from "../lib/generation";
import { InlineMath } from "./MathText";

export type StudyToolsTab = "map" | "integrity" | "jobs";

export interface StudyToolsNavigation {
  chatId: string;
  nodeId: string;
  anchor?: HighlightAnchor;
  annotation?: AnnotationTarget;
}

function annotationRows(chat: ChatTree, nodeId: string) {
  const node = chat.nodes[nodeId];
  if (!node) return [];
  return [
    ...(node.definitions ?? []).map((item) => ({
      id: `definition:${item.id}`,
      kind: "Definition",
      icon: BookOpen,
      anchor: item.anchor,
      annotation: { kind: "definition", id: item.id } as AnnotationTarget,
    })),
    ...(node.visualizations ?? []).map((item) => ({
      id: `visualization:${item.id}`,
      kind: "Visualization",
      icon: ChartNoAxesCombined,
      anchor: item.anchor,
      annotation: { kind: "visualization", id: item.id } as AnnotationTarget,
    })),
    ...(node.inlineElaborations ?? []).map((item) => ({
      id: `inline:${item.id}`,
      kind: "Inline elaboration",
      icon: MessageSquareText,
      anchor: item.anchor,
      annotation: { kind: "inline-elaboration", id: item.id } as AnnotationTarget,
    })),
  ];
}

function formatWhen(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "";
  const elapsed = Date.now() - time;
  if (elapsed < 60_000) return "just now";
  if (elapsed < 3_600_000) return `${Math.max(1, Math.round(elapsed / 60_000))}m ago`;
  if (elapsed < 86_400_000) return `${Math.max(1, Math.round(elapsed / 3_600_000))}h ago`;
  return new Date(time).toLocaleDateString();
}

function jobIcon(job: WorkspaceJob) {
  if (job.status === "running") return LoaderCircle;
  if (job.status === "failed") return AlertTriangle;
  if (job.status === "stopped") return Square;
  if (job.kind === "visualization") return ChartNoAxesCombined;
  if (job.kind === "pdf") return Braces;
  return CheckCircle2;
}

export function StudyToolsPanel({
  chat,
  jobs,
  integrity,
  initialTab = "map",
  onClose,
  onNavigate,
  onRepair,
  onAutoRepair,
  onStopJob,
  onRetryJob,
}: {
  chat: ChatTree | null;
  jobs: WorkspaceJob[];
  integrity: AnnotationIntegrityItem[];
  initialTab?: StudyToolsTab;
  onClose: () => void;
  onNavigate: (location: StudyToolsNavigation) => void;
  onRepair: (item: AnnotationIntegrityItem) => void;
  onAutoRepair: (items: AnnotationIntegrityItem[]) => void;
  onStopJob: (job: WorkspaceJob) => void;
  onRetryJob: (job: WorkspaceJob) => void;
}) {
  const [tab, setTab] = useState<StudyToolsTab>(initialTab);
  const [showCompleted, setShowCompleted] = useState(false);
  const problemItems = integrity.filter((item) => item.status !== "healthy");
  const autoRepairable = problemItems.filter((item) => item.suggestedAnchor);
  const visibleJobs = useMemo(
    () =>
      jobs
        .filter((job) => showCompleted || job.status !== "completed")
        .slice(0, showCompleted ? 100 : 60),
    [jobs, showCompleted],
  );

  const renderNode = (nodeId: string, depth: number): ReactNode => {
    if (!chat) return null;
    const node = chat.nodes[nodeId];
    if (!node) return null;
    const children = Object.values(chat.nodes)
      .filter((candidate) => candidate.parentId === nodeId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const annotations = annotationRows(chat, nodeId);
    return (
      <li className="study-map__node" key={node.id}>
        <button
          type="button"
          className="study-map__thread"
          style={{ "--study-depth": depth } as CSSProperties}
          onClick={() =>
            onNavigate({
              chatId: chat.id,
              nodeId: node.id,
              annotation:
                node.parentId && node.anchor
                  ? { kind: "branch", id: node.id }
                  : undefined,
            })
          }
        >
          <GitBranch size={13} />
          <span>
            <strong>
              {node.id === chat.rootId ? "Main thread" : <InlineMath source={node.title} />}
            </strong>
            <small>
              {node.messages.length} messages
              {annotations.length ? ` · ${annotations.length} inline` : ""}
            </small>
          </span>
          <ChevronRight size={13} />
        </button>
        {!!annotations.length && (
          <ul className="study-map__annotations">
            {annotations.map((annotation) => {
              const Icon = annotation.icon;
              return (
                <li key={annotation.id}>
                  <button
                    type="button"
                    onClick={() =>
                      onNavigate({
                        chatId: chat.id,
                        nodeId,
                        anchor: annotation.anchor,
                        annotation: annotation.annotation,
                      })
                    }
                  >
                    <Icon size={12} />
                    <span>{annotation.kind}</span>
                    <em>
                      <InlineMath source={annotation.anchor.quote.slice(0, 90)} />
                    </em>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {!!children.length && (
          <ul>{children.map((child) => renderNode(child.id, depth + 1))}</ul>
        )}
      </li>
    );
  };

  return (
    <div className="study-tools-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <aside className="study-tools-panel" role="dialog" aria-modal="true" aria-label="Study tools">
        <header className="study-tools-panel__header">
          <div>
            <span>Workspace</span>
            <h2>{chat?.title ?? "Study tools"}</h2>
          </div>
          <button className="icon-button" type="button" aria-label="Close study tools" onClick={onClose}>
            <X size={17} />
          </button>
        </header>

        <nav className="study-tools-tabs" aria-label="Study tools">
          <button type="button" className={tab === "map" ? "active" : ""} onClick={() => setTab("map")}>
            <Map size={14} /> Map
          </button>
          <button type="button" className={tab === "integrity" ? "active" : ""} onClick={() => setTab("integrity")}>
            <Hammer size={14} /> Anchors
            {!!problemItems.length && <em>{problemItems.length}</em>}
          </button>
          <button type="button" className={tab === "jobs" ? "active" : ""} onClick={() => setTab("jobs")}>
            <Activity size={14} /> Jobs
            {!!jobs.filter((job) => job.status === "running").length && (
              <em>{jobs.filter((job) => job.status === "running").length}</em>
            )}
          </button>
        </nav>

        <div className="study-tools-panel__body">
          {tab === "map" && (
            chat ? (
              <section className="study-map">
                <header>
                  <h3>Study map</h3>
                  <p>Every thread and inline annotation in this study.</p>
                </header>
                <ul className="study-map__tree">{renderNode(chat.rootId, 0)}</ul>
              </section>
            ) : (
              <div className="study-tools-empty">
                <Map size={24} />
                <strong>Open a study to view its map</strong>
              </div>
            )
          )}

          {tab === "integrity" && (
            chat ? (
              <section className="integrity-view">
                <header>
                  <div>
                    <h3>Annotation integrity</h3>
                    <p>Checks every annotation against its current Markdown source.</p>
                  </div>
                  <button
                    type="button"
                    disabled={!autoRepairable.length}
                    onClick={() => onAutoRepair(autoRepairable)}
                  >
                    <Hammer size={13} /> Auto-repair {autoRepairable.length || ""}
                  </button>
                </header>
                {!integrity.length ? (
                  <div className="study-tools-empty">
                    <CircleDashed size={24} />
                    <strong>No annotations yet</strong>
                  </div>
                ) : !problemItems.length ? (
                  <div className="integrity-all-clear">
                    <CheckCircle2 size={23} />
                    <div>
                      <strong>All {integrity.length} anchors resolve cleanly</strong>
                      <span>No repairs are currently needed.</span>
                    </div>
                  </div>
                ) : (
                  <ul className="integrity-list">
                    {problemItems.map((item) => (
                      <li className={`integrity-item integrity-item--${item.status}`} key={item.id}>
                        <AlertTriangle size={15} />
                        <div>
                          <strong>{item.title}</strong>
                          <span>{item.reason}</span>
                          <blockquote><InlineMath source={item.quote.slice(0, 180)} /></blockquote>
                        </div>
                        <div className="integrity-item__actions">
                          <button
                            type="button"
                            onClick={() =>
                              onNavigate({
                                chatId: item.chatId,
                                nodeId: item.nodeId,
                                anchor: item.anchor,
                                annotation: item.target,
                              })
                            }
                          >
                            View
                          </button>
                          {item.suggestedAnchor ? (
                            <button type="button" onClick={() => onAutoRepair([item])}>
                              Repair
                            </button>
                          ) : (
                            <button type="button" onClick={() => onRepair(item)}>
                              Relocate
                            </button>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            ) : (
              <div className="study-tools-empty">
                <Hammer size={24} />
                <strong>Open a study to inspect its annotations</strong>
              </div>
            )
          )}

          {tab === "jobs" && (
            <section className="job-center">
              <header>
                <div>
                  <h3>Job center</h3>
                  <p>Long-running and recent work remains attached to its study.</p>
                </div>
                <label>
                  <input
                    type="checkbox"
                    checked={showCompleted}
                    onChange={(event) => setShowCompleted(event.target.checked)}
                  />
                  Show completed
                </label>
              </header>
              {!visibleJobs.length ? (
                <div className="study-tools-empty">
                  <Activity size={24} />
                  <strong>No active or failed jobs</strong>
                </div>
              ) : (
                <ul className="job-list">
                  {visibleJobs.map((job) => {
                    const Icon = jobIcon(job);
                    return (
                      <li className={`job-item job-item--${job.status}`} key={job.id}>
                        <Icon className={job.status === "running" ? "spin" : ""} size={16} />
                        <button
                          type="button"
                          className="job-item__summary"
                          onClick={() =>
                            onNavigate({
                              chatId: job.chatId,
                              nodeId: job.nodeId,
                              anchor: job.anchor,
                              annotation: job.annotation,
                            })
                          }
                        >
                          <strong>{job.title}</strong>
                          <span>{job.detail}</span>
                          <small>
                            {job.status} · {formatWhen(job.updatedAt)}
                            {job.generation ? ` · ${generationDetails(job.generation)}` : ""}
                          </small>
                          {job.error && <code>{job.error.slice(0, 260)}</code>}
                          {job.compilerLog && (
                            <details onClick={(event) => event.stopPropagation()}>
                              <summary>Compiler log</summary>
                              <pre>{job.compilerLog.slice(-6_000)}</pre>
                            </details>
                          )}
                        </button>
                        <div className="job-item__actions">
                          {job.status === "running" && job.kind !== "pdf" && (
                            <button type="button" onClick={() => onStopJob(job)}>
                              <Square size={12} /> Stop
                            </button>
                          )}
                          {(job.status === "failed" || job.status === "stopped") &&
                            job.kind !== "pdf" && (
                              <button type="button" onClick={() => onRetryJob(job)}>
                                <RotateCcw size={12} /> Retry
                              </button>
                            )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          )}
        </div>
      </aside>
    </div>
  );
}
