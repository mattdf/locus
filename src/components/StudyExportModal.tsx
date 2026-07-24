import { ChevronLeft, Download, FileText, Printer, X } from "lucide-react";
import { useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import type { ChatTree, ThreadNode } from "../types";
import { generationDetails } from "../lib/generation";
import { normalizeMathDelimiters } from "../lib/markdown";
import { activeEditContent, messagesForNode, threadPath } from "../lib/tree";

interface ExportOptions {
  structure: "tree" | "flat";
  includeAnnotations: boolean;
  includeGenerationDetails: boolean;
}

const EXPORT_MARKDOWN_COMPONENTS: Components = {
  table: ({ node, children, ...props }) => {
    void node;
    return (
      <div className="markdown-table-scroll">
        <table {...props}>{children}</table>
      </div>
    );
  },
};

function Markdown({ source, imported = false }: { source: string; imported?: boolean }) {
  return (
    <div className="markdown-message">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { strict: false }], rehypeHighlight]}
        components={EXPORT_MARKDOWN_COMPONENTS}
      >
        {normalizeMathDelimiters(source, imported)}
      </ReactMarkdown>
    </div>
  );
}

function NodeSection({
  chat,
  node,
  options,
}: {
  chat: ChatTree;
  node: ThreadNode;
  options: ExportOptions;
}) {
  const path = threadPath(chat, node.id);
  const depth = Math.max(0, path.length - 1);
  const messages = messagesForNode(node);
  return (
    <section
      className={`study-export-node ${options.structure === "tree" ? "study-export-node--tree" : ""}`}
      data-depth={depth}
    >
      <header className="study-export-node__header">
        <span>{node.id === chat.rootId ? "Main thread" : `Branch · depth ${depth}`}</span>
        <h2>{node.id === chat.rootId ? chat.title : node.title}</h2>
        {options.structure === "tree" && depth > 0 && (
          <p>{path.map((item) => item.id === chat.rootId ? "Main" : item.title).join(" › ")}</p>
        )}
        {node.anchor && (
          <blockquote className="study-export-anchor">
            <Markdown source={node.anchor.quote} />
          </blockquote>
        )}
      </header>
      <div className="study-export-messages">
        {messages.map((message) => {
          const definitions = (node.definitions ?? []).filter(
            (item) => item.anchor.sourceMessageId === message.id,
          );
          const visualizations = (node.visualizations ?? []).filter(
            (item) => item.anchor.sourceMessageId === message.id,
          );
          const elaborations = (node.inlineElaborations ?? []).filter(
            (item) => item.anchor.sourceMessageId === message.id,
          );
          return (
            <article className={`study-export-message study-export-message--${message.role}`} key={message.id}>
              <header>
                <strong>
                  {message.role === "assistant"
                    ? "Locus"
                    : message.role === "source"
                      ? "Imported source"
                      : "You"}
                </strong>
                <time>{new Date(message.createdAt).toLocaleString()}</time>
              </header>
              <Markdown source={message.content} imported={message.role === "source"} />
              {options.includeGenerationDetails && message.generation && (
                <footer>{generationDetails(message.generation)}</footer>
              )}
              {options.includeAnnotations && (
                <div className="study-export-annotations">
                  {definitions.map((definition) => (
                    <aside className="study-export-annotation study-export-definition" key={definition.id}>
                      <strong>Definition · {definition.anchor.quote}</strong>
                      <Markdown source={definition.content} />
                    </aside>
                  ))}
                  {elaborations.map((elaboration) => (
                    <aside className="study-export-annotation study-export-elaboration" key={elaboration.id}>
                      <strong>Inline elaboration · {elaboration.anchor.quote}</strong>
                      <Markdown
                        source={activeEditContent(
                          node,
                          elaboration.id,
                          elaboration.content,
                        )}
                      />
                      {(node.definitions ?? [])
                        .filter(
                          (definition) =>
                            definition.anchor.sourceMessageId === elaboration.id,
                        )
                        .map((definition) => (
                          <aside
                            className="study-export-annotation study-export-definition"
                            key={definition.id}
                          >
                            <strong>Definition · {definition.anchor.quote}</strong>
                            <Markdown source={definition.content} />
                          </aside>
                        ))}
                    </aside>
                  ))}
                  {visualizations.map((visualization) => (
                    <figure className="study-export-annotation study-export-visualization" key={visualization.id}>
                      <figcaption>Visualization · {visualization.anchor.quote}</figcaption>
                      {visualization.svg ? (
                        <div dangerouslySetInnerHTML={{ __html: visualization.svg }} />
                      ) : (
                        <p>{visualization.errorMessage ?? "Visualization unavailable"}</p>
                      )}
                    </figure>
                  ))}
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function orderedNodes(chat: ChatTree): ThreadNode[] {
  const ordered: ThreadNode[] = [];
  const visit = (nodeId: string) => {
    const node = chat.nodes[nodeId];
    if (!node) return;
    ordered.push(node);
    Object.values(chat.nodes)
      .filter((candidate) => candidate.parentId === nodeId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .forEach((child) => visit(child.id));
  };
  visit(chat.rootId);
  return ordered;
}

function ExportDocument({
  chat,
  options,
}: {
  chat: ChatTree;
  options: ExportOptions;
}) {
  return (
    <main className="study-export-document">
      <header className="study-export-cover">
        <span>Locus study export</span>
        <h1>{chat.title}</h1>
        <p>
          {Object.keys(chat.nodes).length} threads · exported{" "}
          {new Date().toLocaleString()}
        </p>
        {chat.source?.kind === "pdf" && (
          <p>
            Source: {chat.source.filename} · {chat.source.processedPageCount ?? chat.source.pageCount} pages
          </p>
        )}
      </header>
      {orderedNodes(chat).map((node) => (
        <NodeSection chat={chat} node={node} options={options} key={node.id} />
      ))}
    </main>
  );
}

const EXPORT_CSS = `
  :root { color-scheme: light; --accent:#216b59; --line:#ddd9cf; }
  * { box-sizing:border-box; }
  body { margin:0; color:#26322e; background:#fff; font-family:Inter,system-ui,sans-serif; }
  .study-export-document { width:min(860px,calc(100% - 48px)); margin:0 auto; padding:56px 0 80px; }
  .study-export-cover { padding:0 0 34px; margin-bottom:38px; border-bottom:2px solid #26322e; }
  .study-export-cover > span,.study-export-node__header > span { color:#68736e; font-size:10px; font-weight:800; letter-spacing:.12em; text-transform:uppercase; }
  .study-export-cover h1 { margin:10px 0 8px; font:700 34px/1.15 Georgia,serif; }
  .study-export-cover p { margin:5px 0; color:#66706b; font-size:12px; }
  .study-export-node { break-before:page; margin:0 0 52px; }
  .study-export-node:first-of-type { break-before:auto; }
  .study-export-node--tree[data-depth="1"] { border-left:3px solid #d7e7e1; padding-left:24px; }
  .study-export-node--tree[data-depth="2"] { border-left:3px solid #dddaed; padding-left:24px; }
  .study-export-node--tree[data-depth="3"] { border-left:3px solid #eadfbf; padding-left:24px; }
  .study-export-node__header { margin-bottom:24px; }
  .study-export-node__header h2 { margin:7px 0 5px; font:700 25px/1.2 Georgia,serif; }
  .study-export-node__header > p { color:#77817c; font-size:11px; }
  .study-export-anchor { margin:14px 0 0; padding:10px 14px; background:#f7f1e1; border-left:3px solid #c89a32; }
  .study-export-message { margin:0 0 30px; break-inside:avoid-page; }
  .study-export-message > header { display:flex; justify-content:space-between; gap:12px; margin-bottom:8px; color:#7b857f; font-size:10px; text-transform:uppercase; }
  .study-export-message--user { margin-left:12%; padding:14px 16px; background:#f0eee8; border-radius:8px; }
  .study-export-message > footer { margin-top:8px; color:#7c8580; font-size:9px; }
  .study-export-annotation { margin:18px 0 0; padding:13px 15px; break-inside:avoid; border:1px solid #d9e3df; border-radius:8px; background:#f8fbfa; }
  .study-export-annotation > strong,.study-export-annotation > figcaption { display:block; margin-bottom:7px; color:#55706a; font-size:10px; font-weight:800; }
  .study-export-definition { border-color:#c6dfea; background:#f6fbfd; }
  .study-export-visualization { border-color:#d8cce8; background:#fbf9fd; }
  .study-export-visualization svg { display:block; max-width:100%; height:auto; margin:auto; }
  .markdown-message { min-width:0; max-width:100%; color:#293430; font:15px/1.72 Georgia,serif; }
  .markdown-message h1,.markdown-message h2,.markdown-message h3,.markdown-message h4 { font-family:Inter,system-ui,sans-serif; }
  .markdown-message img { display:block; max-width:100%; height:auto; margin:1em auto; }
  .markdown-message pre { padding:14px; overflow:auto; color:#edf3f1; background:#24302d; border-radius:7px; }
  .markdown-message code { font-family:ui-monospace,monospace; }
  .markdown-table-scroll { max-width:100%; overflow-x:auto; }
  .markdown-table-scroll table { width:max-content; min-width:100%; border-collapse:collapse; font:12px/1.4 Inter,system-ui,sans-serif; }
  .markdown-table-scroll th,.markdown-table-scroll td { padding:7px 9px; border-bottom:1px solid #ddd; text-align:left; }
  .katex-display { max-width:100%; overflow-x:auto; overflow-y:hidden; }
  @page { margin:16mm 14mm; }
  @media print {
    .study-export-document { width:100%; padding:0; }
    .study-export-node { break-before:page; }
    .study-export-message { break-inside:auto; }
  }
`;

async function blobAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Could not embed export asset"));
    reader.readAsDataURL(blob);
  });
}

async function inlineCssAssets(css: string, baseUrl: string): Promise<string> {
  const matches = [...css.matchAll(/url\((['"]?)([^)'"]+)\1\)/g)];
  const urls = [...new Set(matches.map((match) => match[2]).filter((url) => !url.startsWith("data:")))];
  const replacements = new Map<string, string>();
  await Promise.all(
    urls.map(async (url) => {
      try {
        const absolute = new URL(url, baseUrl).href;
        const response = await fetch(absolute, { credentials: "same-origin" });
        if (!response.ok) return;
        replacements.set(url, await blobAsDataUrl(await response.blob()));
      } catch {
        // The absolute URL fallback still leaves the export readable.
      }
    }),
  );
  return css.replace(/url\((['"]?)([^)'"]+)\1\)/g, (full, _quote, url) => {
    const replacement = replacements.get(url);
    return replacement ? `url("${replacement}")` : `url("${new URL(url, baseUrl).href}")`;
  });
}

async function pageCss(): Promise<string> {
  const chunks: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      if (sheet.href) {
        const response = await fetch(sheet.href, { credentials: "same-origin" });
        if (response.ok) {
          chunks.push(await inlineCssAssets(await response.text(), sheet.href));
        }
      } else {
        chunks.push(Array.from(sheet.cssRules).map((rule) => rule.cssText).join("\n"));
      }
    } catch {
      // Cross-origin or transient styles are not required for the export shell.
    }
  }
  return chunks.join("\n");
}

async function inlineDocumentImages(html: string): Promise<string> {
  const documentValue = new DOMParser().parseFromString(html, "text/html");
  const images = Array.from(documentValue.querySelectorAll("img[src]"));
  await Promise.all(
    images.map(async (image) => {
      try {
        const absolute = new URL(image.getAttribute("src")!, window.location.href).href;
        const response = await fetch(absolute, { credentials: "same-origin" });
        if (!response.ok) return;
        image.setAttribute("src", await blobAsDataUrl(await response.blob()));
      } catch {
        // Preserve the original source when an asset cannot be embedded.
      }
    }),
  );
  return documentValue.body.innerHTML;
}

async function studyHtml(chat: ChatTree, options: ExportOptions): Promise<string> {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const markup = await inlineDocumentImages(
    renderToStaticMarkup(<ExportDocument chat={chat} options={options} />),
  );
  const css = await pageCss();
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${chat.title.replace(/[<>&"]/g, "")} · Locus export</title>
<style>${css}\n${EXPORT_CSS}</style>
</head>
<body>${markup}</body>
</html>`;
}

function safeFilename(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 70) || "locus-study"
  );
}

export function StudyExportModal({
  chat,
  onBack,
  onClose,
}: {
  chat: ChatTree;
  onBack: () => void;
  onClose: () => void;
}) {
  const [structure, setStructure] = useState<ExportOptions["structure"]>("tree");
  const [includeAnnotations, setIncludeAnnotations] = useState(true);
  const [includeGenerationDetails, setIncludeGenerationDetails] = useState(true);
  const [working, setWorking] = useState<"html" | "print" | null>(null);
  const [error, setError] = useState("");
  const options = { structure, includeAnnotations, includeGenerationDetails };

  const download = async () => {
    setWorking("html");
    setError("");
    try {
      const html = await studyHtml(chat, options);
      const url = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `${safeFilename(chat.title)}.html`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not build the HTML export");
    } finally {
      setWorking(null);
    }
  };

  const print = async () => {
    const popup = window.open("", "_blank");
    if (!popup) {
      setError("The print window was blocked. Allow pop-ups for this site and try again.");
      return;
    }
    popup.document.write("<p style=\"font-family:system-ui;padding:24px\">Preparing study…</p>");
    setWorking("print");
    setError("");
    try {
      const html = await studyHtml(chat, options);
      popup.document.open();
      popup.document.write(html);
      popup.document.close();
      await popup.document.fonts?.ready.catch(() => undefined);
      window.setTimeout(() => {
        popup.focus();
        popup.print();
      }, 250);
    } catch (reason) {
      popup.close();
      setError(reason instanceof Error ? reason.message : "Could not build the print view");
    } finally {
      setWorking(null);
    }
  };

  return (
    <div className="settings-modal-backdrop">
      <section className="settings-modal study-export-modal" role="dialog" aria-modal="true">
        <header>
          <button className="settings-back-button" type="button" aria-label="Back to settings" onClick={onBack}>
            <ChevronLeft size={17} />
          </button>
          <div>
            <span>Portable study</span>
            <h2>Export {chat.title}</h2>
          </div>
          <button className="icon-button" type="button" aria-label="Close export" onClick={onClose}>
            <X size={17} />
          </button>
        </header>
        <div className="study-export-modal__body">
          <section>
            <FileText size={22} />
            <div>
              <h3>Whole-study document</h3>
              <p>
                Includes every thread using only the currently selected message and generation
                variants. Images and stylesheet assets are embedded into the downloaded HTML.
              </p>
            </div>
          </section>
          <fieldset>
            <legend>Structure</legend>
            <label>
              <input type="radio" name="structure" value="tree" checked={structure === "tree"} onChange={() => setStructure("tree")} />
              <span><strong>Preserve branch structure</strong><small>Show paths, depth, and branch anchors</small></span>
            </label>
            <label>
              <input type="radio" name="structure" value="flat" checked={structure === "flat"} onChange={() => setStructure("flat")} />
              <span><strong>Flatten sections</strong><small>Print every active thread as an equal section</small></span>
            </label>
          </fieldset>
          <fieldset>
            <legend>Contents</legend>
            <label>
              <input type="checkbox" checked={includeAnnotations} onChange={(event) => setIncludeAnnotations(event.target.checked)} />
              <span><strong>Inline annotations</strong><small>Definitions, visualizations, and inline elaborations</small></span>
            </label>
            <label>
              <input type="checkbox" checked={includeGenerationDetails} onChange={(event) => setIncludeGenerationDetails(event.target.checked)} />
              <span><strong>Generation details</strong><small>Model, duration, tokens, and cost where available</small></span>
            </label>
          </fieldset>
          {error && <p className="settings-error" role="alert">{error}</p>}
        </div>
        <footer>
          <button className="secondary-button" type="button" disabled={working !== null} onClick={() => void print()}>
            <Printer size={14} /> {working === "print" ? "Preparing…" : "Print / Save PDF"}
          </button>
          <button className="primary-button" type="button" disabled={working !== null} onClick={() => void download()}>
            <Download size={14} /> {working === "html" ? "Building…" : "Download HTML"}
          </button>
        </footer>
      </section>
    </div>
  );
}
