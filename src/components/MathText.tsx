import { memo, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import { KATEX_RENDER_OPTIONS } from "../lib/katex";
import remarkMath from "remark-math";
import { normalizeMathDelimiters } from "../lib/markdown";

interface MathTextProps {
  source: string;
  className?: string;
}

const INLINE_COMPONENTS = { p: ({ children }: { children?: React.ReactNode }) => <>{children}</> };

export const InlineMath = memo(function InlineMath({
  source,
  className = "",
}: MathTextProps) {
  const inlineSource = useMemo(
    () =>
      normalizeMathDelimiters(source)
        .replace(/\$\$\s*([\s\S]*?)\s*\$\$/g, (_match, equation: string) =>
          `$${equation.trim()}$`,
        )
        .replace(/\s*\n\s*/g, " ")
        // Inline labels should not turn leading section numbers or dashes into
        // block-level Markdown lists.
        .replace(/^(\s*)(\d+)\.\s+/, "$1$2\\. ")
        .replace(/^(\s*)([-+])\s+/, "$1\\$2 ")
        .replace(/^(\s*)>\s+/, "$1\\> "),
    [source],
  );
  return (
    <span className={`inline-math ${className}`.trim()}>
      <ReactMarkdown
        remarkPlugins={[remarkMath]}
        rehypePlugins={[[rehypeKatex, KATEX_RENDER_OPTIONS]]}
        components={INLINE_COMPONENTS}
      >
        {inlineSource}
      </ReactMarkdown>
    </span>
  );
});

export const MathBlock = memo(function MathBlock({
  source,
  className = "",
}: MathTextProps) {
  const normalizedSource = useMemo(() => normalizeMathDelimiters(source), [source]);
  return (
    <div className={`math-block ${className}`.trim()}>
      <ReactMarkdown
        remarkPlugins={[remarkMath]}
        rehypePlugins={[[rehypeKatex, KATEX_RENDER_OPTIONS]]}
      >
        {normalizedSource}
      </ReactMarkdown>
    </div>
  );
});
