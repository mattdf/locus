export interface SharedPageMetadata {
  title: string;
  url: string;
  createdAt: string;
}

function escaped(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function plainTitle(value: string): string {
  const normalized = value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_~`#]+/g, "")
    .replace(/\$+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return (normalized || "Shared Locus chat").slice(0, 180);
}

export function sharedPageHtml(document: string, metadata: SharedPageMetadata): string {
  const title = plainTitle(metadata.title);
  const description = `Read “${title}” — a public, read-only Locus chat.`;
  const pageTitle = `${title} · Shared Locus chat`;
  const tags = [
    `<link rel="canonical" href="${escaped(metadata.url)}" />`,
    `<meta property="og:type" content="article" />`,
    `<meta property="og:site_name" content="Locus Chat" />`,
    `<meta property="og:url" content="${escaped(metadata.url)}" />`,
    `<meta property="og:title" content="${escaped(title)}" />`,
    `<meta property="og:description" content="${escaped(description)}" />`,
    `<meta property="article:published_time" content="${escaped(metadata.createdAt)}" />`,
    `<meta name="twitter:card" content="summary" />`,
    `<meta name="twitter:title" content="${escaped(title)}" />`,
    `<meta name="twitter:description" content="${escaped(description)}" />`,
  ].join("\n    ");

  return document
    .replace(/<title>[^<]*<\/title>/i, `<title>${escaped(pageTitle)}</title>`)
    .replace("</head>", `    ${tags}\n  </head>`);
}
