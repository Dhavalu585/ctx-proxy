'use strict';

require('dotenv').config();
const { validatePreservation } = require('./validate-preservation');
const express  = require('express');
const cors     = require('cors');
const fetch    = (...a) => import('node-fetch').then(({ default: f }) => f(...a));
const { compressMessages, estimateTokens } = require('./compressor');
const { classifyIntent, modelForIntent } = require('./intent');
const { retrieveRelevant, formatRetrieved } = require('./retrieval');
const { assembleIntents, formatAssembly } = require('./assembly');
const { orchestrate, combineResults, mergeResults } = require('./orchestrator');
const app  = express();
const PORT = process.env.PORT || 3000;


// ── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '10mb' }));
// === Preservation switch — flip to true to enable content-preservation validation ===
const PRESERVE_ENABLED = false;
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
  body{background:var(--bg);color:var(--text);font-family:'Syne',sans-serif;min-height:100vh;display:grid;grid-template-columns:280px 1fr;grid-template-rows:56px 1fr;grid-template-areas:"header header" "sidebar main"}
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
  .sgrid{display:grid;grid-template-columns:1fr 1fr;gap:6px}
  .sc{background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:9px 10px}
  .sc.w{grid-column:1/-1;border-color:rgba(124,106,255,.3);background:rgba(124,106,255,.06)}
  .sl{font-family:'IBM Plex Mono',monospace;font-size:8px;color:var(--muted);text-transform:uppercase;letter-spacing:.07em;margin-bottom:3px}
  .sv{font-size:19px;font-weight:800;letter-spacing:-1px;line-height:1}
  .sv.g{color:var(--green)} .sv.a{color:var(--accent2)}
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
  #savings-banner{margin:14px 22px 0;padding:16px 20px;border-radius:14px;background:linear-gradient(135deg,rgba(52,211,153,.14),rgba(124,106,255,.12));border:1px solid rgba(52,211,153,.35);text-align:center;animation:fu .3s ease}
  .sb-big{font-size:24px;font-weight:800;letter-spacing:-.5px;color:var(--green)}
  .sb-big span{color:var(--green)}
  .sb-sub{font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--muted);margin-top:5px}
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
    <div class="slbl">Session Stats</div>
    <div class="sgrid">
      <div class="sc w"><div class="sl">Tokens saved</div><div class="sv g" id="ss">0</div></div>
      <div class="sc"><div class="sl">Requests</div><div class="sv a" id="sr">0</div></div>
      <div class="sc"><div class="sl">Avg saved</div><div class="sv" id="sp">0%</div></div>
    </div>
  </div>
</aside>
<main>
  <div id="savings-banner" style="display:none">
    <div class="sb-big"><span id="sb-tokens">0</span> tokens saved this session</div>
    <div class="sb-sub">Without CtxCrush you'd have sent <span id="sb-without">0</span> tokens · with it, only <span id="sb-with">0</span> · that's <span id="sb-pct">0%</span> less</div>
  </div>
  <div id="msgs">
    <div class="empty" id="empty">
      <div class="ei">⚡</div>
      <div>Enter your OpenAI API key<br>and click <strong>Connect</strong></div>
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
let hist=[], conn=false, ss={saved:0,reqs:0,before:0};
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
function updStats(saved,before){
  ss.saved+=saved;ss.reqs++;ss.before+=before;
  $('ss').textContent=ss.saved.toLocaleString();
  $('sr').textContent=ss.reqs;
  $('sp').textContent=(ss.before>0?Math.round(ss.saved/ss.before*100):0)+'%';
  // Update the big savings banner
  if(ss.saved>0){
    const withTokens=ss.before-ss.saved;
    const pct=ss.before>0?Math.round(ss.saved/ss.before*100):0;
    $('sb-tokens').textContent=ss.saved.toLocaleString();
    $('sb-without').textContent=ss.before.toLocaleString();
    $('sb-with').textContent=withTokens.toLocaleString();
    $('sb-pct').textContent=pct+'%';
    $('savings-banner').style.display='block';
  }
}
async function connect(){
  const key=$('akey').value.trim();
  if(!key){alert('Please enter your API key first');return}
  try{
    const r=await fetch(PROXY+'/');
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
    const pct=parseInt(r.headers.get('X-CtxCrush-Saved-Pct')||'0');
    const om=parseInt(r.headers.get('X-CtxCrush-Original-Msgs')||'0');
    const cm=parseInt(r.headers.get('X-CtxCrush-Compressed-Msgs')||'0');
    const badge=saved>0?{t:'s',l:'⚡ '+saved+' tokens saved ('+pct+'%) · '+om+'→'+cm+' msgs'}:null;
    addMsg('assistant',reply,badge);hist.push({role:'assistant',content:reply});
    if(saved>0){const b=Math.ceil(hist.slice(0,-1).reduce((s,m)=>s+m.content.length,0)/4);updStats(saved,b)}
  }catch(e){rmTyping();addMsg('system','✗ '+e.message);hist.pop()}
  finally{$('sbtn').disabled=false;inp.focus()}
}
function clearChat(){hist=[];$('msgs').innerHTML='<div class="empty" id="empty"><div class="ei">⚡</div><div>Chat cleared.</div></div>'}
</script>
</body>
</html>`);
});

// ─────────────────────────────────────────────────────────────────────────────
// CORE: compress + forward
// ─────────────────────────────────────────────────────────────────────────────
// Stage 4: structured retrieval (LOG ONLY — not injected into context yet)
async function handleRequest(req, res, upstreamURL) {
  stats.requests++;

  // Allow the client to override the upstream target via header.
  // This makes the proxy work with ANY OpenAI-compatible provider
  // without needing a hardcoded route.
  const override = req.headers['x-upstream-url'];
  if (override) upstreamURL = override;

  const body = req.body;

  // Pull out the messages array
  const messages = body.messages;
  // Stage 2 + 3: classify intent and route to the matching model
  if (Array.isArray(messages)) {
    const intent = classifyIntent(messages);
    const chosenModel = modelForIntent(intent);
    console.log(`[intent] ${intent} → [model] ${chosenModel}`);
    body.model = chosenModel;   // override the model based on intent
  }
/// Stage 5–8 orchestration is now OPT-IN: only runs when the caller sends
  // the header  X-CtxCrush-Orchestrate: true . Default behaviour = clean
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
        // Stage 8: try coherent merge; fall back to labeled concatenation
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

  if (!Array.isArray(messages) || messages.length === 0) {
    // Nothing to compress — pass straight through
    return forward(req, res, upstreamURL, body);
  }

  // ── Compress ───────────────────────────────────────────────────────────────
  const { messages: compressed, stats: cStats } = compressMessages(messages, CFG);
  // Content-preservation guard: if compression dropped anything critical
  // (code, URLs, error types, numbers), skip compression for safety.
  if (PRESERVE_ENABLED && !cStats.skipped) {
    const originalText = JSON.stringify(messages);
    const compressedText = JSON.stringify(compressed);
    const check = validatePreservation(originalText, compressedText);
    if (!check.ok) {
      console.log(`[preserve] ✗ critical content would be lost — using ORIGINAL. Missing:`,
        JSON.stringify(check.missing));
      return forward(req, res, upstreamURL, body);   // send original, uncompressed
    }
    console.log(`[preserve] ✓ all critical content intact`);
  }

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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n⚡ CtxCrush Proxy running on port ${PORT}`);
  console.log(`   OpenAI  →  POST http://localhost:${PORT}/v1/chat/completions`);
  console.log(`   Claude  →  POST http://localhost:${PORT}/v1/messages`);
  console.log(`   Stats   →  GET  http://localhost:${PORT}/stats`);
  console.log(`\n   Config: windowSize=${CFG.windowSize} | pruneFillers=${CFG.pruneFillers}\n`);
});
