'use strict';

require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const fetch    = (...a) => import('node-fetch').then(({ default: f }) => f(...a));
const { compressMessages, estimateTokens } = require('./compressor');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ── Config from env (with sensible defaults) ─────────────────────────────────
const CFG = {
  windowSize:            parseInt(process.env.WINDOW_SIZE   || '10'),
  minMessagesToCompress: parseInt(process.env.MIN_MESSAGES  || '6'),
  pruneFillers:          process.env.PRUNE_FILLERS !== 'false',
  maxEventsPerCategory:  parseInt(process.env.MAX_EVENTS    || '12'),
};

// ── Simple in-memory stats ───────────────────────────────────────────────────
const stats = {
  requests: 0, compressed: 0, skipped: 0,
  totalSaved: 0, totalBefore: 0
};

// ─────────────────────────────────────────────────────────────────────────────
// HEALTH + STATS
// ─────────────────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({
    name:    'CtxCrush Proxy',
    version: '1.0.0',
    status:  'running',
    config:  CFG,
    stats: {
      ...stats,
      avgSavedPct: stats.totalBefore > 0
        ? Math.round((stats.totalSaved / stats.totalBefore) * 100) + '%'
        : '0%'
    },
    endpoints: {
      openai:    `POST /v1/chat/completions  →  forwards to api.openai.com`,
      anthropic: `POST /v1/messages          →  forwards to api.anthropic.com`
    }
  });
});

app.get('/stats', (req, res) => res.json(stats));

// ─────────────────────────────────────────────────────────────────────────────
// CORE: compress + forward
// ─────────────────────────────────────────────────────────────────────────────

async function handleRequest(req, res, upstreamURL) {
  stats.requests++;

  const body = req.body;

  // Pull out the messages array
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    // Nothing to compress — pass straight through
    return forward(req, res, upstreamURL, body);
  }

  // ── Compress ───────────────────────────────────────────────────────────────
  const { messages: compressed, stats: cStats } = compressMessages(messages, CFG);

  if (cStats.skipped) {
    stats.skipped++;
    console.log(`[CtxCrush] SKIP  ${cStats.reason} | ${messages.length} msgs`);
    return forward(req, res, upstreamURL, body);
  }

  stats.compressed++;
  stats.totalSaved  += cStats.tokensSaved;
  stats.totalBefore += cStats.tokensBefore;

  console.log(
    `[CtxCrush] ✓  ${cStats.originalMsgCount}→${cStats.compressedMsgCount} msgs` +
    ` | saved ${cStats.tokensSaved} tokens (${cStats.percentSaved}%)` +
    ` | ${cStats.compressionType}`
  );

  // Send compression stats back via response header (optional, useful for debugging)
  res.setHeader('X-CtxCrush-Saved-Tokens',   String(cStats.tokensSaved));
  res.setHeader('X-CtxCrush-Saved-Pct',      String(cStats.percentSaved));
  res.setHeader('X-CtxCrush-Original-Msgs',  String(cStats.originalMsgCount));
  res.setHeader('X-CtxCrush-Compressed-Msgs',String(cStats.compressedMsgCount));

  const newBody = { ...body, messages: compressed };
  return forward(req, res, upstreamURL, newBody);
}

// ── Forward to real upstream (handles both streaming and JSON) ────────────────
async function forward(req, res, upstreamURL, body) {
  // Build headers — forward auth, content-type, etc.
  const headers = {
    'Content-Type':  'application/json',
    'Authorization': req.headers['authorization'] || '',
  };

  // Anthropic uses x-api-key instead of Authorization
  if (req.headers['x-api-key'])         headers['x-api-key']         = req.headers['x-api-key'];
  if (req.headers['anthropic-version']) headers['anthropic-version'] = req.headers['anthropic-version'];

  let upstream;
  try {
    upstream = await fetch(upstreamURL, {
      method:  'POST',
      headers,
      body:    JSON.stringify(body),
    });
  } catch (err) {
    console.error('[CtxCrush] upstream fetch error:', err.message);
    return res.status(502).json({ error: 'Proxy upstream error', detail: err.message });
  }

  // Mirror the upstream status code
  res.status(upstream.status);

  // Mirror all upstream headers except ones that break streaming
  upstream.headers.forEach((val, key) => {
    if (!['content-encoding', 'transfer-encoding', 'connection'].includes(key)) {
      res.setHeader(key, val);
    }
  });

  // Stream the response body back — works for both streaming and JSON
  upstream.body.pipe(res);
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTES — one per provider
// ─────────────────────────────────────────────────────────────────────────────

// OpenAI-compatible (GPT-4, GPT-4o, local models, LiteLLM, etc.)
app.post('/v1/chat/completions', (req, res) => {
  handleRequest(req, res, 'https://api.openai.com/v1/chat/completions');
});

// Anthropic Claude
app.post('/v1/messages', (req, res) => {
  handleRequest(req, res, 'https://api.anthropic.com/v1/messages');
});

// Catch-all for any other OpenAI-compatible endpoint (embeddings, models, etc.)
// These are passed through unmodified
app.all('/v1/*', async (req, res) => {
  const upstreamURL = `https://api.openai.com${req.path}`;
  try {
    const upstream = await fetch(upstreamURL, {
      method:  req.method,
      headers: {
        'Content-Type':  'application/json',
        'Authorization': req.headers['authorization'] || '',
      },
      body: req.method !== 'GET' ? JSON.stringify(req.body) : undefined,
    });
    res.status(upstream.status);
    upstream.headers.forEach((val, key) => res.setHeader(key, val));
    upstream.body.pipe(res);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n⚡ CtxCrush Proxy running on http://localhost:${PORT}`);
  console.log(`   OpenAI  →  POST http://localhost:${PORT}/v1/chat/completions`);
  console.log(`   Claude  →  POST http://localhost:${PORT}/v1/messages`);
  console.log(`   Stats   →  GET  http://localhost:${PORT}/stats`);
  console.log(`\n   Config: windowSize=${CFG.windowSize} | pruneFillers=${CFG.pruneFillers}\n`);
});
