'use strict';

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.CTXCRUSH_DB || './ctxcrush.db';
let db = null;

// ─────────────────────────────────────────────────────────────
// INIT: set up database and schema
// ─────────────────────────────────────────────────────────────

async function initStore() {
  db = new Database(DB_PATH);
  console.log(`[store] database ready at ${DB_PATH}`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_activity TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  console.log('[store] ✓ sessions table ready');

  db.exec(`
    CREATE TABLE IF NOT EXISTS content_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      fragment_id TEXT NOT NULL,
      original_size_tokens INTEGER,
      chunk_text TEXT NOT NULL,
      chunk_index INTEGER,
      indexed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `);
  console.log('[store] ✓ content_chunks table ready');

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS content_fts USING fts5(
      chunk_text,
      content=content_chunks,
      content_rowid=id
    )
  `);
  console.log('[store] ✓ content_fts (full-text search) ready');

  db.exec(`
    CREATE TABLE IF NOT EXISTS session_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      event_data JSON,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `);
  console.log('[store] ✓ session_events table ready');

  db.exec(`CREATE INDEX IF NOT EXISTS idx_content_chunks_session ON content_chunks(session_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_session_events_session ON session_events(session_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_session_events_created ON session_events(created_at)`);
  console.log('[store] ✓ all schema migrations complete');
}

// ─────────────────────────────────────────────────────────────
// SESSION MANAGEMENT
// ─────────────────────────────────────────────────────────────

async function getOrCreateSession(sessionId, userId) {
  const row = db.prepare('SELECT id FROM sessions WHERE id = ?').get(sessionId);
  if (row) {
    db.prepare('UPDATE sessions SET last_activity = CURRENT_TIMESTAMP WHERE id = ?').run(sessionId);
    return sessionId;
  }
  db.prepare('INSERT INTO sessions (id, user_id) VALUES (?, ?)').run(sessionId, userId || 'anonymous');
  console.log(`[store] created session ${sessionId}`);
  return sessionId;
}

// ─────────────────────────────────────────────────────────────
// CONTENT INDEXING ("search it later") — Stage 8: LIVE
// ─────────────────────────────────────────────────────────────

async function indexContentChunk(sessionId, fragmentId, chunkText, originalTokens, chunkIndex = 0) {
  const chunkSizeTokens = Math.round(chunkText.length / 4);
  // Skip if this session already indexed this fragment (idempotent across requests)
  const existing = db.prepare(
    'SELECT id FROM content_chunks WHERE session_id = ? AND fragment_id = ?'
  ).get(sessionId, fragmentId);
  if (existing) {
    console.log(`[store] fragment ${fragmentId} already indexed (rowid=${existing.id}) — skipping duplicate`);
    return existing.id;
  }
  const savings = originalTokens - chunkSizeTokens;

  const info = db.prepare(
    `INSERT INTO content_chunks (session_id, fragment_id, original_size_tokens, chunk_text, chunk_index)
     VALUES (?, ?, ?, ?, ?)`
  ).run(sessionId, fragmentId, originalTokens, chunkText, chunkIndex);

  const rowId = info.lastInsertRowid;

  // keep the FTS index in sync (external-content FTS5 table)
  db.prepare(
    `INSERT INTO content_fts (rowid, chunk_text) VALUES (?, ?)`
  ).run(rowId, chunkText);

 console.log(
    `[store] ✓ indexed chunk ${chunkIndex} | session=${sessionId} | fragment=${fragmentId} ` +
    `| rowid=${rowId} | original=${originalTokens}tok | stored`
  );
  return rowId;
}

async function searchContent(query, limit = 5) {
  if (!query || query.trim().length === 0) return [];

  // FTS5 treats punctuation (, ? . etc.) as query operators — strip to safe terms.
  // Keep words of 3+ chars, drop the rest, OR them together so any term can match.
  const ftsQuery = query
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')        // punctuation → space
    .split(/\s+/)
    .filter(w => w.length >= 3)       // drop tiny words
    .map(w => `"${w}"`)               // quote each term (extra-safe)
    .join(' OR ');

  if (!ftsQuery) return [];           // nothing searchable left

  const rows = db.prepare(
    `SELECT
       cc.id,
       cc.session_id,
       cc.fragment_id,
       cc.chunk_text,
       cc.chunk_index,
       rank AS relevance_score
     FROM content_fts
     JOIN content_chunks cc ON content_fts.rowid = cc.id
    WHERE content_fts MATCH ?
     ORDER BY rank
     LIMIT ?`
  ).all(ftsQuery, limit);

  if (rows && rows.length > 0) {
    console.log(`[store] ✓ search found ${rows.length} chunks | query="${query}"`);
    return rows;
  }
  console.log(`[store] search found 0 chunks | query="${query}"`);
  return [];
}

async function getContentChunksBySession(sessionId) {
  return db.prepare(
    'SELECT id, fragment_id, original_size_tokens, LENGTH(chunk_text) as chunk_bytes FROM content_chunks WHERE session_id = ?'
  ).all(sessionId);
}

// ─────────────────────────────────────────────────────────────
// SESSION EVENT LOGGING — Stage 9: still log-only
// ─────────────────────────────────────────────────────────────

async function logSessionEvent(sessionId, eventType, eventData) {
  console.log(
    `[store] would log event | session=${sessionId} | type=${eventType} | data=${JSON.stringify(eventData).substring(0, 80)}...`
  );
  return null;
}

async function getSessionEvents(sessionId, limit = 50) {
  const rows = db.prepare(
    'SELECT event_type, event_data, created_at FROM session_events WHERE session_id = ? ORDER BY created_at DESC LIMIT ?'
  ).all(sessionId, limit);
  return rows ? rows.reverse() : [];
}

async function getSessionSnapshot(sessionId, lookbackEvents = 20) {
  console.log(`[store] would build snapshot | session=${sessionId} | lookback ${lookbackEvents} events`);
  return null;
}

// ─────────────────────────────────────────────────────────────
// SEARCH RESULT FORMATTING (Stage 8)
// ─────────────────────────────────────────────────────────────

function formatSearchResults(chunks) {
  if (!chunks || chunks.length === 0) return null;
  let formattedText = '[Retrieved from indexed content:]\n\n';
  chunks.forEach((chunk, idx) => {
    formattedText += `[Chunk ${idx + 1} from ${chunk.fragment_id}]\n${chunk.chunk_text}\n\n`;
  });
  return formattedText;
}

// ─────────────────────────────────────────────────────────────
// UTILITIES & CLEANUP
// ─────────────────────────────────────────────────────────────

async function getStoreStats() {
  const stats = {};
  stats.sessions = db.prepare('SELECT COUNT(*) as count FROM sessions').get().count;
  stats.content_chunks = db.prepare('SELECT COUNT(*) as count FROM content_chunks').get().count;
  stats.session_events = db.prepare('SELECT COUNT(*) as count FROM session_events').get().count;
  return stats;
}

async function closeStore() {
  if (db) {
    db.close();
    console.log('[store] database closed');
  }
}

// ─────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────

module.exports = {
  initStore,
  getOrCreateSession,
  indexContentChunk,
  searchContent,
  formatSearchResults,
  getContentChunksBySession,
  logSessionEvent,
  getSessionEvents,
  getSessionSnapshot,
  getStoreStats,
  closeStore,
};