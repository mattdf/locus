/** KaTeX compatibility aliases for conventional textbook commands that are
 * provided by common LaTeX packages but not by KaTeX's default command set. */
export const KATEX_MACROS: Record<string, string> = {
  "\\square": "\\boxed{\\phantom{x}}",
  "\\Box": "\\boxed{\\phantom{x}}",
};

export const KATEX_RENDER_OPTIONS = {
  strict: false as const,
  macros: KATEX_MACROS,
};
