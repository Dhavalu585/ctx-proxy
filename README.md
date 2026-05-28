# CtxCrush — Context Compressor for ChatGPT & Claude

Compresses your AI conversations before they're sent — cuts token costs up to 70% with zero effort.

## How to install (takes 60 seconds)

1. Open Chrome and go to `chrome://extensions`
2. Toggle **Developer mode** ON (top-right switch)
3. Click **Load unpacked**
4. Select the `ctx-crush` folder (this folder)
5. The ⚡ icon appears in your toolbar — you're live

## What it does

Every time you send a message on ChatGPT or Claude.ai, the extension:

1. **Intercepts** the outgoing API request
2. **Compresses** the older parts of the conversation into a compact summary
3. **Keeps** your most recent messages verbatim (configurable, default: last 6)
4. **Prunes** filler phrases ("Sure!", "Hope this helps!", etc.)
5. **Forwards** the lean prompt to the LLM instead

The LLM still sees the full context — just packed efficiently.

## Popup controls

| Control | What it does |
|---|---|
| Compression toggle | Enable / pause the extension |
| Recent messages to keep | How many latest messages stay verbatim |
| Prune filler phrases | Remove low-information assistant preambles |
| Reset Stats | Clear the session token counter |

## Works on

- ChatGPT (chat.openai.com, chatgpt.com)
- Claude.ai

## Privacy

Everything runs locally in your browser. No data is sent to any third-party server.
Your conversations never leave your browser except to the LLM you're already using.

## Files

```
ctx-crush/
  manifest.json          Chrome extension manifest
  popup.html             The ⚡ popup UI
  src/
    background.js        Service worker (config + stats storage)
    interceptor.js       Fetch interceptor (runs on page)
    compressor.js        Compression engine (pure logic)
  icons/
    icon16/48/128.png    Extension icons
```
