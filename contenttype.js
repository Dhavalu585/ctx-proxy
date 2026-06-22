'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Content-type detection (Phase 2, step 1)
// Identifies what KIND of content a message is, so it can later be routed to a
// specialized compressor — generalizing the existing Java-code detection.
//
// This step is DETECTION ONLY. It classifies and (in server.js) logs what it
// sees. It does NOT yet change or compress anything. Behavior is unchanged.
// ─────────────────────────────────────────────────────────────────────────────

// Detect JSON: the text (trimmed) parses as a JSON object or array.
// We require it to be non-trivial (an object/array, not just a bare number or
// short string) so we don't flag ordinary prose that happens to be valid JSON.
function looksLikeJson(text) {
  if (!text || typeof text !== 'string') return false;
  const t = text.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return false;
  try {
    const parsed = JSON.parse(t);
    // Only count objects/arrays with real content
    if (Array.isArray(parsed)) return parsed.length > 0;
    if (parsed && typeof parsed === 'object') return Object.keys(parsed).length > 0;
    return false;
  } catch {
    return false;
  }
}

// Detect logs: many lines, a high share of which look like log entries —
// timestamps, level markers (INFO/WARN/ERROR/DEBUG), or stack-trace lines.
function looksLikeLogs(text) {
  if (!text || typeof text !== 'string') return false;
  const lines = text.split('\n').filter(l => l.trim().length > 0);
  if (lines.length < 5) return false; // logs are multi-line by nature

  const logLinePattern = /(\b(INFO|WARN|WARNING|ERROR|DEBUG|TRACE|FATAL)\b)|(\d{4}-\d{2}-\d{2})|(\d{2}:\d{2}:\d{2})|(^\s+at\s+)/i;
  let hits = 0;
  for (const line of lines) {
    if (logLinePattern.test(line)) hits++;
  }
  // If a clear majority of lines look like log entries, call it logs.
  return (hits / lines.length) >= 0.4;
}

// Main classifier: returns a simple type label.
// Order matters — JSON is the most specific, then logs, else plain text.
// (Java code is handled separately by codestore's detectJavaCode, upstream.)
function detectContentType(text) {
  if (looksLikeJson(text)) return 'json';
  if (looksLikeLogs(text)) return 'logs';
  return 'text';
}
// Minify JSON: parse and re-stringify with no whitespace. Lossless — values
// are byte-for-byte identical, only formatting whitespace is removed.
// Returns { minified, savedTokens } or null if it can't safely minify.
function minifyJson(text) {
  try {
    const parsed = JSON.parse(text.trim());
    const minified = JSON.stringify(parsed);          // no spaces, no newlines
    const beforeTokens = Math.round(text.length / 4);
    const afterTokens  = Math.round(minified.length / 4);
    const savedTokens  = Math.max(0, beforeTokens - afterTokens);
    return { minified, savedTokens, beforeTokens, afterTokens };
  } catch {
    return null;  // not valid JSON after all — leave it untouched
  }
}
// Compress logs: collapse runs of CONSECUTIVE identical lines into one line
// with a (×N) count. Error/warn/fatal lines are never collapsed. This is mildly
// lossy (individual repeat timestamps are dropped) but preserves all signal.
// Returns { compressed, savedTokens, beforeTokens, afterTokens } or null.
function compressLogs(text) {
  try {
    const lines = text.split('\n');
    const out = [];
    const preserve = /\b(ERROR|WARN|WARNING|FATAL)\b/i;

    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      // Never collapse error/warn lines — keep them verbatim.
      if (preserve.test(line)) {
        out.push(line);
        i++;
        continue;
      }
      // Count consecutive identical lines.
      let count = 1;
      while (i + count < lines.length && lines[i + count] === line) count++;
      if (count > 1) {
        out.push(`${line}  (×${count})`);
      } else {
        out.push(line);
      }
      i += count;
    }

    const compressed = out.join('\n');
    const beforeTokens = Math.round(text.length / 4);
    const afterTokens  = Math.round(compressed.length / 4);
    const savedTokens  = Math.max(0, beforeTokens - afterTokens);
    return { compressed, savedTokens, beforeTokens, afterTokens };
  } catch {
    return null;
  }
}
module.exports = {
  detectContentType,
  looksLikeJson,
  looksLikeLogs,
  minifyJson,
  compressLogs,
};