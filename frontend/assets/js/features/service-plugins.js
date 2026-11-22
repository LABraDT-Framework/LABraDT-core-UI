// Runtimes (runtime-plugins): the plugins that execute services of one technology.
// A technology is a fixed category (SCRIPT, CONTAINER, EXTERNAL) plus an adapter inside it (LUA, PYTHON, DOCKER, REST, ...).
// The Service Registry holds service instances; each names the runtime it needs. Backend runtime types come only from
// installed runtimes. "Add Service Plugin" installs a runtime from a plugin project folder or a built JAR.
(function (root) {
  "use strict";
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  // runtime-type key and label of the built-in adapters (the key selects the File / Endpoint behaviour in service-files.js)
  const TYPE_OF_ADAPTER = { LUA: ["LUA", "Lua"], BASH: ["BASH", "Bash"], DOCKER: ["CONTAINER", "Container"], REST: ["REST", "REST"], PYTHON: ["PYTHON", "Python"] };
  const CATEGORIES = [
    ["SCRIPT", "Scripts run inside the Runtime (Lua, Bash, Python, …)"],
    ["CONTAINER", "Services packaged as container images"],
    ["EXTERNAL", "Services that already run elsewhere and are called (REST, …)"]
  ];
  const FOLDER_KEY = "labradt-ui:runtime-plugin-folder";

  async function call(path, method = "GET", body) {
    const response = await fetch(path, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    const payload = (response.headers.get("content-type") || "").includes("application/json") ? await response.json() : await response.text();
    if (!response.ok) throw new Error(typeof payload?.detail === "string" ? payload.detail : payload?.detail?.message || String(payload));
    return payload;
  }

  const fileToBase64 = file => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] || "");
    reader.onerror = () => reject(reader.error || new Error("Could not read the file"));
    reader.readAsDataURL(file);
  });

  // Runtime groups (category → adapters) from a runtime-types map; shared by the Overview and the Services tab.
  function runnerGroups(types, instances = []) {
    const runtimes = Object.entries(types || {}).map(([key, t]) => ({ key, ...t }));
    return CATEGORIES.map(([category, text]) => ({
      category, text,
      runtimes: runtimes.filter(r => r.category === category).map(r => ({ ...r, uses: instances.filter(s => s.adapter === r.adapter && s.category === r.category).length }))
    }));
  }
  function renderRunnerGroups(types, instances, { compact = false, emptyText = "" } = {}) {
    const groups = runnerGroups(types, instances);
    if (!groups.some(g => g.runtimes.length)) return `<div class="small">${esc(emptyText || "No runtimes installed: add a service plugin (e.g. Lua, Python, Docker, REST) to run services.")}</div>`;
    return groups.map(group => `<div class="runner-group${compact ? " compact" : ""}"><div class="runner-group-head"><strong>${esc(group.category)}</strong>${compact ? "" : `<span class="small">${esc(group.text)}</span>`}</div>
      <div class="runner-chips">${group.runtimes.map(r => {
        const status = r.source === "plugin" ? r.status || "Installed" : r.source === "demo" ? "Demo" : "Bundled";
        const tone = r.source === "plugin" ? (status === "Loaded" ? "" : "warning") : r.source === "demo" ? "warning" : "draft";
        const title = `${r.label} · ${group.category} / ${r.adapter}${r.via ? " · via " + r.via : ""}${r.uses ? ` · ${r.uses} service instance(s)` : ""}`;
        return `<span class="runner-chip" title="${esc(title)}"><code>${esc(group.category)} / ${esc(r.adapter)}</code><span class="runner-label">${esc(r.label)}${r.via ? ` <span class="small">via ${esc(r.via)}</span>` : ""}</span>${r.uses ? `<span class="small">${r.uses} svc</span>` : ""}<span class="badge ${tone}">${esc(status)}</span></span>`;
      }).join("") || '<span class="small runner-none">No runtime</span>'}</div></div>`).join("");
  }

  function init({ toast }) {
    let state = { installed: [], job: { state: "idle" }, docker: false }, signature = "", checked = null, jobTimer = null, available = null;

    function runtimeTypes() {
      const types = {};
      for (const plugin of state.installed) {
        const [key, label] = TYPE_OF_ADAPTER[plugin.adapter] || [plugin.adapter, plugin.name || plugin.adapter];
        types[key] = { category: plugin.category, adapter: plugin.adapter, label, backend: true, source: "plugin", status: plugin.status, pluginId: plugin.id, kind: plugin.kind };
      }
      if (types.CONTAINER && !types.PYTHON) types.PYTHON = { category: "CONTAINER", adapter: "DOCKER", label: "Python (container)", backend: true, source: "plugin", status: types.CONTAINER.status, via: "Docker runtime" };
      return types;
    }
    function apply() {
      const next = runtimeTypes(), key = JSON.stringify(next);
      if (key === signature) return;
      signature = key;
      serviceRuntimeTypes = next; // shared state (app/state.js)
      renderServices();
    }
    async function refresh() {
      try { state = await call("/api/stack/runtime/plugins"); available = true; } catch { available = false; return; }
      apply(); if (host.classList.contains("open")) renderDialog();
    }

    // ── dialog ────────────────────────────────────────────────────────────
    const host = document.createElement("div");
    host.id = "servicePluginWizard"; host.className = "modal-backdrop"; host.setAttribute("aria-hidden", "true");
    host.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="servicePluginTitle"><div class="modal-head"><h2 id="servicePluginTitle">Service Plugins (runtimes)</h2><button class="btn icon-only" type="button" data-close aria-label="Close">×</button></div>
      <div class="modal-body">
        <p class="small">A runtime executes services of one technology: a fixed category (SCRIPT, CONTAINER or EXTERNAL) and a language or tool inside it, e.g. SCRIPT / LUA or SCRIPT / PYTHON. Registered services are instances that name their runtime.</p>
        <h3 class="plugin-source-title">Add a runtime</h3>
        <p class="small">Choose a runtime plugin <strong>project folder</strong> (with its pom.xml, e.g. from runtime-plugins: Lua, Python, Bash, Docker, REST, or your own) or a built plugin <strong>.jar</strong>. A project is built with Maven; a JAR's dependencies are resolved from its Maven metadata. The JARs go on the Service Manager classpath; nothing in the plugin is changed. Restart the Runtime afterwards. A new language appears as its own technology (e.g. SCRIPT / RUBY) when the plugin defines it with <code>TechnologyAdapter.define("RUBY", ExecutionCategory.SCRIPT)</code>.</p>
        <div class="plugin-path-row"><input id="servicePluginPath" placeholder="Runtime plugin project folder, or a plugin .jar" autocomplete="off" spellcheck="false" aria-label="Runtime plugin project folder or JAR file"><button type="button" class="btn ghost" data-sp-browse>Browse…</button><button type="button" class="btn ghost" data-sp-upload>Upload JAR…</button><button type="button" class="btn blue" data-sp-check>Check</button></div>
        <input type="file" id="servicePluginUpload" accept=".jar,application/java-archive" hidden>
        <div class="folder-browser" id="servicePluginBrowser" hidden></div>
        <div id="servicePluginInfo"></div>
        <pre class="empty-note plugin-job-log" id="servicePluginLog" hidden></pre>
        <p role="alert" class="management-error" id="servicePluginError"></p>
        <h3 class="plugin-source-title">Installed runtimes</h3><div id="servicePluginInstalled"></div>
      </div>
      <div class="modal-actions"><button class="btn primary" type="button" data-close>Close</button></div></div>`;
    document.body.append(host);
    const $ = id => host.querySelector("#" + id);
    const pathInput = $("servicePluginPath"), browser = $("servicePluginBrowser"), info = $("servicePluginInfo"), log = $("servicePluginLog"), error = $("servicePluginError"), upload = $("servicePluginUpload");
    const folderIcon = '<svg class="icon folder-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/></svg>';
    const jarIcon = '<svg class="icon folder-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M7 3h10v4H7z"/><path d="M6 7h12v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1z"/><path d="M9 12h6"/></svg>';

    function renderDialog() {
      const uses = adapter => (typeof services !== "undefined" ? services : []).filter(s => s.adapter === adapter).length;
      $("servicePluginInstalled").innerHTML = state.installed.length ? state.installed.map(p => `<div class="gateway-plugin plugin-project"><div class="section-head"><strong>${esc(p.category)} / ${esc(p.adapter)} · ${esc(p.name)}</strong><span class="badge ${p.status === "Loaded" ? "" : "warning"}">${esc(p.status)}</span></div><div class="small">${p.kind === "jar" ? "JAR" : "project"} <code>${esc(p.projectName)}</code> · ${esc((p.jars || []).length)} JARs${uses(p.adapter) ? ` · used by ${uses(p.adapter)} service instance(s)` : ""}</div><p class="small">${esc(p.message || "")}${p.adapter === "DOCKER" && !state.docker ? " Docker was not found on this computer: install it before running container services." : ""}</p><button type="button" class="btn danger" data-sp-remove="${esc(p.id)}">Uninstall runtime</button></div>`).join("")
        : '<div class="empty-note">No runtimes installed. Without a runtime the Service Manager cannot run any service.</div>';
      const job = state.job || {}, busy = job.state === "running";
      log.hidden = !job.logTail || job.state === "idle";
      log.textContent = job.state === "failed" ? "Install failed: " + job.message + "\n\n" + (job.logTail || "") : job.state === "done" ? job.message + "\n\n" + (job.logTail || "") : job.logTail || "";
      if (!log.hidden) log.scrollTop = log.scrollHeight;
      const clash = checked && !checked.installed && state.installed.find(p => p.adapter === checked.adapter);
      info.innerHTML = checked ? `<div class="gateway-plugin plugin-project"><div class="section-head"><strong>${esc(checked.category)} / ${esc(checked.adapter)} · ${esc(checked.name)}</strong><span class="badge ${checked.installed ? "" : "draft"}">${checked.installed ? "Installed" : clash ? "Adapter taken" : "New technology"}</span></div><div class="small">${checked.kind === "jar" ? "JAR" : "Project"} <code>${esc(checked.projectName)}</code> · artifact <code>${esc(checked.artifact)}</code></div>${checked.summary ? `<p class="small">${esc(checked.summary)}</p>` : ""}${clash ? `<p class="small management-error">A ${esc(checked.adapter)} runtime is already installed (${esc(clash.projectName)}). Uninstall it first.</p>` : ""}<button class="btn primary" type="button" data-sp-install ${checked.installed || busy || clash ? "disabled" : ""}>${busy ? "Installing… " + esc(job.step || "") : checked.installed ? "Installed" : "Install " + esc(checked.category + " / " + checked.adapter)}</button></div>` : "";
    }
    async function showFolder(path) {
      try {
        const listing = await call("/api/stack/runtime/folders?path=" + encodeURIComponent(path || ""));
        browser.hidden = false;
        const home = state.startFolder || "", homeName = home.split(/[\\/]/).filter(Boolean).pop() || home;
        browser.innerHTML = `<div class="folder-head"><button type="button" class="btn ghost" data-sp-open="${esc(listing.parent ?? "")}" ${listing.parent === null ? "disabled" : ""}>↑ Up</button>${home && home !== listing.path ? `<button type="button" class="btn ghost" data-sp-open="${esc(home)}" title="${esc(home)}">⌂ ${esc(homeName)}</button>` : ""}<code title="${esc(listing.path)}">${esc(listing.path || "Computer")}</code>${listing.path ? `<button type="button" class="btn primary" data-sp-use="${esc(listing.path)}">Use this folder</button>` : ""}</div>`
          + (listing.plugin ? `<p class="small folder-hit">This folder is a ${esc(listing.plugin)} runtime plugin project.</p>` : "")
          + `<ul class="folder-list">${listing.dirs.map(d => `<li><button type="button" class="folder-entry" data-sp-open="${esc(d.path)}">${folderIcon}<span>${esc(d.name)}</span></button>${d.plugin ? `<span class="badge">${esc(d.plugin)} runtime</span><button type="button" class="link-btn" data-sp-use="${esc(d.path)}">Use</button>` : ""}</li>`).join("")}`
          + `${(listing.jars || []).map(j => `<li><button type="button" class="folder-entry" data-sp-use="${esc(j.path)}">${jarIcon}<span>${esc(j.name)}</span></button><span class="small">${Math.max(1, Math.round((j.size || 0) / 1024))} KB</span></li>`).join("")}`
          + `${!listing.dirs.length && !(listing.jars || []).length ? '<li class="small">No sub-folders or JARs.</li>' : ""}</ul>`;
      } catch (exception) {
        if (path && state.startFolder && path !== state.startFolder) return showFolder(state.startFolder); // remembered folder is gone
        error.textContent = exception.message;
      }
    }
    async function check(path) {
      error.textContent = ""; checked = null;
      const value = String(path ?? pathInput.value).trim();
      if (!value) { error.textContent = "Enter or browse to a runtime plugin project folder or a .jar."; return renderDialog(); }
      pathInput.value = value;
      try {
        checked = await call("/api/stack/runtime/plugins/inspect", "POST", { path: value });
        root.localStorage?.setItem(FOLDER_KEY, checked.kind === "jar" ? checked.path.replace(/[\\/][^\\/]*$/, "") : checked.path);
        browser.hidden = true;
      } catch (exception) { error.textContent = exception.message; }
      renderDialog();
    }
    async function uploadJar(file) {
      if (!file) return;
      error.textContent = ""; checked = null; renderDialog();
      try {
        checked = await call("/api/stack/runtime/plugins/upload", "POST", { filename: file.name, contentBase64: await fileToBase64(file) });
        pathInput.value = file.name + " (uploaded)"; browser.hidden = true;
      } catch (exception) { error.textContent = exception.message; }
      upload.value = "";
      renderDialog();
    }
    async function pollJob() {
      await refresh();
      const running = state.job?.state === "running";
      if (running && !jobTimer) jobTimer = root.setInterval(pollJob, 2000);
      if (!running && jobTimer) { root.clearInterval(jobTimer); jobTimer = null; if (state.job?.state === "done") { toast(state.job.message); if (checked) checked.installed = true; renderDialog(); } }
    }
    async function open() {
      if (available === null) await refresh();
      checked = null; error.textContent = ""; info.innerHTML = "";
      const remembered = root.localStorage?.getItem(FOLDER_KEY) || "";
      pathInput.value = remembered;
      host.classList.add("open"); host.setAttribute("aria-hidden", "false"); renderDialog();
      showFolder(remembered || state.startFolder || ""); // the folder browser opens right away (default: the runtime-plugins folder)
      pollJob();
    }
    const close = () => { host.classList.remove("open"); host.setAttribute("aria-hidden", "true"); };
    host.addEventListener("click", async event => {
      if (event.target.matches("[data-close]") || event.target === host) return close();
      const b = event.target.closest("button"); if (!b) return;
      if (b.dataset.spBrowse !== undefined) return showFolder(pathInput.value.trim().replace(/\s*\(uploaded\)$/, "").replace(/[\\/][^\\/]*\.jar$/i, "") || state.startFolder || "");
      if (b.dataset.spUpload !== undefined) return upload.click();
      if (b.dataset.spCheck !== undefined) return check();
      if (b.dataset.spOpen !== undefined) return showFolder(b.dataset.spOpen);
      if (b.dataset.spUse !== undefined) return check(b.dataset.spUse);
      if (b.dataset.spInstall !== undefined && checked) {
        error.textContent = "";
        try { await call("/api/stack/runtime/plugins/install", "POST", { path: checked.path }); await pollJob(); } catch (exception) { error.textContent = exception.message; }
      }
      if (b.dataset.spRemove) {
        try { await call("/api/stack/runtime/plugins/" + encodeURIComponent(b.dataset.spRemove), "DELETE"); toast("Runtime removed. Restart the Runtime to finish."); await refresh(); }
        catch (exception) { error.textContent = exception.message; }
      }
    });
    upload.addEventListener("change", () => uploadJar(upload.files?.[0]));
    pathInput.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); check(); } });
    document.addEventListener("keydown", event => { if (event.key === "Escape" && host.classList.contains("open")) close(); });

    refresh();
    const timer = root.setInterval(refresh, 5000);
    root.addEventListener("pagehide", () => root.clearInterval(timer), { once: true });
    return { open, refresh, snapshot: () => state };
  }

  root.GucServicePlugins = { init, runnerGroups, renderRunnerGroups, CATEGORIES };
})(window);
