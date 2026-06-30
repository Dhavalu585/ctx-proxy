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
      return { content: [{ type: 'text', text: formatted }] };
    }
  );

  return server;
}

module.exports = { createMcpServer, deriveUserId };
