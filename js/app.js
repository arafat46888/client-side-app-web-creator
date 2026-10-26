/* ============================================================================
   CLIENT-SIDE APP BUILDER — 100% browser-executed, zero-backend AI studio
   Storage: localStorage (providers / theme / settings) + IndexedDB (projects,
            file trees, generation logs).
   ==========================================================================*/
"use strict";

/* ---------------------------------------------------------------- helpers */
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
const fmtNum = n => n >= 1e6 ? (n/1e6).toFixed(2)+"M" : n >= 1e3 ? (n/1e3).toFixed(1)+"k" : String(n|0);

function toast(msg, kind = "", ms = 3200) {
  const t = document.createElement("div");
  t.className = "toast " + kind; t.textContent = msg;
  $("#toastWrap").appendChild(t);
  setTimeout(() => { t.style.opacity = "0"; t.style.transition = ".3s"; setTimeout(() => t.remove(), 300); }, ms);
}
function promptModal(title, def = "", placeholder = "") {
  return new Promise(res => {
    const m = $("#modalBack"), i = $("#modalInput");
    $("#modalTitle").textContent = title; i.value = def; i.placeholder = placeholder;
    m.classList.add("open"); i.focus(); i.select();
    const done = v => { m.classList.remove("open"); $("#modalOk").onclick = $("#modalCancel").onclick = i.onkeydown = null; res(v); };
    $("#modalOk").onclick = () => done(i.value.trim() || null);
    $("#modalCancel").onclick = () => done(null);
    i.onkeydown = e => { if (e.key === "Enter") done(i.value.trim() || null); if (e.key === "Escape") done(null); };
  });
}

/* --------------------------------------------- TWO-PASS AI SYSTEM PROMPTS */
const DEFAULT_SP_PLANNER = `You are the planning brain of a client-side app builder. Given a user request and the current project file list, output ONLY valid JSON:
{
  "intent": "build" | "edit",
  "summary": "<one sentence>",
  "filesToTouch": ["<existing or new path>", ...],
  "plan": ["<imperative step>", ...]
}
Rules:
- For "edit", filesToTouch MUST be a subset of existing files + at most 2 new files.
- Never list more than 6 files. Prefer fewer.
- No prose. No markdown fences. JSON only.`;

const DEFAULT_SP_CODER = `You are "Client-Side App Builder AI". You generate production-ready web app code.

### INPUT
You receive: user request, an approved plan, the full content of files listed in the plan, and a CDN whitelist.

### RUNTIME
Browser-only sandbox. No build step. No Node. No require(). Use <script type="module"> + ESM CDN URLs (esm.sh, jsdelivr) for libs. Tailwind via CDN (https://cdn.tailwindcss.com). Prefer vanilla JS + Tailwind for small apps; React via esm.sh only if requested.

### OUTPUT
Return ONLY valid JSON, no fences, matching:
{
  "changes": [
    { "op": "create"|"update"|"delete", "path": "<relative, no leading />", "content": "<full file content>" }
  ]
}
Rules:
- Only touch files in the approved plan. Unmentioned files are preserved by the host.
- "delete" has no content field.
- Every "create"/"update" contains the COMPLETE file. Never write "// rest unchanged".
- All relative <script src>/<link href> must point to files you are creating or updating in THIS response, or to absolute https CDN URLs.
- No placeholder comments. No TODOs. No truncation.
- If the request is ambiguous or unsafe, return:
  { "changes": [], "error": "<reason>" }`;

const getSpPlanner = () => localStorage.getItem("csab.sp.planner") || DEFAULT_SP_PLANNER;
const getSpCoder   = () => localStorage.getItem("csab.sp.coder")   || DEFAULT_SP_CODER;
const getRouting   = () => { try { return JSON.parse(localStorage.getItem("csab.routing")) || {}; } catch { return {}; } };
const setRouting   = r => localStorage.setItem("csab.routing", JSON.stringify(r));

/* ------------------------------------------------------ localStorage cfg */
const LS_PROVIDERS = "csab.providers", LS_THEME = "csab.theme", LS_PROJECT = "csab.activeProject";
const getProviders = () => { try { return JSON.parse(localStorage.getItem(LS_PROVIDERS)) || []; } catch { return []; } };
const setProviders = p => localStorage.setItem(LS_PROVIDERS, JSON.stringify(p));

/* ------------------------------------------------------------- IndexedDB */
const DB_NAME = "csappbuilder", DB_VER = 2;
let _dbp = null;
function openDB() {
  if (_dbp) return _dbp;
  _dbp = new Promise((res, rej) => {
    const rq = indexedDB.open(DB_NAME, DB_VER);
    rq.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains("projects"))     db.createObjectStore("projects", { keyPath: "id" });
      if (!db.objectStoreNames.contains("generationLogs")) db.createObjectStore("generationLogs", { keyPath: "id" });
      if (!db.objectStoreNames.contains("chatMessages"))  db.createObjectStore("chatMessages",  { keyPath: "id" });
      if (!db.objectStoreNames.contains("checkpoints"))   db.createObjectStore("checkpoints",   { keyPath: "id" });
    };
    rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error);
  });
  return _dbp;
}
async function idb(store, mode, fn) {                 // generic tx helper; fn(tx) -> req
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, mode), r = fn(tx);
    tx.oncomplete = () => res(r && r.result); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error);
  });
}
const DB = {
  putProject:  p => idb("projects", "readwrite", tx => tx.objectStore("projects").put(p)),
  delProject:  id => idb("projects", "readwrite", tx => tx.objectStore("projects").delete(id)),
  getProject:  id => idb("projects", "readonly",  tx => tx.objectStore("projects").get(id)),
  allProjects: () => idb("projects", "readonly",  tx => tx.objectStore("projects").getAll()),
  addLog:      l => idb("generationLogs", "readwrite", tx => tx.objectStore("generationLogs").put(l)),
  allLogs:     () => idb("generationLogs", "readonly", tx => tx.objectStore("generationLogs").getAll()),
  clearLogs:   () => idb("generationLogs", "readwrite", tx => tx.objectStore("generationLogs").clear()),
  /* chat thread per project */
  putMsg:      m => idb("chatMessages", "readwrite", tx => tx.objectStore("chatMessages").put(m)),
  msgsOf:      pid => idb("chatMessages", "readonly", tx => tx.objectStore("chatMessages").getAll()),
  delMsgsOf:   pid => idb("chatMessages", "readwrite", async tx => {
                    const st = tx.objectStore("chatMessages");
                    const all = await req0(st.getAll());
                    all.filter(m => m.projectId === pid).forEach(m => st.delete(m.id));
                  }),
  /* checkpoints (full snapshots — bulletproof undo) */
  putCkpt:     c => idb("checkpoints", "readwrite", tx => tx.objectStore("checkpoints").put(c)),
  ckptsOf:     pid => idb("checkpoints", "readonly", tx => tx.objectStore("checkpoints").getAll()),
  delCkptsOf:  pid => idb("checkpoints", "readwrite", async tx => {
                    const st = tx.objectStore("checkpoints");
                    const all = await req0(st.getAll());
                    all.filter(c => c.projectId === pid).forEach(c => st.delete(c.id));
                  }),
};
/* helper: turn an IDBRequest into a promise inside an async transaction callback */
function req0(r){ return new Promise((res,rej)=>{ r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); }); }

/* ============================================================== PROVIDERS */
const PRESETS = [
  { name:"OpenAI",     spec:"openai",    url:"https://api.openai.com/v1",                        model:"gpt-4o-mini" },
  { name:"Groq",       spec:"openai",    url:"https://api.groq.com/openai/v1",                   model:"llama-3.3-70b-versatile" },
  { name:"OpenRouter", spec:"openai",    url:"https://openrouter.ai/api/v1",                     model:"meta-llama/llama-3.3-70b-instruct" },
  { name:"Together",   spec:"openai",    url:"https://api.together.xyz/v1",                      model:"meta-llama/Llama-3.3-70B-Instruct-Turbo" },
  { name:"Ollama (local)", spec:"openai",url:"http://localhost:11434/v1",                        model:"llama3.1" },
  { name:"LM Studio (local)", spec:"openai", url:"http://localhost:1234/v1",                    model:"local-model" },
  { name:"Anthropic",  spec:"anthropic", url:"https://api.anthropic.com/v1",                     model:"claude-sonnet-4-20250514" },
  { name:"Gemini",     spec:"gemini",    url:"https://generativelanguage.googleapis.com/v1beta", model:"gemini-2.0-flash" },
];
let editingProviderId = null, testPassedFor = "";   // conditional-save gate

function providerSignature(f) { return [f.name, f.baseUrl, f.apiKey, f.model, f.spec].join("|"); }

function buildChatRequest(p, messages, opts = {}) {
  const maxTok = p.maxTokens || 8192, temp = p.temperature ?? 0.4;
  const wantStream = !!opts.stream;
  if (p.spec === "anthropic") {
    const sys = messages.find(m => m.role === "system")?.content;
    const rest = messages.filter(m => m.role !== "system");
    return {
      url: `${p.baseUrl.replace(/\/$/, "")}/messages`,
      headers: { "Content-Type":"application/json", "x-api-key":p.apiKey||"none",
                 "anthropic-version":"2023-06-01", "anthropic-dangerous-direct-browser-access":"true" },
      body: { model:p.model, max_tokens:maxTok, temperature:temp, ...(sys?{system:sys}:{}) , messages:rest, ...(wantStream?{stream:true}:{}) },
      extract: j => (j.content||[]).map(c => c.text || "").join(""),
      usage: j => ({ in:(j.usage?.input_tokens)||0, out:(j.usage?.output_tokens)||0 }),
    };
  }
  if (p.spec === "gemini") {
    const sys = messages.find(m => m.role === "system")?.content;
    const rest = messages.filter(m => m.role !== "system")
      .map(m => ({ role: m.role === "assistant" ? "model" : "user", parts:[{ text:m.content }] }));
    return {
      url: `${p.baseUrl.replace(/\/$/, "")}/models/${encodeURIComponent(p.model)}:generateContent?key=${encodeURIComponent(p.apiKey||"")}`,
      headers: { "Content-Type":"application/json" },
      body: { contents:rest, ...(sys?{systemInstruction:{parts:[{text:sys}]}}:{}),
              generationConfig:{ maxOutputTokens:maxTok, temperature:temp } },
      streamUrl: `${p.baseUrl.replace(/\/$/, "")}/models/${encodeURIComponent(p.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(p.apiKey||"")}`,
      sseExtract: j => (j.candidates?.[0]?.content?.parts||[]).map(x=>x.text).join(""),
      extract: j => (j.candidates?.[0]?.content?.parts||[]).map(x=>x.text).join(""),
      usage: j => ({ in:(j.usageMetadata?.promptTokenCount)||0, out:(j.usageMetadata?.candidatesTokenCount)||0 }),
    };
  }
  /* OpenAI-compatible default */
  return {
    url: `${p.baseUrl.replace(/\/$/, "")}/chat/completions`,
    headers: { "Content-Type":"application/json", ...(p.apiKey?{Authorization:`Bearer ${p.apiKey}`}:{}) },
    body: { model:p.model, messages, max_tokens:maxTok, temperature:temp, ...(wantStream?{stream:true}:{}) },
    sseExtract: j => j.choices?.[0]?.delta?.content ?? "",
    extract: j => j.choices?.[0]?.message?.content ?? "",
    usage: j => ({ in:(j.usage?.prompt_tokens)||0, out:(j.usage?.completion_tokens)||0 }),
  };
}

/* Unified completion call. Streams SSE when provider supports it (onDelta gets chunks). */
async function chatCompletion(p, messages, { signal, onDelta } = {}) {
  const req = buildChatRequest(p, messages, { stream: !!onDelta });
  let resp;
  try {
    resp = await fetch(req.url, { method:"POST", headers:req.headers, body:JSON.stringify(req.body), signal });
    if (!resp.ok && onDelta && req.sseExtract) {          // retry without streaming (some proxies reject SSE)
      resp = await fetch(req.url, { method:"POST", headers:req.headers,
        body:JSON.stringify({ ...req.body, stream:false }), signal });
    }
  } catch (e) {
    throw new Error(e.name === "AbortError" ? e : (e.message || "Network/CORS failure"));
  }
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${(await resp.text().catch(()=>"")) .slice(0,220)}`);
  const ctype = resp.headers.get("content-type") || "";
  if (onDelta && req.sseExtract && ctype.includes("event-stream") && resp.body) {
    const dec = new TextDecoder(); let buf = "", full = "";
    for await (const chunk of resp.body) {
      buf += dec.decode(chunk, { stream:true });
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        try {
          const j = JSON.parse(data);
          const piece = req.sseExtract(j);
          if (piece) { full += piece; onDelta(piece, full); }
        } catch {}
      }
    }
    const usage = { in: Math.ceil(messages.reduce((a,m)=>a+m.content.length,0)/4), out: Math.ceil(full.length/4) };
    return { text: full, usage, streamed: true };
  }
  const j = await resp.json();
  return { text: String(req.extract(j) || ""), usage: req.usage(j), streamed: false };
}

async function pingProvider(p) {
  /* Lightweight health check: models listing when available, else a tiny chat probe. */
  const t0 = performance.now();
  const base = p.baseUrl.replace(/\/$/, "");
  const noKey = !p.apiKey;
  const probeUrl = p.spec === "anthropic"
    ? { u: base + "/models?limit=1", h:{ "x-api-key":p.apiKey||"none", "anthropic-version":"2023-06-01", "anthropic-dangerous-direct-browser-access":"true" } }
    : p.spec === "gemini"
    ? { u: `${base}/models?key=${encodeURIComponent(p.apiKey||"")}`, h:{} }
    : { u: base + "/models", h: noKey?{}:{ Authorization:`Bearer ${p.apiKey}` } };
  try {
    const r = await fetch(probeUrl.u, { headers:probeUrl.h, signal: AbortSignal.timeout(15000) });
    if (r.ok) return { ok:true, ms: Math.round(performance.now()-t0) };
  } catch {}
  /* fallback: minimal chat probe "1+1=?" */
  try {
    const req = buildChatRequest(p, [{role:"user",content:"What is 1+1? Reply with only the number."}]);
    const r = await fetch(req.url, { method:"POST", headers:req.headers, body:JSON.stringify(req.body), signal: AbortSignal.timeout(20000) });
    if (r.ok) return { ok:true, ms: Math.round(performance.now()-t0) };
    return { ok:false, ms: Math.round(performance.now()-t0), err:`HTTP ${r.status} ${r.statusText}` };
  } catch (e) {
    return { ok:false, ms: Math.round(performance.now()-t0), err: e.message || "Network/CORS error" };
  }
}

function statusBadge(p) {
  if (p.status === "active") return `<span class="badge ok">🟢 Active · ${p.lastHealthCheckMs||0}ms</span>`;
  if (p.status === "error")  return `<span class="badge err">🔴 Error</span>`;
  return `<span class="badge warn">⚪ Untested</span>`;
}

function renderProviders() {
  const list = getProviders(), wrap = $("#providersList");
  $("#noProvHint").style.display = list.length ? "none" : "block";
  wrap.innerHTML = list.map(p => `
    <div class="provider-card" data-id="${p.id}">
      <div class="head">
        <b>${esc(p.name)}</b><span class="spec-tag">${esc((p.spec||"openai").toUpperCase())}</span>
        <span style="flex:1"></span>${statusBadge(p)}
      </div>
      <div class="muted mono" style="word-break:break-all">${esc(p.baseUrl)} → ${esc(p.model)}</div>
      <div class="row" style="font-size:11.5px;color:var(--muted)">
        <span>📮 ${p.totalRequests} req</span><span>🔢 ${fmtNum(p.totalTokensUsed)} tokens</span>
        <span>🌡 ${p.temperature ?? 0.4}</span><span>⬆ ${p.maxTokens || 8192} max tok</span>
      </div>
      <div class="row">
        <button class="btn sm" data-act="ping">📡 Ping / Check Status</button>
        <button class="btn sm" data-act="edit">✏️ Edit</button>
        <button class="btn sm danger" data-act="del">🗑 Delete</button>
        <span style="flex:1"></span>
        <span class="muted ping-slot" style="min-width:110px;text-align:right"></span>
      </div>
    </div>`).join("");
  renderUsageTable(); populateProviderSelects(); renderAnalytics();
}

function renderUsageTable() {
  $("#usageBody").innerHTML = getProviders().map(p => `
    <tr><td>${esc(p.name)}</td><td>${p.totalRequests}</td><td>${fmtNum(p.totalTokensUsed)}</td>
    <td>${p.lastHealthCheckMs ? p.lastHealthCheckMs + "ms" : "—"}</td>
    <td>${p.status === "active" ? "🟢 active" : p.status === "error" ? "🔴 error" : "⚪ untested"}</td></tr>`).join("")
    || `<tr><td colspan="5" class="muted">No providers configured.</td></tr>`;
}

function bumpUsage(id, tokens, ok) {
  const ps = getProviders(); const p = ps.find(x => x.id === id);
  if (p) { p.totalRequests++; p.totalTokensUsed += tokens;
    if (ok === true) { p.status = "active"; } if (ok === false) { p.status = "error"; }
    setProviders(ps); }
}

/* form <-> provider */
function readForm() {
  return {
    name: $("#pfName").value.trim(), spec: $("#pfSpec").value, baseUrl: $("#pfUrl").value.trim(),
    apiKey: $("#pfKey").value.trim(), model: $("#pfModel").value.trim(),
    maxTokens: parseInt($("#pfMaxTok").value, 10) || 8192,
    temperature: parseFloat($("#pfTemp").value) || 0.4,
  };
}
function fillForm(p) {
  $("#pfName").value = p?.name || ""; $("#pfSpec").value = p?.spec || "openai";
  $("#pfUrl").value = p?.baseUrl || ""; $("#pfKey").value = p?.apiKey || "";
  $("#pfModel").value = p?.model || ""; $("#pfMaxTok").value = p?.maxTokens || 8192;
  $("#pfTemp").value = p?.temperature ?? 0.4;
}
function resetForm() {
  editingProviderId = null; testPassedFor = "";
  fillForm({}); $("#provFormTitle").firstChild.textContent = "➕ Add Provider ";
  $("#saveProvBtn").disabled = true; $("#cancelEditBtn").style.display = "none";
  $("#testResult").textContent = "Save stays locked until a live HTTP 200 OK is received from this endpoint.";
}
function invalidateTest() {           // any change re-locks Save
  const sig = providerSignature(readForm());
  if (sig !== testPassedFor) $("#saveProvBtn").disabled = true;
}

/* friendly hints for the most common browser-side connection failures */
function explainTestFailure(detail, f) {
  const d = String(detail || "").toLowerCase();
  if (d.includes("failed to fetch") || d.includes("networkerror") || d.includes("load failed") || d.includes("network/cors")) {
    let hint = "The browser could not reach this endpoint at all (network blocked or CORS refused).";
    if (/^http:\/\//i.test(f.baseUrl) && location.protocol === "https:")
      hint += " \u26a0\ufe0f Mixed content: an https page cannot call an http:// endpoint \u2014 open this app over http://localhost instead.";
    if (/localhost|127\.0\.0\.1/.test(f.baseUrl))
      hint += " For Ollama set OLLAMA_ORIGINS=* ; for LM Studio enable CORS in the server settings.";
    if ((f.spec || "openai") === "anthropic")
      hint += " Anthropic needs the anthropic-dangerous-direct-browser-access header (this app already sends it).";
    if ((f.spec || "openai") === "gemini")
      hint += " Gemini keys go in the ?key= query param (this app does that automatically).";
    return `${hint} Raw error: ${detail}`;
  }
  if (d.includes("timed out")) return `${detail} \u2014 try again, or use a faster/nearer endpoint.`;
  if (/\b401\b|\b403\b/.test(d)) return `${detail} \u2014 the API Key was rejected. Double-check the key and that it matches this base URL.`;
  if (/\b404\b/.test(d)) return `${detail} \u2014 endpoint or model not found. The OpenAI-style base URL usually ends with /v1, and the Model id must match the provider's list exactly.`;
  if (/\b429\b/.test(d)) return `${detail} \u2014 rate-limited by the provider. Wait a moment and test again.`;
  return detail;
}

async function testConnection() {
  const f = readForm();
  if (!f.name || !f.baseUrl || !f.model) { $("#testResult").innerHTML = "\u26a0\ufe0f Fill Name, Base URL and Model first."; return; }
  if (!/^https?:\/\//i.test(f.baseUrl)) { $("#testResult").innerHTML = "\u26a0\ufe0f Base URL must start with http:// or https:// (e.g. https://api.openai.com/v1)."; return; }
  const btn = $("#testConnBtn"), saveBtn = $("#saveProvBtn");
  btn.disabled = true; saveBtn.disabled = true; testPassedFor = "";
  $("#testResult").innerHTML = `<span class="spin">\U0001f504</span> Contacting ${esc(f.baseUrl)} \u2026`;
  let ok = false, detail = "";
  try {
    const probeMsgs = [{ role:"user", content:"What is 1+1? Reply with only the number." }];
    const req = buildChatRequest({ ...f }, probeMsgs);
    let resp;
    try {
      resp = await fetch(req.url, { method:"POST", headers:req.headers,
        body:JSON.stringify({ ...req.body, max_tokens:16, ...(req.body.generationConfig?{generationConfig:{maxOutputTokens:16}}:{}) }),
        signal: AbortSignal.timeout(20000) });
    } catch (e) { throw new Error(e.name === "TimeoutError" ? "Request timed out (20s)" : (e.message || "Network/CORS failure")); }
    if (resp.ok) {
      const j = await resp.json().catch(() => ({}));
      const txt = String(req.extract(j) || "(empty reply)").trim();
      const u = req.usage(j);
      /* HTTP 200 but no assistant text usually means the Spec doesn't match this endpoint */
      const empty = txt === "(empty reply)";
      ok = true;
      detail = `HTTP 200 OK \u00b7 ${(u.in+u.out)} tok \u00b7 model said \u201c${txt.slice(0,40)}\u201d` +
               (empty ? " (\u26a0\ufe0f empty reply \u2014 check the Spec matches this endpoint)" : "");
    } else {
      const body = await resp.text().catch(()=>"" );
      detail = `HTTP ${resp.status} ${resp.statusText} \u2014 ${body.slice(0,140)}`;
    }
  } catch (e) { detail = e.message || String(e); }
  btn.disabled = false;
  if (ok) {
    testPassedFor = providerSignature(readForm());
    saveBtn.disabled = false;
    $("#testResult").innerHTML = `\u2705 <b>${esc(detail)}</b> \u2014 Save unlocked.`;
  } else {
    testPassedFor = ""; saveBtn.disabled = true;
    $("#testResult").innerHTML = `\u274c Connection failed: ${esc(explainTestFailure(detail, f))}`;
  }
}

function saveProvider(e) {
  e.preventDefault();
  if ($("#saveProvBtn").disabled) return;
  const f = readForm(); const ps = getProviders();
  if (editingProviderId) {
    const p = ps.find(x => x.id === editingProviderId);
    Object.assign(p, f, { status:"active", lastHealthCheckMs: p.lastHealthCheckMs || 0 });
  } else {
    ps.push({ id:uid(), ...f, totalRequests:0, totalTokensUsed:0, lastHealthCheckMs:0, status:"active" });
  }
  setProviders(ps); renderProviders(); populateProviderSelects(); resetForm();
  toast(`Provider “${f.name}” saved 🟢`, "ok");
}

/* ============================================================ PROJECTS */
let currentProject = null, openFileId = null, editor = null, dirty = false;

function normalizePath(p) {
  return "/" + String(p || "").split("/").map(s => s.trim()).filter(s => s && s !== "." && s !== "..").join("/");
}
function fileIcon(name) {
  const ext = name.split(".").pop().toLowerCase();
  return { html:"🌐", css:"🎨", js:"🟨", ts:"🔷", php:"🐘", json:"🧾", md:"📘" }[ext] || "📄";
}
const ALLOWED_EXT = ["html","css","js","ts","php","json","md"];

async function newProject(title) {
  const proj = { id:uid(), title, createdAt:Date.now(), updatedAt:Date.now(), currentCheckpointId:null,
    files:[ { id:uid(), path:"/index.html", name:"index.html", type:"file", content:
`<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8"><title>${esc(title)}</title>\n<link rel="stylesheet" href="/css/styles.css">\n</head>\n<body>\n<h1>Hello from ${esc(title)} 👋</h1>\n<script src="/js/app.js"><\/script>\n</body>\n</html>` },
      { id:uid(), path:"/css", name:"css", type:"folder", content:"" },
      { id:uid(), path:"/css/styles.css", name:"styles.css", type:"file", content:"body{font-family:system-ui;display:grid;place-items:center;min-height:100vh;background:#0f172a;color:#e2e8f0}\nh1{font-size:2rem}" },
      { id:uid(), path:"/js", name:"js", type:"folder", content:"" },
      { id:uid(), path:"/js/app.js", name:"app.js", type:"file", content:"console.log('Ready.');" } ] };
  await DB.putProject(proj);
  localStorage.setItem(LS_PROJECT, proj.id);
  currentProject = proj; openFileId = null;
  renderProjectsLists(); renderTree(); refreshPreview();
  return proj;
}

async function loadProject(id) {
  const p = await DB.getProject(id); if (!p) return;
  currentProject = p; localStorage.setItem(LS_PROJECT, id);
  pickedElement = null; updatePickBar(); hideErrorOverlay();
  openFileId = null; $("#editorFileName").textContent = "no file open";
  renderTree(); renderProjectsLists(); refreshPreview(); renderTimeline(); renderChat();
  const idx = p.files.find(f => f.type==="file" && f.name.toLowerCase()==="index.html");
  if (idx) openFile(idx.path);
}

async function saveCurrentProject() {
  if (!currentProject) return;
  currentProject.updatedAt = Date.now();
  await DB.putProject({ ...currentProject });
}

/* ---------- tree building from flat ProjectFile list ---------- */
function buildTree(files) {
  /* returns a nested structure derived purely from paths — folders are virtual
     when only their child files exist, real ProjectFile folder records merge in. */
  const root = { name:"", path:"", type:"folder", children:new Map() };
  const ensureDir = (parts) => {
    let node = root, acc = "";
    for (const p of parts) {
      acc += "/" + p;
      if (!node.children.has(p)) node.children.set(p, { name:p, path:acc, type:"folder", children:new Map() });
      node = node.children.get(p);
    }
    return node;
  };
  [...files].sort((a,b)=>a.path.localeCompare(b.path)).forEach(f => {
    const parts = f.path.split("/").filter(Boolean);
    const fname = parts.pop();
    const parent = ensureDir(parts);
    const existing = parent.children.get(fname);
    if (existing) {                       // folder record for an auto-created dir → merge ids
      if (f.type === "folder" && !existing.id) existing.id = f.id;
      else if (f.type === "file") { existing.type = "file"; existing.id = f.id; existing.content = f.content; existing.name = fname; }
    } else {
      parent.children.set(fname, f.type === "file"
        ? { name:fname, path:f.path, type:"file", id:f.id, content:f.content }
        : { name:fname, path:f.path, type:"folder", id:f.id, children:new Map() });
    }
  });
  const toArray = node => [...node.children.values()].sort((a,b) =>
    (a.type===b.type ? a.name.localeCompare(b.name) : a.type==="folder" ? -1 : 1));
  return { root, toArray };
}

function renderTree() {
  const host = $("#fileTree");
  if (!currentProject) { host.innerHTML = `<p class="muted" style="padding:8px">No project selected.<br/>Create one from the Dashboard.</p>`; return; }
  const { root, toArray } = buildTree(currentProject.files);
  const roots = toArray(root);
  const walk = (nodes, depth) => nodes.map(n => {
    if (n.type === "folder") {
      const kids = toArray(n);
      return `<div class="tnode" data-path="${esc(n.path)}" data-type="folder" ${n.id?`data-id="${n.id}"`:""} style="padding-left:${depth*6}px">
        <span class="ico">📁</span><span class="nm">${esc(n.name)}</span>
        <span style="flex:1"></span>
        <button class="icon-btn" style="width:22px;height:20px;font-size:11px;border:none;background:none" data-qact="nf" data-p="${esc(n.path)}" title="New file here">＋📄</button>
        <button class="icon-btn" style="width:22px;height:20px;font-size:11px;border:none;background:none" data-qact="nd" data-p="${esc(n.path)}" title="New folder here">＋📁</button>
        ${n.id ? `<button class="icon-btn" style="width:22px;height:20px;font-size:11px;border:none;background:none" data-qact="del" data-id="${n.id}" title="Delete folder">🗑</button>` : ""}</div>
        <div class="tkids">${kids.length ? walk(kids, depth+1) : `<span class="muted" style="font-size:11px;padding-left:${(depth+1)*6}px">empty</span>`}</div>`;
    }
    const tools = `<span style="flex:1"></span>
      <button class="icon-btn" style="width:22px;height:20px;font-size:11px;border:none;background:none" data-qact="ren" data-id="${n.id}" title="Rename">✏️</button>
      <button class="icon-btn" style="width:22px;height:20px;font-size:11px;border:none;background:none" data-qact="del" data-id="${n.id}" title="Delete">🗑</button>`;
    return `<div class="tnode ${n.id===openFileId?"sel":""}" data-id="${n.id}" data-path="${esc(n.path)}" data-type="file"
      style="padding-left:${depth*6}px">
      <span class="ico">${fileIcon(n.name)}</span><span class="nm">${esc(n.name)}</span>${tools}</div>`;
  }).join("");
  host.innerHTML = `<div class="tnode" data-type="root" style="font-weight:700"><span class="ico">🏔</span><span class="nm">${esc(currentProject.title)}</span></div>`
    + walk(roots, 1);
}

/* ---------- file ops ---------- */
async function createFile(dirPath = "") {
  if (!currentProject) return toast("Open/create a project first", "err");
  const raw = await promptModal("New file (relative to " + (dirPath || "/") + ")", "", "e.g. index.html or utils/helpers.js");
  if (!raw) return;
  const path = normalizePath(dirPath ? dirPath + "/" + raw : raw);
  const name = path.split("/").pop();
  const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
  if (!ALLOWED_EXT.includes(ext)) return toast(`Unsupported format “.${ext || "?"}”. Allowed: ${ALLOWED_EXT.join(", ")}`, "err");
  if (currentProject.files.some(f => f.path === path)) return toast("A file with that path already exists.", "err");
  /* materialize ancestor folders */
  const parts = path.split("/").filter(Boolean);
  for (let i = 1; i < parts.length; i++) {
    const fp = "/" + parts.slice(0,i).join("/");
    if (!currentProject.files.some(f => f.path === fp))
      currentProject.files.push({ id:uid(), path:fp, name:parts[i-1], content:"", type:"folder" });
  }
  currentProject.files.push({ id:uid(), path, name, content:"", type:"file" });
  await saveCurrentProject(); renderTree(); openFile(path);
}
async function createFolder(dirPath = "") {
  if (!currentProject) return toast("Open/create a project first", "err");
  const raw = await promptModal("New folder (relative to " + (dirPath || "/") + ")", "", "e.g. assets or components/ui");
  if (!raw) return;
  const path = normalizePath(dirPath ? dirPath + "/" + raw : raw);
  if (currentProject.files.some(f => f.path === path)) return toast("Folder already exists.", "err");
  const parts = path.split("/").filter(Boolean);
  for (let i = 1; i <= parts.length; i++) {
    const p = "/" + parts.slice(0, i).join("/");
    if (!currentProject.files.some(f => f.path === p))
      currentProject.files.push({ id:uid(), path:p, name:parts[i-1], content:"", type:"folder" });
  }
  await saveCurrentProject(); renderTree();
}
async function deleteNode(idOrPath) {
  if (!currentProject) return;
  const f = currentProject.files.find(x => x.id === idOrPath || x.path === idOrPath);
  if (!f) return;
  if (!confirm(`Delete ${f.type} “${f.path}”?` + (f.type==="folder" ? " Its contents will be removed too." : ""))) return;
  currentProject.files = currentProject.files.filter(x => !(x.id === f.id || x.path === f.path || x.path.startsWith(f.path + "/")));
  if (openFileId && !currentProject.files.some(x => x.id === openFileId)) {
    openFileId = null; editor?.setValue(""); $("#editorFileName").textContent = "no file open";
  }
  await saveCurrentProject(); renderTree(); refreshPreview();
}
async function renameNode(id) {
  const f = currentProject?.files.find(x => x.id === id); if (!f) return;
  const nv = await promptModal(`Rename ${f.type} “${f.name}”`, f.name);
  if (!nv || nv === f.name) return;
  if (nv.includes("/") || nv.includes("..")) return toast("Name cannot contain / or ..", "err");
  if (f.type === "file" && !ALLOWED_EXT.includes(nv.split(".").pop()?.toLowerCase()))
    return toast("Unsupported extension. Allowed: " + ALLOWED_EXT.join(", "), "err");
  const oldPath = f.path, parent = oldPath.split("/").slice(0,-1).join("/");
  const newPath = normalizePath(parent + "/" + nv);
  if (currentProject.files.some(x => x.path === newPath && x.id !== f.id)) return toast("Target name already exists.", "err");
  if (f.type === "folder") {  /* cascade children paths */
    currentProject.files.forEach(x => { if (x.path.startsWith(oldPath + "/")) x.path = newPath + x.path.slice(oldPath.length); });
    currentProject.files.forEach(x => x.name = x.path.split("/").pop());
  } else {
    f.path = newPath; f.name = nv;
  }
  if (f.id === openFileId) $("#editorFileName").textContent = f.path;
  await saveCurrentProject(); renderTree(); refreshPreview();
}

/* ---------- editor ---------- */
function cmMode(name) {
  const ext = name.split(".").pop().toLowerCase();
  return { html:"htmlmixed", css:"css", js:"javascript", ts:"javascript", php:"htmlmixed", json:"javascript", md:"markdown", xml:"xml" }[ext] || "text/plain";
}
function initEditor() {
  editor = CodeMirror($("#editorHost"), {
    value: "", mode: "htmlmixed", theme: "material-darker", lineNumbers: true,
    indentUnit: 2, tabSize: 2, matchBrackets: true, lineWrapping: false,
  });
  editor.on("change", () => {
    if (!openFileId) return;
    dirty = true; $("#editorDirty").textContent = "● unsaved";
    clearTimeout(initEditor._t);
    initEditor._t = setTimeout(() => { if (dirty) doSaveFile(true); }, 900);   // autosave
  });
}
function openFile(path) {
  const f = currentProject?.files.find(x => x.path === path && x.type === "file");
  if (!f) return;
  openFileId = f.id; dirty = false; $("#editorDirty").textContent = "";
  $("#editorFileName").textContent = f.path;
  editor.setValue(f.content || "");
  editor.setOption("mode", cmMode(f.name));
  renderTree();
  if (/\.html?$/i.test(f.name)) refreshPreview();
}
async function doSaveFile(silent) {
  const f = currentProject?.files.find(x => x.id === openFileId);
  if (!f) return;
  f.content = editor.getValue(); dirty = false;
  $("#editorDirty").textContent = "saved ✓";
  await saveCurrentProject();
  if (!silent) toast("Saved " + f.path, "ok", 1600);
  if (/\.html?$/i.test(f.name)) refreshPreview();
}

/* ---------- live sandbox preview (srcdoc iframe) ---------- */
function inlineAssets(html) {
  /* resolve relative <link stylesheet href> and <script src> against project files */
  const findRel = rel => {
    rel = rel.split("?")[0];
    if (/^\//.test(rel)) return currentProject.files.find(f => f.type==="file" && f.path === rel);
    return currentProject.files.find(f => f.type==="file" && f.path === normalizePath("/" + rel))
        || currentProject.files.find(f => f.type==="file" && f.name === rel.split("/").pop());
  };
  html = html.replace(/<link([^>]*?)href=["']([^"']+)["']([^>]*?)>/gi, (mm, pre, href, post) => {
    if (/^(https?:|data:)/i.test(href) || !/stylesheet/i.test(pre+post)) return mm;
    const f = findRel(href); return f ? `<style data-src="${esc(href)}">\n${f.content}\n</style>` : mm;
  });
  html = html.replace(/<script([^>]*?)src=["']([^"']+)["']([^>]*?)>\s*<\/script>/gi, (mm, pre, src, post) => {
    if (/^(https?:|data:)/i.test(src)) return mm;
    const f = findRel(src); return f ? `<script${pre}${post}>\n${f.content.replace(/<\/script>/gi,"<\\/script>")}\n</script>` : mm;
  });
  return html;
}
let _lastBundledHtml = "", _hotCount = 0, _pendingHot = null;
function refreshPreview(force) {
  const frame = $("#previewFrame");
  if (!currentProject) { frame.srcdoc = ""; _lastBundledHtml = ""; return; }
  const idx = currentProject.files.find(f => f.type==="file" && f.name.toLowerCase()==="index.html");
  if (!idx) { frame.srcdoc = `<body style="font:14px system-ui;display:grid;place-items:center;height:100vh;color:#666">No index.html in this project.</body>`; return; }
  let html = inlineAssets(idx.content || "");
  /* runtime bridge: error capture + element inspector (injected before user code) */
  html = html.replace(/<head[^>]*>/i, m => m + PREVIEW_BRIDGE);
  if (!/<head[^>]*>/i.test(html)) html = PREVIEW_BRIDGE + html;   // headless models sometimes omit <head>
  if (!force && html === _lastBundledHtml) return;               // hot reload: skip identical rebuilds
  _lastBundledHtml = html; _hotCount++;
  $("#hotReloadTag").textContent = `hot-reload #${_hotCount} · srcdoc`;
  hideErrorOverlay();
  frame.srcdoc = html;
}
const PREVIEW_BRIDGE = `
<script>
(function(){
  function cssPath(el){var p=[];while(el&&el.nodeType===1&&p.length<6){var s=el.tagName.toLowerCase();
    if(el.id){p.unshift(s+"#"+el.id);break}
    if(el.className&&typeof el.className==="string"){var c=el.className.trim().split(/\s+/)[0];if(c)s+="."+c}
    p.unshift(s);el=el.parentElement}return p.join(">")}
  window.addEventListener("error",function(e){try{parent.postMessage({type:"preview-error",
    message:e.message||String(e.error),file:e.filename,line:e.lineno},"*")}catch(_){}});
  window.addEventListener("unhandledrejection",function(e){try{parent.postMessage({type:"preview-error",
    message:"Unhandled promise rejection: "+(e.reason&&(e.reason.message||e.reason))},"*")}catch(_){}});
  var PICK=false,OLD=null;
  window.addEventListener("message",function(ev){
    var d=ev.data||{};
    if(d.type==="set-pick-mode"){PICK=d.on;document.querySelectorAll("[data-ab-hl]").forEach(function(n){n.removeAttribute("data-ab-hl");n.style.outline=""});}
  });
  document.addEventListener("mouseover",function(e){if(!PICK)return;var t=e.target;
    if(OLD&&OLD!==t){OLD.style.outline=""}t.style.outline="2px dashed #ff2d78";t.setAttribute("data-ab-hl","1");OLD=t;},true);
  document.addEventListener("click",function(e){if(!PICK)return;e.preventDefault();e.stopPropagation();
    var t=e.target;t.style.outline="2px solid #6d8dff";
    parent.postMessage({type:"element-pick",selector:cssPath(t),tag:t.tagName.toLowerCase(),
      outerHTML:(t.outerHTML||"").slice(0,500)},"*");
    PICK=false;document.querySelectorAll("[data-ab-hl]").forEach(function(n){n.removeAttribute("data-ab-hl");n.style.outline=""});
    parent.postMessage({type:"pick-off"},"*");},true);
})();
<\/script>`;

/* ---- error overlay ---- */
function showErrorOverlay(err){
  $("#errOverlayMsg").textContent = `${err.message}${err.line ? " (line "+err.line+")" : ""}`;
  $("#errOverlay").classList.add("show");
  lastPreviewError = err;
}
function hideErrorOverlay(){ $("#errOverlay").classList.remove("show"); }
let lastPreviewError = null;

/* ---- viewport switcher ---- */
function setViewport(vp){
  const f = $("#previewFrame");
  $$(".vp-btn").forEach(b => b.classList.toggle("active", b.dataset.vp === vp));
  f.style.maxWidth = vp === "mobile" ? "390px" : vp === "tablet" ? "768px" : "100%";
  localStorage.setItem("csab.viewport", vp);
}

/* ---- element inspector state ---- */
let pickedElement = null, pickMode = false;
function togglePickMode(on){
  pickMode = on ?? !pickMode;
  $("#previewPane").classList.toggle("pick-mode", pickMode);
  $("#pickModeBtn").classList.toggle("primary", pickMode);
  try { $("#previewFrame").contentWindow.postMessage({ type:"set-pick-mode", on:pickMode }, "*"); } catch {}
}
function updatePickBar(){
  const bar = $("#pickBar"), badge = $("#elPickBadge");
  if (pickedElement){
    $("#pickedElInfo").textContent = `<${pickedElement.tag}> ${pickedElement.selector}`;
    bar.classList.add("show");
    badge.style.display = ""; badge.textContent = `🎯 target: <${pickedElement.tag}>`;
  } else { bar.classList.remove("show"); badge.style.display = "none"; }
}

/* ---------- ZIP export (JSZip) ---------- */
async function exportZip() {
  if (!currentProject) return toast("No project loaded.", "err");
  if (dirty) await doSaveFile(true);
  const zip = new JSZip();
  const base = zip.folder(currentProject.title.replace(/[^\w.-]+/g,"_") || "project");
  currentProject.files.filter(f => f.type === "file").forEach(f => base.file(f.path.replace(/^\//,""), f.content || ""));
  const blob = await zip.generateAsync({ type:"blob" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = (currentProject.title.replace(/[^\w.-]+/g,"_")||"project") + ".zip";
  a.click(); setTimeout(()=>URL.revokeObjectURL(a.href), 4000);
  toast("ZIP exported 📦", "ok");
}

/* ====================================================== AI PIPELINE ====
   Two-pass Lovable-style loop: Plan -> approve -> Code (streamed) -> validate -> apply -> checkpoint.
   ==========================================================================*/
let genAbort = null, pendingPlan = null;   // {mode, userPrompt, plan, coderId, plannerId, elementCtx}

/* --- tolerant JSON extraction (fence-stripper + bracket scanner) --- */
function extractJsonObject(text) {
  if (!text) return null;
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const s = t.indexOf("{"), e = t.lastIndexOf("}");
  if (s === -1 || e <= s) return null;
  try { return JSON.parse(t.slice(s, e+1)); } catch { return null; }
}
function extractChanges(text) {
  /* accepts {changes:[...]} or legacy bare array [{path,content}] */
  if (!text) return null;
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const obj = extractJsonObject(t);
  if (obj && Array.isArray(obj.changes)) return obj.error ? { error: obj.error, changes: [] } : { changes: obj.changes };
  const s = t.indexOf("["), e = t.lastIndexOf("]");
  if (s !== -1 && e > s) {
    try {
      const arr = JSON.parse(t.slice(s, e+1));
      if (Array.isArray(arr)) {
        return { changes: arr.filter(o => o && typeof o.path === "string")
          .map(o => ({ op: o.op || "create", path: o.path, content: o.content ?? "" })) };
      }
    } catch {}
  }
  return null;
}

/* --- Pass 3: deterministic validator (no LLM) --- */
function validateChanges(changes, files) {
  const errs = [];
  const existing = new Set(files.filter(f => f.type === "file").map(f => f.path.replace(/^\//, "")));
  const planned = new Set();
  for (const c of changes) {
    if (!["create","update","delete"].includes(c.op)) { errs.push(`bad op "${c.op}" on ${c.path}`); continue; }
    const p = String(c.path || "").replace(/^\//, "");
    if (!p || p.includes("..")) { errs.push(`unsafe path: ${c.path}`); continue; }
    if (c.op === "update" || c.op === "delete") {
      if (!existing.has(p) && !planned.has(p)) errs.push(`${c.op} targets non-existent file: ${p}`);
    }
    if (c.op === "create" && existing.has(p)) errs.push(`create collides with existing file: ${p} (use update)`);
    if (c.op !== "delete" && typeof c.content !== "string") errs.push(`${p}: missing complete content`);
    planned.add(p);
  }
  /* reference check on HTML changes: relative src/href must resolve to a real/planned file or absolute URL */
  const finalSet = new Set(existing);
  changes.forEach(c => { const p = String(c.path).replace(/^\//,"");
    if (c.op === "delete") finalSet.delete(p); else finalSet.add(p); });
  const html = changes.filter(c => /\.html?$/i.test(c.path)).map(c => c.content || "").join("\n");
  const refRe = /<(?:script[^>]+src|link[^>]+href)=["']([^"']+)["']/gi; let m;
  while ((m = refRe.exec(html))) {
    const r = m[1];
    if (/^(https?:|data:|#|mailto:)/i.test(r)) continue;
    const rel = r.replace(/^\//, "").split("?")[0];
    const base = rel.split("/").pop();
    if (!finalSet.has(rel) && ![...finalSet].some(p => p.endsWith("/" + base)))
      errs.push(`broken reference in HTML: "${r}" (no such file & not created in this response)`);
  }
  /* DOMParser sanity for every html change */
  for (const c of changes.filter(c => /\.html?$/i.test(c.path) && c.content)) {
    try {
      const doc = new DOMParser().parseFromString(c.content, "text/html");
      if (doc.querySelector("parsererror")) errs.push(`${c.path}: HTML does not parse cleanly`);
    } catch { errs.push(`${c.path}: HTML parse threw`); }
  }
  return errs;
}

/* --- apply diff ops to project.files (non-destructive merge) --- */
async function applyChanges(proj, changes, label, sourceMsgId) {
  const before = await createCheckpoint(proj, label + " · before", sourceMsgId);
  for (const c of changes) {
    const path = normalizePath(c.path);
    const name = path.split("/").pop();
    if (c.op === "delete") {
      proj.files = proj.files.filter(f => !(f.path === path || f.path.startsWith(path + "/")));
      continue;
    }
    const parts = path.split("/").filter(Boolean);
    for (let i = 1; i < parts.length; i++) {
      const fp = "/" + parts.slice(0, i).join("/");
      if (!proj.files.some(f => f.path === fp))
        proj.files.push({ id:uid(), path:fp, name:parts[i-1], content:"", type:"folder" });
    }
    const ex = proj.files.find(f => f.path === path && f.type === "file");
    if (ex) ex.content = c.content ?? "";
    else proj.files.push({ id:uid(), path, name, content:c.content ?? "", type:"file" });
  }
  proj.updatedAt = Date.now();
  await DB.putProject({ ...proj });
  const ck = await createCheckpoint(proj, label, sourceMsgId);
  proj.currentCheckpointId = ck.id;
  await DB.putProject({ ...proj });
  currentProject = proj;
  renderTree(); refreshPreview(); renderTimeline(); renderProjectsLists();
  const idx = proj.files.find(f => f.type==="file" && f.name.toLowerCase()==="index.html");
  if (idx && (!openFileId || !proj.files.some(f=>f.id===openFileId))) openFile(idx.path);
  else if (idx && openFileId) {
    const cur = proj.files.find(f=>f.id===openFileId);
    if (cur && editor && cur.content !== editor.getValue()) openFile(cur.path);
  }
  return { before, after: ck };
}

async function createCheckpoint(proj, label, messageId) {
  const ck = { id: uid(), projectId: proj.id, messageId: messageId || null,
    files: JSON.parse(JSON.stringify(proj.files)), createdAt: Date.now(), label };
  await DB.putCkpt(ck);
  return ck;
}

/* --- Pass 1: planner --- */
function fileListBrief(files) {
  return files.filter(f => f.type === "file")
    .map(f => `${f.path} :: ${(f.content||"").slice(0,200).replace(/\s+/g," ")}`).join("\n") || "(empty project)";
}
async function runPlanner(provider, userPrompt, files, signal) {
  const msgs = [
    { role:"system", content: getSpPlanner() },
    { role:"user", content: `USER REQUEST:\n${userPrompt}\n\nCURRENT PROJECT FILES (path :: first 200 chars):\n${fileListBrief(files)}\n\nReturn ONLY the JSON plan object.` },
  ];
  const { text, usage } = await chatCompletion(provider, msgs, { signal });
  const j = extractJsonObject(text);
  if (!j || !Array.isArray(j.plan) || !Array.isArray(j.filesToTouch))
    throw new Error("Planner returned invalid JSON. Snippet: " + (text||"(empty)").slice(0,140));
  j.intent = j.intent === "build" ? "build" : "edit";
  return { plan: j, usage };
}

/* --- Pass 2: coder (streamed) --- */
function buildCoderMessages(userPrompt, planObj, files, elementCtx) {
  const touch = new Set((planObj.filesToTouch||[]).map(p => p.replace(/^\//,"")));
  const ctxFiles = files.filter(f => f.type==="file" && touch.has(f.path.replace(/^\//,"")));
  const ctx = ctxFiles.map(f => `--- FILE: ${f.path} ---\n${f.content}`).join("\n\n") || "(no existing files — fresh build)";
  let user = `USER REQUEST:\n${userPrompt}\n\nAPPROVED PLAN:\n${JSON.stringify(planObj, null, 2)}\n\nFULL CONTENT OF FILES TO TOUCH:\n${ctx}\n\nReturn ONLY {"changes":[...]} JSON.`;
  if (elementCtx) user += `\n\n🎯 USER SELECTED THIS ELEMENT IN THE PREVIEW — target your edit at it:\n${elementCtx.outerHTML}\n(selector hint: ${elementCtx.selector})`;
  return [{ role:"system", content: getSpCoder() }, { role:"user", content: user }];
}

async function runCoder(provider, userPrompt, planObj, files, elementCtx, signal, onDelta) {
  const msgs = buildCoderMessages(userPrompt, planObj, files, elementCtx);
  const { text, usage } = await chatCompletion(provider, msgs, { signal, onDelta });
  const parsed = extractChanges(text);
  if (!parsed) throw new Error("CODER_INVALID_JSON::" + (text||"(empty)").slice(0,200));
  if (parsed.error) throw new Error("CODER_REFUSED::" + parsed.error);
  return { changes: parsed.changes, usage, raw: text };
}

/* Full pipeline for one turn. mode: "build" (new project) | "chat" (iterate current project) */
async function runPipeline(mode, userPrompt, opts = {}) {
  const coderP   = getProviders().find(x => x.id === (opts.coderId   || chosenProvider("coder")));
  const plannerP = getProviders().find(x => x.id === (opts.plannerId || chosenProvider("planner"))) || coderP;
  if (!coderP) { toast("Configure a provider in ⚙️ Providers first (and Test Connection).", "err"); return { error:"no provider" }; }
  const setStatus = opts.setStatus || (t => { $("#genStatus").textContent = t; });
  const setProg   = opts.setProg   || (on => { $("#genProgress").style.display = on ? "block" : "none"; });
  const btn = opts.btn, stopBtn = opts.stopBtn;
  if (btn) btn.disabled = true; setProg(true); if (stopBtn) stopBtn.style.display = "";
  genAbort = new AbortController();
  const signal = genAbort.signal;
  const t0 = performance.now();
  try {
    setStatus(`Pass 1/3 · Planning (${plannerP.name}/${plannerP.model})…`);
    const baseFiles = mode === "build" ? [] : currentProject.files;
    const { plan: planObj, usage: pu } = await runPlanner(plannerP, userPrompt, baseFiles, signal);
    bumpUsage(plannerP.id, (pu.in||0)+(pu.out||0), true);
    planObj.intent = mode === "build" ? "build" : "edit";
    await opts.onPlan?.(planObj);

    if (!opts.autoApprove) {                 // hand control to the UI (approve/edit chips)
      pendingPlan = { mode, userPrompt, plan: planObj, coderId: coderP.id, plannerId: plannerP.id, elementCtx: opts.elementCtx || null };
      setStatus(""); setProg(false); if (btn) btn.disabled = false; if (stopBtn) stopBtn.style.display = "none";
      genAbort = null;
      opts.onAwaitApproval?.(pendingPlan);
      return { awaiting: true, plan: planObj };
    }
    return await executePlanStep(planObj, { ...opts, coderP, signal, setStatus, setProg, t0 });
  } catch (e) {
    if (e.name === "AbortError") { setStatus("⏹ Stopped."); return { aborted:true }; }
    setStatus(""); toast("AI turn failed: " + e.message, "err", 6000);
    bumpUsage(coderP.id, 0, false); renderProviders();
    return { error: e.message };
  } finally {
    if (!pendingPlan) { setProg(false); if (btn) btn.disabled = false; if (stopBtn) stopBtn.style.display = "none"; genAbort = null; }
  }
}

/* Passes 2+3 after approval */
async function executePlanStep(planObj, o) {
  const { coderP, signal, setStatus, setProg, t0 } = o;
  const mode = o.mode || pendingPlan?.mode || "chat";
  const userPrompt = o.userPrompt || pendingPlan?.userPrompt;
  const elementCtx = o.elementCtx ?? pendingPlan?.elementCtx;
  const msgId = o.msgId || null;
  setStatus(`Pass 2/3 · Coding (${coderP.name}/${coderP.model}) — streaming…`);
  const filesNow = mode === "build" ? [] : currentProject.files;
  let res, errs = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      res = await runCoder(coderP, userPrompt, planObj, filesNow, elementCtx, signal, o.onDelta);
      errs = validateChanges(res.changes, filesNow);
    } catch (e) {
      if (e.name === "AbortError") throw e;
      errs = [e.message];
    }
    if (!errs.length) break;
    if (attempt === 0) {                     // one automatic retry with errors appended
      setStatus(`Pass 2/3 · Validation failed (${String(errs[0]).slice(0,80)}) — retrying once…`);
      const retryMsgs = buildCoderMessages(userPrompt, planObj, filesNow, elementCtx);
      retryMsgs.push({ role:"assistant", content: res?.raw || "{}" },
                     { role:"user", content: "Your previous output failed validation:\n- " + errs.join("\n- ") + "\nReturn corrected ONLY valid JSON." });
      try {
        const r2 = await chatCompletion(coderP, retryMsgs, { signal });
        const p2 = extractChanges(r2.text);
        if (p2 && !p2.error) {
          const e2 = validateChanges(p2.changes, filesNow);
          if (!e2.length) { res = { changes:p2.changes, usage:r2.usage, raw:r2.text }; errs = []; break; }
          errs = e2;
        }
      } catch (e) { if (e.name === "AbortError") throw e; errs = [e.message]; }
    }
  }
  if (errs.length) throw new Error("Validation failed after retry: " + errs.slice(0,3).join(" · "));

  bumpUsage(coderP.id, (res.usage.in||0)+(res.usage.out||0), true);
  const lat = Math.round(performance.now() - (t0 || performance.now()));
  setStatus(`Pass 3/3 · Applying ${res.changes.length} change(s)… ✓ ${lat}ms`);

  let proj;
  if (mode === "build") {
    const title = userPrompt.split(/\s+/).slice(0,5).join(" ");
    proj = { id:uid(), title, createdAt:Date.now(), updatedAt:Date.now(), currentCheckpointId:null, files:[] };
  } else proj = currentProject;

  for (const c of res.changes) {
    await DB.addLog({ id:uid(), time:Date.now(), provider:coderP.name, file:c.path,
      tokensIn:(res.usage.in||0), tokensOut:(res.usage.out||0), latencyMs:lat, op:c.op });
  }
  const applied = await applyChanges(proj, res.changes, planObj.summary || userPrompt.slice(0,40), msgId);
  if (mode === "build") { localStorage.setItem(LS_PROJECT, proj.id); switchPage("studio"); }
  renderProviders(); loadLogs(); renderAnalytics();
  setStatus("");
  return { ok:true, changes: res.changes, checkpoint: applied.after, latencyMs: lat, usage: res.usage };
}

/* --- provider routing helpers --- */
function chosenProvider(role) {
  const r = getRouting();
  const ps = getProviders();
  const valid = id => id && ps.some(p => p.id === id);
  /* priority: explicit per-context select (chat bar) > dashboard select > saved routing > first provider */
  const chatSel = $(role === "planner" ? "#chatPlannerProvider" : "#chatCoderProvider")?.value;
  const dashSel = $(role === "planner" ? "#plannerProvider"     : "#genProvider")?.value;
  return valid(chatSel) ? chatSel
       : valid(dashSel) ? dashSel
       : valid(r[role]) ? r[role]
       : (ps[0]?.id || "");
}

/* ============================================================== CHAT ==== */
let chatBusy = false;
async function sendChatTurn(promptText, kind = "edit", elementCtx = null) {
  if (chatBusy) return toast("An AI turn is already running — Stop it first.", "warn");
  if (!currentProject) return toast("Open or create a project first.", "err");
  const pid = currentProject.id;
  chatBusy = true;
  const userMsg = { id:uid(), projectId:pid, role:"user", kind, content:promptText,
    providerId:chosenProvider("coder"), tokensIn:0, tokensOut:0, createdAt:Date.now() };
  await DB.putMsg(userMsg); renderChat(userMsg.id);
  $("#chatInput").value = "";
  const progOn = on => { $("#chatProgress").style.display = on ? "block" : "none"; };
  const status = t => { $("#chatStatus").textContent = t; };
  progOn(true);
  try {
    const out = await runPipeline("chat", promptText, {
      autoApprove: $("#autoApproveChk").checked,
      elementCtx, setStatus:status, setProg:progOn,
      btn: $("#chatSendBtn"), stopBtn: $("#chatStopBtn"),
      onPlan: async pl => {
        const m = { id:uid(), projectId:pid, role:"assistant", kind:"plan", content:pl.summary || "Plan",
          plan:pl, providerId:chosenProvider("planner"), tokensIn:0, tokensOut:0, createdAt:Date.now() };
        await DB.putMsg(m); renderChat(m.id);
      },
      onAwaitApproval: () => { status("Review the plan above → click 🛠 Build it."); },
    });
    if (out?.awaiting) return;               // user will press Build on the plan chip row
    if (out?.ok) {
      const m = { id:uid(), projectId:pid, role:"assistant", kind:"edit",
        content:`✅ ${out.changes.length} file change(s) applied · ${out.latencyMs}ms · checkpoint saved`,
        changes:out.changes, checkpointId:out.checkpoint.id,
        providerId:chosenProvider("coder"), tokensIn:out.usage.in||0, tokensOut:out.usage.out||0, createdAt:Date.now() };
      await DB.putMsg(m); renderChat(m.id); renderTimeline();
      toast(`✔ Applied ${out.changes.length} change(s) — undoable via 🕘 History`, "ok", 4200);
    } else if (out?.error) {
      const m = { id:uid(), projectId:pid, role:"assistant", kind:"error", content:"❌ " + out.error,
        providerId:chosenProvider("coder"), tokensIn:0, tokensOut:0, createdAt:Date.now() };
      await DB.putMsg(m); renderChat(m.id);
    }
  } finally { chatBusy = false; progOn(false); status("");
    $("#chatSendBtn").disabled = false; $("#chatStopBtn").style.display = "none"; }
}

/* approve a pending plan from the chat UI */
async function approvePendingPlan(editedPlan) {
  if (!pendingPlan) return toast("No pending plan to build.", "warn");
  const pp = pendingPlan; pendingPlan = null;
  const planObj = editedPlan || pp.plan;
  chatBusy = true;
  const progOn = on => { $("#chatProgress").style.display = on ? "block" : "none"; };
  const status = t => { $("#chatStatus").textContent = t; };
  progOn(true); $("#chatSendBtn").disabled = true; $("#chatStopBtn").style.display = "";
  try {
    genAbort = new AbortController();
    const out = await executePlanStep(planObj, {
      mode: pp.mode, userPrompt: pp.userPrompt, elementCtx: pp.elementCtx,
      coderP: getProviders().find(x => x.id === pp.coderId),
      signal: genAbort.signal, setStatus:status, setProg:progOn, t0:performance.now(),
    });
    if (out.ok) {
      const pid = currentProject.id;
      const m = { id:uid(), projectId:pid, role:"assistant", kind:"edit",
        content:`✅ ${out.changes.length} file change(s) applied · ${out.latencyMs}ms · checkpoint saved`,
        changes:out.changes, checkpointId:out.checkpoint.id, providerId:pp.coderId,
        tokensIn:out.usage.in||0, tokensOut:out.usage.out||0, createdAt:Date.now() };
      await DB.putMsg(m); renderChat(m.id); renderTimeline();
      toast(`✔ ${out.changes.length} change(s) applied`, "ok");
    }
    return out;
  } catch (e) {
    if (e.name !== "AbortError") toast("Apply failed: " + e.message, "err", 6000);
  } finally {
    chatBusy = false; progOn(false); status(""); genAbort = null;
    $("#chatSendBtn").disabled = false; $("#chatStopBtn").style.display = "none";
  }
}

/* --- dashboard BUILD flow (two-pass, plan shown in studio chat) --- */
async function startBuildFromDashboard() {
  const promptText = $("#promptInput").value.trim();
  if (!promptText) return toast("Describe what you want to build ✍️", "err");
  if (!getProviders().length) return toast("Configure a provider first (⚙️ Providers → Test Connection).", "err");
  pendingPlan = null;
  showPanel("chat");                         // make sure the chat panel is visible to follow the pipeline
  if (!currentProject) await newProject(promptText.split(/\s+/).slice(0,5).join(" "));
  const pid = currentProject.id;
  const um = { id:uid(), projectId:pid, role:"user", kind:"build", content:promptText,
    providerId:chosenProvider("coder"), tokensIn:0, tokensOut:0, createdAt:Date.now() };
  await DB.putMsg(um); renderChat(um.id);
  const out = await runPipeline("build", promptText, {
    autoApprove: false,
    setStatus: t => { $("#chatStatus").textContent = t; $("#genStatus").textContent = t; },
    setProg: on => { $("#chatProgress").style.display = on ? "block" : "none"; $("#genProgress").style.display = on ? "block" : "none"; },
    btn: $("#generateBtn"), stopBtn: $("#stopGenBtn"),
    onPlan: async pl => {
      const m = { id:uid(), projectId:pid, role:"assistant", kind:"plan", content:pl.summary || "Plan",
        plan:{ ...pl, intent:"build" }, providerId:chosenProvider("planner"), tokensIn:0, tokensOut:0, createdAt:Date.now() };
      await DB.putMsg(m); renderChat(m.id);
    },
    onAwaitApproval: () => { $("#chatStatus").textContent = "Review the plan → click 🛠 Build it."; switchPage("studio"); },
  });
  if (out?.ok) {
    const m = { id:uid(), projectId:pid, role:"assistant", kind:"build",
      content:`✅ Initial build: ${out.changes.length} file(s) · ${out.latencyMs}ms · checkpoint saved`,
      changes:out.changes, checkpointId:out.checkpoint.id, providerId:chosenProvider("coder"),
      tokensIn:out.usage.in||0, tokensOut:out.usage.out||0, createdAt:Date.now() };
    await DB.putMsg(m); renderChat(m.id); renderTimeline();
    toast(`🎉 Built “${currentProject.title}” — iterate via 💬 Chat`, "ok", 5000);
  }
  return out;
}

/* --- render chat thread --- */
async function renderChat(scrollToId) {
  const host = $("#chatScroll");
  if (!host) return;
  if (!currentProject) { host.innerHTML = `<p class="muted">No project loaded.</p>`; return; }
  const msgs = (await DB.msgsOf(currentProject.id)).sort((a,b)=>a.createdAt-b.createdAt);
  host.innerHTML = msgs.map(m => {
    const meta = `<div class="meta"><span>${m.role==="user"?"🧑 you":"🤖 "+esc(m.kind||"")}</span><span>${new Date(m.createdAt).toLocaleTimeString()}</span>${m.tokensIn||m.tokensOut?`<span>🔢 ${(m.tokensIn||0)+"/"+(m.tokensOut||0)}</span>`:""}</div>`;
    let body = esc(m.content);
    if (m.plan) {
      body += `<div class="plan-box"><b>📋 Plan</b> <span class="muted">(${esc(m.plan.intent||"edit")})</span><br/>${esc(m.plan.summary||"")}
        <ol>${(m.plan.plan||[]).map(s=>`<li>${esc(s)}</li>`).join("")}</ol>
        <div class="muted" style="font-size:11px;margin-top:4px">files: ${esc((m.plan.filesToTouch||[]).join(", "))}</div></div>`;
    }
    if (m.changes) {
      body += `<div class="diff-list">${m.changes.map(c=>`<div class="dif ${c.op}"><b>${c.op==="create"?"🔶":c.op==="delete"?"🗑":"✏️"} ${c.op}</b><span class="mono">${esc(c.path)}</span></div>`).join("")}</div>`;
    }
    const actions = (m.plan && !m.changes && m.kind === "plan")
      ? `<div class="row plan-actions" data-msg="${m.id}" style="margin-top:8px">
           <button class="btn sm primary" data-pact="build">🛠 Build it</button>
           <button class="btn sm" data-pact="edit">✏️ Edit plan</button>
           <button class="btn sm" data-pact="cancel">✖ Cancel</button></div>` : "";
    return `<div class="msg ${m.role==="user"?"user":"ai"} ${m.kind==="error"?"err":""}" id="msg-${m.id}">${body}${actions}${meta}</div>`;
  }).join("") || `<p class="muted">No messages yet — ask the AI to change something.</p>`;
  setTimeout(() => { const t = (scrollToId && document.getElementById("msg-"+scrollToId)) || host.lastElementChild;
    t?.scrollIntoView({ behavior:"smooth", block:"end" }); }, 40);
}

/* handle plan action chips */
async function handlePlanAction(act, msgId) {
  const msgs = await DB.msgsOf(currentProject.id);
  const m = msgs.find(x => x.id === msgId); if (!m || !m.plan) return;
  if (act === "cancel") {
    pendingPlan = null;
    const nm = { id:uid(), projectId:currentProject.id, role:"system", kind:"error",
      content:"Plan cancelled — nothing was changed.", providerId:"", tokensIn:0, tokensOut:0, createdAt:Date.now() };
    await DB.putMsg(nm); renderChat(nm.id); return;
  }
  if (act === "edit") {
    const txt = await promptModal("Edit plan steps (one per line)", m.plan.plan.join("\n"));
    if (txt === null) return;
    m.plan.plan = txt.split("\n").map(s=>s.trim()).filter(Boolean);
    await DB.putMsg(m); renderChat(msgId);
  }
  /* ensure pendingPlan matches this message's plan */
  if (!pendingPlan) pendingPlan = { mode:"chat", userPrompt:m.content, plan:m.plan,
    coderId:chosenProvider("coder"), plannerId:chosenProvider("planner"), elementCtx:pickedElement };
  else pendingPlan.plan = m.plan;
  await approvePendingPlan(m.plan);
  $$(".plan-actions").forEach(e => e.remove());
}

/* ======================================================= CHECKPOINTS === */
async function renderTimeline() {
  const host = $("#timelineList");
  if (!host) return;
  if (!currentProject) { host.innerHTML = `<p class="muted">No project loaded.</p>`; return; }
  const cs = (await DB.ckptsOf(currentProject.id)).sort((a,b)=>b.createdAt-a.createdAt);
  host.innerHTML = cs.map(c => `
    <div class="timeline-item ${c.id===currentProject.currentCheckpointId?"sel":""}" data-ck="${c.id}">
      <span>📸</span>
      <span class="lbl" title="${esc(c.label)}">${esc(c.label)}<br/><span class="muted" style="font-size:10px">${new Date(c.createdAt).toLocaleString()} · ${c.files.filter(f=>f.type==="file").length} files</span></span>
      <button class="btn sm" data-ckact="restore">↩ Restore</button>
    </div>`).join("") || `<p class="muted">No checkpoints yet — they are created automatically after every AI turn.</p>`;
}
async function restoreCheckpoint(id) {
  const cs = await DB.ckptsOf(currentProject.id);
  const c = cs.find(x => x.id === id);
  if (!c || !currentProject) return;
  if (!confirm(`Restore checkpoint “${c.label}”? A safety snapshot of the CURRENT state is taken first, so this is undoable.`)) return;
  await createCheckpoint(currentProject, "Auto-snapshot before restore", null);
  currentProject.files = JSON.parse(JSON.stringify(c.files));
  currentProject.currentCheckpointId = c.id;
  currentProject.updatedAt = Date.now();
  await DB.putProject({ ...currentProject });
  openFileId = null; renderTree(); refreshPreview(true); renderTimeline();
  const idx = currentProject.files.find(f => f.type==="file" && f.name.toLowerCase()==="index.html");
  if (idx) openFile(idx.path);
  toast(`↩ Restored “${c.label}”`, "ok");
}

/* ============================================================ SHARE ==== */
async function compressUtf8(s){ const d=new TextEncoder().encode(s), cs=new CompressionStream("gzip"), w=cs.writable.getWriter();
  w.write(d); w.close(); const buf=await new Response(cs.readable).arrayBuffer();
  let bin=""; const b=new Uint8Array(buf); for(let i=0;i<b.length;i++)bin+=String.fromCharCode(b[i]); return bin; }
async function decompressUtf8(b64){ const bin=atob(b64), b=new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++)b[i]=bin.charCodeAt(i);
  const rs=new Blob([b]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new TextDecoder().decode(await new Response(rs).arrayBuffer()); }
async function shareProjectUrl() {
  if (!currentProject) return toast("No project loaded.", "err");
  if (dirty) await doSaveFile(true);
  const payload = { t: currentProject.title, f: currentProject.files.map(f => ({ p:f.path, n:f.name, ty:f.type, c:f.content })) };
  try {
    const gz = await compressUtf8(JSON.stringify(payload));
    const b64 = btoa(gz).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
    const url = location.origin + location.pathname + "#share=" + b64;
    if (url.length > 2000000) return toast("Project too large for a share URL (>~2MB). Use ZIP export instead.", "err", 5000);
    window.__lastShareUrl = url;
    await navigator.clipboard?.writeText(url).catch(()=>{});
    toast(`🔗 Share URL ready (${Math.round(url.length/1024)} KB) — copied to clipboard & logged to console.`, "ok", 6000);
    console.log("%cSHARE URL:", "font-weight:bold", url);
  } catch (e) { toast("Share failed: " + e.message, "err"); }
}
async function importFromHash() {
  const m = location.hash.match(/#share=(.+)$/s); if (!m) return false;
  try {
    let b64 = m[1].replace(/-/g,"+").replace(/_/g,"/");
    while (b64.length % 4) b64 += "=";
    const data = JSON.parse(await decompressUtf8(b64));
    const proj = { id:uid(), title:data.t || "Shared project", createdAt:Date.now(), updatedAt:Date.now(),
      currentCheckpointId:null,
      files: data.f.map(f => ({ id:uid(), path:f.p, name:f.n, type:f.ty, content:f.c })) };
    await DB.putProject(proj);
    await loadProject(proj.id);
    toast(`📥 Imported shared project “${proj.title}” (${proj.files.filter(f=>f.type==="file").length} files)`, "ok", 5000);
    history.replaceState(null, "", location.pathname);
    return true;
  } catch (e) { toast("Could not import shared URL: " + e.message, "err", 6000); return false; }
}

/* ========================================================= TEMPLATES === */
const APP_TEMPLATES = [
  { e:"🚀", n:"Landing Page", d:"Hero, features, pricing, FAQ",
    p:"A modern SaaS landing page: sticky nav, hero with gradient headline and CTA, 3 feature cards, pricing tiers (3 plans), FAQ accordion, footer. Tailwind CDN." },
  { e:"📊", n:"Dashboard", d:"KPI cards + charts",
    p:"An analytics dashboard mock: sidebar nav, 4 KPI stat cards, a line chart and donut chart drawn with canvas or inline SVG (no backend, seeded random data), recent activity table." },
  { e:"📝", n:"Blog", d:"Posts, tags, reader",
    p:"A personal blog: header nav, hero post card, grid of post cards with tags, clicking a post renders its full content client-side from a JS data array, dark-mode toggle." },
  { e:"✅", n:"Todo App", d:"localStorage persistence",
    p:"A polished todo app: add/complete/delete tasks, filters (all/active/done), counts, persisted to localStorage, keyboard accessible." },
  { e:"🎹", n:"Portfolio", d:"Gallery + contact",
    p:"A developer portfolio: hero intro, project gallery with hover overlays, skills bars, contact form (client-side validation only)." },
  { e:"⏱", n:"Pomodoro", d:"Timer + sessions log",
    p:"A Pomodoro focus timer: 25/5 minute cycles, circular progress ring (SVG), start/pause/reset, session counter, glassmorphism styling." },
];

function renderTemplates() {
  const grid = $("#templateGrid"); if (!grid) return;
  grid.innerHTML = APP_TEMPLATES.map((t, i) => `
    <button type="button" class="chip tpl" data-tpl="${i}" title="${esc(t.p)}">
      ${t.e} ${esc(t.n)}<span class="muted" style="font-size:10.5px;display:block">${esc(t.d)}</span></button>`).join("");
}

/* =============================================== DASHBOARD / SUGGESTS == */
const SUGGESTIONS_BY_DAYPART = {
  morning: [
    "Build a SaaS landing page with Tailwind, pricing tiers and an FAQ accordion",
    "Create a daily habit tracker PWA with streak charts (localStorage only)",
    "Design a productivity Pomodoro timer with glassmorphism UI",
    "Make a breakfast recipe finder app with filter chips and cards",
  ],
  afternoon: [
    "Create a portfolio website with Tailwind, dark-mode toggle and project gallery",
    "Build a Kanban board with drag-and-drop columns and IndexedDB persistence",
    "Make an interactive markdown note-taking app with live preview",
    "Design a travel itinerary planner with day-by-day timeline",
  ],
  evening: [
    "Build a movie-watchlist app using poster cards and rating stars",
    "Create a personal finance dashboard with income/expense donut chart",
    "Make a quiz game app with timer, score screen and confetti",
    "Design a music-player mockup with playlist sidebar and visualizer",
  ],
  night: [
    "Build a retro terminal-style todo app with ASCII art header",
    "Create a cyberpunk-themed crypto price ticker dashboard mock",
    "Make a focus soundscape mixer (rain / café / white noise sliders)",
    "Design a stargazing night-sky card app with constellation facts",
  ],
};
function dayPart() { const h = new Date().getHours();
  return h < 5 ? "night" : h < 12 ? "morning" : h < 17 ? "afternoon" : h < 22 ? "evening" : "night"; }
function greeting() { const d = dayPart();
  return { morning:"Good morning ☀️", afternoon:"Good afternoon 🌤", evening:"Good evening 🌆", night:"Late-night session 🌙" }[d]; }

let twTimer = null, twIdx = 0, twCurrent = "";
function startTypewriter() {
  clearInterval(twTimer);
  const box = $("#typewriterBox");
  const list = SUGGESTIONS_BY_DAYPART[dayPart()];
  const phrase = list[twIdx % list.length]; twCurrent = phrase;
  let i = 0, dir = 1;
  box.innerHTML = `<span class="muted" style="font-size:11px">💡 ${greeting()} — suggested idea:</span><br/><span id="twText"></span><span class="caret"></span>`;
  const el = () => $("#twText");
  twTimer = setInterval(() => {
    if (!el()) return;
    i += dir;
    el().textContent = "“" + phrase.slice(0, i) + "”";
    if (i >= phrase.length) { dir = -1; clearInterval(twTimer); setTimeout(() => { twIdx++; startTypewriter(); }, 5200); }
    else if (i <= 0 && dir === -1) { clearInterval(twTimer); twIdx++; startTypewriter(); }
  }, 28);
}
function renderSuggestions() {
  $("#suggestChips").innerHTML = SUGGESTIONS_BY_DAYPART[dayPart()].map((s,i) =>
    `<button class="chip" data-i="${i}">✨ ${esc(s)}</button>`).join("");
}

function renderAnalytics() {
  const ps = getProviders();
  $("#statProviders").textContent = ps.length;
  $("#statRequests").textContent = fmtNum(ps.reduce((a,p)=>a+(p.totalRequests||0),0));
  $("#statTokens").textContent = fmtNum(ps.reduce((a,p)=>a+(p.totalTokensUsed||0),0));
  DB.allLogs().then(logs => { $("#statFiles").textContent = logs.length; }).catch(()=>{});
}

async function loadLogs() {
  const logs = (await DB.allLogs()).sort((a,b)=>b.time-a.time).slice(0,60);
  $("#logsBody").innerHTML = logs.map(l =>
    `<tr><td>${new Date(l.time).toLocaleTimeString()}</td><td>${esc(l.provider)}</td>
     <td class="mono" style="font-size:11px">${esc(l.file)}</td><td>${l.tokensIn}</td><td>${l.tokensOut}</td><td>${l.latencyMs}ms</td></tr>`).join("")
    || `<tr><td colspan="6" class="muted">No generations yet.</td></tr>`;
}

async function renderProjectsLists() {
  const projs = (await DB.allProjects()).sort((a,b)=>b.updatedAt-a.updatedAt);
  $("#projectsList").innerHTML = projs.map(p => `
    <div class="proj-item">
      <span style="font-size:18px">🗂</span>
      <div style="flex:1;min-width:0"><div class="t">${esc(p.title)}</div>
        <div class="m">${p.files.filter(f=>f.type==="file").length} files · updated ${new Date(p.updatedAt).toLocaleString()}</div></div>
      <button class="btn sm" data-open="${p.id}">Open ▸</button>
      <button class="btn sm danger" data-del="${p.id}">🗑</button>
    </div>`).join("") || `<p class="muted">No projects yet — generate one above or press ＋ New.</p>`;
  const tag = $("#activeProjTag");
  if (tag) tag.textContent = currentProject ? `📂 active: ${currentProject.title}` : "";
  const opts = projs.map(p => `<option value="${p.id}">${esc(p.title)}</option>`).join("") || `<option value="">— no projects —</option>`;
  for (const sel of [$("#studioProjectSel"), $("#chatProjectSel")]) {
    if (!sel) continue;
    const cur = sel.value;
    sel.innerHTML = opts;
    if (cur && projs.some(p=>p.id===cur)) sel.value = cur;
    else if (currentProject) sel.value = currentProject.id;
  }
}

/* fills EVERY provider dropdown (dashboard coder/planner, chat coder/planner, settings routing) */
function providerOptionHtml(p) {
  return `<option value="${p.id}">${esc(p.name)} · ${esc(p.model)} ${p.status==="active"?"🟢":p.status==="error"?"🔴":"⚪"}</option>`;
}
function fillProviderSelect(selId, keepId) {
  const sel = $(selId); if (!sel) return;
  const cur = keepId ?? sel.value;
  const ps = getProviders();
  sel.innerHTML = ps.map(providerOptionHtml).join("")
    || `<option value="">No provider configured</option>`;
  if (cur && ps.some(p => p.id === cur)) sel.value = cur;
  else if (ps.length && keepId && ps.some(p => p.id === keepId)) sel.value = keepId;
}
function populateProviderSelects() {
  const r = getRouting();
  fillProviderSelect("#genProvider");
  fillProviderSelect("#plannerProvider");
  fillProviderSelect("#chatCoderProvider");
  fillProviderSelect("#chatPlannerProvider");
  fillProviderSelect("#routePlanner",  r.planner);
  fillProviderSelect("#routeCoder",    r.coder);
}
const renderGenProviderSelect = populateProviderSelects;   /* legacy alias */

/* ================================================================ THEMES */
const THEMES = ["glass-dark","cyberpunk","neumorphism","clean-minimal"];
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  localStorage.setItem(LS_THEME, t);
  $("#themeSelect").value = t;
  if (editor) editor.setOption("theme", (t==="clean-minimal"||t==="neumorphism") ? "default" : "material-darker");
}
function aiTheme() {  /* deterministic "AI-driven" vibe picker seeded by prompt + time entropy */
  const seed = ($("#promptInput").value + Date.now()).split("").reduce((a,c)=>a+c.charCodeAt(0),0);
  const labels = { "glass-dark":"🌌 Glassmorphism Dark — sleek & focused", "cyberpunk":"🟣 Cyberpunk — neon hacker energy",
                   "neumorphism":"⚪ Neumorphism — soft tactile calm", "clean-minimal":"⬜ Clean Minimal — distraction-free shipping" };
  const t = THEMES[seed % THEMES.length];
  applyTheme(t); toast("🤖 Theme engine picked: " + labels[t], "ok", 3500);
}

/* ================================================================ ROUTING */
function setBuilderMode(mode) {
  const build = mode === "build";
  $("#buildMode").style.display  = build ? "" : "none";
  $("#chatMode").style.display   = build ? "none" : "";
  $("#modeBuildBtn").classList.toggle("active", build);
  $("#modeChatBtn").classList.toggle("active", !build);
  if (!build && currentProject) $("#chatProjectSel").value = currentProject.id;
}

/* right-side panel of the studio: chat thread or checkpoint timeline */
function showPanel(which) {
  const chat = which === "chat";
  $("#chatPanel").style.display    = chat ? "" : "none";
  $("#historyPanel").style.display = chat ? "none" : "";
}

function switchPage(name) {
  $$(".page").forEach(p => p.classList.toggle("active", p.id === "page-" + name));
  $$(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.page === name));
  if (name === "studio") setTimeout(() => editor && editor.refresh(), 60);
  history.replaceState(null, "", "#" + name);
}

/* ==================================================================== INIT */
window.addEventListener("error", e => { try {
  const w = document.getElementById("toastWrap"); if (!w) return;
  const d = document.createElement("div"); d.className = "toast err";
  d.textContent = "⚠️ JS error: " + (e.message || "unknown"); w.appendChild(d);
  setTimeout(() => d.remove(), 8000);
} catch {} });

document.addEventListener("DOMContentLoaded", async () => {
  /* ---- theme ---- */
  applyTheme(localStorage.getItem(LS_THEME) || "glass-dark");
  $("#themeSelect").onchange = e => applyTheme(e.target.value);
  $("#aiThemeBtn").onclick = aiTheme;

  /* ---- tabs ---- */
  $$(".tab-btn").forEach(b => b.onclick = () => switchPage(b.dataset.page));
  if (location.hash) switchPage(location.hash.slice(1));

  /* ---- greeting / suggestions / typewriter / templates ---- */
  $("#greetingSub").textContent = greeting();
  renderTemplates(); renderSuggestions(); startTypewriter();
  $("#suggestChips").addEventListener("click", e => {
    const c = e.target.closest(".chip"); if (!c) return;
    const s = SUGGESTIONS_BY_DAYPART[dayPart()][+c.dataset.i];
    const ta = $("#promptInput");
    ta.value = ta.value.trim() ? ta.value.trim() + "\n" + s : s;
    ta.focus(); toast("Inserted suggestion into prompt context ➕", "ok", 1800);
  });
  $("#useSuggestionBtn").onclick = () => {
    const ta = $("#promptInput");
    ta.value = ta.value.trim() ? ta.value.trim() + "\n" + twCurrent : twCurrent;
    ta.focus(); toast("Idea inserted ➡️ prompt", "ok", 1800);
  };
  $("#nextSuggestionBtn").onclick = () => { twIdx++; startTypewriter(); };

  /* ---- build mode / generation ---- */
  $("#templateGrid").addEventListener("click", e => {
    const b = e.target.closest("[data-tpl]"); if (!b) return;
    const t = APP_TEMPLATES[+b.dataset.tpl];
    setBuilderMode("build");
    const ta = $("#promptInput"); ta.value = t.p; ta.focus();
    toast(`Template “${t.n}” loaded into the prompt ✨`, "ok", 2200);
  });
  $("#modeBuildBtn").onclick = () => setBuilderMode("build");
  $("#modeChatBtn").onclick   = () => setBuilderMode("chat");
  $("#generateBtn").onclick = startBuildFromDashboard;
  $("#stopGenBtn").onclick = () => { genAbort?.abort(); pendingPlan = null; };
  $("#chatSendBtn").onclick = () => {
    const t = $("#chatInput").value.trim(); if (!t) return toast("Type what to change first ✍️", "err");
    sendChatTurn(t, "edit", pickedElement); pickedElement = null; updatePickBar();
  };
  $("#chatStopBtn").onclick = () => { genAbort?.abort(); };
  $("#chatInput").addEventListener("keydown", e => {
    if ((e.ctrlKey||e.metaKey) && e.key === "Enter") { e.preventDefault(); $("#chatSendBtn").click(); } });
  $("#chatProjectSel").onchange = e => e.target.value && loadProject(e.target.value);
  $("#clearChatBtn").onclick = async () => {
    if (!currentProject) return;
    if (!confirm("Clear this project's chat thread? (files & checkpoints are kept)")) return;
    await DB.delMsgsOf(currentProject.id); renderChat(); };
  $("#autoApproveChk").checked = localStorage.getItem("csab.autoapprove") === "1";
  $("#autoApproveChk").onchange = e => localStorage.setItem("csab.autoapprove", e.target.checked ? "1" : "0");

  /* ---- projects ---- */
  $("#newProjectBtn").onclick = async () => {
    const t = await promptModal("New empty project title", "My Awesome App");
    if (t) { await newProject(t); switchPage("studio"); toast("Project created 📁", "ok"); }
  };
  $("#projectsList").addEventListener("click", async e => {
    const o = e.target.closest("[data-open]"), d = e.target.closest("[data-del]");
    if (o) { await loadProject(o.dataset.open); switchPage("studio"); showPanel("chat"); }
    if (d) { if (confirm("Delete this project permanently?")) { await DB.delProject(d.dataset.del);
      if (currentProject?.id === d.dataset.del) { currentProject = null; openFileId = null; renderTree(); refreshPreview(); }
      renderProjectsLists(); } }
  });
  $("#studioProjectSel").onchange = e => e.target.value && loadProject(e.target.value);
  $("#renameProjectBtn").onclick = async () => {
    if (!currentProject) return toast("No project loaded.","err");
    const t = await promptModal("Project title", currentProject.title);
    if (t) { currentProject.title = t; await saveCurrentProject(); renderTree(); renderProjectsLists(); }
  };
  $("#deleteProjectBtn").onclick = async () => {
    if (!currentProject) return toast("No project loaded.","err");
    if (confirm(`Delete project “${currentProject.title}”?`)) {
      await DB.delProject(currentProject.id);
      await DB.delMsgsOf(currentProject.id); await DB.delCkptsOf(currentProject.id);
      currentProject = null; openFileId = null;
      renderProjectsLists(); renderTree(); refreshPreview(); renderChat(); renderTimeline();
    }
  };

  /* ---- explorer ---- */
  $("#newFileBtn").onclick = () => createFile("");
  $("#newFolderBtn").onclick = () => createFolder("");
  $("#fileTree").addEventListener("click", e => {
    const q = e.target.closest("[data-qact]");
    if (q) { e.stopPropagation();
      const act = q.dataset.qact;
      if (act === "nf") createFile(q.dataset.p);
      else if (act === "nd") createFolder(q.dataset.p);
      else if (act === "del") deleteNode(q.dataset.id || q.dataset.p);
      else if (act === "ren") renameNode(q.dataset.id);
      return; }
    const n = e.target.closest(".tnode[data-type='file']");
    if (n) openFile(n.dataset.path);
  });
  $("#fileTree").addEventListener("contextmenu", e => {
    const n = e.target.closest(".tnode:not([data-type='root'])"); if (!n) return;
    e.preventDefault();
    const label = n.querySelector(".nm")?.textContent || "";
    const key = n.dataset.id || n.dataset.path;
    if (confirm(`“${label}” — press OK to DELETE, Cancel to keep (rename via the ✏️ button)`)) deleteNode(key);
  });

  /* ---- editor / preview / zip ---- */
  initEditor();
  applyTheme(localStorage.getItem(LS_THEME) || "glass-dark");   // sync CM theme now editor exists
  $("#saveFileBtn").onclick = () => doSaveFile(false);
  document.addEventListener("keydown", e => { if ((e.ctrlKey||e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); doSaveFile(false); } });
  $("#refreshPreviewBtn").onclick = () => refreshPreview(true);

  /* panels: chat + history */
  $("#toggleChatBtn").onclick = () => showPanel("chat");
  $("#toggleHistoryBtn").onclick = () => showPanel("history");
  $("#shareBtn").onclick = shareProjectUrl;

  /* viewport switcher */
  $$(".vp-btn").forEach(b => b.onclick = () => setViewport(b.dataset.vp));
  setViewport(localStorage.getItem("csab.viewport") || "auto");

  /* element inspector */
  $("#pickModeBtn").onclick = () => togglePickMode();
  $("#cancelPickBtn").onclick = () => { pickedElement = null; updatePickBar(); togglePickMode(false); };
  $("#editPickedBtn").onclick = () => {
    if (!pickedElement) return;
    setBuilderMode("chat");
    const ta = $("#chatInput");
    ta.value = "";
    ta.placeholder = `Describe the change for <${pickedElement.tag}> (${pickedElement.selector})…`;
    ta.focus();
    toast("🎯 Element targeted — your next message will include its HTML.", "ok", 3500);
  };

  /* error overlay */
  $("#dismissErrBtn").onclick = hideErrorOverlay;
  $("#fixWithAiBtn").onclick = () => {
    if (!lastPreviewError) return;
    hideErrorOverlay();
    sendChatTurn(`The preview throws this runtime error:\n"${lastPreviewError.message}"${lastPreviewError.file?` [${lastPreviewError.file}:${lastPreviewError.line||"?"}]`:""}\nFix it without breaking other features.`, "edit", null);
  };

  /* window messages from the sandboxed preview iframe */
  window.addEventListener("message", ev => {
    const d = ev.data || {};
    if (d.type === "preview-error") showErrorOverlay(d);
    else if (d.type === "element-pick") { pickedElement = d; updatePickBar(); togglePickMode(false); }
    else if (d.type === "pick-off") { $("#pickModeBtn").classList.remove("primary"); $("#previewPane").classList.remove("pick-mode"); pickMode = false; }
  });

  /* plan action chips + checkpoint timeline (delegated) */
  $("#chatScroll").addEventListener("click", e => {
    const b = e.target.closest("[data-pact]"); if (!b) return;
    handlePlanAction(b.dataset.pact, b.closest(".plan-actions").dataset.msg);
  });
  $("#timelineList").addEventListener("click", e => {
    const b = e.target.closest("[data-ckact]"); if (!b) return;
    restoreCheckpoint(b.closest("[data-ck]").dataset.ck);
  });
  $("#runAllBtn").onclick = () => { const i = currentProject?.files.find(f=>f.type==="file"&&f.name.toLowerCase()==="index.html");
    if (i) { openFile(i.path); refreshPreview(); toast("Running index.html ▶", "ok", 1600); } else toast("No index.html found.","err"); };
  $("#exportZipBtn").onclick = exportZip;

  /* ---- settings form ---- */
  $("#providerPresets").innerHTML = PRESETS.map((p,i)=>`<button type="button" class="preset" data-i="${i}">${esc(p.name)}</button>`).join("");
  $("#providerPresets").addEventListener("click", e => {
    const b = e.target.closest(".preset"); if (!b) return;
    const p = PRESETS[+b.dataset.i];
    const cur = readForm();
    fillForm({ ...cur, spec:p.spec, baseUrl:p.url, model:p.model, name: cur.name || p.name });
    invalidateTest();
  });
  ["pfName","pfUrl","pfKey","pfModel","pfSpec","pfMaxTok","pfTemp"].forEach(id =>
    $("#"+id).addEventListener("input", invalidateTest));
  $("#keyEyeBtn").onclick = () => { const k = $("#pfKey"); k.type = k.type === "password" ? "text" : "password"; };
  $("#testConnBtn").onclick = testConnection;
  $("#providerForm").addEventListener("submit", saveProvider);
  $("#cancelEditBtn").onclick = resetForm;

  $("#providersList").addEventListener("click", async e => {
    const b = e.target.closest("[data-act]"); if (!b) return;
    const card = b.closest(".provider-card"), id = card.dataset.id;
    const ps = getProviders(), p = ps.find(x => x.id === id); if (!p) return;
    if (b.dataset.act === "del") {
      if (confirm(`Delete provider “${p.name}”?`)) { setProviders(ps.filter(x=>x.id!==id)); renderProviders(); }
    } else if (b.dataset.act === "edit") {
      editingProviderId = id; fillForm(p);
      $("#provFormTitle").firstChild.textContent = "✏️ Edit Provider ";
      $("#cancelEditBtn").style.display = "";
      testPassedFor = providerSignature(readForm()); $("#saveProvBtn").disabled = false;
      $("#testResult").textContent = "Editing a saved provider — hit Test again to re-validate, or Save changes directly.";
      switchPage("settings"); window.scrollTo({top:0,behavior:"smooth"});
    } else if (b.dataset.act === "ping") {
      const slot = card.querySelector(".ping-slot");
      slot.textContent = "pinging…"; b.disabled = true;
      const res = await pingProvider(p);
      b.disabled = false;
      const fresh = getProviders(); const fp = fresh.find(x=>x.id===id);
      fp.lastHealthCheckMs = res.ms; fp.status = res.ok ? "active" : "error";
      setProviders(fresh);
      slot.innerHTML = res.ok ? `<b style="color:var(--ok)">${res.ms}ms – Active 🟢</b>` : `<b style="color:var(--err)">${res.ms}ms – Down 🔴</b>`;
      if (!res.ok) { slot.title = res.err || ""; toast(`${p.name}: ${res.err}`, "err", 6000); }
      renderUsageTable(); renderAnalytics();
      setTimeout(renderProviders, 1400);
    }
  });
  $("#clearLogsBtn").onclick = async () => { await DB.clearLogs(); loadLogs(); renderAnalytics(); };

  /* ---- editable system prompts + model routing (Settings) ---- */
  $("#spPlanner").value = getSpPlanner();
  $("#spCoder").value = getSpCoder();
  $("#savePromptsBtn").onclick = () => {
    localStorage.setItem("csab.sp.planner", $("#spPlanner").value);
    localStorage.setItem("csab.sp.coder", $("#spCoder").value);
    setRouting({ planner: $("#routePlanner").value, coder: $("#routeCoder").value });
    $("#promptsSavedTag").textContent = "✓ saved locally " + new Date().toLocaleTimeString();
    populateProviderSelects(); toast("System prompts & routing saved 💾", "ok");
  };
  $("#resetPromptsBtn").onclick = () => {
    localStorage.removeItem("csab.sp.planner"); localStorage.removeItem("csab.sp.coder");
    $("#spPlanner").value = DEFAULT_SP_PLANNER; $("#spCoder").value = DEFAULT_SP_CODER;
    toast("Prompts reset to defaults ↺", "ok");
  };

  /* ---- boot data ---- */
  renderProviders(); resetForm(); loadLogs().catch(()=>{}); renderAnalytics();
  try { await openDB(); } catch (e) { toast("IndexedDB unavailable: " + e, "err", 6000); return; }
  if (await importFromHash()) { renderProjectsLists(); return; }   // shared URL wins over last project
  const last = localStorage.getItem(LS_PROJECT);
  const all = await DB.allProjects().catch(()=>[]);
  if (last && all.some(p=>p.id===last)) await loadProject(last);
  renderProjectsLists(); populateProviderSelects(); renderChat(); renderTimeline();
});
