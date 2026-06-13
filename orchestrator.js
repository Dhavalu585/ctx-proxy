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

// Stage 8: coherent merge — one model call synthesizes all fragment answers
// into a single unified response. Falls back to combineResults if it fails.
async function mergeResults(originalPrompt, results, apiKey, fetchFn) {
  // Build the synthesis prompt from all the sub-answers
  const parts = results
    .map((r, i) => `Task ${i + 1} (${r.text}):\n${r.answer}`)
    .join('\n\n');

  const msgs = [
    {
      role: 'system',
      content: `You are a synthesis engine. The user asked a multi-part question that was split into sub-tasks and answered separately. Combine the sub-answers into ONE coherent, well-organized response that flows naturally. Preserve all important details (code, facts, numbers). Remove redundancy. Do not mention that the question was split into tasks. Write as a single unified answer.`
    },
    {
      role: 'user',
      content: `Original question: "${originalPrompt}"\n\nSub-answers to merge:\n\n${parts}\n\nWrite the unified response:`
    }
  ];

  try {
    const resp = await fetchFn(GROQ_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model: 'llama-3.3-70b-versatile', temperature: 0.4, messages: msgs }),
    });
    if (!resp.ok) return null;            // signal caller to use fallback
    const data = await resp.json();
    return data.choices?.[0]?.message?.content || null;
  } catch (e) {
    return null;                          // signal caller to use fallback
  }
}
// Stage 6: simple labeled concatenation. Coherent merge = Stage 8.
function combineResults(results) {
  return results
    .map((r, i) => `**Task ${i + 1}: ${r.text}**\n${r.answer}`)
    .join('\n\n---\n\n');
}

module.exports = { orchestrate, combineResults, mergeResults, runFragment };