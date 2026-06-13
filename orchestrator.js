'use strict';

/**
 * CtxCrush V3 — Orchestrator (Stage 6 + 7)
 * Per-fragment retrieval + routing.
 * Stage 6: each fragment gets its own retrieval + model.
 * Stage 7: fragments run in PARALLEL (Promise.all) instead of sequentially.
 * Stage 8 (future): coherent merge of the fragment answers.
 */

const { modelForIntent } = require('./intent');
const { retrieveRelevant, formatRetrieved } = require('./retrieval');

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

// Run ONE fragment: retrieve its context, route to its model, get its answer.
async function runFragment(fragment, oldMessages, apiKey, fetchFn) {
  // Per-fragment retrieval — scoped to THIS fragment's text
  let contextBlock = '';
  if (Array.isArray(oldMessages) && oldMessages.length) {
    const { retrieved } = retrieveRelevant(oldMessages, fragment.text);
    if (retrieved.length) contextBlock = formatRetrieved(retrieved);
  }

  const model = modelForIntent(fragment.intent);
  const msgs = [];
  if (contextBlock) {
    msgs.push({
      role: 'system',
      content: `Relevant context from earlier in this conversation:\n${contextBlock}`
    });
  }
  msgs.push({ role: 'user', content: fragment.text });

  try {
    const resp = await fetchFn(GROQ_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model, temperature: 0.3, messages: msgs }),
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      return { ...fragment, model, ok: false, answer: `(task failed: ${resp.status} ${errText.slice(0, 120)})` };
    }
    const data = await resp.json();
    return {
      ...fragment, model, ok: true,
      answer: data.choices?.[0]?.message?.content || '(empty)',
    };
  } catch (e) {
    return { ...fragment, model, ok: false, answer: `(task error: ${e.message})` };
  }
}

// Stage 7: run ALL fragments in PARALLEL.
// Promise.all fires every fragment's model call at once and waits for all.
// Results stay in the original fragment order (Promise.all preserves order).
async function orchestrate(fragments, oldMessages, apiKey, fetchFn) {
  const results = await Promise.all(
    fragments.map(f => runFragment(f, oldMessages, apiKey, fetchFn))
  );
  return results;
}

// Stage 6: simple labeled concatenation. Coherent merge = Stage 8.
function combineResults(results) {
  return results
    .map((r, i) => `**Task ${i + 1}: ${r.text}**\n${r.answer}`)
    .join('\n\n---\n\n');
}

module.exports = { orchestrate, combineResults, runFragment };