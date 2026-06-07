'use strict';

/**
 * CtxCrush V2 — Intent Assembly (Stage 5, Path B)
 * Model-based decomposition with keyword fallback.
 */

const { classifyText } = require('./intent');

const SPLIT_PATTERNS = [
  /\s+and then\s+/i, /\s*;\s*then\s+/i, /\s*,?\s+then\s+/i,
  /\s+also,?\s+/i, /\s*;\s+/, /\s+after that,?\s+/i,
];

function splitIntoFragments(text) {
  if (!text || !text.trim()) return [];
  const clean = text.trim();
  const combined = new RegExp(SPLIT_PATTERNS.map(p => p.source).join('|'), 'i');
  let parts = clean.split(combined).map(s => (s || '').trim()).filter(Boolean);
  if (parts.length === 1) {
    const sentences = clean.split(/(?<=[.?!])\s+/).map(s => s.trim()).filter(Boolean);
    if (sentences.length > 1) parts = sentences;
  }
  return parts.length ? parts : [clean];
}

const DECOMP_MODEL = process.env.ASSEMBLY_MODEL || 'llama-3.1-8b-instant';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

const DECOMP_SYSTEM = `You are a task decomposition engine. Split the user's request into distinct, self-contained tasks.
Rules:
- Return ONLY a JSON array of strings. No prose, no markdown, no code fences.
- Each string is one task, rephrased to stand alone.
- If the request is a single task, return an array with one string.
- Maximum 5 tasks.
Example input: "Summarize the log then write a fix and tell me if it breaks prod"
Example output: ["Summarize the log","Write a fix for the issue","Assess whether the fix breaks production"]`;

async function modelDecompose(text, apiKey, fetchFn) {
  if (!apiKey) return null;
  try {
    const resp = await fetchFn(GROQ_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: DECOMP_MODEL,
        temperature: 0,
        messages: [
          { role: 'system', content: DECOMP_SYSTEM },
          { role: 'user', content: text },
        ],
      }),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    let content = data.choices?.[0]?.message?.content || '';
    content = content.trim().replace(/^```(json)?/i, '').replace(/```$/, '').trim();
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed) && parsed.every(x => typeof x === 'string') && parsed.length) {
      return parsed.map(s => s.trim()).filter(Boolean);
    }
    return null;
  } catch (e) {
    return null;
  }
}

async function assembleIntents(text, apiKey, fetchFn) {
  let pieces = await modelDecompose(text, apiKey, fetchFn);
  let method = 'model';
  if (!pieces) {
    pieces = splitIntoFragments(text);
    method = 'keyword-fallback';
  }
  const fragments = pieces.map(f => ({ text: f, intent: classifyText(f) }));
  return { fragments, isMulti: fragments.length > 1, method };
}

function formatAssembly(assembled) {
  return assembled.fragments
    .map((f, i) => `  ${i + 1}. [${f.intent}] ${f.text.slice(0, 70)}${f.text.length > 70 ? '…' : ''}`)
    .join('\n');
}

module.exports = { splitIntoFragments, assembleIntents, formatAssembly, modelDecompose };