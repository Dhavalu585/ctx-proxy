# ⚡ CtxCrush Proxy

A drop-in proxy that **compresses LLM conversation history before it reaches the model**, cutting token usage (and cost) on long conversations — with a single configuration change and no rewrite of your application code.
Test Line
Works with OpenAI, Anthropic, Groq, Google Gemini, OpenRouter, or **any** OpenAI-compatible API.

---

## The problem

LLM API costs scale with conversation length. Every time you send a message in a multi-turn chat, the **entire history** is resent and re-billed. A 50-message conversation pays for all 50 messages on every single turn. For apps with long-running conversations, this dominates the bill.

## The solution

CtxCrush sits between your application and the LLM provider. On each request it:

1. Keeps your most recent messages **verbatim** (the model needs full recent detail).
2. Compresses older messages into a compact, structured summary.
3. Forwards the smaller payload to the provider.

The model still receives the full context — just packed efficiently. Typical savings on long conversations are **20–70%**, depending on content.

> **Note:** Compression of older messages is *lossy by design* — it summarizes. Validate output quality on your own real conversations before relying on it in production.

---

## How it works

CtxCrush applies five techniques together:

| Technique | What it does | Lossy? |
|---|---|---|
| **Sliding window** | Keeps the last N messages (default 10) completely untouched | No |
| **Event classification** | Tags each old message by type — error, code, decision, task, reference, role, intent — with a priority weight | — |
| **XML snapshot** | Repacks classified events into a compact `<ctx>` block, grouped by category and deduplicated | Yes |
| **Filler pruning** | Strips zero-information phrases ("Sure!", "Hope this helps!") | Minimal |
| **Safety check** | If compression wouldn't save tokens, sends the original untouched — never makes things worse | No |



---

## Quick start

### Run locally

```bash
git clone https://github.com/YOUR-USERNAME/ctx-proxy.git
cd ctx-proxy
npm install
node server.js
```

You'll see:

```
⚡ CtxCrush Proxy running on port 3000
```

### Deploy to Render (free)

1. Push this repo to GitHub.
2. On [render.com](https://render.com): **New → Web Service** → connect the repo.
3. Settings:
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Instance Type:** Free
4. Deploy. Your proxy is live at `https://your-service.onrender.com`.

> Render's free tier sleeps after 15 minutes idle; the first request then takes ~30–60s to wake. Use a paid tier for production.

---

## Usage

Change **one line** in your code — point the base URL at the proxy instead of the provider.

### Python

```python
from openai import OpenAI

client = OpenAI(
    api_key="sk-...",
    base_url="https://your-service.onrender.com/v1"
)
```

### JavaScript / Node.js

```js
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: "sk-...",
  baseURL: "https://your-service.onrender.com/v1"
});
```

### curl

```bash
curl https://your-service.onrender.com/v1/chat/completions \
  -H "Authorization: Bearer sk-..." \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"Hello"}]}'
```

Your API key is forwarded to the provider in the request header. **It is never stored.**

---

## Supported providers

| Provider | Endpoint | Notes |
|---|---|---|
| OpenAI | `POST /v1/chat/completions` | Default |
| Anthropic | `POST /v1/messages` | Claude |
| Groq | `POST /groq/v1/chat/completions` | Free tier, no card |
| Google Gemini | `POST /gemini/v1/chat/completions` | Free tier |
| OpenRouter | `POST /openrouter/v1/chat/completions` | One key, hundreds of models |
| **Any** | `POST /custom/v1/chat/completions` | Pass target URL in `X-Upstream-Url` header |

---

## Built-in browser tester

Open `https://your-service.onrender.com/test` in a browser for a live chat UI. Pick a provider, paste your key, and watch the per-request token savings appear as you chat. No install required.

---

## Configuration

Set these as environment variables (or in a `.env` file locally):

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Port to run on |
| `WINDOW_SIZE` | `10` | Recent messages kept verbatim |
| `MIN_MESSAGES` | `6` | Skip compression below this message count |
| `PRUNE_FILLERS` | `true` | Strip filler phrases |
| `MAX_EVENTS` | `12` | Max items per category in the XML snapshot |

---

## Monitoring

`GET /` returns health, config, and cumulative stats. `GET /stats` returns raw stats:

```json
{
  "requests": 142,
  "compressed": 128,
  "skipped": 14,
  "totalSaved": 84200,
  "totalBefore": 271000
}
```

Each compressed response also includes headers: `X-CtxCrush-Saved-Tokens`, `X-CtxCrush-Saved-Pct`, `X-CtxCrush-Original-Msgs`, `X-CtxCrush-Compressed-Msgs`.

---

## Who this is for

Best fit: **developers building their own applications** on top of LLM APIs, where the app controls and resends the full conversation history on each call.

Not a fit: commercial coding agents (Cursor, Windsurf) and chat UIs (ChatGPT, Claude.ai), which manage conversation history on their own servers and already apply their own context handling.

---

## Project structure

```
ctx-proxy/
├── server.js        Express proxy server + routes + browser tester
├── compressor.js    Compression engine (classification, snapshot, pruning)
├── package.json     Dependencies
└── .env.example     Configuration template
```

---

## Roadmap

- [ ] Per-user API keys + authentication to the proxy
- [ ] Usage tracking tied to keys (billing foundation)
- [ ] Streaming response support for compressed requests
- [ ] Configurable compression strategy per route
- [ ] Quality benchmarking suite on real conversation datasets

---

## License

MIT — use freely.

---

## Acknowledgements

Event-classification and snapshot approach adapted from [context-mode](https://github.com/mksglu/context-mode).
