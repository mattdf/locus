import { memo, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
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
        .replace(/\s*\n\s*/g, " "),
    [source],
  );
  return (
    <span className={`inline-math ${className}`.trim()}>
      <ReactMarkdown
        remarkPlugins={[remarkMath]}
        rehypePlugins={[[rehypeKatex, { strict: false }]]}
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
        rehypePlugins={[[rehypeKatex, { strict: false }]]}
      >
        {normalizedSource}
      </ReactMarkdown>
    </div>
  );
});
