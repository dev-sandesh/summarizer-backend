# Page Summarizer — Technical Documentation

A Chrome Manifest V3 extension that summarizes any webpage using AI. Free for end users, ~$0/month for the operator at small scale, fully privacy-preserving.

---

## Architecture

```
┌─────────────────────────┐
│  Chrome Extension       │
│  (popup.js + bg worker) │
└───────────┬─────────────┘
            │ POST /api/summarize
            │ { title, text, style, tone }
            ▼
┌─────────────────────────────────────────┐
│  Vercel Serverless Function             │
│  summarizer-backend-omega.vercel.app    │
│  • Validates token                      │
│  • Builds prompt from style + tone      │
│  • Forwards article to Groq             │
│  • Logs anonymous event to PostHog      │
└───────────┬─────────────────────────────┘
            │
            ▼
┌─────────────────────────┐
│  Groq API               │
│  Llama 3.3 70B          │
│  (~1–2s inference)      │
└─────────────────────────┘
```

Two side channels:

```
chrome.storage.local  ←  prefs, daily count, optional BYOK key
PostHog API           ←  anonymous usage events from /api/summarize
Resend API            ←  user feedback emails (server-side, key never exposed)
```

---

## File structure

```
claude-summarizer 2/
├── manifest.json          # MV3 manifest
├── popup.html             # main popup UI
├── popup.js               # popup logic + page extraction
├── background.js          # service worker — routes summarize requests
├── options.html           # settings page (BYOK + about)
├── options.js             # BYOK key entry + validation
├── content.js             # (legacy, unused — kept for reference)
├── icons/                 # 16, 48, 128 px PNGs
├── api/
│   ├── summarize.js       # Vercel function — Groq proxy + analytics
│   └── feedback.js        # Vercel function — Resend email forwarder
├── vercel.json            # Vercel runtime config
└── worker/                # (alternate Cloudflare Worker — not currently deployed)
```

---

## Extension (client)

### Permissions

Declared in `manifest.json`:

| Permission | Purpose |
|---|---|
| `activeTab` | Access the current tab when the user clicks Summarize |
| `scripting` | Inject the content-extraction function into the active tab |
| `storage` | Persist preferences, daily counter, and optional BYOK key |

Host permissions:

| Host | Used for |
|---|---|
| `https://summarizer-backend-omega.vercel.app/*` | Default backend |
| `https://api.groq.com/*` | BYOK direct call (Groq) |
| `https://openrouter.ai/*` | BYOK direct call (OpenRouter) |

### Page extraction (`popup.js`)

A function is injected into the active tab via `chrome.scripting.executeScript`. It:

1. Tries common article selectors (`article`, `[role="main"]`, `main`, `.article-body`, etc.)
2. Clones the matched element and strips `script`, `style`, `nav`, `header`, `footer`, `aside`, `noscript`, `iframe`
3. Normalizes whitespace and truncates to 15 000 characters
4. Returns `{ title, url, text }`

### Daily rate limiting (`popup.js`)

Client-side only. Stored as `{ usageDate: "YYYY-MM-DD", usageCount: N }` in `chrome.storage.local`. Resets at midnight in the user's locale. Skipped entirely when a BYOK key is set (the user's own quota applies).

### Request flow (`background.js`)

```
popup.js → chrome.runtime.sendMessage({ action: 'summarize', ... })
            → background.js handleSummarize()
                → if byokKey:  callProviderDirect(byokKey, byokProvider, ...)
                → else:        callWorker(...)
```

`callProviderDirect` uses an OpenAI-compatible Chat Completions request to either:
- `api.groq.com/openai/v1/chat/completions` — model `llama-3.3-70b-versatile`
- `openrouter.ai/api/v1/chat/completions` — model `meta-llama/llama-3.3-70b-instruct:free`

`callWorker` POSTs to the Vercel backend with an `X-Extension-Token` header.

### Settings page (`options.html` + `options.js`)

Collapsible Advanced section that lets a user paste a Groq or OpenRouter API key. The key is validated by making a single test completion call to the provider directly. If the response is non-200, the key is rejected. On success, the key is saved to `chrome.storage.local` and used in place of the backend on subsequent requests.

---

## Backend (Vercel)

### `api/summarize.js`

OpenAI-compatible POST endpoint. CommonJS module exported via `module.exports`.

Environment variables:

| Name | Purpose | Required |
|---|---|---|
| `GROQ_API_KEY` | Server-side Groq key for the shared backend | Yes |
| `EXTENSION_TOKEN` | Shared secret in the `X-Extension-Token` header | No (recommended) |
| `POSTHOG_API_KEY` | PostHog project key for analytics | No |

Flow:

1. CORS preflight handling
2. Validate `X-Extension-Token` against `process.env.EXTENSION_TOKEN`
3. Parse `{ title, text, style, tone }` from body; reject if `text.length < 100`
4. Hash the caller IP to a 16-char SHA-256 prefix → used as PostHog `distinct_id`
5. Build the system prompt by joining a `STYLE_PROMPTS[style]` and `TONE_PROMPTS[tone]` snippet
6. Forward to Groq with `model: llama-3.3-70b-versatile`, `temperature: 0.3`, `max_tokens: 1024`
7. On 429 from Groq → 429 to client with a "quota exhausted" message
8. On success → `await capture(distinctId, 'page_summarized', { style, tone, text_length, summary_length, model })`
9. Return `{ summary, model: 'Llama 3.3 70B · Groq' }`

PostHog events are awaited because Vercel freezes the function after the response is sent, otherwise pending fetches are killed.

### `api/feedback.js`

POST endpoint that forwards a user-typed message to the developer via Resend.

Environment variables:

| Name | Purpose | Required |
|---|---|---|
| `RESEND_API_KEY` | Resend API key | Yes |

The free tier of Resend only delivers to the email associated with the Resend account, so the Resend account must be registered with the destination email (`iamsandeshjain@gmail.com`).

### `vercel.json`

```json
{
  "functions": {
    "api/*.js": {
      "maxDuration": 30
    }
  }
}
```

---

## Prompt construction

Style and tone are independent. The system prompt is constructed by string-concatenating the corresponding `STYLE_PROMPTS[style]` and `TONE_PROMPTS[tone]` snippets, then appending an instruction not to add a "Here is a summary…" preamble.

Style snippets:

| Style | Snippet |
|---|---|
| `bullet` | Concise bullet-point list, 5–8 bullets, one idea each |
| `tldr` | Single paragraph, 3–5 sentences |
| `takeaways` | 5–7 complete, standalone insights |
| `qa` | 4–5 Q&A pairs, formatted `Q: … / A: …` |

Tone snippets:

| Tone | Snippet |
|---|---|
| `professional` | Professional, formal |
| `casual` | Conversational, friendly |
| `technical` | Concise, precise, no filler |
| `eli5` | Plain language, no jargon |

The user message is `Title: {title}\n\n{text}` if a title is present, otherwise just the body.

---

## Analytics

PostHog events fired from `api/summarize.js`:

| Event | Properties |
|---|---|
| `page_summarized` | `style`, `tone`, `text_length`, `summary_length`, `model` |
| `summarize_failed` | `reason` ∈ {`groq_quota`, `groq_error`, `empty_response`, `server_error`}, `style`, `tone` |

`distinct_id` is the first 16 hex characters of `SHA-256(x-forwarded-for)`. This gives unique-user counts without storing raw IPs.

---

## Capacity & limits

Free-tier ceilings at time of writing:

| Layer | Limit | Effective max |
|---|---|---|
| Vercel Hobby | 100 000 invocations / month | ~3 300 / day |
| Groq | 14 400 requests / day, 6 000 TPM | ~14 400 / day |
| PostHog | 1 000 000 events / month | far exceeds the above |
| Resend | 100 emails / day | feedback only |

Vercel is the binding constraint. Equates to roughly 1 500–2 000 daily active users at 2 summaries per user per day. Beyond that, either:

- Move the backend to Cloudflare Workers (100 000 req/day free), or
- Upgrade to Vercel Pro ($20/month, unlimited invocations)

---

## Local development

### Loading the extension

```bash
# In Chrome
chrome://extensions/
→ Developer mode ON
→ Load unpacked
→ select /Users/sjain43/Downloads/claude-summarizer 2
```

### Iterating

1. Edit any file in the extension root
2. Hit the refresh icon on the extension card in `chrome://extensions/`
3. Re-open the popup to see changes

### Running the backend locally

```bash
cd "/Users/sjain43/Downloads/claude-summarizer 2"
vercel dev
```

Then change `WORKER_URL` in `background.js` to `http://localhost:3000/api/summarize` for the duration of testing.

### Deploying

The Vercel project is connected to the `dev-sandesh/summarizer-backend` GitHub repo. Push to `main` and Vercel auto-deploys. Manual deploy:

```bash
vercel deploy --prod
```

---

## Privacy

- Article text is sent to the Vercel backend, then to Groq. Neither retains it after the response.
- IP addresses are hashed (SHA-256, 16-char prefix) before being sent to PostHog. Raw IPs are never logged or stored.
- BYOK keys are stored only in `chrome.storage.local`, never transmitted to our backend.
- Feedback messages are forwarded to the developer's email via Resend, then discarded by the function.

---

## Things deliberately left out

- **Server-side rate limiting** — the 10/day cap is enforced client-side. A determined user could bypass it by clearing storage. Acceptable while the user base is small; revisit if abuse becomes visible in PostHog.
- **Real BYOK secret handling** — keys live in `chrome.storage.local`, which is readable by other extensions with `storage` permission. Industry standard for extensions; flagged here for awareness.
- **i18n** — English only.
- **Streaming responses** — the popup waits for the full completion before rendering. Acceptable at Groq's latency; would be worth adding if we ever switch to slower models.
