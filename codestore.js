'use strict';

/**
 * CtxCrush — Session Code Store
 * Holds parsed code functions per session so large code can be replaced with a
 * compact reference (saving tokens) and recalled by name. Now multi-language.
 */

const crypto = require('crypto');
const { parseCode, LANGUAGES } = require('./codeparse');

const store = new Map(); // sessionId -> { functions: Map<name,unit>, lineCount, lang }

function deriveSessionId(messages) {
  if (!Array.isArray(messages)) return 'nosession';
  const firstUser = messages.find(m => m.role === 'user');
  const seed = firstUser
    ? (typeof firstUser.content === 'string' ? firstUser.content : JSON.stringify(firstUser.content))
    : 'empty';
  return crypto.createHash('sha1').update(seed).digest('hex').slice(0, 10);
}

// Map common fence tags / aliases to our registry language keys.
const FENCE_ALIASES = {
  js: 'javascript', javascript: 'javascript',
  ts: 'typescript', typescript: 'typescript',
  py: 'python', python: 'python',
  java: 'java', go: 'go', golang: 'go',
  rust: 'rust', rs: 'rust',
  cpp: 'cpp', 'c++': 'cpp', cc: 'cpp',
  cs: 'csharp', csharp: 'csharp', 'c#': 'csharp',
  php: 'php',
};

// Detect a supported code block in a message's text. Returns {lang, code} or null.
// Strategy: prefer the fenced language tag (reliable). Fall back to a light
// heuristic for untagged blocks (only Java/C-family braces + size).
function detectCode(text) {
  if (typeof text !== 'string') return null;

  // 1) Fenced block WITH a language tag: ```python ... ```
  const tagged = text.match(/```([a-zA-Z0-9+#]+)\s*\n([\s\S]*?)```/);
  if (tagged) {
    const tag = tagged[1].toLowerCase();
    const lang = FENCE_ALIASES[tag];
    if (lang && LANGUAGES[lang]) {
      const code = tagged[2].trim();
      if (code.split('\n').length >= 4) return { lang, code };
    }
  }

  // 2) Untagged fenced block or raw text: light heuristic (brace-language, size).
  const fenced = text.match(/```\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  if (candidate.split('\n').length < 8) return null;
  const looksJava = /\b(public|private|protected)\s+(class|void|static|final|double|int|String|boolean)\b/.test(candidate);
  if (looksJava) return { lang: 'java', code: candidate.trim() };

  return null;
}

// Backward-compatible alias.
function detectJavaCode(text) { return detectCode(text); }

async function ingestCode(sessionId, code, lang = 'java') {
  const units = await parseCode(code, lang);
  const methods = units.filter(u => u.type === 'method');
  if (!store.has(sessionId)) store.set(sessionId, { functions: new Map(), lineCount: 0, lang });
  const sess = store.get(sessionId);
  sess.lang = lang;
  for (const u of units) sess.functions.set(u.name.toLowerCase(), u);
  sess.lineCount = code.split('\n').length;
  const names = methods.map(m => m.name).join(', ');
  const langLabel = lang.charAt(0).toUpperCase() + lang.slice(1);
  return {
    reference: `[CtxCrush indexed ${methods.length} ${langLabel} methods from ${sess.lineCount} lines. Functions: ${names}]`,
    indexed: methods.length,
    names,
  };
}

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

function buildRichReference(sessionId, fallbackCount) {
  const sess = store.get(sessionId);
  const units = listFunctions(sessionId);
  const cls = units.find(u => u.type === 'class');
  const methods = units.filter(u => u.type === 'method');
  const lang = sess && sess.lang ? sess.lang : 'code';
  const langLabel = lang.charAt(0).toUpperCase() + lang.slice(1);
  if (!methods.length) return `[CtxCrush: ${fallbackCount || 0} methods stored, recoverable by name]`;
  let ref = `[CtxCrush: ${langLabel} ${cls ? `class ${cls.name}` : 'code'} — ${methods.length} methods stored intact and recoverable:\n`;
  for (const m of methods) ref += `  • ${m.signature || m.name}\n`;
  ref += `Full source preserved; ask to view any method by name.]`;
  return ref;
}

function replaceCodeWithReference(originalText, codeBlock, reference) {
  const fencedRe = /```[a-zA-Z0-9+#]*\s*[\s\S]*?```/;
  if (fencedRe.test(originalText)) return originalText.replace(fencedRe, reference);
  return originalText.replace(codeBlock, reference);
}

function buildRecallInjection(fn, lang = '') {
  return {
    role: 'system',
    content: `The developer is asking about the "${fn.name}" method. Here is its full source code (recovered from CtxCrush's code store):\n\`\`\`${lang}\n${fn.code}\n\`\`\`\nUse this exact code to answer their question.`
  };
}

module.exports = { deriveSessionId, detectCode, detectJavaCode, ingestCode, recallFunction, listFunctions, detectRecallRequest, buildRichReference, replaceCodeWithReference, buildRecallInjection, store };
