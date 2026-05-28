/**
 * CtxCrush — Compression Engine v4
 *
 * Borrowed from context-mode (github.com/mksglu/context-mode):
 *   - 13-category event classification with priority weights (1=critical…5=low)
 *   - XML session_resume snapshot format (structured sections per category)
 *   - Decisions, errors, intent, role, blocker, task detection
 *   - Filler pruning
 *
 * Adapted for browser / ChatGPT fetch interception:
 *   - Pure JS, no Node/SQLite/filesystem dependencies
 *   - Works on raw ChatGPT messages[] array (role + content)
 *   - Sliding window: recent N messages kept verbatim
 *   - Old messages → classified events → XML snapshot block
 */

'use strict';

// ─── Config ─────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG = {
  enabled: true,
  windowSize: 10,          // keep last N messages verbatim
  minMessagesToCompress: 6,
  pruneFillers: true,
  maxEventsPerCategory: 12  // cap per section to keep XML compact
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function estimateTokens(text) {
  return Math.ceil((text || '').length / 4);
}

function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content.filter(b => b && b.type === 'text').map(b => b.text || '').join('\n').trim();
  return String(content || '');
}

function escapeXML(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ─── Filler pruning (context-mode style) ────────────────────────────────────

const FILLER_RX = [
  /^(sure[,!.]?|certainly[,!.]?|of course[,!.]?|absolutely[,!.]?|great[,!.]?)\s+/i,
  /^(i understand[,.]?|i see[,.]?|got it[,.]?|noted[,.]?)\s+/i,
  /\bplease (let me know|feel free to ask)[^.!?\n]*[.!]?\s*$/gim,
  /\b(hope this helps|hope that helps)[.!]?\s*$/gim,
  /\bis there anything else[^.!?\n]*[.!]?\s*$/gim,
  /\b(certainly|of course)[,!]?\s+/gi,
  /^(thank you for (your|the) (question|message|context))[^.!\n]*[.!]?\s*/gim
];

function pruneFiller(text) {
  let s = text;
  for (const rx of FILLER_RX) s = s.replace(rx, '');
  return s.trim();
}

// ─── Event Classification ────────────────────────────────────────────────────
// Adapted from context-mode/src/session/extract.ts
// Priority: 1=critical, 2=high, 3=medium, 4=low, 5=noise

const QUESTION_MARK_RX   = /[?？؟¿]/u;
const ALPHABETIC_RX      = /\p{L}/u;
const CLAUSE_SEP_RX      = /[,;，；、،]/u;
const TWO_TOKENS_RX      = /\p{L}+\s+\p{L}+/u;
const LONG_RUN_RX        = /\p{L}{6,}/u;
const BLOCKER_RX         = /(?:Error\s*:|Exception\s*:|Traceback\b|\bat\s+\S+\s*\([^)]*:\d+:\d+\))/u;
const RESOLVED_MARK_RX   = /[✓✔✅☑🎉]/u;
const RESOLVED_TEXT_RX   = /^\s*(?:fixed|resolved)\s*:/iu;
const CODE_FENCE_RX      = /```[\s\S]*?```|`[^`]+`/;
const DECISION_VERB_RX   = /\b(use|don't|avoid|switch|changed|decided|instead|chosen|picked|prefer|must|should|will not|won't|let's|we'll)\b/i;
const URL_RX             = /https?:\/\/[^\s)>\]"']+/g;
const TASK_SIGNAL_RX     = /\b(todo|task|ticket|issue|fix|implement|build|create|add|remove|refactor|update|deploy|test)\b/i;
const ERROR_SIGNAL_RX    = /\b(error|bug|fail|broken|exception|crash|undefined|null|cannot|invalid|unexpected)\b/i;

/**
 * Classify a single message into one or more typed events.
 * Returns array of { category, type, data, priority }
 */
function classifyMessage(msg, index) {
  const role    = msg.role; // 'user' | 'assistant' | 'system'
  const raw     = extractText(msg.content);
  const text    = raw.trim();
  const events  = [];

  if (!text) return events;

  // ── Priority 1: errors ───────────────────────────────────────────
  if (BLOCKER_RX.test(text)) {
    if (RESOLVED_MARK_RX.test(text) || RESOLVED_TEXT_RX.test(text)) {
      events.push({ category: 'error', type: 'error_resolved', data: text.slice(0, 300), priority: 1 });
    } else {
      events.push({ category: 'error', type: 'error', data: text.slice(0, 300), priority: 1 });
    }
  }

  // ── Priority 1: code blocks ──────────────────────────────────────
  const codeMatch = text.match(/```[\w]*\n?([\s\S]*?)```/);
  if (codeMatch) {
    const lang    = (text.match(/```(\w+)/) || [])[1] || 'code';
    const snippet = codeMatch[1].trim().slice(0, 200);
    events.push({ category: 'code', type: 'code_block', data: `[${lang}] ${snippet}`, priority: 1 });
  }

  // ── Priority 1: tasks / todos (user messages) ────────────────────
  if (role === 'user' && TASK_SIGNAL_RX.test(text)) {
    const first = text.split('\n')[0].slice(0, 200);
    events.push({ category: 'task', type: 'task', data: first, priority: 1 });
  }

  // ── Priority 2: decisions ────────────────────────────────────────
  if (DECISION_VERB_RX.test(text) && CLAUSE_SEP_RX.test(text)) {
    const snippet = text.slice(0, 250);
    events.push({ category: 'decision', type: 'decision', data: snippet, priority: 2 });
  } else if (
    role === 'user' &&
    CLAUSE_SEP_RX.test(text) &&
    ALPHABETIC_RX.test(text) &&
    !QUESTION_MARK_RX.test(text) &&
    [...text].length >= 15 &&
    [...text].length <= 500
  ) {
    events.push({ category: 'decision', type: 'decision', data: text.slice(0, 250), priority: 2 });
  }

  // ── Priority 2: resolved marks ("fixed ✓", "resolved: ...") ────
  if (!events.find(e => e.type === 'error_resolved') &&
      (RESOLVED_MARK_RX.test(text) || RESOLVED_TEXT_RX.test(text))) {
    const first = text.split('\n')[0].slice(0, 200);
    events.push({ category: 'error', type: 'error_resolved', data: first, priority: 2 });
  }

  // ── Priority 2: errors in plain text ────────────────────────────
  if (!events.find(e => e.category === 'error') && ERROR_SIGNAL_RX.test(text)) {
    const first = text.split('\n').find(l => ERROR_SIGNAL_RX.test(l)) || text.slice(0, 200);
    events.push({ category: 'error', type: 'error_mention', data: first.slice(0, 200), priority: 2 });
  }

  // ── Priority 2: URLs / external references ───────────────────────
  const urls = (text.match(URL_RX) || []).slice(0, 3);
  if (urls.length) {
    events.push({ category: 'external', type: 'url', data: urls.join(', '), priority: 2 });
  }

  // ── Priority 3: role / persona (only explicit persona instructions) ──
  if (role === 'user') {
    const first = text.split(/[.!\n。！]/u)[0].trim();
    const isPersona = /^(you are|act as|behave as|pretend|your role|as a)/i.test(first);
    if (isPersona && [...first].length >= 8 && [...first].length <= 120) {
      events.push({ category: 'role', type: 'role', data: first, priority: 3 });
    }
  }

  // ── Priority 3: intent ────────────────────────────────────────────
  if (role === 'user') {
    if (QUESTION_MARK_RX.test(text)) {
      events.push({ category: 'intent', type: 'intent', data: 'investigate', priority: 3 });
    } else if ([...text].length < 60 && ALPHABETIC_RX.test(text)) {
      events.push({ category: 'intent', type: 'intent', data: 'implement', priority: 3 });
    }
  }

  // ── Priority 4: large data blobs ─────────────────────────────────
  if (text.length > 1024) {
    const preview = text.slice(0, 200).replace(/\n/g, ' ');
    events.push({ category: 'data', type: 'large_data', data: `[${text.length} chars] ${preview}`, priority: 4 });
  }

  // ── Fallback: general summary ─────────────────────────────────────
  // Always emit at least one event per message so the snapshot is complete
  if (events.length === 0 || !events.find(e => e.priority <= 3)) {
    const roleLabel = role === 'user' ? 'U' : 'A';
    const firstLine = text.split('\n').find(l => l.trim()) || text;
    const preview   = firstLine.length > 160 ? firstLine.slice(0, 160) + '…' : firstLine;
    events.push({ category: 'summary', type: 'summary', data: `[${roleLabel}:${index}] ${preview}`, priority: 4 });
  }

  return events;
}

// ─── XML Snapshot Builder ────────────────────────────────────────────────────
// Adapted from context-mode/src/session/snapshot.ts

function buildSection(tag, events, maxItems) {
  if (!events.length) return '';
  const limited = events.slice(-maxItems);
  const lines   = limited.map(e => `  <${e.type}>${escapeXML(e.data)}</${e.type}>`);
  return [`<${tag}>`, ...lines, `</${tag}>`].join('\n');
}

function buildXMLSnapshot(oldMsgs, cfg) {
  const MAX = cfg.maxEventsPerCategory;
  

  // Classify all old messages into events
  const allEvents = [];
  for (let i = 0; i < oldMsgs.length; i++) {
    const events = classifyMessage(oldMsgs[i], i + 1);
    allEvents.push(...events);
  }

  // Group by category, sorted by priority within each group
  const byCategory = {};
  for (const ev of allEvents) {
    if (!byCategory[ev.category]) byCategory[ev.category] = [];
    byCategory[ev.category].push(ev);
  }

  // Build sections in priority order (most important first)
  const CATEGORY_ORDER = ['error', 'code', 'task', 'decision', 'external', 'role', 'data', 'summary'];
  const sections = [];

  // Compact header note
  sections.push(`  <note>Compressed prior context. Recent messages follow verbatim.</note>`);

  // Intent summary (last intent wins)
  const intentEvents = byCategory['intent'] || [];
  if (intentEvents.length) {
    const last = intentEvents[intentEvents.length - 1];
    sections.push(`  <intent mode="${escapeXML(last.data)}" detected_at="msg_${oldMsgs.length}"/>`);
  }

  // Build each category section
  for (const cat of CATEGORY_ORDER) {
    if (cat === 'intent') continue; // already handled
    const evs = byCategory[cat];
    if (!evs || !evs.length) continue;

    // Deduplicate by data content
    const seen = new Set();
    const deduped = evs.filter(e => {
      if (seen.has(e.data)) return false;
      seen.add(e.data);
      return true;
    });

    const section = buildSection(cat, deduped, MAX);
    if (section) sections.push(section);
  }

  const msgCount  = oldMsgs.length;
  const evCount   = allEvents.length;
  const header    = `<ctx msgs="${msgCount}" events="${evCount}">`;
  const footer    = `</ctx>`;
  const body      = sections.join('\n\n');

  return `${header}\n\n${body}\n\n${footer}`;
}

// ─── Main compress function ──────────────────────────────────────────────────

function compressMessages(messages, config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  if (!cfg.enabled) return { messages, stats: { skipped: true, reason: 'disabled' } };

  const systemMsgs = messages.filter(m => m.role === 'system');
  const convoMsgs  = messages.filter(m => m.role !== 'system');

  if (convoMsgs.length < cfg.minMessagesToCompress)
    return { messages, stats: { skipped: true, reason: `only ${convoMsgs.length} messages` } };

  const tokensBefore = messages.reduce((s, m) => s + estimateTokens(extractText(m.content)), 0);

  const windowSize = Math.min(cfg.windowSize, convoMsgs.length - 1);
  const oldMsgs    = convoMsgs.slice(0, -windowSize);
  const recentMsgs = convoMsgs.slice(-windowSize);

  if (oldMsgs.length === 0)
    return { messages, stats: { skipped: true, reason: 'nothing old enough to compress' } };

  // Build XML snapshot from old messages
  const snapshotXML = buildXMLSnapshot(oldMsgs, cfg);
  const snapshotBlock = { role: 'system', content: snapshotXML };

  // Measure: only use snapshot if it saves tokens
  const oldTokens      = oldMsgs.reduce((s, m) => s + estimateTokens(extractText(m.content)), 0);
  const snapshotTokens = estimateTokens(snapshotXML);

  let compressedOld;
  let compressionType;

  if (snapshotTokens < oldTokens) {
    compressedOld    = [snapshotBlock];
    compressionType  = 'xml_snapshot';
  } else {
    // Snapshot not smaller — just prune fillers from old messages
    compressedOld = oldMsgs.map(msg => {
      if (!cfg.pruneFillers || msg.role !== 'assistant') return msg;
      const raw    = extractText(msg.content);
      const pruned = pruneFiller(raw);
      return { ...msg, content: pruned || raw };
    });
    compressionType = 'filler_prune';
  }

  // Prune fillers from recent assistant messages (keep full length)
  const finalRecent = recentMsgs.map(msg => {
    if (!cfg.pruneFillers || msg.role !== 'assistant') return msg;
    const raw    = extractText(msg.content);
    const pruned = pruneFiller(raw);
    return { ...msg, content: pruned || raw };
  });

  const compressed   = [...systemMsgs, ...compressedOld, ...finalRecent];
  const tokensAfter  = compressed.reduce((s, m) => s + estimateTokens(extractText(m.content)), 0);
  const tokensSaved  = Math.max(0, tokensBefore - tokensAfter);
  const percentSaved = tokensBefore > 0 ? Math.round((tokensSaved / tokensBefore) * 100) : 0;

  if (tokensSaved === 0)
    return { messages, stats: { skipped: true, reason: 'no tokens saved' } };

  return {
    messages: compressed,
    stats: {
      skipped: false,
      tokensBefore,
      tokensAfter,
      tokensSaved,
      percentSaved,
      originalMsgCount:   messages.length,
      compressedMsgCount: compressed.length,
      oldMsgsCompressed:  oldMsgs.length,
      recentKept:         recentMsgs.length,
      compressionType
    }
  };
}

// Expose
if (typeof window !== 'undefined') {
  window.__ctxCrush = { compressMessages, estimateTokens, extractText, classifyMessage };
  window.dispatchEvent(new CustomEvent('__ctxCrush_ready'));
}

// CommonJS export — added for proxy server use
if (typeof module !== 'undefined') {
  module.exports = { compressMessages, estimateTokens, extractText, classifyMessage };
}

