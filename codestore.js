'use strict';

/**
 * CtxCrush — Session Code Store (Phase 2, LOG-ONLY wiring)
 * Holds parsed code functions per session so large code can later be replaced
 * with a compact reference (saving tokens) and recalled by name.
 *
 * HONEST LIMITATION: in-memory, session-scoped. Lost on restart, not shared
 * across instances. Fine for first version/demo; persistence needed for prod.
 */

const crypto = require('crypto');
const { parseJava } = require('./codeparse');

const store = new Map(); // sessionId -> { functions: Map<name,unit>, lineCount }

// Stable session id derived from the FIRST user message
function deriveSessionId(messages) {
  if (!Array.isArray(messages)) return 'nosession';
  const firstUser = messages.find(m => m.role === 'user');
  const seed = firstUser
    ? (typeof firstUser.content === 'string' ? firstUser.content : JSON.stringify(firstUser.content))
    : 'empty';
  return crypto.createHash('sha1').update(seed).digest('hex').slice(0, 10);
}

// Detect a Java code block in a message's text. Returns {lang, code} or null.
function detectJavaCode(text) {
  if (typeof text !== 'string') return null;
  const fenced = text.match(/```(?:java)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const looksJava = /\b(public|private|protected)\s+(class|void|static|final|double|int|String|boolean)\b/.test(candidate)
    && candidate.split('\n').length >= 8;
  if (looksJava) return { lang: 'java', code: candidate.trim() };
  return null;
}

// Parse + store code for a session; return a compact reference + stats.
async function ingestCode(sessionId, code) {
  const units = await parseJava(code);
  const methods = units.filter(u => u.type === 'method');
  if (!store.has(sessionId)) store.set(sessionId, { functions: new Map(), lineCount: 0 });
  const sess = store.get(sessionId);
  for (const u of units) sess.functions.set(u.name.toLowerCase(), u);
  sess.lineCount = code.split('\n').length;
  const names = methods.map(m => m.name).join(', ');
  return {
    reference: `[CtxCrush indexed ${methods.length} Java methods from ${sess.lineCount} lines. Functions: ${names}]`,
    indexed: methods.length,
    names,
  };
}
// Detect whether a message is asking to recall a stored function.
// Returns the function name to surface, or null.
function detectRecallRequest(text, knownNames) {
  if (typeof text !== 'string' || !Array.isArray(knownNames) || !knownNames.length) return null;
  const recallVerb = /\b(show|view|see|pull up|display|recall|what does|how does|explain|method|function|code for)\b/i.test(text);
  for (const name of knownNames) {
    const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\b`, 'i');
    if (re.test(text)) {
      if (recallVerb || text.toLowerCase().includes(name.toLowerCase())) return name;
    }
  }
  return null;
}
function recallFunction(sessionId, name) {
  const sess = store.get(sessionId);
  if (!sess) return null;
  return sess.functions.get(name.toLowerCase()) || null;
}

function listFunctions(sessionId) {
  const sess = store.get(sessionId);
  return sess ? [...sess.functions.values()] : [];
}

module.exports = { deriveSessionId, detectJavaCode, ingestCode, recallFunction, listFunctions, detectRecallRequest, store };