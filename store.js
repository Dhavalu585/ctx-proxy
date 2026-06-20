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

async function indexContentChunk(sessionId, fragmentId, chunkText, originalTokens) {
  const chunkSizeTokens = Math.round(chunkText.length / 4);
  const savings = originalTokens - chunkSizeTokens;
  console.log(
    `[store] would index chunk | session=${sessionId} | fragment=${fragmentId} ` +
    `| original=${originalTokens}tok | stored=${chunkSizeTokens}tok | saves ~${savings}tok`
  );
  return null;
}

async function searchContent(query, limit = 5) {
  console.log(`[store] would search content | query="${query}" | top ${limit} results`);
  return [];
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

module.exports = {
  initStore,
  getOrCreateSession,
  indexContentChunk,
  searchContent,
  getContentChunksBySession,
  logSessionEvent,
  getSessionEvents,
  getSessionSnapshot,
  getStoreStats,
  closeStore,
};