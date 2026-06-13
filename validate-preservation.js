'use strict';

/**
 * Content-preservation validation for CtxCrush compression.
 * Does NOT change compression. Inspects ORIGINAL vs COMPRESSED text and
 * reports whether any CRITICAL element was lost. Strict on exact things
 * (code blocks, URLs, error types, numbers); forgiving about prose rewording.
 * Returns { ok, missing }.
 */

function extractCodeBlocks(text) {
  const blocks = [];
  const re = /```[\s\S]*?```/g;
  let m;
  while ((m = re.exec(text)) !== null) blocks.push(m[0]);
  return blocks;
}
function extractUrls(text) {
  return text.match(/https?:\/\/[^\s)>\]]+/g) || [];
}
function extractErrorTokens(text) {
  const tokens = new Set();
  for (const m of text.matchAll(/\b([A-Z][a-zA-Z]*(?:Error|Exception))\b/g)) tokens.add(m[1]);
  for (const m of text.matchAll(/\b(ENOENT|EADDRINUSE|ECONNREFUSED|ETIMEDOUT|EACCES)\b/g)) tokens.add(m[1]);
  for (const m of text.matchAll(/\b(4\d{2}|5\d{2})\b/g)) tokens.add(m[1]);
  return [...tokens];
}
function extractNumbers(text) {
  const noCode = text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ');
  return noCode.match(/\b\d[\d.,]{1,}\b/g) || [];
}
function norm(s) { return s.replace(/\s+/g, ' ').trim(); }

function validatePreservation(original, compressed) {
  const comp = compressed;
  const compNorm = norm(compressed);
  const missing = { codeBlocks: [], urls: [], errorTokens: [], numbers: [] };

  for (const b of extractCodeBlocks(original)) {
    if (!compNorm.includes(norm(b))) missing.codeBlocks.push(b.slice(0, 40) + '…');
  }
  for (const u of extractUrls(original)) {
    if (!comp.includes(u)) missing.urls.push(u);
  }
  for (const t of extractErrorTokens(original)) {
    if (!comp.includes(t)) missing.errorTokens.push(t);
  }
  for (const n of extractNumbers(original)) {
    if (!comp.includes(n)) missing.numbers.push(n);
  }

  const ok =
    missing.codeBlocks.length === 0 &&
    missing.urls.length === 0 &&
    missing.errorTokens.length === 0 &&
    missing.numbers.length === 0;

  return { ok, missing };
}

module.exports = { validatePreservation };