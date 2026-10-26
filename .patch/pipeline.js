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
  const selId = $(role === "planner" ? "#plannerProvider" : "#genProvider")?.value;
  return (selId && ps.some(p => p.id === selId) ? selId
    : (r[role] && ps.some(p => p.id === r[role]) ? r[role] : ps[0]?.id)) || "";
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
