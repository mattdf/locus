import assert from "node:assert/strict";
import { sharedPageHtml } from "../../server/social-meta.ts";

const html = sharedPageHtml(
  "<!doctype html><html><head><title>Locus</title></head><body></body></html>",
  {
    title: "**Attention & $QK^T$**",
    url: "https://locuschat.io/share/example?a=1&b=2",
    createdAt: "2026-07-22T00:00:00.000Z",
  },
);

assert.match(html, /<title>Attention &amp; QK\^T · Shared Locus chat<\/title>/);
assert.match(html, /property="og:title" content="Attention &amp; QK\^T"/);
assert.match(html, /name="twitter:card" content="summary"/);
assert.match(html, /property="og:url" content="https:\/\/locuschat\.io\/share\/example\?a=1&amp;b=2"/);
assert.doesNotMatch(html, /\*\*Attention/);

console.log("Social share metadata invariants passed");
