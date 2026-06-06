'use strict';

/**
 * CtxCrush V2 — Retrieval (Stage 4)
 * PageIndex-style structured retrieval, simplified (Path A: within current request).
 *
 * Organizes old messages into a TREE whose branches are the compressor's
 * existing categories, then retrieves the branch(es) relevant to the new query.
 *
 * This is "simple matching" retrieval (keyword/relevance overlap).
 * FUTURE (flagged): reasoning-based navigation (LLM picks the branch),
 * and Path B (retrieve across stored past conversations, needs a database).
 */

const { classifyMessage } = require('./compressor');

const STOPWORDS = new Set([
  'the','a','an','and','or','but','is','are','was','were','be','been','to','of',
  'in','on','for','with','as','at','by','from','this','that','these','those','it',
  'i','you','he','she','we','they','my','your','our','can','do','does','how','what',
  'why','when','where','which','please','help','me','about','need','want'
]);

function tokenize(text) {
  if (!text || typeof text !== 'string') return new Set();
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOPWORDS.has(w));
  return new Set(words);
}

function buildTree(oldMessages) {
  const tree = {};
  oldMessages.forEach((msg, i) => {
    const events = classifyMessage(msg, i + 1);
    for (const ev of events) {
      if (!tree[ev.category]) tree[ev.category] = [];
      tree[ev.category].push({
        data: ev.data,
        priority: ev.priority,
        tokens: tokenize(ev.data),
      });
    }
  });
  return tree;
}

function scoreBranch(branchItems, queryTokens) {
  let score = 0;
  for (const item of branchItems) {
    let overlap = 0;
    for (const t of queryTokens) {
      if (item.tokens.has(t)) overlap++;
    }
    if (overlap > 0) {
      score += overlap * (5 - Math.min(item.priority, 4));
    }
  }
  return score;
}

function retrieveRelevant(oldMessages, queryText, opts = {}) {
  const maxBranches       = opts.maxBranches       || 2;
  const maxItemsPerBranch = opts.maxItemsPerBranch || 5;

  const tree = buildTree(oldMessages);
  const queryTokens = tokenize(queryText);

  const branchScores = Object.keys(tree).map(cat => ({
    category: cat,
    score: scoreBranch(tree[cat], queryTokens),
    itemCount: tree[cat].length,
  })).sort((a, b) => b.score - a.score);

  const chosen = branchScores.filter(b => b.score > 0).slice(0, maxBranches);

  const retrieved = [];
  for (const b of chosen) {
    const items = tree[b.category]
      .slice()
      .sort((x, y) => x.priority - y.priority)
      .slice(0, maxItemsPerBranch)
      .map(item => ({ category: b.category, data: item.data }));
    retrieved.push(...items);
  }

  return { retrieved, tree, branchScores };
}

function formatRetrieved(retrieved) {
  if (!retrieved.length) return '';
  const lines = retrieved.map(r => `  [${r.category}] ${r.data}`);
  return `<retrieved_context>\n${lines.join('\n')}\n</retrieved_context>`;
}

module.exports = { buildTree, retrieveRelevant, formatRetrieved, tokenize };