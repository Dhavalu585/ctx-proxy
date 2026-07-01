'use strict';

require('dotenv').config();
const { extractFacts, buildFactsReference } = require('./factsnap');
const { validatePreservation } = require('./validate-preservation');
const express  = require('express');
const cors     = require('cors');
const store = require('./store');
const { createMcpServer } = require('./mcp-server');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const fetch    = (...a) => import('node-fetch').then(({ default: f }) => f(...a));
const { compressMessages, estimateTokens } = require('./compressor');
const { classifyIntent, modelForIntent } = require('./intent');
const { retrieveRelevant, formatRetrieved } = require('./retrieval');
const { assembleIntents, formatAssembly } = require('./assembly');
const { orchestrate, combineResults, mergeResults } = require('./orchestrator');
const { deriveSessionId, detectCode, ingestCode, recallFunction, listFunctions, detectRecallRequest, buildRichReference, replaceCodeWithReference, buildRecallInjection } = require('./codestore');
const { detectContentType, minifyJson, compressLogs } = require('./contenttype');
const { extractText, chunkText } = require('./docextract');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
// ── Identity: derive a stable user id from the API key ───
function deriveUserId(apiKey) {
  if (!apiKey) return 'anonymous';
  const hash = crypto.createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
  return 'u_' + hash;
}
const app  = express();
app.use(helmet({ contentSecurityPolicy: false }));
const PORT = process.env.PORT || 3000;



// ── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '10mb' }));
const proxyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — please slow down.' },
});
app.use('/groq', proxyLimiter);
app.use('/openai', proxyLimiter);
app.use('/openrouter', proxyLimiter);
app.use('/gemini', proxyLimiter);
app.use('/custom', proxyLimiter);
app.use('/v1', proxyLimiter);
app.use('/upload', proxyLimiter);
app.use('/mcp', proxyLimiter);
// ── File upload setup (Phase 1: born-digital PDF/DOCX) ───────────────────────
// In-memory storage so we control exactly where originals get saved.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },   // 25MB cap — handles research papers/reports
});

// Local folder for original files (Step 2 replaces this with object storage).
const UPLOAD_DIR = path.join(__dirname, 'uploaded-originals');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
// ── POST /upload — accept a PDF/DOCX, extract text, store original locally ────
// Phase 1, Step 1: prove "file in → text out". Does NOT yet feed the pipeline.
app.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded (send as form field "file")' });
  }

  const { originalname, buffer, size } = req.file;
  console.log(`[upload] received: ${originalname} (${size} bytes)`);

  // Extract text
  const result = await extractText(buffer, originalname);
  if (!result.ok) {
    console.log(`[upload] extraction failed: ${result.error}`);
    return res.status(422).json({ error: result.error, filename: originalname });
  }

  // Store the original locally (Step 2 → object storage)
  const safeName = Date.now() + '-' + originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
  const savedPath = path.join(UPLOAD_DIR, safeName);
  try {
    fs.writeFileSync(savedPath, buffer);
  } catch (err) {
    console.log(`[upload] could not save original: ${err.message}`);
  }

  const tokenEstimate = Math.round(result.text.length / 4);
  console.log(`[upload] ✓ extracted ${result.text.length} chars (~${tokenEstimate} tok) from ${result.type}`);
// Step 1b: index the extracted text so the document is searchable/recallable.
  const apiKey = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  const userId = deriveUserId(apiKey);
  const docSessionId = req.headers['x-session-id'] || ('upload-' + userId);
  let indexed = false;
  if (userId !== 'anonymous' && result.text.trim().length > 0) {
    try {
      await store.getOrCreateSession(docSessionId, userId);
      const chunks = chunkText(result.text);
      for (let i = 0; i < chunks.length; i++) {
        const chunkTokens = Math.round(chunks[i].length / 4);
        await store.indexContentChunk(docSessionId, `doc-${safeName}-chunk-${i}`, chunks[i], chunkTokens);
      }
      indexed = true;
      console.log(`[upload] split into ${chunks.length} chunk(s) for indexing`);
      const totalTok = Math.round(result.text.length / 4);
      console.log(`[upload] ✓ indexed "${originalname}" for ${userId} (${chunks.length} chunk(s), ~${totalTok} tok) — searchable`);
    } catch (err) {
      console.log(`[upload] indexing failed: ${err.message}`);
    }
  }
  res.json({
    filename: originalname,
    type: result.type,
    indexed:indexed,
    sizeBytes: size,
    textLength: result.text.length,
    tokenEstimate,
    textPreview: result.text.slice(0, 500),   // first 500 chars so we can SEE it worked
    savedAs: safeName,
  });
});
// Initialize persistent store (Stage 7)
(async () => {
  try {
    await store.initStore();
    console.log('[server] persistent store initialized');
  } catch (err) {
    console.error('[server] store init failed:', err.message);
    process.exit(1);
  }
})();
// === Preservation switch — flip to true to enable content-preservation validation ===
const PRESERVE_ENABLED = false;
// === Code-replacement switch (Phase 2b) — flip to true to actually replace code with references ===
const CODE_REPLACE_ENABLED = true;
// === Code-recall switch (Phase 3b) — flip to true to inject recalled code into context ===
const CODE_RECALL_ENABLED = true;
// === Fact-injection switch (Phase 3) — flip to true to inject preserved facts into context ===
const FACT_INJECT_ENABLED = true;
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
  totalSaved: 0, totalBefore: 0,
  totalOutputTokens: 0
};
// ── Dollar-savings config (input-side prices per 1M tokens) ──────────────────
// Token savings are on the INPUT side (trimmed history, parked docs).
// Traffic is a mix of cheap + large models; we use a blended estimate.
// ── Model pricing (USD per 1M INPUT tokens; savings are input-side) ──────────
// Verified mid-2026. Prices drift — re-check provider pages periodically.
// Ready for multi-provider: add models here, then price per-model later.
const MODEL_PRICING = {
  // Groq (current traffic)
  'llama-3.1-8b-instant':    0.05,
  'llama-3.3-70b-versatile': 0.59,
  // OpenAI (via OpenRouter, when used)
  'gpt-4.1-nano': 0.10,
  'gpt-4.1-mini': 0.40,
  'gpt-5.4':      2.50,
  'gpt-5.5':      5.00,
};

// Blended rate for the dashboard today. Weighted toward real Groq usage:
// mostly 70B ($0.59) with some 8B ($0.05) → ~$0.45 is an honest midpoint.
const BLENDED_PRICE_PER_1M = 0.45;
const PRICING_VERIFIED = 'mid-2026';

function dollarsSaved(tokens) {
  return (tokens / 1000000) * BLENDED_PRICE_PER_1M;
}
// ─────────────────────────────────────────────────────────────────────────────
// HEALTH + STATS
// ─────────────────────────────────────────────────────────────────────────────

// Landing page — the front door
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'landing.html'));
});
app.get('/status', (req, res) => {
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
// ── Savings dashboard (live, in-memory) ──────────────────────────────────────
app.get('/dashboard', (req, res) => {
  const tokens = stats.totalSaved;
  const dollars = dollarsSaved(tokens);
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CtxCrush — Savings Dashboard</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0a0a0c;color:#f4f0ff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
  .wrap{width:100%;max-width:760px}
  h1{font-size:14px;letter-spacing:.14em;text-transform:uppercase;color:#7c6aff;font-weight:700;margin-bottom:32px;text-align:center}
  .cards{display:grid;grid-template-columns:1fr 1fr;gap:18px}
  @media(max-width:620px){.cards{grid-template-columns:1fr}}
  .card{background:#141418;border:1px solid #27272f;border-radius:16px;padding:34px 30px}
  .card .label{font-size:13px;color:#6b6880;text-transform:uppercase;letter-spacing:.08em;margin-bottom:14px}
  .card .value{font-size:46px;font-weight:800;letter-spacing:-.02em;line-height:1}
  .card.dollars .value{color:#34d399}
  .card .sub{font-size:13px;color:#6b6880;margin-top:10px}
  .meta{margin-top:26px;display:flex;gap:26px;justify-content:center;color:#6b6880;font-size:13px}
  .meta b{color:#f4f0ff;font-weight:600}
  .foot{text-align:center;margin-top:30px;color:#3a3848;font-size:12px}
</style>
</head>
<body>
<div class="wrap">
  <h1>CtxCrush — Live Savings</h1>
  <div class="cards">
    <div class="card">
      <div class="label">Tokens saved</div>
      <div class="value">${tokens.toLocaleString()}</div>
      <div class="sub">this session</div>
    </div>
    <div class="card dollars">
      <div class="label">Estimated cost saved</div>
      <div class="value">$${dollars.toFixed(2)}</div>
      <div class="sub">at ~$${BLENDED_PRICE_PER_1M.toFixed(2)} / 1M tokens (blended estimate)</div>
    </div>
  </div>
  <div class="meta">
    <span>Requests: <b>${stats.requests.toLocaleString()}</b></span>
    <span>Compressed: <b>${stats.compressed.toLocaleString()}</b></span>
    <span>Skipped: <b>${stats.skipped.toLocaleString()}</b></span>
  </div>
  <div class="foot">Live in-memory totals · resets on restart · auto-refreshes every 10s</div>
</div>
<script>setTimeout(()=>location.reload(),10000)</script>
</body>
</html>`);
});
// Stage 8: Search indexed content
app.post('/search', async (req, res) => {
  const { query, limit = 5 } = req.body;
  if (!query) {
    return res.status(400).json({ error: 'query required' });
  }
  try {
    const results = await store.searchContent(query, limit);
    const formatted = store.formatSearchResults(results);
    res.json({ query, count: results.length, results, formatted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// /test — browser chat UI (no separate file, served inline)
// ─────────────────────────────────────────────────────────────────────────────

app.get('/test', (req, res) => {
  const proxyBase = req.get('host').includes('localhost')
  ? `http://${req.get('host')}`
  : `https://${req.get('host')}`;
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CtxCrush — Live Tester</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Syne:wght@400;600;700;800&display=swap');
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  :root{--bg:#09090b;--bg2:#111113;--bg3:#1a1a1f;--border:#27272f;--accent:#7c6aff;--accent2:#a78bfa;--green:#34d399;--red:#f87171;--text:#f4f0ff;--muted:#6b6880;--dim:#3a3848}
  body{background:var(--bg);color:var(--text);font-family:'Syne',sans-serif;height:100vh;overflow:hidden;display:grid;grid-template-columns:280px 1fr;grid-template-rows:56px 1fr;grid-template-areas:"header header" "sidebar main"}
  header{grid-area:header;background:var(--bg2);border-bottom:1px solid var(--border);display:flex;align-items:center;padding:0 24px;gap:12px}
  .logo{display:flex;align-items:center;gap:9px;font-size:17px;font-weight:800;letter-spacing:-.5px}
  .logo-icon{width:28px;height:28px;background:var(--accent);border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:14px}
  .logo span{color:var(--accent2)}
  .tag{font-family:'IBM Plex Mono',monospace;font-size:10px;color:var(--muted);background:var(--bg3);border:1px solid var(--border);padding:3px 9px;border-radius:20px}
  .dot{width:7px;height:7px;border-radius:50%;background:var(--muted);margin-left:auto;transition:background .3s}
  .dot.on{background:var(--green);box-shadow:0 0 6px var(--green)}
  aside{grid-area:sidebar;background:var(--bg2);border-right:1px solid var(--border);padding:18px 14px;display:flex;flex-direction:column;gap:16px;overflow-y:auto}
  .slbl{font-family:'IBM Plex Mono',monospace;font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.1em;margin-bottom:6px}
  .field{display:flex;flex-direction:column;gap:4px;margin-bottom:8px}
  label{font-size:11px;font-weight:600}
  input,select{background:var(--bg3);border:1px solid var(--border);color:var(--text);font-family:'IBM Plex Mono',monospace;font-size:11px;padding:8px 10px;border-radius:7px;outline:none;width:100%;transition:border-color .15s}
  input:focus,select:focus{border-color:var(--accent)}
  .hint{font-family:'IBM Plex Mono',monospace;font-size:9px;color:var(--muted);line-height:1.5}
  .btn{width:100%;padding:9px;background:var(--accent);color:#fff;font-family:'Syne',sans-serif;font-size:12px;font-weight:700;border:none;border-radius:8px;cursor:pointer;transition:opacity .15s;margin-bottom:6px}
  .btn:hover{opacity:.85}
  .btn.sec{background:var(--bg3);border:1px solid var(--border);color:var(--muted)}
  .btn.sec:hover{color:var(--text)}
  .modebox{background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:11px 12px;margin-top:4px}
  .moderow{display:flex;align-items:center;gap:9px;cursor:pointer}
  .moderow input{width:auto;margin:0;cursor:pointer;accent-color:var(--accent)}
  .modetitle{font-size:12px;font-weight:700;color:var(--text)}
  .modenote{font-family:'IBM Plex Mono',monospace;font-size:9px;color:var(--muted);line-height:1.6;margin-top:8px}
  .modenote b{color:var(--accent2)}
  main{grid-area:main;display:flex;flex-direction:column;overflow:hidden}
  #msgs{flex:1;overflow-y:auto;padding:22px 26px;display:flex;flex-direction:column;gap:16px;scroll-behavior:smooth}
  .msg{max-width:72%;display:flex;flex-direction:column;gap:3px;animation:fu .22s ease}
  @keyframes fu{from{opacity:0;transform:translateY(7px)}to{opacity:1;transform:translateY(0)}}
  .msg.user{align-self:flex-end;align-items:flex-end}
  .msg.assistant{align-self:flex-start}
  .msg.system{align-self:center;max-width:88%}
  .mr{font-family:'IBM Plex Mono',monospace;font-size:9px;color:var(--muted);letter-spacing:.07em;text-transform:uppercase;padding:0 3px}
  .mb{padding:11px 15px;border-radius:14px;font-size:14px;line-height:1.65;white-space:pre-wrap;word-break:break-word}
  .msg.user .mb{background:var(--accent);color:#fff;border-radius:14px 14px 4px 14px}
  .msg.assistant .mb{background:var(--bg3);border:1px solid var(--border);border-radius:14px 14px 14px 4px}
  .msg.system .mb{background:rgba(124,106,255,.08);border:1px solid rgba(124,106,255,.25);border-radius:10px;font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--accent2);text-align:center;padding:8px 14px}
  .badge{font-family:'IBM Plex Mono',monospace;font-size:9px;padding:2px 8px;border-radius:20px;display:inline-block;margin-top:2px}
  .badge.s{background:rgba(52,211,153,.12);color:var(--green);border:1px solid rgba(52,211,153,.25)}
  .badge.k{background:rgba(107,104,128,.1);color:var(--muted);border:1px solid var(--border)}
  .tdots span{display:inline-block;width:6px;height:6px;background:var(--muted);border-radius:50%;animation:d 1.2s ease-in-out infinite;margin:0 2px}
  .tdots span:nth-child(2){animation-delay:.2s} .tdots span:nth-child(3){animation-delay:.4s}
  @keyframes d{0%,80%,100%{transform:scale(.8);opacity:.4}40%{transform:scale(1.1);opacity:1}}
  .ibar{padding:14px 22px 18px;border-top:1px solid var(--border);background:var(--bg2);display:flex;gap:9px;align-items:flex-end}
  #inp{flex:1;background:var(--bg3);border:1px solid var(--border);color:var(--text);font-family:'Syne',sans-serif;font-size:14px;padding:11px 14px;border-radius:12px;resize:none;outline:none;min-height:46px;max-height:150px;line-height:1.5;transition:border-color .15s}
  #inp:focus{border-color:var(--accent)}
  #inp::placeholder{color:var(--muted)}
  #sbtn{width:46px;height:46px;background:var(--accent);border:none;border-radius:12px;cursor:pointer;font-size:17px;display:flex;align-items:center;justify-content:center;transition:opacity .15s;flex-shrink:0}
  #sbtn:hover{opacity:.85} #sbtn:disabled{opacity:.35;cursor:not-allowed}
  .empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:9px;color:var(--muted);font-family:'IBM Plex Mono',monospace;font-size:12px;text-align:center}
  .ei{font-size:38px;margin-bottom:4px}
  #savings-banner{position:sticky;top:0;z-index:5;margin:14px 22px 0;padding:16px 20px;border-radius:14px;background:linear-gradient(135deg,rgba(52,211,153,.16),rgba(124,106,255,.14));border:1px solid rgba(52,211,153,.35);text-align:center;animation:fu .3s ease;backdrop-filter:blur(8px)}
  .sb-big{font-size:26px;font-weight:800;letter-spacing:-.5px;color:var(--green)}
  .sb-big span{color:var(--green)}
  .codebanner{margin:10px 22px 0;padding:8px 14px;border-radius:10px;background:rgba(124,106,255,.08);border:1px solid rgba(124,106,255,.25);font-family:'IBM Plex Mono',monospace;font-size:10px;color:var(--accent2);text-align:center}
  ::-webkit-scrollbar{width:4px} ::-webkit-scrollbar-thumb{background:var(--dim);border-radius:2px}
</style>
</head>
<body>
<header>
  <div class="logo"><div class="logo-icon">⚡</div>Ctx<span>Crush</span></div>
  <span class="tag">LIVE TESTER</span>
  <div class="dot" id="dot"></div>
</header>
<aside>
  <div>
    <div class="slbl">Config</div>
    <div class="field">
      <label>Proxy URL</label>
      <input id="purl" type="text" value="${proxyBase}" readonly style="opacity:.6;cursor:not-allowed">
      <div class="hint">Auto-set to this server</div>
    </div>
    <div class="field">
      <label>Provider</label>
      <select id="prov" onchange="onProvChange()">
        <option value="groq">Groq (FREE — no card)</option>
        <option value="openrouter">OpenRouter (1 key, all models)</option>
        <option value="openai">OpenAI (paid)</option>
        <option value="gemini">Google Gemini (free tier)</option>
        <option value="custom">Custom (any provider)</option>
      </select>
      <div class="hint" id="prov-hint">Free key at console.groq.com</div>
    </div>
    <div class="field" id="baseurl-field" style="display:none">
      <label>Base URL</label>
      <input id="baseurl" type="text" placeholder="https://api.example.com/v1/chat/completions">
      <div class="hint">Full chat-completions URL of any OpenAI-compatible API</div>
    </div>
    <div class="field">
      <label>API Key</label>
      <input id="akey" type="password" placeholder="gsk_...">
      <div class="hint">Forwarded to provider. Never stored.</div>
    </div>
    <div class="field">
      <label>Model</label>
      <input id="mdl" type="text" value="llama-3.3-70b-versatile" list="modellist">
      <datalist id="modellist"></datalist>
      <div class="hint">Pick from list or type any model name</div>
    </div>
    <button class="btn" onclick="connect()">Connect</button>
    <button class="btn sec" onclick="clearChat()">Clear Chat</button>
  </div>
  <div>
    <div class="slbl">Mode</div>
    <div class="modebox">
      <label class="moderow">
        <input type="checkbox" id="maxsave" onchange="onModeChange()">
        <span class="modetitle">⚡ Quick &amp; Cheap</span>
      </label>
      <label class="moderow">
        <input type="checkbox" id="concise">
        <span class="modetitle">✂️ Concise replies</span>
      </label>
      <div class="field" style="margin-top:12px">
        <label>Upload Document (PDF/DOCX)</label>
        <input id="docfile" type="file" accept=".pdf,.docx">
        <button id="docbtn" onclick="uploadDoc()" style="margin-top:6px;width:100%">Upload &amp; Index</button>
        <div class="hint" id="docstatus">Extracts text, makes it searchable.</div>
      </div>
      <div class="modenote" id="modenote">
        <b>Smart mode (default):</b> automatically preserves important facts and handles code. Best for work you'll build on.
      </div>
    </div>
  </div>
</aside>
<main>
   <div id="savings-banner" style="display:none">
    <div class="sb-big"><span id="sb-tokens">0</span> tokens saved</div>
    <div class="sb-sub" style="font-size:18px;color:#34d399;margin-top:6px">≈ $<span id="sb-dollars">0.00</span> saved <span style="color:#6b6880;font-size:13px">(est. across all usage)</span></div>
  </div>
  <div class="codebanner">💻 Code compression in 9 languages (Java, Python, JS, TS, Go, Rust, C++, C#, PHP) — parked &amp; recalled to save tokens</div>
  <div id="msgs">
    <div class="empty" id="empty">
      <div class="ei">⚡</div>
      <div>Enter your API key<br>and click <strong>Connect</strong></div>
    </div>
  </div>
  <div class="ibar">
    <textarea id="inp" placeholder="Type a message… (Enter to send)" rows="1"
      onkeydown="hk(event)" oninput="ar(this)"></textarea>
    <button id="sbtn" onclick="send()" disabled>➤</button>
  </div>
</main>
<script>
const PROXY = '${proxyBase}';
let hist=[], conn=false, ss={total:0,reqs:0};
const $=id=>document.getElementById(id);
const PROVIDERS={
  groq:       {path:'/groq/v1/chat/completions',       keyPrefix:'gsk_...', hint:'Free key at console.groq.com',  models:['llama-3.3-70b-versatile','llama-3.1-8b-instant']},
  openrouter: {path:'/openrouter/v1/chat/completions', keyPrefix:'sk-or-...', hint:'1 key for all models at openrouter.ai', models:['openai/gpt-4o-mini','anthropic/claude-3.5-sonnet','google/gemini-2.0-flash-exp','meta-llama/llama-3.3-70b-instruct','deepseek/deepseek-chat']},
  openai:     {path:'/v1/chat/completions',            keyPrefix:'sk-...',  hint:'Paid key at platform.openai.com', models:['gpt-4o-mini','gpt-4o','gpt-3.5-turbo']},
  gemini:     {path:'/gemini/v1/chat/completions',     keyPrefix:'AIza...', hint:'Free key at aistudio.google.com', models:['gemini-2.0-flash','gemini-1.5-flash']},
  custom:     {path:'/custom/v1/chat/completions',     keyPrefix:'your-api-key', hint:'Enter the base URL below', models:[]}
};
function onProvChange(){
  const pv=$('prov').value, p=PROVIDERS[pv];
  $('akey').placeholder=p.keyPrefix;
  $('prov-hint').textContent=p.hint;
  $('modellist').innerHTML=p.models.map(m=>'<option value="'+m+'">').join('');
  if(p.models.length) $('mdl').value=p.models[0];
  $('baseurl-field').style.display = pv==='custom' ? 'flex' : 'none';
  setConn(false);
}
function onModeChange(){
  const on=$('maxsave').checked;
  $('modenote').innerHTML = on
    ? "<b>Quick &amp; Cheap (on):</b> maximum token savings. Best for one-off questions (FIFA scores, quick lookups, places to visit)."
    : "<b>Smart mode (default):</b> automatically preserves important facts and handles code. Best for work you'll build on.";
}
function setConn(on){$('dot').className='dot'+(on?' on':'');conn=on;$('sbtn').disabled=!on}
function ar(el){el.style.height='auto';el.style.height=Math.min(el.scrollHeight,150)+'px'}
function hk(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();if(conn)send()}}
function addMsg(role,text,badge){
  $('empty')?.remove();
  const w=document.createElement('div');w.className='msg '+role;
  const r=document.createElement('div');r.className='mr';r.textContent=role==='user'?'You':role==='assistant'?'AI':'System';
  const b=document.createElement('div');b.className='mb';b.textContent=text;
  w.appendChild(r);w.appendChild(b);
  if(badge){const bd=document.createElement('span');bd.className='badge '+(badge.t==='s'?'s':'k');bd.textContent=badge.l;w.appendChild(bd)}
  $('msgs').appendChild(w);$('msgs').scrollTop=$('msgs').scrollHeight;return b;
}
function addTyping(){
  $('empty')?.remove();
  const w=document.createElement('div');w.className='msg assistant';w.id='typing';
  w.innerHTML='<div class="mr">AI</div><div class="mb"><span class="tdots"><span></span><span></span><span></span></span></div>';
  $('msgs').appendChild(w);$('msgs').scrollTop=$('msgs').scrollHeight;
}
function rmTyping(){$('typing')?.remove()}
async function updStats(turnSaved){
  // Pull the server-wide total (all traffic) so the banner matches the dashboard
  try{
    const r=await fetch(PROXY+'/stats');
    const s=await r.json();
    const total=(s.totalSaved!=null?s.totalSaved:(s.stats?s.stats.totalSaved:0))||0;
    const dollars=(total/1000000)*0.45;
    $('sb-tokens').textContent=total.toLocaleString();
    const d=$('sb-dollars'); if(d) d.textContent=dollars.toFixed(2);
    $('savings-banner').style.display='block';
  }catch(e){
    ss.total+=turnSaved;
    $('sb-tokens').textContent=ss.total.toLocaleString();
    $('savings-banner').style.display='block';
  }
}
  async function uploadDoc(){
  const key=$('akey').value.trim();
  if(!key){alert('Please enter your API key first');return}
  const fileInput=$('docfile');
  if(!fileInput.files||!fileInput.files[0]){alert('Please choose a PDF or DOCX file');return}
  const file=fileInput.files[0];
  const status=$('docstatus');
  status.textContent='Uploading & extracting...';
  $('docbtn').disabled=true;
  try{
    const fd=new FormData();
    fd.append('file',file);
    const r=await fetch(PROXY+'/upload',{method:'POST',headers:{'Authorization':'Bearer '+key},body:fd});
    const d=await r.json();
    if(d.indexed){
      status.textContent='✓ Indexed "'+d.filename+'" ('+d.tokenEstimate+' tok) — now searchable. Ask about it below!';
    }else if(d.error){
      status.textContent='✗ '+d.error;
    }else{
      status.textContent='Extracted but not indexed (check API key).';
    }
  }catch(e){
    status.textContent='✗ Upload failed: '+e.message;
  }
  $('docbtn').disabled=false;
}
async function connect(){
  const key=$('akey').value.trim();
  if(!key){alert('Please enter your API key first');return}
  try{
    const r=await fetch(PROXY+'/status');
    const d=await r.json();
    if(d.status==='running'){
      setConn(true);
      addMsg('system','✓ Connected to '+d.name+' via '+$('prov').value.toUpperCase()+'\\nWindow: '+d.config.windowSize+' msgs | Filler pruning: '+d.config.pruneFillers+'\\n\\nStart chatting — compression kicks in after '+d.config.minMessagesToCompress+' messages.');
    }
  }catch(e){addMsg('system','✗ Could not reach proxy: '+e.message+'\\n\\nThe server may be waking up (free tier sleeps after 15 min). Wait 30 sec and click Connect again.')}
}
async function send(){
  const inp=$('inp'),text=inp.value.trim();
  if(!text)return;
  const key=$('akey').value.trim(),model=$('mdl').value.trim();
  const pv=$('prov').value, endpoint=PROVIDERS[pv].path;
  const headers={'Content-Type':'application/json','Authorization':'Bearer '+key};
  if($('maxsave').checked) headers['X-CtxCrush-Max-Savings']='true';
  if($('concise').checked) headers['X-CtxCrush-Concise']='true';
  if(pv==='custom'){
    const bu=$('baseurl').value.trim();
    if(!bu){addMsg('system','✗ Please enter a Base URL for the custom provider');return}
    headers['X-Upstream-Url']=bu;
  }
  addMsg('user',text);hist.push({role:'user',content:text});
  inp.value='';inp.style.height='auto';$('sbtn').disabled=true;addTyping();
  try{
    const r=await fetch(PROXY+endpoint,{
      method:'POST',
      headers,
      body:JSON.stringify({model,messages:hist,stream:false})
    });
    rmTyping();
    if(!r.ok){const e=await r.json().catch(()=>({error:{message:r.statusText}}));addMsg('system','✗ '+( e.error?.message||r.statusText));hist.pop();return}
    const d=await r.json();
    const reply=d.choices?.[0]?.message?.content||'(empty)';
    const saved=parseInt(r.headers.get('X-CtxCrush-Saved-Tokens')||'0');
    const codeSaved=parseInt(r.headers.get('X-CtxCrush-Code-Saved-Tokens')||'0');
    const pct=parseInt(r.headers.get('X-CtxCrush-Saved-Pct')||'0');
    const om=parseInt(r.headers.get('X-CtxCrush-Original-Msgs')||'0');
    const cm=parseInt(r.headers.get('X-CtxCrush-Compressed-Msgs')||'0');
    const turnSaved = saved + codeSaved;
    addMsg('assistant',reply);hist.push({role:'assistant',content:reply});
    updStats(turnSaved); 
  }catch(e){rmTyping();addMsg('system','✗ '+e.message);hist.pop()}
  finally{$('sbtn').disabled=false;inp.focus()}
}
function clearChat(){hist=[];ss={total:0,reqs:0};$('sb-tokens').textContent='0';$('savings-banner').style.display='none';$('msgs').innerHTML='<div class="empty" id="empty"><div class="ei">⚡</div><div>Chat cleared.</div></div>'}
</script>
</body>
</html>`);
});

// ─────────────────────────────────────────────────────────────────────────────
// CORE: compress + forward
// ─────────────────────────────────────────────────────────────────────────────
async function handleRequest(req, res, upstreamURL) {
  stats.requests++;
  const sessionId = req.headers['x-session-id'] || 'default-session';
  const apiKey = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  const userId = deriveUserId(apiKey);
  console.log(`[identity] session ${sessionId} → user ${userId}`);
  await store.getOrCreateSession(sessionId, userId);
  // Allow the client to override the upstream target via header.
  
  // Allow the client to override the upstream target via header.
  const override = req.headers['x-upstream-url'];
  if (override) upstreamURL = override;

  // Quick & Cheap mode: caller asked for max savings — skip fact-preservation
  const maxSavings = (req.headers['x-ctxcrush-max-savings'] || '').toLowerCase() === 'true';
  const conciseMode = (req.headers['x-ctxcrush-concise'] || '').toLowerCase() === 'true';

  const body = req.body;
  const messages = body.messages;
  if (conciseMode && Array.isArray(messages)) {
    messages.unshift({
      role: 'system',
      content: 'Prefer concise responses. Give a complete answer, but avoid unnecessary preamble, restated questions, filler phrases, and over-explanation. Be direct.'
    });
    console.log('[concise] gentle brevity instruction injected (opt-in mode on)');
  }
  const codeSessionId = Array.isArray(messages) ? deriveSessionId(messages) : 'nosession';
  let totalCodeSaved = 0;
  let factsInjection = null;
  // Stage 2 + 3: classify intent and route to the matching model
  if (Array.isArray(messages)) {
    const intent = classifyIntent(messages);
    const chosenModel = modelForIntent(intent);
    console.log(`[intent] ${intent} → [model] ${chosenModel}${maxSavings ? ' | mode: Quick & Cheap' : ''}`);
    body.model = chosenModel;
  }

  // === Code parsing (Phase 2/2b) — scans ALL user messages for code ===
  if (Array.isArray(messages)) {
    try {
      const sessionId = codeSessionId;
      let codeSavedThisTurn = 0;
      const latestUserMsg = [...messages].reverse().find(x => x.role === 'user');
      for (const m of messages) {
        if (m.role !== 'user') continue;
        const text = typeof m.content === 'string' ? m.content : '';
        const ctype = detectContentType(text);
    
        if (ctype === 'json') {
          const isLatest = (m === latestUserMsg);
          const result = minifyJson(text);
          if (result && result.savedTokens > 0 && !isLatest) {
            m.content = result.minified;
            codeSavedThisTurn += result.savedTokens;
            console.log(`[contenttype] ✓ minified JSON: ${result.beforeTokens}→${result.afterTokens} tok | saved ${result.savedTokens} tok`);
          } else if (result) {
            console.log(`[contenttype] JSON detected (${result.beforeTokens} tok) | ${isLatest ? 'kept latest intact' : 'no whitespace to trim'}`);
          }
        } else if (ctype === 'logs') {
          const isLatest = (m === latestUserMsg);
          const result = compressLogs(text);
          if (result && result.savedTokens > 0 && !isLatest) {
            m.content = result.compressed;
            codeSavedThisTurn += result.savedTokens;
            console.log(`[contenttype] ✓ compressed logs: ${result.beforeTokens}→${result.afterTokens} tok | saved ${result.savedTokens} tok`);
          } else if (result) {
            console.log(`[contenttype] logs detected (${result.beforeTokens} tok) | ${isLatest ? 'kept latest intact' : 'no repeated lines to collapse'}`);
          }
        }
        const detected = detectCode(text);
        if (detected) {
          const result = await ingestCode(sessionId, detected.code, detected.lang);
          const codeTokens = Math.round(detected.code.length / 4);
          const refTokens = Math.round(result.reference.length / 4);
          const pct = codeTokens > 0 ? Math.round((1 - refTokens / codeTokens) * 100) : 0;
          console.log(`[codestore] session ${sessionId} | detected ${detected.lang} | ${result.indexed} methods indexed | would save ~${pct}% (${codeTokens}→${refTokens} tok)`);
          console.log(`[codestore] functions: ${result.names}`);

          // Phase 2b: replace code in OLDER messages only (keep the latest code intact)
          const isLatestUserMsg = (m === latestUserMsg);
          if (!isLatestUserMsg) {
            if (CODE_REPLACE_ENABLED) {
              const richRef = buildRichReference(sessionId, result.indexed);
              const origTok = Math.round(detected.code.length / 4);
              const refTok = Math.round(richRef.length / 4);
              const saved = Math.max(0, origTok - refTok);
              codeSavedThisTurn += saved;
              m.content = replaceCodeWithReference(text, detected.code, richRef);
              console.log(`[codereplace] ✓ replaced (saved ${saved} tokens this turn by not re-sending full code)`);
            } else {
              console.log(`[codereplace] would replace older message's code with reference (toggle OFF — log only)`);
            }
          } else {
            console.log(`[codereplace] kept latest code message intact (never replace current code)`);
          }
        }
      } 
      totalCodeSaved = codeSavedThisTurn;
      if (codeSavedThisTurn > 0) stats.totalSaved += codeSavedThisTurn;
    } catch (e) {
      console.log(`[codestore] skipped (${e.message})`);
    }
  }

  // === Code recall (Phase 3b) — detects "show me X", surfaces the stored code ===
  if (Array.isArray(messages)) {
    try {
      const sessionId = codeSessionId;
      const known = listFunctions(sessionId).filter(u => u.type === 'method').map(u => u.name);
      if (known.length) {
        const latestUser = [...messages].reverse().find(m => m.role === 'user');
        const text = latestUser ? (typeof latestUser.content === 'string' ? latestUser.content : '') : '';
        const wanted = detectRecallRequest(text, known);
        if (wanted) {
          const fn = recallFunction(sessionId, wanted);
          if (fn) {
            if (CODE_RECALL_ENABLED) {
              const injection = buildRecallInjection(fn);
              const arr = body.messages;
              body.messages = [...arr.slice(0, -1), injection, arr[arr.length - 1]];
              console.log(`[recall] ✓ surfaced "${fn.name}" code into context (LIVE, ${fn.code.split('\n').length} lines)`);
            } else {
              console.log(`[recall] would surface "${fn.name}" (lines ${fn.startLine}-${fn.endLine}, ${fn.code.split('\n').length} lines) — toggle OFF`);
            }
          }
        }
      }
    } catch (e) {
      console.log(`[recall] skipped (${e.message})`);
    }
  }

  // === Fact Snapshot (Phase 3) — extract critical facts; inject unless Quick & Cheap mode ===
  if (Array.isArray(messages)) {
    try {
      const snapshot = {};
      let factCount = 0;
      for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        if (m.role !== 'user') continue;
        const text = typeof m.content === 'string' ? m.content : '';
        const facts = extractFacts(text);
        if (facts) {
          snapshot[`msg${i}`] = facts;
          factCount += Object.values(facts).reduce((s, arr) => s + arr.length, 0);
        }
      }
      if (factCount > 0) {
        console.log(`[factsnap] extracted ${factCount} facts across ${Object.keys(snapshot).length} messages`);
        const factsRef = buildFactsReference(snapshot);
        if (maxSavings) {
          console.log(`[factsnap] Quick & Cheap mode — skipping fact injection (max savings)`);
        } else if (factsRef && FACT_INJECT_ENABLED && messages.length > 6) {
          factsInjection = {
            role: 'system',
            content: `Verified facts from earlier in this conversation (treat as authoritative; do not deny these were mentioned):\n${factsRef}`
          };
          console.log(`[factsnap] facts reference ready (~${Math.round(factsRef.length / 4)} tokens) — will inject after compression`);
        } else {
          console.log(`[factsnap] snapshot built (~${factsRef ? Math.round(factsRef.length / 4) : 0} tok ref) — injection ${FACT_INJECT_ENABLED ? 'waiting for >6 msgs' : 'toggle OFF'}`);
        }
      }
    } catch (e) {
      console.log(`[factsnap] skipped (${e.message})`);
    }
  }

  // Stage 5–8 orchestration is now OPT-IN: only runs when the caller sends
  // the header X-CtxCrush-Orchestrate: true. Default behaviour = clean
  // compression + routing (with token-savings stats).
  const wantsOrchestration = (req.headers['x-ctxcrush-orchestrate'] || '').toLowerCase() === 'true';
  if (wantsOrchestration && Array.isArray(messages) && req.originalUrl.includes('/groq/')) {
    const latestUser = [...messages].reverse().find(m => m.role === 'user');
    const qText = latestUser ? (typeof latestUser.content === 'string' ? latestUser.content : '') : '';
    if (qText) {
      const groqKey = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
      const fetchFn = (...a) => import('node-fetch').then(({ default: f }) => f(...a));
      const assembled = await assembleIntents(qText, groqKey, fetchFn);
      console.log(`[assembly] method=${assembled.method} | ${assembled.fragments.length} intent(s)`);
      if (assembled.isMulti) {
        console.log(formatAssembly(assembled));
        const oldMessages = messages.slice(0, -2);
        const t0 = Date.now();
        const results = await orchestrate(assembled.fragments, oldMessages, groqKey, fetchFn);
        results.forEach((r, i) =>
          console.log(`[orchestrate] ${i + 1}/${results.length} [${r.intent}] → ${r.model} | ${r.ok ? 'ok' : 'FAILED'}`)
        );
        let combined = await mergeResults(qText, results, groqKey, fetchFn);
        let mergeMethod = 'merged';
        if (!combined) {
          combined = combineResults(results);
          mergeMethod = 'concatenated-fallback';
        }
        console.log(`[merge] ${mergeMethod}`);
        console.log(`[orchestrate] done in ${Date.now() - t0}ms — returning synthesized response`);
        res.setHeader('X-CtxCrush-Orchestrated', String(results.length));
        return res.json({
          id: 'ctxcrush-orch-' + Date.now(),
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'ctxcrush-multi',
          choices: [{ index: 0, message: { role: 'assistant', content: combined }, finish_reason: 'stop' }],
        });
      }
    }
  }

  // Stage 4b: structured retrieval — inject relevant old context into the request
  if (Array.isArray(messages) && messages.length > 6) {
    const latestUser = [...messages].reverse().find(m => m.role === 'user');
    const queryText = latestUser ? (typeof latestUser.content === 'string' ? latestUser.content : '') : '';
    const oldMessages = messages.slice(0, -2);
    const { retrieved, branchScores } = retrieveRelevant(oldMessages, queryText);
    const topBranches = branchScores.filter(b => b.score > 0).map(b => `${b.category}(${b.score})`).join(', ');
    console.log(`[retrieval] branches: ${topBranches || 'none'} | items: ${retrieved.length}`);

    if (retrieved.length) {
      const contextBlock = formatRetrieved(retrieved);
      const injected = {
        role: 'system',
        content: `Relevant context from earlier in this conversation:\n${contextBlock}`
      };
      body.messages = [...messages.slice(0, -1), injected, messages[messages.length - 1]];
      console.log(`[retrieval] injected ${retrieved.length} items into context`);
    }
  }
// Stage 8: Large fragments → index instead of forwarding to the LLM
  const INDEX_THRESHOLD_TOKENS = 1500;
  const PLACEHOLDER = '[Large content indexed — retrieved on demand]';
  let stage8SavedTokens = 0;
  if (Array.isArray(messages)) {
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const content = typeof msg.content === 'string' ? msg.content : '';

      // Skip anything already swapped to a placeholder (don't re-index)
      if (content === PLACEHOLDER) continue;

      const msgTokens = Math.round(content.length / 4);
      if (msgTokens > INDEX_THRESHOLD_TOKENS && msg.role === 'user') {
        const fragmentId = `frag-${i}-${sessionId}`;
        try {
          await store.indexContentChunk(sessionId, fragmentId, content, msgTokens);
          msg.content = PLACEHOLDER;
          const placeholderTokens = Math.round(PLACEHOLDER.length / 4);
          const saved = msgTokens - placeholderTokens;
          stage8SavedTokens += saved;
          console.log(`[Stage 8] ✓ fragment ${i}: ${msgTokens}tok → placeholder | saved ${saved}tok from outbound request`);
        } catch (err) {
          console.error(`[Stage 8] indexing failed for fragment ${i}:`, err.message);
        }
      }
    }
  }
  if (stage8SavedTokens > 0) {
    res.setHeader('X-CtxCrush-Saved-Tokens', String(stage8SavedTokens));
    stats.totalSaved += stage8SavedTokens;
    console.log(`[Stage 8] total outbound savings this request: ${stage8SavedTokens}tok`);
  }
  // Stage 9a: Search-back — pull indexed content relevant to the latest question
  if (Array.isArray(messages) && messages.length > 0) {
    const latestUser = [...messages].reverse().find(m => m.role === 'user');
    const queryText = latestUser && typeof latestUser.content === 'string' ? latestUser.content : '';

    // only search if this session actually has indexed content, and the query isn't the placeholder itself
    if (queryText && queryText !== PLACEHOLDER) {
      try {
        const userSessionsForGate = store.getSessionIdsForUser(userId);
        const userHasContent = userSessionsForGate.length > 0;
        if (userHasContent) {
        
          const hits = await store.searchContent(queryText, 3);
          const ownHits = hits.filter(h => h.session_id === sessionId);
          const userSessions = userSessionsForGate;
          // Cross-session: use the user's hits across all their sessions, with
          // a safety guard — no valid identity falls back to same-session only,
          // never exposing other users' content.
          const userHits = (userId && userId !== 'anonymous')
            ? hits.filter(h => userSessions.includes(h.session_id))
            : [];
          const hitsToInject = (userId && userId !== 'anonymous') ? userHits : ownHits;
          
          console.log(`[cross-session] same-session: ${ownHits.length} | user-scoped: ${userHits.length} | injecting: ${hitsToInject.length} (user ${userId}, ${userSessions.length} session(s))`);
          if (hitsToInject.length > 0) {
            const block = store.formatSearchResults(hitsToInject);
            const injected = { role: 'system', content: block };
            const last = messages[messages.length - 1];
            body.messages = [...messages.slice(0, -1), injected, last];
            console.log(`[Stage 9a] injected ${hitsToInject.length} indexed chunk(s) for query: "${queryText.slice(0, 60)}"`);
            // Honest accounting: each recalled chunk's ORIGINAL size (real,
            // known at upload time) is what would have been re-sent without
            // CtxCrush. Sum that as "before"; what's actually injected
            // (the chunk content itself) is what's sent now.
            const seenDocs = new Set();
            let recallBefore = 0;
            for (const h of hitsToInject) {
              const prefixMatch = (h.fragment_id || '').match(/^(.*)-chunk-\d+$/);
              const docKey = prefixMatch ? prefixMatch[1] : h.fragment_id;
              if (seenDocs.has(docKey)) continue;
              seenDocs.add(docKey);
              recallBefore += store.getDocumentTotalTokens(h.session_id, h.fragment_id);
            }
            const recallAfter = hitsToInject.reduce((sum, h) => sum + Math.round((h.chunk_text || '').length / 4), 0);
            if (recallBefore > recallAfter) {
              stats.totalBefore += recallBefore;
              stats.totalSaved += (recallBefore - recallAfter);
              console.log(`[Stage 9a] recall savings: ${recallBefore} → ${recallAfter} tok (+${recallBefore - recallAfter} saved, ${seenDocs.size} doc(s))`);
            }
          } else {
            console.log(`[Stage 9a] no relevant indexed content for this query`);
          }
        }
      } catch (err) {
        console.error(`[Stage 9a] search-back failed:`, err.message);
      }
    }
  }
  // ── Compress ───────────────────────────────────────────────────────────────
  const { messages: compressed, stats: cStats } = compressMessages(messages, CFG);

  // Content-preservation guard (only when PRESERVE_ENABLED)
  if (PRESERVE_ENABLED && !cStats.skipped) {
    const originalText = JSON.stringify(messages);
    const compressedText = JSON.stringify(compressed);
    const check = validatePreservation(originalText, compressedText);
    if (!check.ok) {
      console.log(`[preserve] ✗ critical content would be lost — using ORIGINAL. Missing:`,
        JSON.stringify(check.missing));
      res.setHeader('X-CtxCrush-Code-Saved-Tokens', String(totalCodeSaved));
      return forward(req, res, upstreamURL, body);
    }
    console.log(`[preserve] ✓ all critical content intact`);
  }

  if (cStats.skipped) {
    stats.skipped++;
    res.setHeader('X-CtxCrush-Code-Saved-Tokens', String(totalCodeSaved));
    console.log(`[CtxCrush] SKIP  ${cStats.reason} | ${messages.length} msgs | code saved ${totalCodeSaved}`);
    if (factsInjection) {
      const arr = body.messages;
      body.messages = [...arr.slice(0, -1), factsInjection, arr[arr.length - 1]];
      console.log(`[factsnap] ✓ injected facts into FINAL context (skip path)`);
    }
    return forward(req, res, upstreamURL, body);
  }

  stats.compressed++;
  stats.totalSaved  += cStats.tokensSaved;
  stats.totalBefore += cStats.tokensBefore;

  console.log(
    `[CtxCrush] ✓  ${cStats.originalMsgCount}→${cStats.compressedMsgCount} msgs` +
    ` | saved ${cStats.tokensSaved} tokens (${cStats.percentSaved}%)` +
    ` | ${cStats.compressionType}` +
    ` | code saved ${totalCodeSaved}`
  );

  res.setHeader('X-CtxCrush-Saved-Tokens',      String(cStats.tokensSaved));
  res.setHeader('X-CtxCrush-Saved-Pct',         String(cStats.percentSaved));
  res.setHeader('X-CtxCrush-Original-Msgs',     String(cStats.originalMsgCount));
  res.setHeader('X-CtxCrush-Compressed-Msgs',   String(cStats.compressedMsgCount));
  res.setHeader('X-CtxCrush-Code-Saved-Tokens', String(totalCodeSaved));

  let finalMessages = compressed;
  if (factsInjection) {
    finalMessages = [...compressed.slice(0, -1), factsInjection, compressed[compressed.length - 1]];
    console.log(`[factsnap] ✓ injected facts into FINAL context (after compression)`);
  }
  const newBody = { ...body, messages: finalMessages };
  return forward(req, res, upstreamURL, newBody);
}
// Step 1 (log-only): for non-streaming Groq requests, read the response to
// capture completion_tokens (real output tokens used), log it, then send the
// response on. Everything else keeps the blind pipe in forward() untouched.
async function forwardWithOutputCount(req, res, upstreamURL, body) {
  const headers = {
    'Content-Type':  'application/json',
    'Authorization': req.headers['authorization'] || '',
  };

  let upstream;
  try {
    upstream = await fetch(upstreamURL, {
      method:  'POST',
      headers,
      body:    JSON.stringify(body),
    });
  } catch (err) {
    console.error('[output] upstream fetch error:', err.message);
    return res.status(502).json({ error: 'Proxy upstream error', detail: err.message });
  }

  let data;
  try {
    data = await upstream.json();
  } catch (err) {
    console.error('[output] failed to parse response:', err.message);
    return res.status(upstream.status).json({ error: 'Could not parse upstream response' });
  }

  // LOG ONLY: real output tokens used, from the provider's own count.
  const outputTokens = data?.usage?.completion_tokens;
  if (typeof outputTokens === 'number') {
    stats.totalOutputTokens += outputTokens;
    console.log(`[output] completion_tokens: ${outputTokens} | running total: ${stats.totalOutputTokens}`);
  } else {
    console.log(`[output] no completion_tokens in response`);
  }

  // Send the response on unchanged.
  res.status(upstream.status).json(data);
}
// ── Forward to real upstream (handles both streaming and JSON) ────────────────

  async function forward(req, res, upstreamURL, body) {
  // Step 1: non-streaming Groq requests go through output-counting path.
  // Everything else keeps the original blind-pipe below, untouched.
  const isGroq = upstreamURL.includes('api.groq.com');
  const isNonStreaming = body.stream !== true;
  if (isGroq && isNonStreaming) {
    return forwardWithOutputCount(req, res, upstreamURL, body);
  }
  // Build headers — forward auth, content-type, etc.
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

// Groq (FREE tier — Llama, Mixtral, etc.) — OpenAI-compatible
app.post('/groq/v1/chat/completions', (req, res) => {
  handleRequest(req, res, 'https://api.groq.com/openai/v1/chat/completions');
});

// Google Gemini — OpenAI-compatible endpoint
app.post('/gemini/v1/chat/completions', (req, res) => {
  handleRequest(req, res, 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
});

// OpenRouter — ONE key, access to hundreds of models (GPT, Claude, Gemini, Llama, etc.)
app.post('/openrouter/v1/chat/completions', (req, res) => {
  handleRequest(req, res, 'https://openrouter.ai/api/v1/chat/completions');
});

// UNIVERSAL — works with ANY OpenAI-compatible provider.
// The client sends the full upstream URL in the X-Upstream-Url header.
app.post('/custom/v1/chat/completions', (req, res) => {
  const target = req.headers['x-upstream-url'];
  if (!target) {
    return res.status(400).json({ error: 'Custom provider requires X-Upstream-Url header' });
  }
  handleRequest(req, res, target);
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
app.post('/mcp', async (req, res) => {
  try {
    const mcpServer = createMcpServer(stats);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close(); mcpServer.close(); });
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('[mcp] error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'MCP server error' });
  }
});
app.get('/mcp', async (req, res) => {
  try {
    const mcpServer = createMcpServer(stats);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close(); mcpServer.close(); });
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res);
  } catch (err) {
    console.error('[mcp] error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'MCP server error' });
  }
});
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n⚡ CtxCrush Proxy running on port ${PORT}`);
  console.log(`   OpenAI  →  POST http://localhost:${PORT}/v1/chat/completions`);
  console.log(`   Claude  →  POST http://localhost:${PORT}/v1/messages`);
  console.log(`   Stats   →  GET  http://localhost:${PORT}/stats`);
  console.log(`\n   Config: windowSize=${CFG.windowSize} | pruneFillers=${CFG.pruneFillers}\n`);
});