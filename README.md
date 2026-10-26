# ⚡ Client-Side App Builder

A **100% client-side, zero-backend, privacy-first** multi-model AI app/website builder that runs entirely in the browser (static SPA — just open `index.html` or serve the folder).

- **No server, no accounts, no telemetry.** API keys live in `localStorage`; project files, trees and logs live in `IndexedDB`.
- Works with any **OpenAI-compatible** endpoint (OpenAI, Groq, OpenRouter, Together AI, Ollama, LM Studio…), plus native **Anthropic** and **Gemini** request formats.

## 🚀 Run it

```bash
# Option A – just open
open index.html            # (Chrome/Edge/Firefox)

# Option B – static serve (recommended for fetch/CORS comfort)
python3 -m http.server 8080
# → http://localhost:8080
```

Everything is vendored locally (`vendor/jszip.min.js`, CodeMirror editor + modes) — no CDN needed at runtime; only your chosen model endpoint is contacted.

## 🧩 Feature map (PRD coverage)

### Module A — Provider & API Management (⚙️ Providers page)
| Requirement | Implementation |
|---|---|
| Config form (Name, Base URL, Key, Model, Max Tokens, Temperature) | `providerForm` + presets for OpenAI/Groq/OpenRouter/Together/Ollama/LM Studio/Anthropic/Gemini |
| OpenAI REST / Anthropic / Gemini specs | `buildChatRequest()` emits `/chat/completions`, `/messages` (+`anthropic-dangerous-direct-browser-access`), or `:generateContent` |
| Test Connection (`1+1=?` probe) | Sends a tiny chat probe; shows HTTP status, token count and the model's reply |
| **Conditional Save button** | `Save Provider` stays `disabled` until a live **HTTP 200 OK** is received; any edit to name/url/key/model/spec re-locks it |
| Active health check per card | 📡 Ping button → `/v1/models` (fallback chat probe) → live latency e.g. **“3ms – Active 🟢”** |
| API analytics | Per-provider `totalRequests` / `totalTokensUsed` counters + usage table + dashboard tiles |

### Module B — AI-Powered Interactive Dashboard (🏠)
- **Dynamic theme engine:** Glassmorphism Dark · Cyberpunk · Neumorphism · Clean Minimal (CSS-variable driven, persisted, “🎨 AI Theme” vibe picker).
- **Daily smart prompts:** time-aware suggestion pools (morning/afternoon/evening/night) rendered as one-click chips.
- **Auto-typing prompt assistant:** animated typewriter cycling ideas; *Use this idea* inserts into the active prompt context.
- Project launcher cards, generation stats, and per-file token log table.

### Module C — File Manager & Code Studio (🧑‍💻)
- VS Code-style tree from the flat `ProjectFile[]` schema: create file/folder (nested paths auto-create ancestors), rename (folders cascade), delete, right-click actions, format whitelist `.html .css .js .ts .php .json .md`.
- **CodeMirror editor** (CM6-style editing API) with per-extension syntax highlighting, autosave + `Ctrl/Cmd+S`.
- **Live sandbox:** isolated `<iframe sandbox>` rendered via `srcdoc`; relative `<link>`/`<script src>` are resolved against project files so multi-file apps run instantly.
- **One-click ZIP export** of the whole directory tree using JSZip (fully client-side).

### 🤖 Generation pipeline
The exact **Master System Prompt** from the PRD is sent as the system message; the reply is parsed as a JSON array of `{path, content}` (fenced-code tolerant), folders are materialized, each file logged with input/output tokens + latency.

## 💾 Data schema (as specified)
- `ProviderConfig` → localStorage `csab.providers` (id, name, baseUrl, apiKey, model, totalRequests, totalTokensUsed, lastHealthCheckMs, status `'active'|'error'|'untested'`, plus spec/maxTokens/temperature).
- `ProjectFile` / `AppProject` → IndexedDB `csappbuilder` → stores `projects` and `generationLogs`.

## 🔒 Privacy notes
- Keys never leave the browser except as auth headers directly to the endpoint you configured.
- Local providers (Ollama/LM Studio) need no key and keep everything on-machine.
- Browser CORS policy applies to remote APIs — endpoints that allow browser calls (Groq, OpenRouter, Ollama with `OLLAMA_ORIGINS=*`) work out of the box.
