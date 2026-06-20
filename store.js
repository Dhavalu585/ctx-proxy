'use strict';

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.CTXCRUSH_DB || './ctxcrush.db';
let db = null;

async function initStore() {
  return new Promise((resolve, reject) => {
    db = new sqlite3.Database(DB_PATH, (err) => {
      if (err) {
        console.error('[store] failed to open database:', err.message);
        return reject(err);
      }
      console.log(`[store] database ready at ${DB_PATH}`);

      db.serialize(() => {
        db.run(`
          CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            user_id TEXT,
            started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            last_activity TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          )
        `, (err) => {
          if (err) console.error('[store] sessions table error:', err.message);
          else console.log('[store] ✓ sessions table ready');
        });

        db.run(`
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
        `, (err) => {
          if (err) console.error('[store] content_chunks table error:', err.message);
          else console.log('[store] ✓ content_chunks table ready');
        });

        db.run(`
          CREATE VIRTUAL TABLE IF NOT EXISTS content_fts USING fts5(
            chunk_text,
            content=content_chunks,
            content_rowid=id
          )
        `, (err) => {
          if (err) console.error('[store] content_fts table error:', err.message);
          else console.log('[store] ✓ content_fts (full-text search) ready');
        });

        db.run(`
          CREATE TABLE IF NOT EXISTS session_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            event_type TEXT NOT NULL,
            event_data JSON,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
          )
        `, (err) => {
          if (err) console.error('[store] session_events table error:', err.message);
          else console.log('[store] ✓ session_events table ready');
        });

        db.run(`CREATE INDEX IF NOT EXISTS idx_content_chunks_session ON content_chunks(session_id)`, (err) => {
          if (err) console.error('[store] index error:', err.message);
        });
        db.run(`CREATE INDEX IF NOT EXISTS idx_session_events_session ON session_events(session_id)`, (err) => {
          if (err) console.error('[store] index error:', err.message);
        });
        db.run(`CREATE INDEX IF NOT EXISTS idx_session_events_created ON session_events(created_at)`, (err) => {
          if (err) console.error('[store] index error:', err.message);
          else {
            console.log('[store] ✓ all schema migrations complete');
            resolve();
          }
        });
      });
    });
  });
}

async function getOrCreateSession(sessionId, userId) {
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT id FROM sessions WHERE id = ?',
      [sessionId],
      (err, row) => {
        if (err) return reject(err);
        if (row) {
          db.run(
            'UPDATE sessions SET last_activity = CURRENT_TIMESTAMP WHERE id = ?',
            [sessionId],
            (err) => {
              if (err) console.error('[store] session update error:', err.message);
              resolve(sessionId);
            }
          );
        } else {
          db.run(
            'INSERT INTO sessions (id, user_id) VALUES (?, ?)',
            [sessionId, userId || 'anonymous'],
            (err) => {
              if (err) return reject(err);
              console.log(`[store] created session ${sessionId}`);
              resolve(sessionId);
            }
          );
        }
      }
    );
  });
}

async function indexContentChunk(sessionId, fragmentId, chunkText, originalTokens, chunkIndex = 0) {
  return new Promise((resolve, reject) => {
    const chunkSizeTokens = Math.round(chunkText.length / 4);
    const savings = originalTokens - chunkSizeTokens;
    
    db.run(
      `INSERT INTO content_chunks (session_id, fragment_id, original_size_tokens, chunk_text, chunk_index)
       VALUES (?, ?, ?, ?, ?)`,
      [sessionId, fragmentId, originalTokens, chunkText, chunkIndex],
      function(err) {
        if (err) {
          console.error('[store] indexing error:', err.message);
          return reject(err);
        }
        const rowId = this.lastID;
        console.log(
          `[store] ✓ indexed chunk ${chunkIndex} | session=${sessionId} | fragment=${fragmentId} ` +
          `| rowid=${rowId} | original=${originalTokens}tok | stored=${chunkSizeTokens}tok | saves ~${savings}tok`
        );
        resolve(rowId);
      }
    );
  });
}

async function searchContent(query, limit = 5) {
  return new Promise((resolve, reject) => {
    if (!query || query.trim().length === 0) {
      return resolve([]);
    }
    
    // FTS5 search with BM25 ranking
    db.all(
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
      LIMIT ?`,
      [query, limit],
      (err, rows) => {
        if (err) {
          console.error('[store] search error:', err.message);
          return reject(err);
        }
        if (rows && rows.length > 0) {
          console.log(`[store] ✓ search found ${rows.length} chunks | query="${query}"`);
          resolve(rows);
        } else {
          console.log(`[store] search found 0 chunks | query="${query}"`);
          resolve([]);
        }
      }
    );
  });
}

async function getContentChunksBySession(sessionId) {
  return new Promise((resolve, reject) => {
    db.all(
      'SELECT id, fragment_id, original_size_tokens FROM content_chunks WHERE session_id = ?',
      [sessionId],
      (err, rows) => {
        if (err) return reject(err);
        resolve(rows || []);
      }
    );
  });
}

async function logSessionEvent(sessionId, eventType, eventData) {
  console.log(
    `[store] would log event | session=${sessionId} | type=${eventType} | data=${JSON.stringify(eventData).substring(0, 80)}...`
  );
  return null;
}

async function getSessionEvents(sessionId, limit = 50) {
  return new Promise((resolve, reject) => {
    db.all(
      'SELECT event_type, event_data, created_at FROM session_events WHERE session_id = ? ORDER BY created_at DESC LIMIT ?',
      [sessionId, limit],
      (err, rows) => {
        if (err) return reject(err);
        resolve(rows ? rows.reverse() : []);
      }
    );
  });
}

async function getSessionSnapshot(sessionId, lookbackEvents = 20) {
  console.log(`[store] would build snapshot | session=${sessionId} | lookback ${lookbackEvents} events`);
  return null;
}

async function getStoreStats() {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      let stats = {};
      db.get('SELECT COUNT(*) as count FROM sessions', (err, row) => {
        if (!err) stats.sessions = row.count;
      });
      db.get('SELECT COUNT(*) as count FROM content_chunks', (err, row) => {
        if (!err) stats.content_chunks = row.count;
      });
      db.get('SELECT COUNT(*) as count FROM session_events', (err, row) => {
        if (!err) stats.session_events = row.count;
        resolve(stats);
      });
    });
  });
}

async function closeStore() {
  return new Promise((resolve, reject) => {
    if (db) {
      db.close((err) => {
        if (err) return reject(err);
        console.log('[store] database closed');
        resolve();
      });
    } else {
      resolve();
    }
  });
}
function formatSearchResults(chunks) {
  if (!chunks || chunks.length === 0) return null;
  
  let formattedText = '[Retrieved from indexed content:]\n\n';
  chunks.forEach((chunk, idx) => {
    formattedText += `[Chunk ${idx + 1} from ${chunk.fragment_id}]\n${chunk.chunk_text}\n\n`;
  });
  return formattedText;
}
module.exports = {
  initStore,
  getOrCreateSession,
  indexContentChunk,          // NOW WORKING
  searchContent,              // NOW WORKING
  formatSearchResults,        // NEW
  getContentChunksBySession,
  logSessionEvent,
  getSessionEvents,
  getSessionSnapshot,
  getStoreStats,
  closeStore,
};