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

/* ------------------------------------------------- MASTER SYSTEM PROMPT */
const MASTER_SYSTEM_PROMPT = `You are "Client-Side App Builder AI", an elite full-stack web engineering assistant. Your role is to generate complete, clean, modular, and production-ready web application code based on user requests.

### CRITICAL RULES:
1. OUTPUT FORMAT: Always format code outputs strictly as valid JSON array of files so the client-side app manager can write them directly into the file system.
2. FILE STRUCTURE: Separate concerns cleanly. Never put everything in one file unless explicitly requested. Always separate HTML, CSS, JavaScript/TypeScript, and modular assets where applicable.
3. DEPENDENCIES: Use browser-executable CDN scripts (like Tailwind CSS CDN, FontAwesome, Lucide Icons) inside \`index.html\` for instant client-side rendering.
4. ZERO ASSUMPTIONS: Ensure all code generated is fully functional without missing functions, placeholder comments, or truncated logic ("// write remaining code here").

### RESPONSE JSON FORMAT SCHEMA:
[
  {
    "path": "index.html",
    "content": "<!DOCTYPE html>..."
  },
  {
    "path": "css/styles.css",
    "content": "/* CSS styling */"
  },
  {
    "path": "js/app.js",
    "content": "// JavaScript code"
  }
]`;

/* ------------------------------------------------------ localStorage cfg */
const LS_PROVIDERS = "csab.providers", LS_THEME = "csab.theme", LS_PROJECT = "csab.activeProject";
const getProviders = () => { try { return JSON.parse(localStorage.getItem(LS_PROVIDERS)) || []; } catch { return []; } };
const setProviders = p => localStorage.setItem(LS_PROVIDERS, JSON.stringify(p));

/* ------------------------------------------------------------- IndexedDB */
const DB_NAME = "csappbuilder", DB_VER = 1;
let _dbp = null;
function openDB() {
  if (_dbp) return _dbp;
  _dbp = new Promise((res, rej) => {
    const rq = indexedDB.open(DB_NAME, DB_VER);
    rq.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains("projects"))     db.createObjectStore("projects", { keyPath: "id" });
      if (!db.objectStoreNames.contains("generationLogs")) db.createObjectStore("generationLogs", { keyPath: "id" });
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
};

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

function buildChatRequest(p, messages) {
  const maxTok = p.maxTokens || 8192, temp = p.temperature ?? 0.4;
  if (p.spec === "anthropic") {
    const sys = messages.find(m => m.role === "system")?.content;
    const rest = messages.filter(m => m.role !== "system");
    return {
      url: `${p.baseUrl.replace(/\/$/, "")}/messages`,
      headers: { "Content-Type":"application/json", "x-api-key":p.apiKey||"none",
                 "anthropic-version":"2023-06-01", "anthropic-dangerous-direct-browser-access":"true" },
      body: { model:p.model, max_tokens:maxTok, temperature:temp, ...(sys?{system:sys}:{}) , messages:rest },
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
      extract: j => (j.candidates?.[0]?.content?.parts||[]).map(x=>x.text).join(""),
      usage: j => ({ in:(j.usageMetadata?.promptTokenCount)||0, out:(j.usageMetadata?.candidatesTokenCount)||0 }),
    };
  }
  /* OpenAI-compatible default */
  return {
    url: `${p.baseUrl.replace(/\/$/, "")}/chat/completions`,
    headers: { "Content-Type":"application/json", ...(p.apiKey?{Authorization:`Bearer ${p.apiKey}`}:{}) },
    body: { model:p.model, messages, max_tokens:maxTok, temperature:temp },
    extract: j => j.choices?.[0]?.message?.content ?? "",
    usage: j => ({ in:(j.usage?.prompt_tokens)||0, out:(j.usage?.completion_tokens)||0 }),
  };
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
  renderUsageTable(); renderGenProviderSelect(); renderAnalytics();
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

async function testConnection() {
  const f = readForm();
  if (!f.name || !f.baseUrl || !f.model) { $("#testResult").innerHTML = "⚠️ Fill Name, Base URL and Model first."; return; }
  const btn = $("#testConnBtn"); btn.disabled = true;
  $("#testResult").innerHTML = `<span class="spin">🔄</span> Contacting ${esc(f.baseUrl)} …`;
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
      ok = true; detail = `HTTP 200 OK · ${(u.in+u.out)} tok · model said “${txt.slice(0,40)}”`;
    } else {
      const body = await resp.text().catch(()=>"");
      detail = `HTTP ${resp.status} ${resp.statusText} — ${body.slice(0,140)}`;
    }
  } catch (e) { detail = e.message || String(e); }
  btn.disabled = false;
  if (ok) {
    testPassedFor = providerSignature(readForm());
    $("#saveProvBtn").disabled = false;
    $("#testResult").innerHTML = `✅ <b>${esc(detail)}</b> — Save unlocked.`;
  } else {
    testPassedFor = ""; $("#saveProvBtn").disabled = true;
    $("#testResult").innerHTML = `❌ Connection failed: ${esc(detail)}`;
  }
}

function saveProvider(e) {
  e.preventDefault();
  if ($("#saveProvBtn").disabled) return;
  const f = readForm(); const ps = getProviders();
  if (editingProviderId) {
    const p = ps.find(x => x.id === editingProviderId);
    Object.assign(p, f, { status:"active" });
  } else {
    ps.push({ id:uid(), ...f, totalRequests:0, totalTokensUsed:0, lastHealthCheckMs:0, status:"active" });
  }
  setProviders(ps); renderProviders(); resetForm();
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
  const proj = { id:uid(), title, createdAt:Date.now(), updatedAt:Date.now(),
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
  openFileId = null; $("#editorFileName").textContent = "no file open";
  renderTree(); renderProjectsLists(); refreshPreview();
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
function refreshPreview() {
  const frame = $("#previewFrame");
  if (!currentProject) { frame.srcdoc = ""; return; }
  const idx = currentProject.files.find(f => f.type==="file" && f.name.toLowerCase()==="index.html");
  if (!idx) { frame.srcdoc = `<body style="font:14px system-ui;display:grid;place-items:center;height:100vh;color:#666">No index.html in this project.</body>`; return; }
  frame.srcdoc = inlineAssets(idx.content || "");
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

/* ====================================================== AI GENERATION ==== */
let genAbort = null;

function extractJsonFiles(text) {
  if (!text) return null;
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1].trim().startsWith("[")) t = fence[1].trim();
  const s = t.indexOf("["), e = t.lastIndexOf("]");
  if (s === -1 || e <= s) return null;
  try {
    const arr = JSON.parse(t.slice(s, e+1));
    if (!Array.isArray(arr)) return null;
    return arr.filter(o => o && typeof o.path === "string" && typeof o.content === "string");
  } catch { return null; }
}

async function generateProject() {
  const promptText = $("#promptInput").value.trim();
  const pid = $("#genProvider").value;
  if (!promptText) return toast("Describe what you want to build first ✍️", "err");
  const p = getProviders().find(x => x.id === pid);
  if (!p) return toast("Configure a provider in ⚙️ Providers first (and Test Connection).", "err");

  const btn = $("#generateBtn"), stop = $("#stopGenBtn"), st = $("#genStatus"), pr = $("#genProgress");
  btn.disabled = true; stop.style.display = ""; pr.style.display = "block";
  st.textContent = "Thinking… (calling " + p.name + " / " + p.model + ")";
  genAbort = new AbortController();
  const t0 = performance.now();
  try {
    const messages = [
      { role:"system", content: MASTER_SYSTEM_PROMPT },
      { role:"user", content: promptText + "\n\nReturn ONLY the JSON array of files, nothing else." },
    ];
    const req = buildChatRequest(p, messages);
    const r = await fetch(req.url, { method:"POST", headers:req.headers, body:JSON.stringify(req.body), signal:genAbort.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0,200)}`);
    const j = await r.json();
    const text = req.extract(j);
    const usage = req.usage(j);
    const inTok = usage.in || Math.ceil((MASTER_SYSTEM_PROMPT.length + promptText.length)/4);
    const outTok = usage.out || Math.ceil((text||"").length/4);
    bumpUsage(p.id, inTok + outTok, true);
    const files = extractJsonFiles(text);
    if (!files || !files.length) throw new Error("Model did not return a valid JSON file array.\nRaw snippet: " + (text||"(empty)").slice(0,160));
    const lat = Math.round(performance.now() - t0);
    const title = promptText.split(/\s+/).slice(0,5).join(" ");
    const proj = { id:uid(), title, createdAt:Date.now(), updatedAt:Date.now(), files:[] };
    for (const gf of files) {
      const path = normalizePath(gf.path);
      const name = path.split("/").pop();
      const parts = path.split("/").filter(Boolean);
      for (let i = 1; i < parts.length; i++) {
        const fp = "/" + parts.slice(0,i).join("/");
        if (!proj.files.some(f => f.path === fp))
          proj.files.push({ id:uid(), path:fp, name:parts[i-1], content:"", type:"folder" });
      }
      proj.files.push({ id:uid(), path, name, content:gf.content, type:"file" });
      await DB.addLog({ id:uid(), time:Date.now(), provider:p.name, file:path,
        tokensIn: Math.max(1, Math.round(inTok/files.length)), tokensOut: Math.max(1, Math.round(outTok/files.length)),
        latencyMs: Math.round(lat/files.length) });
    }
    await DB.putProject(proj);
    localStorage.setItem(LS_PROJECT, proj.id);
    currentProject = proj; openFileId = null;
    renderProjectsLists(); renderTree(); renderAnalytics(); loadLogs(); renderProviders();
    const idx = proj.files.find(f => f.type==="file" && f.name.toLowerCase()==="index.html");
    if (idx) openFile(idx.path); else refreshPreview();
    st.textContent = ""; switchPage("studio");
    toast(`🎉 Generated ${files.length} files in ${lat}ms — project “${title}”`, "ok", 5000);
  } catch (e) {
    if (e.name === "AbortError") st.textContent = "Stopped.";
    else { st.textContent = ""; bumpUsage(p.id, 0, false); toast("Generation failed: " + e.message, "err", 6000); }
  } finally {
    btn.disabled = false; stop.style.display = "none"; pr.style.display = "none"; genAbort = null;
    renderProviders();
  }
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
  const sel = $("#studioProjectSel"), cur = sel.value;
  sel.innerHTML = projs.map(p => `<option value="${p.id}">${esc(p.title)}</option>`).join("") || `<option value="">— no projects —</option>`;
  if (cur && projs.some(p=>p.id===cur)) sel.value = cur;
  else if (currentProject) sel.value = currentProject.id;
}

function renderGenProviderSelect() {
  const sel = $("#genProvider"), cur = sel.value;
  sel.innerHTML = getProviders().map(p =>
    `<option value="${p.id}">${esc(p.name)} · ${esc(p.model)} ${p.status==="active"?"🟢":p.status==="error"?"🔴":"⚪"}</option>`).join("")
    || `<option value="">No provider configured</option>`;
  if ([...sel.options].some(o=>o.value===cur)) sel.value = cur;
}

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
function switchPage(name) {
  $$(".page").forEach(p => p.classList.toggle("active", p.id === "page-" + name));
  $$(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.page === name));
  if (name === "studio") setTimeout(() => editor && editor.refresh(), 60);
  history.replaceState(null, "", "#" + name);
}

/* ==================================================================== INIT */
document.addEventListener("DOMContentLoaded", async () => {
  /* ---- theme ---- */
  applyTheme(localStorage.getItem(LS_THEME) || "glass-dark");
  $("#themeSelect").onchange = e => applyTheme(e.target.value);
  $("#aiThemeBtn").onclick = aiTheme;

  /* ---- tabs ---- */
  $$(".tab-btn").forEach(b => b.onclick = () => switchPage(b.dataset.page));
  if (location.hash) switchPage(location.hash.slice(1));

  /* ---- greeting / suggestions / typewriter ---- */
  $("#greetingSub").textContent = greeting();
  $("#masterPromptView").textContent = MASTER_SYSTEM_PROMPT;
  renderSuggestions(); startTypewriter();
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

  /* ---- generation ---- */
  $("#generateBtn").onclick = generateProject;
  $("#stopGenBtn").onclick = () => { genAbort?.abort(); };

  /* ---- projects ---- */
  $("#newProjectBtn").onclick = async () => {
    const t = await promptModal("New empty project title", "My Awesome App");
    if (t) { await newProject(t); switchPage("studio"); toast("Project created 📁", "ok"); }
  };
  $("#projectsList").addEventListener("click", async e => {
    const o = e.target.closest("[data-open]"), d = e.target.closest("[data-del]");
    if (o) { await loadProject(o.dataset.open); switchPage("studio"); }
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
      await DB.delProject(currentProject.id); currentProject = null; openFileId = null;
      renderProjectsLists(); renderTree(); refreshPreview();
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
  $("#refreshPreviewBtn").onclick = refreshPreview;
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
      if (!res.ok) toast(`${p.name}: ${res.err}`, "err");
      renderUsageTable(); renderAnalytics();
      setTimeout(renderProviders, 1400);
    }
  });
  $("#clearLogsBtn").onclick = async () => { await DB.clearLogs(); loadLogs(); renderAnalytics(); };

  /* ---- boot data ---- */
  renderProviders(); resetForm(); loadLogs().catch(()=>{}); renderAnalytics();
  try { await openDB(); } catch (e) { toast("IndexedDB unavailable: " + e, "err", 6000); return; }
  const last = localStorage.getItem(LS_PROJECT);
  const all = await DB.allProjects().catch(()=>[]);
  if (last && all.some(p=>p.id===last)) await loadProject(last);
  renderProjectsLists();
});
