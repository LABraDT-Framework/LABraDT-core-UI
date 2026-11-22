// System page: configure and run the LABraDT stack (tasks of tools-labradt-framework/unified_cli.py).
// Talks only to the UI controller routes /api/stack/* (backend/stack.py).
(function (root) {
  "use strict";
  const $ = id => document.getElementById(id);
  const esc = value => (typeof escapeHtml === "function" ? escapeHtml(value) : String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])));
  const toast = text => (typeof showToast === "function" ? showToast(text) : console.log(text));
  const ORDER = ["runtime", "gateway", "engine"];
  const PHASES = {
    stopped: ["Stopped", "draft"], building: ["Building", "warning"], starting: ["Starting", "warning"],
    running: ["Running", ""], external: ["Running · external", ""], stopping: ["Stopping", "warning"], failed: ["Failed", "offline"]
  };
  const CONDITION_LABELS = { greater_than: "> greater than", less_than: "< less than", equals: "== equals", out_of_bounds: "out of bounds (min,max,…)" };
  const ADAPTERS = { SCRIPT: ["LUA", "BASH"], CONTAINER: ["DOCKER"], EXTERNAL: ["REST"] };
  const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELLED", "TIMEOUT", "ERROR"]);
  let overview = null, rules = [], services = null, servicesError = "", configs = null, projects = null;
  let selectedServices = new Set(), logTimer = null;

  // ── helpers ───────────────────────────────────────────────────────────────
  async function api(path, { method = "GET", body } = {}) {
    const response = await fetch(path, { method, headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const type = response.headers.get("content-type") || "";
    const payload = type.includes("application/json") ? await response.json() : await response.text();
    if (!response.ok) {
      const detail = payload?.detail ?? payload;
      const error = new Error(typeof detail === "string" ? detail : detail?.message || detail?.error || ("HTTP " + response.status));
      error.detail = detail; error.status = response.status;
      throw error;
    }
    return payload;
  }
  const visible = () => $("systemTab")?.classList.contains("active");
  const short = path => String(path || "").split(/[\\/]/).filter(Boolean).pop() || path;
  const time = ms => (ms ? new Date(ms).toLocaleString() : "–");
  const parseArgs = text => Object.fromEntries(String(text || "").split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
    const at = line.indexOf("=");
    if (at < 1) throw new Error(`Expected key=value, got "${line}"`);
    return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
  }));
  const readFile = file => new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error); reader.readAsArrayBuffer(file); });
  const toBase64 = buffer => { let binary = ""; const bytes = new Uint8Array(buffer); for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(binary); };
  const errorList = (detail) => {
    const errors = detail?.errors || [], warnings = detail?.warnings || [];
    return (errors.length ? `<ul class="stack-errors">${errors.map(e => `<li>${esc(e)}</li>`).join("")}</ul>` : "") +
      (warnings.length ? `<ul class="stack-warnings">${warnings.map(w => `<li>${esc(w)}</li>`).join("")}</ul>` : "");
  };

  // Shared modal of the page (core/ui.js); the wide variant is reset whenever the modal closes.
  const modal = document.querySelector("#modalBackdrop .modal");
  new MutationObserver(() => { if (!modalBackdrop.classList.contains("open")) { modal.classList.remove("stack-wide"); clearInterval(logTimer); logTimer = null; } })
    .observe(modalBackdrop, { attributes: true, attributeFilter: ["class"] });
  function openModal({ title, html, submitLabel = "Save", danger = false, wide = false, cancel = true, onSubmit }) {
    modalTitle.textContent = title;
    modalBody.innerHTML = html;
    modalCancel.style.display = cancel ? "" : "none";
    modalSubmit.textContent = submitLabel;
    modalSubmit.className = danger ? "btn fill-danger" : "btn primary";
    modal.classList.toggle("stack-wide", wide);
    modalSubmitHandler = async () => {
      modalBody.querySelector(".stack-modal-error")?.remove();
      modalSubmit.disabled = true;
      try { if (!onSubmit || await onSubmit(modalBody) !== false) closeModal(); }
      catch (error) { modalBody.insertAdjacentHTML("beforeend", `<div class="stack-modal-error">${esc(error.message)}${errorList(error.detail)}</div>`); }
      finally { modalSubmit.disabled = false; }
    };
    modalBackdrop.classList.add("open"); modalBackdrop.setAttribute("aria-hidden", "false");
    setTimeout(() => modalBody.querySelector("input:not([type=checkbox]):not([type=file]),textarea,select")?.focus(), 30);
  }
  const showText = (title, text) => openModal({ title, html: `<pre class="empty-note stack-pre">${esc(text || "(empty)")}</pre>`, submitLabel: "Close", cancel: false, wide: true });
  function confirmAction(title, message, label, action) {
    openModal({ title, html: `<div class="modal-message">${message}</div>`, submitLabel: label, danger: true, onSubmit: action });
  }

  // ── components ────────────────────────────────────────────────────────────
  function phaseBadge(status) { const [label, cls] = PHASES[status?.phase] || ["Unknown", "draft"]; return `<span class="badge ${cls}">${esc(label)}</span>`; }

  function renderStrip() {
    const comps = overview?.components || {};
    $("stackStripPills").innerHTML = ORDER.map(key => {
      const c = comps[key]; const [label] = PHASES[c?.phase] || ["Offline"];
      return `<span class="stack-pill" data-phase="${esc(c?.phase || "unknown")}"><i></i>${esc(c?.label || key)} · ${esc(c?.port || "")}<b>${esc(label)}</b></span>`;
    }).join("");
    const job = overview?.job || {};
    const allUp = ORDER.every(key => comps[key]?.healthy);
    $("stackStripJob").textContent = job.state === "running" ? job.message : job.state === "failed" ? "Last action failed: " + job.message : !overview ? "UI controller not reachable" : allUp ? "All components running" : ORDER.filter(key => comps[key]?.healthy).length + " / 3 components running";
    for (const id of ["stackStripStart", "stackStartAll"]) $(id).disabled = !overview || job.state === "running" || allUp;
    for (const id of ["stackStripStop", "stackStopAll"]) $(id).disabled = !overview || job.state === "running" || !ORDER.some(key => comps[key]?.tracked);
    const badge = $("stackJobBadge");
    badge.textContent = job.state === "running" ? `${job.action === "start" ? "Starting" : "Stopping"} · ${job.step || ""}` : job.state === "failed" ? "Failed" : job.state === "done" ? "Done" : "Idle";
    badge.className = "badge " + (job.state === "running" ? "warning" : job.state === "failed" ? "offline" : "draft");
    badge.title = job.message || "";
  }

  function renderCards() {
    const comps = overview?.components || {};
    $("stackCards").innerHTML = ORDER.map(key => {
      const c = comps[key];
      if (!c) return `<article class="stack-card"><div class="stack-card-head"><h4>${esc(key)}</h4><span class="badge draft">Unknown</span></div></article>`;
      const busy = ["building", "starting", "stopping"].includes(c.phase);
      return `<article class="stack-card" data-phase="${esc(c.phase)}">
        <div class="stack-card-head"><span class="stack-dot"></span><h4>${esc(c.label)}</h4>${phaseBadge(c)}</div>
        <div class="kv">
          <span>URL</span><strong><a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.url)}</a></strong>
          <span>Process</span><strong>${c.tracked ? "PID " + esc(c.pid ?? "–") + (c.since ? " · since " + esc(new Date(c.since).toLocaleTimeString()) : "") : c.external ? "started outside this UI" : "–"}</strong>
          <span>Project</span><strong title="${esc(c.project)}">${esc(short(c.project))}${c.projectFound ? "" : ' <em class="stack-missing">(not found)</em>'}</strong>
          <span>Build</span><strong>${c.built ? "built by this UI" : "builds on first start"}</strong>
        </div>
        <p class="small stack-msg">${esc(c.message || (c.maven ? "" : "Maven not found – install it or set MAVEN_CMD."))}</p>
        <div class="component-actions">
          <button class="btn primary" data-stack-start="${key}" ${c.running || busy || !c.projectFound ? "disabled" : ""}>Start</button>
          <button class="btn fill-danger" data-stack-stop="${key}" ${c.tracked ? "" : "disabled"}>Stop</button>
          ${c.external ? `<button class="btn danger" data-stack-force="${key}">Force stop</button>` : ""}
          <button class="btn ghost" data-stack-logs="${key}">Logs</button>
        </div>
        <details class="stack-cmd"><summary>Commands</summary><code>${esc(c.commands.build)}</code><code>${esc(c.commands.run)}</code></details>
      </article>`;
    }).join("");
    const o = overview;
    if (!o) return;
    const rows = [
      ["Gateway configs", o.gatewayConfigDir + (o.gatewayConfigDirFound ? "" : "  (not found)")], ["Engine AASX", o.aasx.path + (o.aasx.exists ? "" : "  (not found)")],
      ["JAVA_HOME", o.toolchain.javaHome ? o.toolchain.javaHome + " · " + (o.toolchain.java || "") : "not found – install a JDK or set JAVA_HOME"],
      ...ORDER.map(key => ["Maven · " + key, o.components[key].maven || "not found – set MAVEN_CMD"]),
      ["Extra Maven args", o.toolchain.mavenArgs || "– (set LABRADT_MAVEN_ARGS, e.g. -o)"]
    ];
    $("stackToolchain").innerHTML = rows.map(([k, v]) => `<span>${esc(k)}</span><strong>${esc(v)}</strong>`).join("");
  }

  async function refreshOverview() {
    try { overview = await api("/api/stack"); } catch { overview = null; }
    renderStrip();
    if (visible()) renderCards();
    return overview;
  }

  async function startComponent(key) {
    try { const result = await api(`/api/stack/${key}/start`, { method: "POST", body: { build: $("stackBuildFirst").checked ? true : null } }); toast(result.message || "Start requested."); }
    catch (error) { toast(error.message); }
    refreshOverview();
  }
  async function stopComponent(key) {
    toast("Stopping " + key + " …");
    try { const result = await api(`/api/stack/${key}/stop`, { method: "POST" }); toast(result.message); } catch (error) { toast(error.message); }
    refreshOverview();
  }
  function forceStop(key) {
    const c = overview?.components?.[key];
    confirmAction("Force stop", `Stop the process that listens on port <strong>${esc(c?.port)}</strong>? It was not started by this UI.`, "Force stop", async () => {
      const result = await api(`/api/stack/${key}/force-stop`, { method: "POST" }); toast(result.message); refreshOverview();
    });
  }
  function showLogs(key) {
    const label = overview?.components?.[key]?.label || key;
    openModal({ title: label + " · Log", html: `<p class="small">${esc(overview?.components?.[key]?.logFile || "")} · refreshes every 2 s</p><pre class="empty-note stack-pre stack-log" id="stackLogText">Loading…</pre>`, submitLabel: "Close", cancel: false, wide: true });
    const load = async () => {
      const pre = $("stackLogText"); if (!pre) return;
      const stick = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 30;
      try { pre.textContent = await api(`/api/stack/${key}/logs?lines=400`); } catch (error) { pre.textContent = error.message; }
      if (stick) pre.scrollTop = pre.scrollHeight;
    };
    load(); clearInterval(logTimer); logTimer = setInterval(load, 2000);
  }
  async function stackAction(action, build) {
    try { await api("/api/stack/" + action, { method: "POST", body: action === "start" ? { build } : undefined }); toast(action === "start" ? "Starting Runtime → Gateway → Engine …" : "Stopping Engine → Gateway → Runtime …"); }
    catch (error) { toast(error.message); }
    refreshOverview();
  }

  // ── gateway configs ───────────────────────────────────────────────────────
  async function refreshConfigs() {
    try { configs = await api("/api/stack/gateway/configs"); } catch (error) { configs = { error: error.message, configs: [], credentials: [] }; }
    const list = configs.configs || [];
    $("stackConfigCount").textContent = configs.error ? "Unavailable" : list.length + " config" + (list.length === 1 ? "" : "s");
    $("stackConfigDir").innerHTML = configs.error ? esc(configs.error) : `Folder: <code>${esc(configs.directory)}</code>${configs.found ? "" : " <em class=\"stack-missing\">(will be created on first install)</em>"} · the Gateway loads <code>*.json</code> from here at start.`;
    $("stackConfigRows").innerHTML = list.length ? list.map(c => c.error
      ? `<tr><td>${esc(c.file)}</td><td colspan="4" class="stack-missing">${esc(c.error)}</td><td></td></tr>`
      : `<tr><td><strong>${esc(c.machineId)}</strong><div class="small">${esc(c.machineType || "")} · ${esc(c.file)}</div></td><td>${esc(c.protocol)}</td><td><code>${esc(c.endpoint)}</code></td><td>${esc(c.mappings)}</td>
         <td>${c.enabled ? '<span class="badge">Enabled</span>' : '<span class="badge draft">Disabled</span>'}${c.placeholders?.length ? `<div class="small">${c.placeholders.map(esc).join(", ")}</div>` : ""}</td>
         <td><div class="row-actions"><button class="link-btn" data-stack-config-open="${esc(c.machineId)}">Edit on Gateway page</button><button class="link-btn stack-danger-link" data-stack-config-remove="${esc(c.file)}">Remove</button></div></td></tr>`).join("")
      : `<tr><td colspan="6" class="small">No machine configs yet. Install a config file, configure one on the Gateway page, or browse a live machine.</td></tr>`;
    const creds = configs.credentials || [];
    $("stackCredentials").innerHTML = creds.length ? creds.map(v => `<form class="stack-cred" data-stack-cred="${esc(v.name)}"><code>${esc(v.name)}</code>
        <span class="badge ${v.set ? "" : "warning"}">${v.set ? "set · " + esc(v.source) : "not set"}</span>
        <input type="password" autocomplete="off" placeholder="value" aria-label="${esc(v.name)}" />
        <button class="btn ghost" type="submit">Set</button>${v.source === "UI (memory)" ? `<button class="btn ghost" type="button" data-stack-cred-clear="${esc(v.name)}">Clear</button>` : ""}</form>`).join("")
      : `<p class="small">No placeholders in the installed configs.</p>`;
  }

  function openInstallConfig(prefill) {
    openModal({
      title: "Install a ready config file", submitLabel: "Install", wide: true,
      html: `<p class="small">The file is validated like in the CLI: required fields, unique machineId and idShort names, value types, and no plain-text <code>connection.password</code> (use <code>\${DT_&lt;MACHINE&gt;_PASSWORD}</code>).</p>
        <label class="field">JSON file<input type="file" id="stackCfgFile" accept=".json,application/json" /></label>
        <label class="field">Config JSON<textarea id="stackCfgText" rows="14" spellcheck="false" class="stack-code">${esc(prefill ? JSON.stringify(prefill, null, 2) : "")}</textarea></label>
        <label class="stack-check"><input type="checkbox" id="stackCfgReplace" /> Replace an installed config with the same machineId</label>
        <label class="stack-check"><input type="checkbox" id="stackCfgForce" /> Install despite warnings</label>
        <div id="stackCfgResult"></div>
        <div class="component-actions"><button class="btn ghost" type="button" id="stackCfgValidate">Validate</button></div>`,
      onSubmit: async () => {
        const result = await api("/api/stack/gateway/configs/install", { method: "POST", body: { config: parseConfig(), force: $("stackCfgForce").checked, replace: $("stackCfgReplace").checked } });
        toast(`Config installed: ${result.installed} · ${result.elements} signals` + (result.restartRequired ? " · restart the Gateway to load it" : ""));
        if (result.credentialVariables?.length) toast("Set " + result.credentialVariables.join(" and ") + " before starting the Gateway.");
        refreshConfigs();
      }
    });
    const parseConfig = () => { try { return JSON.parse($("stackCfgText").value); } catch (error) { throw new Error("Invalid JSON: " + error.message); } };
    $("stackCfgFile").addEventListener("change", async event => { const file = event.target.files[0]; if (file) $("stackCfgText").value = await file.text(); });
    $("stackCfgValidate").addEventListener("click", async () => {
      const out = $("stackCfgResult");
      try {
        const result = await api("/api/stack/gateway/configs/validate", { method: "POST", body: { config: parseConfig(), replace: $("stackCfgReplace").checked } });
        out.innerHTML = (result.valid ? `<p class="stack-ok">Valid${result.warnings.length ? " · with warnings" : ""}.</p>` : `<p class="stack-missing">Not valid.</p>`) + errorList(result);
      } catch (error) { out.innerHTML = `<p class="stack-missing">${esc(error.message)}</p>`; }
    });
  }

  function openBrowseMachine() {
    openModal({
      title: "Browse a live machine and create a config", submitLabel: "Browse", wide: true,
      html: `<div class="form-grid">
          <label class="field">Machine ID<input name="machineId" placeholder="molder-2" required pattern="[^\\s/\\\\]+" /></label>
          <label class="field">Machine type<input name="machineType" value="Generic" /></label>
          <label class="field">Protocol<select name="protocol" id="stackBrowseProtocol"><option>OPC_UA</option><option>MQTT</option></select></label>
          <label class="field">Endpoint<input name="endpoint" id="stackBrowseEndpoint" placeholder="opc.tcp://host:4840" required /></label>
          <label class="field" id="stackBrowseTopicField" hidden>Topic filter<input name="topicFilter" value="#" /></label>
          <label class="stack-check field full"><input type="checkbox" name="withCredentials" id="stackBrowseCreds" /> The server requires username / password</label>
          <label class="field stack-cred-field" hidden>Username<input name="username" autocomplete="off" /></label>
          <label class="field stack-cred-field" hidden>Password (used only for browsing, never saved)<input name="password" type="password" autocomplete="off" /></label>
        </div><div id="stackBrowseSignals"></div>`,
      onSubmit: async body => {
        const form = Object.fromEntries([...body.querySelectorAll("[name]")].map(el => [el.name, el.type === "checkbox" ? el.checked : el.value.trim()]));
        const table = $("stackBrowseSignals");
        if (!table.dataset.ready) {
          modalSubmit.textContent = "Browsing…";
          try {
            const result = await api("/api/stack/gateway/browse", { method: "POST", body: form });
            if (!result.signals.length) throw new Error("No signals found – is the machine / publisher running?");
            table.dataset.ready = "1";
            table.innerHTML = `<p class="small">${result.count} signals found. Pick the ones to expose and confirm name, type and unit.</p>
              <div class="table-wrap stack-scroll"><table><thead><tr><th><input type="checkbox" id="stackBrowseAll" aria-label="Select all" /></th><th>Address</th><th>Current</th><th>Element name (idShort)</th><th>Type</th><th>Unit</th></tr></thead><tbody>
              ${result.signals.map((s, i) => `<tr data-address="${esc(s.address)}"><td><input type="checkbox" data-pick="${i}" aria-label="Pick ${esc(s.name)}" /></td><td><code>${esc(s.address)}</code></td><td>${esc(String(s.value ?? "").slice(0, 40))}</td>
                <td><input data-idshort value="${esc(String(s.name || "").replace(/[^A-Za-z0-9_]/g, "_").replace(/^([^A-Za-z])/, "s$1"))}" /></td>
                <td><select data-type>${["xs:string", "xs:double", "xs:int", "xs:boolean", "xs:float", "xs:long", "xs:dateTime"].map(t => `<option ${t === s.valueType ? "selected" : ""}>${t}</option>`).join("")}</select></td>
                <td><input data-unit placeholder="–" /></td></tr>`).join("")}</tbody></table></div>`;
            $("stackBrowseAll").addEventListener("change", e => table.querySelectorAll("[data-pick]").forEach(box => box.checked = e.target.checked));
            body.querySelectorAll(".form-grid [name]").forEach(el => el.disabled = el.name !== "machineId" && el.name !== "machineType");
            modalSubmit.textContent = "Create config";
          } catch (error) { modalSubmit.textContent = "Browse"; throw error; }
          return false;
        }
        const mappings = [...table.querySelectorAll("tbody tr")].filter(row => row.querySelector("[data-pick]").checked).map(row => ({
          sourceAddress: row.dataset.address, idShort: row.querySelector("[data-idshort]").value.trim(), valueType: row.querySelector("[data-type]").value, unit: row.querySelector("[data-unit]").value.trim()
        }));
        if (!mappings.length) throw new Error("Nothing selected.");
        const result = await api("/api/stack/gateway/configs/create", { method: "POST", body: { ...form, mappings } });
        toast(`Config installed: ${result.installed} · ${result.elements} signals`);
        if (result.credentialVariables.length) setTimeout(() => toast(`The file stores no credentials. Set ${result.credentialVariables.join(" and ")} (Credential variables) before starting the Gateway.`), 2600);
        refreshConfigs();
      }
    });
    const protocol = $("stackBrowseProtocol");
    protocol.addEventListener("change", () => { $("stackBrowseTopicField").hidden = protocol.value !== "MQTT"; $("stackBrowseEndpoint").placeholder = protocol.value === "MQTT" ? "tcp://host:1883" : "opc.tcp://host:4840"; });
    $("stackBrowseCreds").addEventListener("change", e => modalBody.querySelectorAll(".stack-cred-field").forEach(el => el.hidden = !e.target.checked));
  }

  // ── engine rules (AASX) ───────────────────────────────────────────────────
  async function refreshRules() {
    let data;
    try { data = await api("/api/stack/engine/rules"); } catch (error) { data = { error: error.message, rules: [] }; }
    rules = data.rules || [];
    $("stackRuleCount").textContent = data.error ? "Unavailable" : rules.length + " rule" + (rules.length === 1 ? "" : "s");
    $("stackAasxInfo").innerHTML = data.error ? esc(data.error) : `<code>${esc(data.path)}</code>${data.exists ? ` · modified ${esc(new Date(data.modified).toLocaleString())}` : ' <em class="stack-missing">(not found)</em>'}${data.backups?.length ? ` · ${data.backups.length} backup(s), latest ${esc(data.backups[0])}` : ""}. Changes apply when the Engine re-loads the AASX (Initialize or restart).`;
    renderRulesPageAasx(data);
    $("stackRuleRows").innerHTML = rules.length ? rules.map(r => `<tr><td><strong>${esc(r.id)}</strong></td><td>${esc(r.targetSubmodel || "")}${r.targetSubmodel ? " · " : ""}<strong>${esc(r.targetElement)}</strong></td>
      <td><code>${esc(r.condition)}</code> ${esc(r.threshold)}</td><td>${esc(r.action)}</td><td>${r.cooldownMs ? esc(r.cooldownMs) + " ms" : "–"}</td><td>${esc(r.description || "")}${String(r.source || "").startsWith("rules-page:") ? ' <span class="badge">Rules page</span>' : ""}</td>
      <td><div class="row-actions"><button class="link-btn" data-stack-rule-edit="${esc(r.id)}">Edit</button><button class="link-btn stack-danger-link" data-stack-rule-delete="${esc(r.id)}">Delete</button></div></td></tr>`).join("")
      : `<tr><td colspan="7" class="small">${data.exists === false ? "The engine AASX was not found." : "No rules in the AASX."}</td></tr>`;
  }

  async function openRule(ruleId) {
    const rule = rules.find(r => r.id === ruleId) || { targetSubmodel: rules[0]?.targetSubmodel || "CPS-SM", condition: "greater_than" };
    if (services === null) await refreshServices();
    const options = (services || []).map(s => `<option value="${esc(s.serviceId)}">${esc(s.displayName || "")}</option>`).join("");
    const extra = Object.keys(rule).filter(k => !["id", "targetSubmodel", "targetElement", "condition", "threshold", "action", "cooldownMs", "description"].includes(k));
    openModal({
      title: ruleId ? "Edit " + ruleId : "Add rule to the AASX", submitLabel: ruleId ? "Save" : "Add rule", wide: true,
      html: `<p class="small">${ruleId ? "Only changed properties are written." : "The new rule gets the next free <code>Rule_N</code> ID."} The Engine reads the AASX when it initializes.</p>
        <div class="form-grid">
          <label class="field">Target submodel<input name="targetSubmodel" value="${esc(rule.targetSubmodel || "")}" /></label>
          <label class="field">Target element (sensor to watch)<input name="targetElement" value="${esc(rule.targetElement || "")}" required placeholder="Temperature" /></label>
          <label class="field">Condition<select name="condition">${Object.entries(CONDITION_LABELS).map(([v, l]) => `<option value="${v}" ${v === rule.condition ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></label>
          <label class="field">Threshold<input name="threshold" value="${esc(rule.threshold || "")}" required placeholder="75.0 or -0.45,0.45" /></label>
          <label class="field">Action · service to trigger<input name="action" list="stackRuleServices" value="${esc(rule.action || "")}" required placeholder="cooling-service" /><datalist id="stackRuleServices">${options}</datalist>
            <span class="small">${services === null || servicesError ? "Service Manager not reachable – enter the service ID." : services.length ? services.length + " registered services suggested." : "No services registered yet – register one first."}</span></label>
          <label class="field">Cooldown (ms)<input name="cooldownMs" inputmode="numeric" pattern="[0-9]*" value="${esc(rule.cooldownMs || "")}" /></label>
          <label class="field full">Description<input name="description" value="${esc(rule.description || "")}" /></label>
          ${extra.map(k => `<label class="field">${esc(k)}<input name="${esc(k)}" value="${esc(rule[k])}" /></label>`).join("")}
        </div>`,
      onSubmit: async body => {
        const values = Object.fromEntries([...body.querySelectorAll("[name]")].map(el => [el.name, el.value.trim()]));
        if (ruleId) {
          const changes = Object.fromEntries(Object.entries(values).filter(([k, v]) => v !== (rule[k] ?? "")));
          if (!Object.keys(changes).length) return toast("Nothing changed.");
          const result = await api("/api/stack/engine/rules/" + encodeURIComponent(ruleId), { method: "PUT", body: changes });
          toast(result.changed.map(c => `${ruleId}.${c.property}: '${c.old ?? ""}' → '${c.new}'`).join(" · ") + " · Initialize the Engine to apply.");
        } else {
          const result = await api("/api/stack/engine/rules", { method: "POST", body: Object.fromEntries(Object.entries(values).filter(([, v]) => v)) });
          toast(result.id + " added to the AASX · Initialize the Engine to apply.");
        }
        refreshRules();
      }
    });
  }

  // ── Rules page: the Engine rules of the AASX, next to the rules created there ─────────────
  const RULE_ICONS = {
    sme: '<svg viewBox="0 0 24 24"><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9"/></svg>',
    condition: '<svg viewBox="0 0 24 24"><path d="m12 3 8 9-8 9-8-9 8-9Z"/><path d="M9 12h6"/></svg>',
    service: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/></svg>',
    result: '<svg viewBox="0 0 24 24"><path d="M6 3h12v18H6zM9 8h6M9 12h6M9 16h4"/></svg>'
  };
  const ruleNode = (type, title, detail, state = "pending") => `<div class="engine-flow-node ${state}"><span class="engine-flow-icon">${RULE_ICONS[type]}</span><strong>${esc(title)}</strong><span>${esc(detail)}</span></div>`;
  const ruleArrow = '<span class="engine-flow-connector" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 12h15m-5-5 5 5-5 5"/></svg></span>';
  const fromRulesPage = rule => String(rule.source || "").startsWith("rules-page:");
  function renderRulesPageAasx(data) {
    const host = $("aasxRulesList"); if (!host) return;
    const list = (data?.rules || []).filter(rule => !fromRulesPage(rule));
    const linked = (data?.rules || []).length - list.length;
    $("aasxRulesCount").textContent = data?.error ? "Unavailable" : `${list.length} rule${list.length === 1 ? "" : "s"}`;
    $("aasxRulesInfo").innerHTML = data?.error ? esc(data.error)
      : `Loaded by the Engine from <code>${esc(data.path || "")}</code> (Rules_SM) when it initializes.${linked ? ` ${linked} more rule${linked === 1 ? " was" : "s were"} created above and ${linked === 1 ? "is" : "are"} marked <strong>Engine</strong> there.` : ""}`;
    document.getElementById("rulesTab")?.classList.toggle("has-aasx-rules", list.length > 0);
    const before = JSON.stringify(root.gucAasxRules || null);
    root.gucAasxRules = { total: list.length, enabled: list.filter(rule => rule.enabled !== "false").length };
    if (before !== JSON.stringify(root.gucAasxRules)) root.gucAasServiceLinks?.render?.();
    const overview = $("overviewAasxRulesList");
    if (overview) overview.innerHTML = list.map(rule => `<button type="button" class="overview-entity-row" data-overview-aasx-rule="${esc(rule.id)}"><span class="overview-entity-copy"><strong>${esc(rule.description || rule.id)}</strong><span class="small">${esc(rule.id)} · ${esc(rule.targetElement || "")} ${esc(rule.condition || "")} ${esc(rule.threshold || "")} → ${esc(rule.action || "")}</span></span><span class="badge ${rule.enabled === "false" ? "draft" : ""}">Engine · AASX</span></button>`).join("");
    host.innerHTML = list.map(rule => {
      const enabled = rule.enabled !== "false";
      const watch = (rule.targetSubmodel ? rule.targetSubmodel + " · " : "") + (rule.targetElement || "?");
      const condition = `${CONDITION_LABELS[rule.condition] || rule.condition || "?"} ${rule.threshold || ""}`.trim();
      let parameters = "";
      try { const p = JSON.parse(rule.parameters || "{}"); parameters = Object.keys(p).length ? " · " + Object.keys(p).length + " parameter" + (Object.keys(p).length === 1 ? "" : "s") : ""; } catch {}
      return `<article class="engine-instance aasx-rule" data-aasx-rule="${esc(rule.id)}"><div class="engine-instance-head"><div><h3>${esc(rule.description || rule.id)}</h3><span class="small">${esc(rule.id)}</span> <span class="badge" title="Stored in the engine project's AASX; the Engine runs it.">Engine · AASX</span></div>
        <span class="badge ${enabled ? "" : "draft"}">${enabled ? "Enabled" : "Disabled"}</span>
        <div class="engine-instance-actions"><button class="link-btn" data-aasx-action="edit">Edit</button><button class="link-btn" data-aasx-action="toggle">${enabled ? "Disable" : "Enable"}</button><button class="link-btn danger-text" data-aasx-action="delete">Delete</button></div></div>
        <div class="engine-flow">${ruleNode("sme", "Watched value", watch, "complete")}${ruleArrow}${ruleNode("condition", "Condition", condition)}${ruleArrow}${ruleNode("service", "Service Trigger", (rule.action || "?") + parameters)}${ruleArrow}${ruleNode("result", "Cooldown", rule.cooldownMs ? rule.cooldownMs + " ms" : "none")}</div></article>`;
    }).join("") || (data?.error ? "" : '<p class="small">No further rules in the AASX.</p>');
  }
  async function openAasxRule(ruleId) {
    if (!rules.length || ruleId === null) await refreshRules();
    openRule(ruleId);
  }
  $("aasxRuleAdd")?.addEventListener("click", () => openAasxRule(null));
  $("overviewAasxRulesList")?.addEventListener("click", event => { const id = event.target.closest("[data-overview-aasx-rule]")?.dataset.overviewAasxRule; if (id) openAasxRule(id); });
  $("aasxRulesList")?.addEventListener("click", async event => {
    const action = event.target.closest("[data-aasx-action]")?.dataset.aasxAction; if (!action) return;
    const id = event.target.closest("[data-aasx-rule]")?.dataset.aasxRule; if (!id) return;
    const rule = rules.find(r => r.id === id) || {};
    try {
      if (action === "edit") return openAasxRule(id);
      if (action === "toggle") {
        await api("/api/stack/engine/rules/" + encodeURIComponent(id), { method: "PUT", body: { enabled: rule.enabled === "false" ? "true" : "false" } });
        toast(`${id} ${rule.enabled === "false" ? "enabled" : "disabled"} in the AASX · Initialize the Engine to apply.`); refreshRules();
      }
      if (action === "delete") confirmAction("Delete rule", `Delete <strong>${esc(rule.description || id)}</strong> (${esc(id)}) from the engine AASX? Create a backup on the System page first if you may need it again.`, "Delete",
        async () => { await api("/api/stack/engine/rules/" + encodeURIComponent(id), { method: "DELETE" }); toast(id + " removed from the AASX · Initialize the Engine to apply."); refreshRules(); });
    } catch (error) { toast(error.message); }
  });
  // The Rules page reads the AASX itself (works with the Engine stopped) and follows changes made elsewhere.
  document.querySelector('.nav button[data-nav="rules"]')?.addEventListener("click", () => refreshRules());
  setInterval(() => { if (document.getElementById("rulesTab")?.classList.contains("active")) refreshRules(); }, 4000);
  refreshRules(); // also fills the Overview's Rules card

  // ── engine operator ───────────────────────────────────────────────────────
  async function refreshEngineState() {
    const badge = $("stackEngineState");
    try {
      const state = await api("/api/stack/engine/state");
      const name = (state.state.match(/Current state:\s*([A-Z_]+)/) || [])[1] || "Reachable";
      badge.textContent = name + (state.runtime ? " · " + state.runtime : "");
      badge.className = "badge " + (name === "INITIALIZING" ? "warning" : name === "ERROR" ? "offline" : "");
      $("stackEngineStateText").textContent = state.state + (name === "INITIALIZING" ? " — use Initialize to complete startup." : "");
    } catch (error) { badge.textContent = "Not reachable"; badge.className = "badge offline"; $("stackEngineStateText").textContent = "Engine not reachable at port 8080. Start it under Components."; }
  }
  function engineOutput(text) { const pre = $("stackEngineOutput"); pre.hidden = false; pre.textContent = text; }

  // ── services ──────────────────────────────────────────────────────────────
  async function refreshServices() {
    try { services = await api("/api/stack/services"); servicesError = ""; } catch (error) { services = []; servicesError = error.message; }
    const live = overview?.components?.runtime?.healthy;
    selectedServices = new Set([...selectedServices].filter(id => services.some(s => s.serviceId === id)));
    $("stackServiceCount").textContent = servicesError ? "Unavailable" : services.length + (live ? " registered" : " in the runtime project");
    $("stackServiceCount").className = "badge " + (servicesError ? "offline" : "draft");
    $("stackServiceCount").title = live ? "Live registry of the running Service Manager" : "The Runtime is stopped: these services are kept in the runtime project and registered at its next start.";
    $("stackServiceRows").innerHTML = servicesError ? `<tr><td colspan="7" class="small">${esc(servicesError)}</td></tr>`
      : services.length ? services.map(s => `<tr><td><input type="checkbox" data-stack-svc-pick="${esc(s.serviceId)}" ${selectedServices.has(s.serviceId) ? "checked" : ""} aria-label="Select ${esc(s.serviceId)}" /></td>
        <td><strong>${esc(s.serviceId)}</strong></td><td>${esc(s.executionCategory)}</td><td>${esc(s.technologyAdapter)}</td><td>${esc(s.displayName || "")}</td><td><code>${esc(s.fileReference || "–")}</code></td>
        <td><div class="row-actions"><button class="link-btn" data-stack-svc-view="${esc(s.serviceId)}">Details</button><button class="link-btn" data-stack-svc-run="${esc(s.serviceId)}">Trigger</button><button class="link-btn stack-danger-link" data-stack-svc-delete="${esc(s.serviceId)}">Delete</button></div></td></tr>`).join("")
      : `<tr><td colspan="7" class="small">No services registered. Register one – rules need a registered service as action.</td></tr>`;
    $("stackTriggerServices").disabled = !selectedServices.size;
  }
  async function refreshExecutions() {
    let data;
    try { data = await api("/api/stack/services/executions"); } catch { data = null; }
    $("stackRunningNote").textContent = data ? (data.running.length ? data.running.length + " in progress" : "Nothing running") : "Service Manager not reachable";
    $("stackRunningRows").innerHTML = data?.running?.length ? data.running.map(r => `<tr><td>${esc(r.serviceId)}</td><td><span class="badge warning">${esc(r.status)}</span></td><td><code>${esc(r.executionId)}</code></td>
      <td><button class="btn danger" data-stack-exec-stop="${esc(r.executionId)}" data-service="${esc(r.serviceId)}">Stop</button></td></tr>`).join("") : `<tr><td colspan="4" class="small">–</td></tr>`;
    $("stackHistoryRows").innerHTML = data?.history?.length ? data.history.slice(0, 25).map(r => `<tr><td>${esc(time(r.completedAt))}</td><td>${esc(r.serviceId)}</td>
      <td><span class="badge ${r.success ? "" : "offline"}">${esc(r.status)}</span></td><td>${r.executionDurationMs != null ? esc(r.executionDurationMs) + " ms" : "–"}</td>
      <td class="stack-trunc" title="${esc(r.success ? r.outputData : r.errorMessage)}">${esc(String((r.success ? r.outputData : r.errorMessage) || "(empty)").slice(0, 120))}</td>
      <td><button class="link-btn" data-stack-exec-view="${esc(r.executionId)}">Result</button></td></tr>`).join("") : `<tr><td colspan="6" class="small">No completed executions yet.</td></tr>`;
  }

  function openRegister() {
    openModal({
      title: "Register service", submitLabel: "Register", wide: true,
      html: `<div class="form-grid">
        <label class="field">Service ID<input name="serviceId" required pattern="[A-Za-z0-9_.\\-]+" /></label>
        <label class="field">Display name<input name="displayName" /></label>
        <label class="field full">Description<input name="description" /></label>
        <label class="field">Service type<select name="executionCategory" id="stackRegCategory">${Object.keys(ADAPTERS).map(c => `<option>${c}</option>`).join("")}</select></label>
        <label class="field">Runtime<select name="technologyAdapter" id="stackRegAdapter"></select></label>
        <label class="field full" id="stackRegFileField"><span id="stackRegFileLabel">Script</span><input type="file" id="stackRegFile" /><span class="small">Uploaded to the Engine storage; the returned file reference is stored in the definition.</span></label>
        <label class="field full">Default args (key=value per line)<textarea name="defaultArgs" rows="4" class="stack-code" placeholder="threshold=80"></textarea></label>
      </div><div class="stack-tip" id="stackRegTip"></div>`,
      onSubmit: async body => {
        const values = Object.fromEntries([...body.querySelectorAll("[name]")].map(el => [el.name, el.value.trim()]));
        const payload = { ...values, defaultArgs: parseArgs(values.defaultArgs) };
        const file = $("stackRegFile").files[0];
        if (file && values.executionCategory !== "EXTERNAL") payload.file = { name: file.name, content: toBase64(await readFile(file)) };
        const result = await api("/api/stack/services", { method: "POST", body: payload });
        toast("Service registered: " + result.registered + (result.definition.fileReference ? " · file " + result.definition.fileReference : ""));
        refreshServices();
      }
    });
    const category = $("stackRegCategory"), adapter = $("stackRegAdapter");
    const sync = () => {
      adapter.innerHTML = ADAPTERS[category.value].map(a => `<option>${a}</option>`).join("");
      $("stackRegFileField").hidden = category.value === "EXTERNAL";
      $("stackRegFileLabel").textContent = category.value === "CONTAINER" ? "Dockerfile (optional)" : "Script (optional)";
      $("stackRegTip").innerHTML = nestedTip(category.value);
    };
    category.addEventListener("change", sync); sync();
  }
  function nestedTip(category) {
    if (category === "SCRIPT") return `<strong>Nested service tip</strong> – inside your script:<pre>local result = triggerNestedService("other-service-id")</pre>`;
    if (category === "CONTAINER") return `<strong>Nested service tip</strong> – inside your Dockerfile ENTRYPOINT:<pre>curl -s -X POST -H 'Content-Type: application/json' \\\n     -d '{"serviceIds":["other-service-id"],"dynamicArgs":{}}' \\\n     $SERVICE_TRIGGER_NESTED_URL</pre>`;
    return `<strong>Nested service calls</strong> are not supported for EXTERNAL services.`;
  }
  function openNestedGuide() {
    showText("How to call nested services", [
      "A nested service is another registered service your service calls at runtime to delegate work.",
      "Register it first, then call it from inside your script or Dockerfile.", "",
      "── Script (Lua)", '  local result = triggerNestedService("your-service-id")', '  local result = triggerNestedService("your-service-id", {key="value"})', "  -- result is the outputData string of the nested service", "",
      "── Dockerfile / container", "  $SERVICE_TRIGGER_NESTED_URL is injected into the container. The call blocks until the nested service completes:",
      "  RESPONSE=$(curl -s -X POST -H 'Content-Type: application/json' \\", "    -d '{\"serviceIds\":[\"your-service-id\"],\"dynamicArgs\":{}}' \\", "    $SERVICE_TRIGGER_NESTED_URL)",
      "  OUTPUT=$(echo \"$RESPONSE\" | jq -r '.outputData')", "  SUCCESS=$(echo \"$RESPONSE\" | jq -r '.success')",
      "  Response: { \"serviceId\": \"…\", \"status\": \"COMPLETED\", \"success\": true, \"outputData\": \"…\", \"errorMessage\": null }",
      "  Your image needs curl and jq:  RUN apk add --no-cache curl jq   (Alpine)   /   RUN apt-get install -y curl jq", "",
      "── External REST service", "  Runs in a third-party environment – nested service calls are not supported."
    ].join("\n"));
  }
  function openTrigger(ids) {
    openModal({
      title: "Trigger " + (ids.length === 1 ? ids[0] : ids.length + " services"), submitLabel: "Trigger", wide: true,
      html: `<p class="small">Services: <strong>${ids.map(esc).join(", ")}</strong> · several services run concurrently, each with its own execution ID.</p>
        <div class="form-grid"><label class="field">Runs per service<input type="number" id="stackTrigRuns" min="1" max="5" value="1" /></label>
        <label class="field full">Dynamic args (key=value per line, override the defaults)<textarea id="stackTrigArgs" rows="4" class="stack-code"></textarea></label></div>
        <div id="stackTrigResult"></div>`,
      onSubmit: async () => {
        const runs = Math.max(1, Math.min(5, Number($("stackTrigRuns").value) || 1));
        const serviceIds = ids.flatMap(id => Array(runs).fill(id));
        const ack = await api("/api/stack/services/trigger", { method: "POST", body: { serviceIds, dynamicArgs: parseArgs($("stackTrigArgs").value) } });
        const triggered = ack?.triggered || [];
        if (!triggered.length) throw new Error("The Service Manager accepted no execution: " + JSON.stringify(ack));
        const out = $("stackTrigResult");
        out.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Service</th><th>Execution</th><th>Status</th><th>Output / Error</th></tr></thead><tbody>${triggered.map(t => `<tr data-exec="${esc(t.executionId)}"><td>${esc(t.serviceId)}</td><td><code>${esc(t.executionId.slice(0, 8))}</code></td><td data-status>${esc(t.status)}</td><td data-out class="stack-trunc">…</td></tr>`).join("")}</tbody></table></div>`;
        modalSubmit.textContent = "Close"; modalCancel.style.display = "none"; modalSubmitHandler = closeModal;
        pollExecutions(out, triggered);
        return false;
      }
    });
  }
  async function pollExecutions(out, triggered) {
        const deadline = Date.now() + 120000;
        const pending = new Set(triggered.map(t => t.executionId));
        while (pending.size && Date.now() < deadline && modalBackdrop.classList.contains("open")) {
          await new Promise(r => setTimeout(r, 2000));
          for (const id of [...pending]) {
            const row = out.querySelector(`[data-exec="${CSS.escape(id)}"]`); if (!row) continue;
            try {
              const status = await api("/api/stack/services/status?executionId=" + encodeURIComponent(id));
              const name = status?.status || status;
              row.querySelector("[data-status]").textContent = name;
              if (TERMINAL.has(name)) {
                pending.delete(id);
                const result = await api("/api/stack/services/result?executionId=" + encodeURIComponent(id)).catch(() => null);
                row.querySelector("[data-out]").textContent = result ? (result.success ? result.outputData || "(empty)" : result.errorMessage || "(no error message)") : "–";
              }
            } catch { /* keep polling */ }
          }
        }
        for (const id of pending) { const row = out.querySelector(`[data-exec="${CSS.escape(id)}"]`); if (row) row.querySelector("[data-out]").textContent = "Timed out after 2 min – see History."; }
        refreshExecutions();
  }
  async function showResult(executionId) {
    const [status, result] = await Promise.all([
      api("/api/stack/services/status?executionId=" + encodeURIComponent(executionId)).catch(error => ({ error: error.message })),
      api("/api/stack/services/result?executionId=" + encodeURIComponent(executionId)).catch(() => null)
    ]);
    const lines = [`Execution  : ${executionId}`, `Status     : ${status?.status || status?.error || JSON.stringify(status)}`];
    if (result) {
      lines.push(`Service    : ${result.serviceId}`, `Success    : ${result.success}`);
      if (result.completedAt) lines.push(`Completed  : ${time(result.completedAt)}`);
      if (result.executionDurationMs != null) lines.push(`Duration   : ${result.executionDurationMs} ms`);
      lines.push(result.success ? `Output     : ${result.outputData || "(empty)"}` : `Error      : ${result.errorMessage || "(none)"}`);
    } else lines.push("No completed result – it may still be running or never existed.");
    showText("Service result", lines.join("\n"));
  }
  function deleteService(id, force = false) {
    confirmAction("Delete service", `Delete <strong>${esc(id)}</strong> from the Service Manager registry? Its uploaded file is removed from the Engine storage.`, "Delete", async () => {
      try {
        const result = await api(`/api/stack/services/${encodeURIComponent(id)}${force ? "?force=true" : ""}`, { method: "DELETE" });
        toast(`Deleted: ${id}` + (result.storage ? ` · storage file ${result.storage}` : ""));
        refreshServices();
      } catch (error) {
        if (error.status === 409 && error.detail?.needsConfirmation) {
          setTimeout(() => confirmAction("Service is used by rules", `${esc(error.message)}<ul>${error.detail.rules.map(r => `<li>${esc(r.id)} (${esc(r.source)}): ${esc(r.targetElement)} ${esc(r.condition)} ${esc(r.threshold)} → ${esc(r.action)}</li>`).join("")}</ul>Delete anyway?`, "Delete anyway", async () => {
            const result = await api(`/api/stack/services/${encodeURIComponent(id)}?force=true`, { method: "DELETE" }); toast(`Deleted: ${id}` + (result.storage ? ` · storage file ${result.storage}` : "")); refreshServices();
          }), 0);
          return;
        }
        throw error;
      }
    });
  }

  // ── events ────────────────────────────────────────────────────────────────
  // ── project: folders of the three components, export / import, hand-over ───
  const PROJECT_LABEL = { engine: "Engine (core-engine)", gateway: "Gateway", runtime: "Runtime (Service Manager)" };
  const PROJECT_ORDER = ["engine", "gateway", "runtime"];
  const folderIcon = '<svg class="icon folder-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/></svg>';
  let browsing = null;
  async function refreshProjects() {
    try { projects = await api("/api/stack/projects"); } catch (error) { projects = { error: error.message }; }
    renderProjects();
  }
  function renderProjects() {
    const host = $("projectFolders"); if (!host) return;
    if (projects?.error) { host.innerHTML = `<p class="small stack-missing">${esc(projects.error)}</p>`; $("projectState").textContent = "Unavailable"; return; }
    const ok = PROJECT_ORDER.filter(key => projects?.[key]?.kind === key).length;
    $("projectState").textContent = `${ok} / 3 projects found`;
    $("projectState").className = ok === 3 ? "badge" : "badge warning";
    host.innerHTML = PROJECT_ORDER.map(key => {
      const p = projects?.[key] || {}, good = p.kind === key;
      const status = !p.found ? '<span class="badge offline">Not found</span>' : good ? '<span class="badge">Found</span>' : `<span class="badge warning">${p.kind ? "Looks like the " + esc(p.kind) + " project" : "Not a " + esc(key) + " project"}</span>`;
      const extra = key === "gateway" ? `Machine configs: <code>${esc(p.configDir || "")}</code>` : key === "engine" ? `Rules AASX: <code>${esc(p.aasx || "")}</code> · service files: <code>storage/</code>` : "Service registry: in the project (H2) · imported services: <code>config/services.json</code>";
      const plugins = key === "engine" ? "" : ` · <code>plugins/</code>: ${p.plugins?.length ? p.plugins.map(esc).join(", ") : "none yet"}`;
      return `<div class="project-folder" data-project="${key}">
        <div class="project-folder-head"><strong>${esc(PROJECT_LABEL[key])}</strong>${status}<button type="button" class="btn ghost" data-project-browse="${key}">Browse…</button></div>
        <code class="project-path" title="${esc(p.path || "")}">${esc(p.path || "–")}</code>
        <div class="small">${extra}${plugins}</div>
        <div class="folder-browser" data-project-browser="${key}" ${browsing?.key === key ? "" : "hidden"}></div>
      </div>`;
    }).join("");
    if (browsing) showProjectFolder(browsing.key, browsing.path);
  }
  async function showProjectFolder(key, path) {
    browsing = { key, path };
    const box = document.querySelector(`[data-project-browser="${key}"]`); if (!box) return;
    try {
      const listing = await api("/api/stack/projects/folders?path=" + encodeURIComponent(path || ""));
      browsing.path = listing.path;
      box.hidden = false;
      const useHere = listing.project === key ? `<button type="button" class="btn primary" data-project-use="${key}" data-path="${esc(listing.path)}">Use this folder</button>` : "";
      box.innerHTML = `<div class="folder-head"><button type="button" class="btn ghost" data-project-open="${key}" data-path="${esc(listing.parent ?? "")}" ${listing.parent === null ? "disabled" : ""}>↑ Up</button><code title="${esc(listing.path)}">${esc(listing.path || "Computer")}</code>${useHere}<button type="button" class="btn ghost" data-project-close>Close</button></div>`
        + (listing.project && listing.project !== key ? `<p class="small folder-hit">This folder is the ${esc(listing.project)} project.</p>` : "")
        + `<ul class="folder-list">${listing.dirs.map(d => `<li><button type="button" class="folder-entry" data-project-open="${key}" data-path="${esc(d.path)}">${folderIcon}<span>${esc(d.name)}</span></button>${d.project ? `<span class="badge ${d.project === key ? "" : "draft"}">${esc(d.project)} project</span>` : ""}${d.project === key ? `<button type="button" class="link-btn" data-project-use="${key}" data-path="${esc(d.path)}">Use</button>` : ""}</li>`).join("") || '<li class="small">No sub-folders.</li>'}</ul>`;
    } catch (error) { toast(error.message); }
  }
  async function useProject(key, path) {
    try {
      const result = await api("/api/stack/projects", { method: "POST", body: { [key]: path } });
      browsing = null; projects = result.projects; renderProjects(); refreshOverview(); refreshConfigs(); refreshRules();
      toast(result.changed.length ? `${PROJECT_LABEL[key]} project set to ${short(path)}.` : "Unchanged.");
    } catch (error) { toast(error.message); }
  }
  async function exportProject() {
    const button = $("projectExport"); button.disabled = true;
    try {
      const response = await fetch("/api/project/export");
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).detail || "Export failed (HTTP " + response.status + ")");
      const name = (response.headers.get("content-disposition") || "").match(/filename="([^"]+)"/)?.[1] || "labradt-project.zip";
      const url = URL.createObjectURL(await response.blob());
      const link = Object.assign(document.createElement("a"), { href: url, download: name });
      document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000);
      toast("Project exported as " + name + ".");
    } catch (error) { toast(error.message); } finally { button.disabled = false; }
  }
  function summary(contents) {
    const c = contents || {};
    return [["Machine configs", c.gatewayConfigs], ["Rules AASX", c.aasx || "–"], ["Services", c.services], ["Service files", c.serviceFiles],
      ["AAS", c.aas ? Object.entries(c.aas).map(([k, v]) => `${v} ${k}`).join(", ") : "–"],
      ["Gateway plugins", (c.gatewayPlugins || []).join(", ") || "–"], ["Runtimes", (c.runtimePlugins || []).join(", ") || "–"]]
      .map(([k, v]) => `<span>${esc(k)}</span><strong>${esc(v ?? 0)}</strong>`).join("");
  }
  async function importProject(file) {
    if (!file) return;
    let data, manifest;
    try { data = await readFile(file); manifest = await (await rawPost("/api/project/inspect", data)).json(); }
    catch (error) { return toast(error.message); }
    openModal({ title: "Import project", submitLabel: "Import", danger: true, wide: true,
      html: `<div class="modal-message"><p><strong>${esc(file.name)}</strong> · exported ${esc(manifest.createdAt || "")}${manifest.projects ? ` from ${esc(Object.values(manifest.projects).join(", "))}` : ""}</p>
        <div class="detail-grid">${summary(manifest.contents)}</div>
        <p class="small">Import <strong>replaces</strong> the machine configs, rules AASX, service registry, UI workspace and installed plugins of the projects chosen above. The previous state is backed up first. Stop the stack before importing.</p>
        ${(manifest.notes || []).map(n => `<p class="small">${esc(n)}</p>`).join("")}</div>`,
      onSubmit: async () => {
        const response = await rawPost("/api/project/import", data);
        const report = await response.json();
        if (!response.ok) throw new Error(typeof report.detail === "string" ? report.detail : report.detail?.message || "Import failed");
        refreshPage(); window.gucServicePlugins?.refresh(); window.gucGatewayManagement?.refresh?.();
        const aas = report.aas?.state === "pending" ? " AAS are written when the AAS repository is reachable." : "";
        toast(`Project imported: ${report.gatewayConfigs} configs, ${report.services} services, ${(report.gatewayPlugins || []).length + (report.runtimePlugins || []).length} plugins.` + aas + " Start the stack to load it.");
      } });
  }
  async function rawPost(path, data) {
    const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/zip" }, body: data });
    if (!response.ok && path.endsWith("/inspect")) { const body = await response.json().catch(() => ({})); throw new Error(typeof body.detail === "string" ? body.detail : "Not a LABraDT project archive."); }
    return response;
  }
  async function applyProjects() {
    try {
      const r = await api("/api/stack/apply", { method: "POST" });
      const parts = ["gateway", "runtime"].map(k => `${k}: ${(r[k]?.plugins || []).length} plugin(s)${r[k]?.removed?.length ? `, removed ${r[k].removed.join(", ")}` : ""}`);
      const problems = ["gateway", "runtime"].flatMap(k => r[k]?.problems || []);
      toast("Applied to the projects · " + parts.join(" · ") + (problems.length ? " · " + problems.join("; ") : "") + (r.aas?.state === "pending" ? " · AAS still waiting for the repository" : ""));
      refreshProjects();
    } catch (error) { toast(error.message); }
  }
  $("projectExport")?.addEventListener("click", exportProject);
  $("projectImport")?.addEventListener("click", () => $("projectImportFile").click());
  $("projectImportFile")?.addEventListener("change", event => { importProject(event.target.files?.[0]); event.target.value = ""; });
  $("projectApply")?.addEventListener("click", applyProjects);
  $("projectFolders")?.addEventListener("click", event => {
    const b = event.target.closest("button"); if (!b) return;
    if (b.dataset.projectBrowse) { const p = projects?.[b.dataset.projectBrowse]?.path || ""; return showProjectFolder(b.dataset.projectBrowse, p.replace(/[\\/][^\\/]+[\\/]?$/, "") || p); }
    if (b.dataset.projectOpen) return showProjectFolder(b.dataset.projectOpen, b.dataset.path);
    if (b.dataset.projectUse) return useProject(b.dataset.projectUse, b.dataset.path);
    if (b.dataset.projectClose !== undefined) { browsing = null; renderProjects(); }
  });

  function refreshPage() { refreshProjects(); refreshOverview(); refreshConfigs(); refreshRules(); refreshEngineState(); refreshServices(); refreshExecutions(); }

  $("stackStripStart").addEventListener("click", () => stackAction("start", null));
  $("stackStripStop").addEventListener("click", () => stackAction("stop"));
  $("stackStripOpen").addEventListener("click", () => { setTab("systemTab"); location.hash = "system"; refreshPage(); });
  document.querySelector('.nav button[data-nav="system"]').addEventListener("click", () => refreshPage());
  $("stackStartAll").addEventListener("click", () => stackAction("start", $("stackBuildFirst").checked ? true : null));
  $("stackStopAll").addEventListener("click", () => stackAction("stop"));
  $("stackRefresh").addEventListener("click", () => { refreshPage(); toast("System status refreshed."); });
  $("stackInstallConfig").addEventListener("click", () => openInstallConfig());
  $("stackBrowseMachine").addEventListener("click", openBrowseMachine);
  $("stackAddRule").addEventListener("click", () => openRule(null));
  $("stackVerifyAasx").addEventListener("click", async () => {
    try {
      const result = await api("/api/stack/engine/aasx/verify", { method: "POST" });
      showText("AASX verification", [`AASX readable – ${result.count} rule(s):`, ...result.rules.map(r => `  ${r.id}: ${r.targetElement} ${r.condition} ${r.threshold}  →  ${r.action}`), "", result.problems.length ? "Problems:\n" + result.problems.map(p => "  ✗ " + p).join("\n") : "No problems found."].join("\n"));
    } catch (error) { toast(error.message); }
  });
  $("stackBackupAasx").addEventListener("click", async () => { try { const r = await api("/api/stack/engine/aasx/backup", { method: "POST" }); toast("Backup created: " + r.backup); refreshRules(); } catch (error) { toast(error.message); } });
  $("stackEngineInit").addEventListener("click", async () => { try { engineOutput((await api("/api/stack/engine/initialize", { method: "POST" })).message); } catch (error) { engineOutput(error.message); } refreshEngineState(); });
  $("stackEngineShutdown").addEventListener("click", () => confirmAction("Shutdown engine", "Shut down the Engine state chart? The Spring Boot process keeps running; use Initialize to start it again.", "Shutdown", async () => { engineOutput((await api("/api/stack/engine/shutdown", { method: "POST" })).message); refreshEngineState(); }));
  $("stackEngineHistory").addEventListener("click", async () => { try { engineOutput((await api("/api/stack/engine/history")).history || "(no transitions yet)"); } catch (error) { engineOutput(error.message); } });
  $("stackEngineData").addEventListener("click", async () => { try { engineOutput((await api("/api/stack/engine/submodel-data")).data || "(no data)"); } catch (error) { engineOutput(error.message); } });
  $("stackRegisterService").addEventListener("click", openRegister);
  $("stackTriggerServices").addEventListener("click", () => selectedServices.size && openTrigger([...selectedServices]));
  $("stackServiceGuide").addEventListener("click", openNestedGuide);
  $("stackLookupForm").addEventListener("submit", event => { event.preventDefault(); const id = $("stackLookupId").value.trim(); if (id) showResult(id).catch(error => toast(error.message)); });

  $("systemTab").addEventListener("click", event => {
    const t = event.target.closest("button"); if (!t) return;
    const d = t.dataset;
    if (d.stackStart) startComponent(d.stackStart);
    else if (d.stackStop) stopComponent(d.stackStop);
    else if (d.stackForce) forceStop(d.stackForce);
    else if (d.stackLogs) showLogs(d.stackLogs);
    else if (d.stackConfigOpen) { setTab("gatewayTab"); const select = $("gatewayConfigSelect"); const option = [...select.options].find(o => o.textContent.includes(d.stackConfigOpen)); if (option) { select.value = option.value; select.dispatchEvent(new Event("change")); } }
    else if (d.stackConfigRemove) confirmAction("Remove machine config", `Remove <strong>${esc(d.stackConfigRemove)}</strong> from the gateway project? Rules and bindings that use its signals stop receiving values after the next Gateway restart.`, "Remove", async () => { await api("/api/stack/gateway/configs/" + encodeURIComponent(d.stackConfigRemove), { method: "DELETE" }); toast("Config removed."); refreshConfigs(); });
    else if (d.stackCredClear) api("/api/stack/gateway/credentials", { method: "POST", body: { name: d.stackCredClear, value: null } }).then(() => { toast(d.stackCredClear + " cleared."); refreshConfigs(); }).catch(error => toast(error.message));
    else if (d.stackRuleEdit) openRule(d.stackRuleEdit);
    else if (d.stackRuleDelete) confirmAction("Delete rule", `Delete <strong>${esc(d.stackRuleDelete)}</strong> from the AASX? Create a backup first if you may need it again.`, "Delete", async () => { await api("/api/stack/engine/rules/" + encodeURIComponent(d.stackRuleDelete), { method: "DELETE" }); toast(d.stackRuleDelete + " removed from the AASX · Initialize the Engine to apply."); refreshRules(); });
    else if (d.stackSvcView) api("/api/stack/services/" + encodeURIComponent(d.stackSvcView)).then(s => showText("Service " + d.stackSvcView, JSON.stringify(s, null, 2))).catch(error => toast(error.message));
    else if (d.stackSvcRun) openTrigger([d.stackSvcRun]);
    else if (d.stackSvcDelete) deleteService(d.stackSvcDelete);
    else if (d.stackExecStop) confirmAction("Stop execution", `Stop <strong>${esc(d.service)}</strong> (${esc(d.stackExecStop.slice(0, 8))})?`, "Stop", async () => { const r = await api("/api/stack/services/stop?executionId=" + encodeURIComponent(d.stackExecStop), { method: "POST" }); toast(r?.message || "Service stopped."); refreshExecutions(); });
    else if (d.stackExecView) showResult(d.stackExecView).catch(error => toast(error.message));
  });
  $("systemTab").addEventListener("change", event => {
    const id = event.target.dataset.stackSvcPick; if (!id) return;
    event.target.checked ? selectedServices.add(id) : selectedServices.delete(id);
    $("stackTriggerServices").disabled = !selectedServices.size;
  });
  $("systemTab").addEventListener("submit", event => {
    const form = event.target.closest("[data-stack-cred]"); if (!form) return;
    event.preventDefault();
    const value = form.querySelector("input").value;
    if (!value) return toast("Enter a value first.");
    api("/api/stack/gateway/credentials", { method: "POST", body: { name: form.dataset.stackCred, value } })
      .then(r => { toast(r.name + " set" + (r.restartRequired ? " · restart the Gateway to use it." : " · used at the next Gateway start.")); refreshConfigs(); }).catch(error => toast(error.message));
  });

  refreshOverview();
  if (visible()) refreshPage();
  setInterval(() => { refreshOverview(); if (visible()) { refreshEngineState(); refreshExecutions(); } }, 3000);
  root.gucStackControl = { refresh: refreshPage, overview: () => overview };
})(window);
