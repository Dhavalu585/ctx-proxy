'use strict';

/**
 * CtxCrush — Fact Snapshot (Phase 1: rule-based extraction, LOG-ONLY)
 * Extracts structured critical facts from conversation messages into a
 * categorized snapshot. Free, deterministic, no AI. Catches patterned facts;
 * unstructured facts (e.g. "two weeks after launch") need the later AI précis layer.
 */

const PATTERNS = {
  dates: [
    /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}\b/gi,
    /\b\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{4}\b/gi,
    /\b\d{4}-\d{2}-\d{2}\b/g,
    /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g,
    /\bQ[1-4]\s+\d{4}\b/gi,
    /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{4}\b/gi,
  ],
  amounts: [
    /[$€£¥]\s?\d[\d,]*(?:\.\d+)?\s?(?:million|billion|thousand|M|B|K|k|mn|bn)?\b/gi,
    /\b\d[\d,]*(?:\.\d+)?\s?(?:million|billion|thousand)\s?(?:dollars|euros|pounds|USD|EUR|GBP)?\b/gi,
  ],
  figures: [
    /\b\d+(?:\.\d+)?\s?%/g,
    /\b\d+(?:\.\d+)?\s?(?:hours?|days?|weeks?|months?|years?)\b/gi,
  ],
  times: [
    /\b\d{1,2}:\d{2}\s?(?:AM|PM|am|pm)?\b/g,
  ],
};

const DECISION_WORDS = /\b(approved|decided|agreed|committed|deadline|must|will|shall|confirmed|finalized|signed|budget|launch|deliver|due)\b/i;

const MONTHS = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i;
const STOPWORD_STARTS = /^(The|This|That|These|Those|There|However|What|When|Where|Why|How|Can|Some|Here|On|In|At|For|With|During)\b/;

function extractProperNouns(text) {
  const found = new Set();
  const re = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    let phrase = m[1];
    // strip a leading stopword like "On March" -> "March" (then drop if just a month)
    const firstWord = phrase.split(/\s+/)[0];
    if (STOPWORD_STARTS.test(firstWord)) {
      phrase = phrase.split(/\s+/).slice(1).join(' ');
    }
    if (!phrase) continue;
    if (MONTHS.test(phrase) && phrase.split(/\s+/).length === 1) continue; // skip bare month
    if (phrase.split(/\s+/).length >= 2) found.add(phrase);
  }
  return [...found];
}

function applyPatterns(text, patternList) {
  const found = new Set();
  for (const re of patternList) {
    const matches = text.match(re);
    if (matches) matches.forEach(x => found.add(x.trim()));
  }
  return [...found];
}

function extractDecisions(text) {
  const sentences = text.split(/(?<=[.!?])\s+/);
  return sentences.filter(s => DECISION_WORDS.test(s)).map(s => s.trim()).filter(Boolean);
}

function extractFacts(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const facts = {
    dates: applyPatterns(text, PATTERNS.dates),
    amounts: applyPatterns(text, PATTERNS.amounts),
    figures: applyPatterns(text, PATTERNS.figures),
    times: applyPatterns(text, PATTERNS.times),
    entities: extractProperNouns(text),
    decisions: extractDecisions(text),
  };
  const total = Object.values(facts).reduce((s, arr) => s + arr.length, 0);
  return total > 0 ? facts : null;
}
// Build a compact facts-reference from an accumulated snapshot (per-session)
function buildFactsReference(snapshot) {
  const all = { dates: new Set(), amounts: new Set(), entities: new Set(), figures: new Set(), times: new Set(), decisions: new Set() };
  for (const key of Object.keys(snapshot)) {
    const f = snapshot[key];
    for (const cat of Object.keys(all)) {
      (f[cat] || []).forEach(v => all[cat].add(v));
    }
  }
  const parts = [];
  if (all.dates.size)     parts.push(`Dates: ${[...all.dates].join('; ')}`);
  if (all.amounts.size)   parts.push(`Amounts: ${[...all.amounts].join('; ')}`);
  if (all.entities.size)  parts.push(`Names/Places: ${[...all.entities].join('; ')}`);
  if (all.figures.size)   parts.push(`Figures: ${[...all.figures].join('; ')}`);
  if (all.times.size)     parts.push(`Times: ${[...all.times].join('; ')}`);
  if (all.decisions.size) parts.push(`Key statements: ${[...all.decisions].join(' | ')}`);
  return parts.length ? parts.join('\n') : null;
}
module.exports = { extractFacts, buildFactsReference };