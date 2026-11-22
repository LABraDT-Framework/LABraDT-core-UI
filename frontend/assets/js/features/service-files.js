// Services: browsable "File / Endpoint" field and the packaging step of a registration.
// The chooser lists files and folders on the computer running the UI controller (/api/stack/files);
// on save the controller turns the chosen path into what the runtime executes (/api/stack/services/prepare).
(function (root) {
  "use strict";
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const FOLDER_KEY = "labradt-ui:service-file-folder";
  const SPECS = {
    LUA: { browse: true, folders: true, accept: [".lua"], placeholder: "Folder with main.lua, or a .lua script",
      hint: "A .lua script, or a folder with main.lua (or init.lua). The other .lua files of the folder become modules for require(); the UI bundles everything into one script in the Engine storage." },
    BASH: { browse: true, folders: false, accept: [".sh"], placeholder: "Shell script (.sh)", hint: "One shell script; it is stored in the Engine storage." },
    CONTAINER: { browse: true, folders: true, accept: ["dockerfile", ".dockerfile", "containerfile", ".tar", ".tar.gz", ".tgz"], placeholder: "Folder with a Dockerfile, a Dockerfile or an image archive (.tar)",
      hint: "Needs Docker installed on this computer. A folder is built with docker build (the whole folder is the build context) and the service runs that image. An image archive (.tar, from docker save) is loaded with docker load. A single Dockerfile is stored and built by the runtime." },
    PYTHON: { browse: true, folders: true, filesHidden: true, accept: [".py"], placeholder: "Folder with main.py",
      hint: "A folder with main.py (optional requirements.txt). It runs in a container built from python:3.12-slim, so it needs the Docker service plugin and Docker on this computer. Service arguments arrive as environment variables; what main.py prints is the result." },
    REST: { browse: false, placeholder: "https://host/api/endpoint", hint: "The URL of the external endpoint (or set defaultArgs.url)." }
  };
  const PYTHON_RUNNER = { browse: true, folders: true, accept: [".py"], placeholder: "Folder with main.py, or a .py script",
    hint: "Runs with the Python runtime (SCRIPT/PYTHON) on the Runtime's own Python. A .py script is stored as is; a folder with main.py is packed with its modules and data (up to 1 MB) into the Engine storage. Packages from requirements.txt must be installed into that Python. Service arguments arrive as environment variables; what the script prints is the result." };
  const SCRIPT_PLUGIN = { browse: true, folders: false, accept: [], placeholder: "Script file for this runtime",
    hint: "A script language added by a runtime plugin: choose one script file; it is stored in the Engine storage and handed to the runtime. A URL or other value is passed on as entered." };
  const GENERIC = { browse: true, folders: true, accept: [], placeholder: "Path, URL or any value the plugin expects",
    hint: "This runtime comes from a plugin. The value is passed on exactly as entered: a path, a URL or any string." };
  const runtimeOf = type => { try { return serviceRuntimeTypes[type] || null; } catch { return null; } };
  const spec = type => {
    const runtime = runtimeOf(type);
    if (type === "PYTHON" && runtime?.adapter === "PYTHON") return PYTHON_RUNNER;
    if (SPECS[type]) return SPECS[type];
    return runtime?.category === "SCRIPT" ? SCRIPT_PLUGIN : GENERIC;
  };

  async function call(path, method = "GET", body) {
    const response = await fetch(path, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    const payload = (response.headers.get("content-type") || "").includes("application/json") ? await response.json() : await response.text();
    if (!response.ok) throw new Error(typeof payload?.detail === "string" ? payload.detail : payload?.detail?.message || String(payload));
    return payload;
  }

  const folderIcon = '<svg class="icon folder-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/></svg>';
  const fileIcon = '<svg class="icon folder-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/></svg>';

  // Adds Browse… + a per-runtime hint + an inline chooser below a text input.
  function attach(input, getType) {
    if (!input || input.dataset.fileChooser) return { update() {} };
    input.dataset.fileChooser = "1";
    input.spellcheck = false;
    const tools = document.createElement("div");
    tools.className = "file-field";
    tools.innerHTML = '<button type="button" class="btn ghost file-browse">Browse…</button><span class="small file-hint"></span><div class="folder-browser file-chooser" hidden></div>';
    input.insertAdjacentElement("afterend", tools);
    const button = tools.querySelector(".file-browse"), hint = tools.querySelector(".file-hint"), chooser = tools.querySelector(".file-chooser");
    let current = "";

    function update() {
      const s = spec(getType());
      button.hidden = !s.browse; hint.textContent = s.hint; input.placeholder = s.placeholder;
      if (!s.browse) chooser.hidden = true;
    }
    async function show(path) {
      const s = spec(getType());
      try {
        const listing = await call("/api/stack/files?path=" + encodeURIComponent(path || "") + "&accept=" + encodeURIComponent(s.filesHidden ? "-" : (s.accept || []).join(",")));
        current = listing.path; chooser.hidden = false;
        if (listing.path) root.localStorage?.setItem(FOLDER_KEY, listing.path);
        const useFolder = s.folders && listing.path ? `<button type="button" class="btn primary" data-file-use="${esc(listing.path)}">Use this folder</button>` : "";
        chooser.innerHTML = `<div class="folder-head"><button type="button" class="btn ghost" data-file-open="${esc(listing.parent ?? "")}" ${listing.parent === null ? "disabled" : ""}>↑ Up</button><code title="${esc(listing.path)}">${esc(listing.path || "Computer")}</code>${useFolder}</div>`
          + (listing.contains?.length ? `<p class="small folder-hit">This folder contains ${listing.contains.map(esc).join(", ")}.</p>` : "")
          + `<ul class="folder-list">${listing.entries.map(e => e.type === "dir"
            ? `<li><button type="button" class="folder-entry" data-file-open="${esc(e.path)}">${folderIcon}<span>${esc(e.name)}</span></button>${(e.contains || []).map(c => `<span class="badge draft">${esc(c)}</span>`).join("")}${s.folders && (e.contains || []).length ? `<button type="button" class="link-btn" data-file-use="${esc(e.path)}">Use</button>` : ""}</li>`
            : `<li><button type="button" class="folder-entry" data-file-use="${esc(e.path)}">${fileIcon}<span>${esc(e.name)}</span></button><span class="small">${Math.max(1, Math.round((e.size || 0) / 1024))} KB</span></li>`).join("") || '<li class="small">Nothing to choose here.</li>'}</ul>`;
      } catch (error) {
        if (path && path !== "~") return show("~"); // e.g. the remembered folder is gone
        root.showToast?.(error.message);
      }
    }
    button.addEventListener("click", () => {
      if (!chooser.hidden) { chooser.hidden = true; return; }
      // Always opens the chooser: at the typed path when it is one (the controller shows its folder, or the
      // closest existing parent), otherwise at the last folder used, otherwise at the home folder.
      const typed = input.value.trim();
      const isPath = /^([a-zA-Z]:[\\/]|\\\\|\/|~)/.test(typed);
      show(isPath ? typed : (current || root.localStorage?.getItem(FOLDER_KEY) || "~"));
    });
    chooser.addEventListener("click", event => {
      const target = event.target.closest("button"); if (!target) return;
      if (target.dataset.fileOpen !== undefined) show(target.dataset.fileOpen);
      if (target.dataset.fileUse !== undefined) { input.value = target.dataset.fileUse; chooser.hidden = true; input.dispatchEvent(new Event("input", { bubbles: true })); }
    });
    update();
    return { update };
  }

  // Runs the packaging job for a service registration (Backend only). Returns null when nothing had to be done.
  async function prepare(data, onStep = () => {}) {
    if (!root.GucEnvironment?.isBackend) return null;
    const value = String(data.file || "").trim();
    if (!value || value.startsWith("[image]") || value === "[inline Lua]") return null;
    let job = await call("/api/stack/services/prepare", "POST", { runtimeType: data.runtimeType, value, serviceId: data.id });
    while (job.state === "running") {
      onStep(job);
      await new Promise(resolve => setTimeout(resolve, 1000));
      job = await call("/api/stack/services/prepare/" + encodeURIComponent(job.id));
    }
    onStep(job);
    if (job.state === "failed") { const error = new Error(job.message); error.log = job.logTail; throw error; }
    return job.result;
  }

  function apply(data, result) {
    if (!result || result.action === "keep") return data;
    const args = (() => { try { return JSON.parse(data.defaultArgs || "{}"); } catch { return {}; } })();
    Object.assign(args, result.defaultArgs || {});
    if (result.defaultArgs?.image) delete args.testContent;
    return { ...data, file: result.fileReference || (result.defaultArgs?.image ? "[image] " + result.defaultArgs.image : ""), defaultArgs: JSON.stringify(args, null, 2),
      ...(result.category ? { category: result.category, adapter: result.adapter } : {}) };
  }

  // Progress box inside the open modal while a package is prepared.
  function progress(host) {
    let box = host.querySelector(".package-progress");
    if (!box) { box = document.createElement("div"); box.className = "package-progress"; host.append(box); }
    return job => {
      box.className = "package-progress " + (job.state || "running");
      box.innerHTML = `<strong>${esc(job.state === "failed" ? "Preparing failed" : job.state === "done" ? job.message : job.step || "Preparing…")}</strong>${job.logTail ? `<pre class="empty-note">${esc(job.logTail)}</pre>` : ""}`;
      const pre = box.querySelector("pre"); if (pre) pre.scrollTop = pre.scrollHeight;
    };
  }

  root.GucServiceFiles = { attach, prepare, apply, progress, spec };
})(window);
