'use strict';

/**
 * CtxCrush V2 — Intent Classifier (Stage 2)
 * Keyword-based classification of the dominant intent in a request.
 * Stage 2: classify and LABEL only. Routing happens in Stage 3.
 *
 * Categories:
 *   - "reasoning" : coding, math, multi-step, "explain why", debugging
 *   - "simple"    : short factual questions
 *   - "medium"    : everything else (the default)
 */

// Signals that suggest a reasoning-heavy request
const REASONING_SIGNALS = [
  /```/,                                  // code block
  /\b(code|function|debug|error|bug|fix|refactor|implement|algorithm)\b/i,
  /\b(why|how does|how do|explain|reason|prove|derive|calculate|solve)\b/i,
  /\b(step by step|step-by-step|think through|work out)\b/i,
  /[=+\-*/^]\s*\d/,                        // math-like expressions
];

// Signals that suggest a simple factual request
const SIMPLE_SIGNALS = [
  /^\s*(what|who|when|where)\s+(is|are|was|were)\b/i,  // "what is...", "who was..."
  /^\s*(define|list|name)\b/i,
];

/**
 * Extract the latest user message text from a messages array.
 */
function getLatestUserText(messages) {
  if (!Array.isArray(messages)) return '';
  // walk backwards to find the most recent user message
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      const c = messages[i].content;
      if (typeof c === 'string') return c;
      if (Array.isArray(c)) return c.map(b => b.text || '').join(' ');
    }
  }
  return '';
}

/**
 * Classify the dominant intent of a request.
 * Returns one of: "reasoning" | "simple" | "medium"
 */
function classifyIntent(messages) {
  const text = getLatestUserText(messages).trim();
  if (!text) return 'medium';

  // Reasoning wins if any reasoning signal matches (highest priority)
  for (const rx of REASONING_SIGNALS) {
    if (rx.test(text)) return 'reasoning';
  }

  // Simple if it's a short factual question
  const isShort = text.length < 80;
  if (isShort) {
    for (const rx of SIMPLE_SIGNALS) {
      if (rx.test(text)) return 'simple';
    }
  }

  // Default
  return 'medium';
}

module.exports = { classifyIntent, getLatestUserText };