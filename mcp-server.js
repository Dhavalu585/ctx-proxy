'use strict';

/**
 * CtxCrush — MCP Server
 * Exposes CtxCrush's compression, memory, and retrieval capabilities as MCP
 * tools, so any MCP client (Claude Desktop, Cursor, etc.) can call them
 * directly. Identity follows the same pattern as the proxy: the caller's
 * provider API key is hashed (never stored raw) to scope data per user.
 *
 * Phase 1: get_savings, recall_document. More tools added incrementally.
 */

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { z } = require('zod');
const crypto = require('crypto');
const store = require('./store');
const { compressMessages } = require('./compressor');
const { chunkText } = require('./docextract');

// Same identity derivation as server.js — one hash, never the raw key.
function deriveUserId(apiKey) {
  if (!apiKey) return 'anonymous';
  const hash = crypto.createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
  return 'u_' + hash;
}

// `stats` is passed in from server.js so the MCP server reads the SAME
// live stats object the proxy updates — not a stale copy.
function createMcpServer(stats) {
  const server = new McpServer({ name: 'ctxcrush', version: '1.0.0' });

  // ── Tool 1: get_savings ─────────────────────────────────────────────────
  server.registerTool(
    'get_savings',
    {
      description: 'Get CtxCrush\'s current token savings statistics: requests processed, tokens saved, and total tokens before compression.',
      inputSchema: {},
    },
    async () => {
      const avgSavedPct = stats.totalBefore > 0
        ? Math.round((stats.totalSaved / stats.totalBefore) * 100) + '%'
        : '0%';
      const summary = {
        requests: stats.requests,
        compressed: stats.compressed,
        skipped: stats.skipped,
        totalSaved: stats.totalSaved,
        totalBefore: stats.totalBefore,
        avgSavedPct,
        totalOutputTokens: stats.totalOutputTokens,
      };
      return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
    }
  );

  // ── Tool 2: recall_document ──────────────────────────────────────────────
  server.registerTool(
    'recall_document',
    {
      description: 'Search the caller\'s previously uploaded documents and conversation memory for content relevant to a query. Returns only content belonging to the authenticated caller — never another user\'s data.',
      inputSchema: {
        apiKey: z.string().describe('The provider API key used to identify the caller (same key used with the CtxCrush proxy). Never stored — only hashed.'),
        query: z.string().describe('What to search for, e.g. "termination clause" or "the calculateTotal function".'),
      },
    },
    async ({ apiKey, query }) => {
      const userId = deriveUserId(apiKey);

      // Same safety guard as the proxy: no valid identity → no results.
      // Never falls back to showing everything.
      if (!userId || userId === 'anonymous') {
        return {
          content: [{ type: 'text', text: 'No valid API key provided — cannot identify caller, so no content can be safely returned.' }],
        };
      }

      const userSessions = store.getSessionIdsForUser(userId);
      if (!userSessions.length) {
        return {
          content: [{ type: 'text', text: 'No indexed content found for this account yet. Upload a document or have a conversation with code/content first.' }],
        };
      }

      const hits = await store.searchContent(query, 5);
      const myHits = hits.filter(h => userSessions.includes(h.session_id));

      if (!myHits.length) {
        return {
          content: [{ type: 'text', text: `No relevant content found for "${query}" in your indexed documents/sessions.` }],
        };
      }

      const formatted = store.formatSearchResults(myHits);

      // Honest accounting: same pattern as the proxy's Stage 9a fix.
      // "before" = full original document size per unique doc recalled
      // (what would have been re-sent without CtxCrush).
      // "after" = what was actually sent (just the recalled chunks).
      const seenDocs = new Set();
      let recallBefore = 0;
      for (const h of myHits) {
        const prefixMatch = (h.fragment_id || '').match(/^(.*)-chunk-\d+$/);
        const docKey = prefixMatch ? prefixMatch[1] : h.fragment_id;
        if (seenDocs.has(docKey)) continue;
        seenDocs.add(docKey);
        recallBefore += store.getDocumentTotalTokens(h.session_id, h.fragment_id);
      }
      const recallAfter = myHits.reduce((sum, h) => sum + Math.round((h.chunk_text || '').length / 4), 0);
      if (recallBefore > recallAfter) {
        stats.totalBefore += recallBefore;
        stats.totalSaved += (recallBefore - recallAfter);
        console.log(`[mcp] recall savings: ${recallBefore} → ${recallAfter} tok (+${recallBefore - recallAfter} saved, ${seenDocs.size} doc(s))`);
      }

      return { content: [{ type: 'text', text: formatted }] };
    }
  );

  // ── Tool 3: compress_context ─────────────────────────────────────────────
  server.registerTool(
    'compress_context',
    {
      description: 'Compress a conversation\'s message history using CtxCrush\'s compression pipeline (pruning fillers, trimming old turns). Returns the compressed messages plus before/after token stats.',
      inputSchema: {
        messages: z.array(z.object({
          role: z.string(),
          content: z.string(),
        })).describe('The conversation messages to compress, in order.'),
      },
    },
    async ({ messages }) => {
      const result = compressMessages(messages, {});
      const before = messages.reduce((sum, m) => sum + Math.round((m.content || '').length / 4), 0);
      const after = result.messages.reduce((sum, m) => sum + Math.round((typeof m.content === 'string' ? m.content : '').length / 4), 0);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            compressedMessages: result.messages,
            stats: result.stats,
            estimatedTokensBefore: before,
            estimatedTokensAfter: after,
          }, null, 2),
        }],
      };
    }
  );

  // ── Tool 4: upload_document ──────────────────────────────────────────────
  server.registerTool(
    'upload_document',
    {
      description: 'Index a document\'s text so it can be recalled later via recall_document. Splits large documents into chunks automatically. Content is scoped to the caller\'s account only.',
      inputSchema: {
        apiKey: z.string().describe('The provider API key used to identify the caller. Never stored — only hashed.'),
        filename: z.string().describe('A name for this document, e.g. "contract.pdf".'),
        text: z.string().describe('The extracted text content of the document to index.'),
      },
    },
    async ({ apiKey, filename, text }) => {
      const userId = deriveUserId(apiKey);
      if (!userId || userId === 'anonymous') {
        return {
          content: [{ type: 'text', text: 'No valid API key provided — cannot index without an identified caller.' }],
        };
      }
      const sessionId = 'mcp-upload-' + userId;
      await store.getOrCreateSession(sessionId, userId);

      const chunks = chunkText(text);
      for (let i = 0; i < chunks.length; i++) {
        const chunkTokens = Math.round(chunks[i].length / 4);
        await store.indexContentChunk(sessionId, `mcp-doc-${filename}-chunk-${i}`, chunks[i], chunkTokens, i);
      }

      const totalTok = Math.round(text.length / 4);
      return {
        content: [{
          type: 'text',
          text: `Indexed "${filename}" — ${chunks.length} chunk(s), ~${totalTok} tokens. Now searchable via recall_document.`,
        }],
      };
    }
  );

  return server;
}

module.exports = { createMcpServer, deriveUserId };
