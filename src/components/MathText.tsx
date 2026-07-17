import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkMath from "remark-math";
import { normalizeMathDelimiters } from "../lib/markdown";

interface MathTextProps {
  source: string;
  className?: string;
}

export function InlineMath({ source, className = "" }: MathTextProps) {
  const inlineSource = normalizeMathDelimiters(source)
    .replace(/\$\$\s*([\s\S]*?)\s*\$\$/g, (_match, equation: string) =>
      `$${equation.trim()}$`,
    )
    .replace(/\s*\n\s*/g, " ");
  return (
    <span className={`inline-math ${className}`.trim()}>
      <ReactMarkdown
        remarkPlugins={[remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{ p: ({ children }) => <>{children}</> }}
      >
        {inlineSource}
      </ReactMarkdown>
    </span>
  );
}

export function MathBlock({ source, className = "" }: MathTextProps) {
  return (
    <div className={`math-block ${className}`.trim()}>
      <ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>
        {normalizeMathDelimiters(source)}
      </ReactMarkdown>
    </div>
  );
}
