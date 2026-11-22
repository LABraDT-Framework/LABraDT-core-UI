(function (root) {
    "use strict";
    const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
    function init({ model, toast }) {
        let catalogue = null, pending = null, file = null, inspected = null, generation = 0;
        const host = document.createElement("div");
        host.id = "pluginWizard"; host.className = "modal-backdrop"; host.setAttribute("aria-hidden", "true");
        host.innerHTML = '<div class="modal" role="dialog" aria-modal="true" aria-labelledby="pluginWizardTitle"><div class="modal-head"><h2 id="pluginWizardTitle">Install Gateway Plugin</h2><button class="btn icon-only" type="button" data-close aria-label="Close">×</button></div><form><div class="modal-body"><h3 class="plugin-source-title">Plugin project folder</h3><p class="small">Choose the folder of a Gateway protocol plugin project, e.g. the MQTT plugin with its modules <code>mqtt-adapter</code> and <code>mqtt-translator</code>. Install builds it with Maven and puts its JARs on the Gateway classpath; the project itself is not changed.</p><div class="plugin-path-row"><input id="pluginProjectPath" placeholder="Folder of the plugin project" autocomplete="off" spellcheck="false" aria-label="Plugin project folder"><button type="button" class="btn ghost" id="pluginBrowseFolders">Browse…</button><button type="button" class="btn blue" id="pluginCheckFolder">Check folder</button></div><div id="pluginFolderBrowser" class="folder-browser" hidden></div><div id="pluginProjectInfo"></div><pre class="empty-note plugin-job-log" id="pluginJobLog" hidden></pre><details class="plugin-jar-upload" id="pluginJarDetails"><summary>Or upload a plugin JAR with a Gateway descriptor</summary><label class="field">Plugin JAR (max 25 MB)<input id="pluginJar" type="file" accept=".jar,application/java-archive"></label><p class="small">The package must contain the Gateway descriptor, compiled Adapter and Translator, and Spring auto-configuration. Validation checks the package; only a Gateway restart can verify Java compatibility.</p><div id="pluginReview"></div></details><p id="pluginError" role="alert" class="management-error"></p></div><div class="modal-actions"><button class="btn" type="button" data-close>Cancel</button><button class="btn primary" type="submit">Validate package</button></div></form></div>';
        document.body.append(host);
        const form = host.querySelector("form"), input = host.querySelector("#pluginJar"), submit = host.querySelector('[type="submit"]'), review = host.querySelector("#pluginReview"), error = host.querySelector("#pluginError");
        const close = () => { generation++; host.classList.remove("open"); host.setAttribute("aria-hidden", "true"); };
        let jobTimer = null, checked = null, browsing = "";
        const FOLDER_KEY = "labradt-ui:plugin-project-folder";
        const pathInput = host.querySelector("#pluginProjectPath"), browser = host.querySelector("#pluginFolderBrowser"), info = host.querySelector("#pluginProjectInfo"), log = host.querySelector("#pluginJobLog"), jarDetails = host.querySelector("#pluginJarDetails");
        async function stackJson(path, method = "GET", body) {
            const response = await fetch(path, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
            const payload = (response.headers.get("content-type") || "").includes("application/json") ? await response.json() : await response.text();
            if (!response.ok) throw Error(typeof payload?.detail === "string" ? payload.detail : payload?.detail?.message || String(payload));
            return payload;
        }
        const folderIcon = '<svg class="icon folder-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/></svg>';
        async function showFolder(path) {
            try {
                const listing = await stackJson("/api/stack/folders?path=" + encodeURIComponent(path || ""));
                browsing = listing.path;
                browser.hidden = false;
                browser.innerHTML = `<div class="folder-head"><button type="button" class="btn ghost" data-folder-open="${esc(listing.parent ?? "")}" ${listing.parent === null ? "disabled" : ""}>↑ Up</button><code title="${esc(listing.path)}">${esc(listing.path || "Computer")}</code>${listing.path ? `<button type="button" class="btn primary" data-folder-use="${esc(listing.path)}">Use this folder</button>` : ""}</div>`
                    + (listing.plugin ? `<p class="small folder-hit">This folder is a ${esc(listing.plugin)} plugin project.</p>` : "")
                    + `<ul class="folder-list">${listing.dirs.map(d => `<li><button type="button" class="folder-entry" data-folder-open="${esc(d.path)}">${folderIcon}<span>${esc(d.name)}</span></button>${d.plugin ? `<span class="badge">${esc(d.plugin)} plugin</span><button type="button" class="link-btn" data-folder-use="${esc(d.path)}">Use</button>` : ""}</li>`).join("") || '<li class="small">No sub-folders.</li>'}</ul>`;
            } catch (exception) { error.textContent = exception.message; }
        }
        function renderInfo() {
            const job = jobStatus || {}, busy = job.state === "running";
            if (!checked) { info.innerHTML = ""; return; }
            info.innerHTML = `<div class="gateway-plugin plugin-project"><div class="section-head"><strong>${esc(checked.name)}</strong><span class="badge ${checked.installed ? "" : "draft"}">${checked.installed ? "Installed" : esc(checked.protocol)}</span></div><div class="small">Project <code>${esc(checked.projectName)}</code> · modules ${checked.modules.map(esc).join(", ")}</div>${checked.summary ? `<p class="small">${esc(checked.summary)}</p>` : ""}<button class="btn primary" type="button" data-install-plugin ${checked.installed || busy ? "disabled" : ""}>${busy ? "Installing… " + esc(job.step || "") : checked.installed ? "Installed" : "Install " + esc(checked.name)}</button></div>`;
        }
        let jobStatus = null;
        function renderJob() {
            const job = jobStatus || {};
            log.hidden = !job.logTail || job.state === "idle";
            log.textContent = job.state === "failed" ? "Install failed: " + job.message + "\n\n" + (job.logTail || "") : job.state === "done" ? job.message + "\n\n" + (job.logTail || "") : job.logTail || "";
            if (!log.hidden) log.scrollTop = log.scrollHeight;
            renderInfo();
        }
        async function refreshJob() {
            try { jobStatus = (await stackJson("/api/stack/gateway/plugins")).job; } catch { jobStatus = null; }
            const running = jobStatus?.state === "running";
            if (running && !jobTimer) jobTimer = root.setInterval(refreshJob, 2000);
            if (!running && jobTimer) {
                root.clearInterval(jobTimer); jobTimer = null; refresh();
                if (jobStatus?.state === "done") { toast(jobStatus.message); if (checked) checked.installed = true; }
            }
            renderJob();
        }
        async function checkFolder(path) {
            error.textContent = ""; checked = null; renderInfo();
            const value = String(path ?? pathInput.value).trim();
            if (!value) { error.textContent = "Enter or browse to the plugin project folder."; return; }
            pathInput.value = value;
            try { checked = await stackJson("/api/stack/gateway/plugins/inspect", "POST", { path: value }); root.localStorage?.setItem(FOLDER_KEY, checked.path); browser.hidden = true; }
            catch (exception) { error.textContent = exception.message; }
            renderInfo();
        }
        function open() {
            if (root.GucEnvironment.isDemo && root.GucEnvironment.demoRunning) return toast("Stop Demo before installing plugins.");
            generation++; file = inspected = null; input.value = ""; input.disabled = false; review.innerHTML = ""; error.textContent = ""; submit.disabled = false; submit.textContent = "Validate package";
            checked = null; browser.hidden = true; info.innerHTML = ""; jarDetails.open = false; submit.hidden = true;
            pathInput.value = root.localStorage?.getItem(FOLDER_KEY) || "";
            host.classList.add("open"); host.setAttribute("aria-hidden", "false"); refreshJob(); pathInput.focus();
        }
        function protocols() {
            const installed = catalogue ? catalogue.plugins.filter(p => p.source !== "removed").map(p => p.protocol) : [];
            return ["MQTT", ...installed.filter(p => p !== "MQTT")];
        }
        function render() {
            const plugins = catalogue?.plugins || [], offline = !root.GucEnvironment.hasLiveGateway;
            document.getElementById("pluginCatalog").innerHTML = plugins.map(p => `<div class="gateway-plugin" data-plugin-id="${esc(p.id)}"><div class="section-head"><strong>${esc(p.name || p.id)}</strong><span class="badge ${p.status === "Loaded" ? "" : "warning"}">${esc(p.status)}</span></div><div class="small"><code>${esc(p.id)}</code> · ${esc(p.protocol)} · ${esc(p.version || "")} · ${esc(p.source)}</div><p class="small">${esc(p.message || "")}</p><div class="small">Connections: ${p.references?.length ? p.references.map(r => esc(r.machineId) + (r.enabled ? "" : " (disabled)")).join(", ") : "None"}</div>${p.source === "project" ? `<div class="small">Project <code>${esc(p.projectName || p.key || "")}</code> · ${esc((p.jars || []).length)} JARs on the Gateway classpath</div>` : ""}${["installed", "project"].includes(p.source) ? `<button class="btn danger plugin-delete" data-plugin-id="${esc(p.id)}">Uninstall plugin</button>` : p.source === "bundled" ? '<span class="small">Bundled module · protected from uninstall</span>' : ""}</div>`).join("") || '<div class="empty-note">No Gateway plugins installed yet. Click <strong>Add GW Plugin</strong> and choose the folder of a protocol plugin project (e.g. the MQTT plugin).</div>';
            document.getElementById("overviewGatewayPlugins").innerHTML = plugins.map(p => `<div class="technology-item"><div class="technology-item-copy"><strong>${esc(p.name || p.id)}</strong><span class="small">${esc(p.protocol)} · ${esc(p.id)}</span></div><span class="badge ${p.status === "Loaded" ? "" : "warning"}">${esc(p.status)}</span></div>`).join("") || '<div class="small">No Gateway plugins installed.</div>';
            const select = document.getElementById("gatewayProtocol"), selected = select.value;
            const available = protocols(); if (selected && !available.includes(selected)) available.push(selected);
            select.innerHTML = available.map(p => `<option${p === selected ? " selected" : ""}>${esc(p)}</option>`).join("");
            if (!select.value) select.value = available[0] || "";
            const plugin = plugins.find(p => p.protocol === select.value && p.source !== "removed");
            document.getElementById("connectionPluginInfo").textContent = plugin ? `Selected plugin: ${plugin.name} (${plugin.id}) · ${plugin.status}. The endpoint specifies the device; the plugin implements its protocol.` : `No ${select.value || "protocol"} plugin installed yet · add it under Gateway Java Client Plugins before the Gateway can connect.`;
            const status = document.getElementById("gatewayManagementStatus");
            status.textContent = offline ? "Browser simulation · no Java plugins installed" : !catalogue ? "Checking loaded configuration…" : !catalogue.runtimeAvailable ? "Gateway stopped" : catalogue.restartRequired ? "Restart required" : "Gateway changes applied";
            status.className = "badge " + (catalogue?.runtimeAvailable && !catalogue.restartRequired ? "" : "warning");
            document.getElementById("gatewayRestartHint").textContent = offline ? "Open the Docker-hosted UI to install and load Java plugins." : catalogue?.message || "After a plugin or active connection change, restart only this environment’s Gateway, then check applied state. Stop automatic execution before editing.";
            document.getElementById("gatewayRestartCommand").textContent = catalogue?.restartCommand || `docker compose -p ui_v09 restart ${root.GucEnvironment.isDemo ? "demo-gateway" : "gateway"}`;
            const locked = root.GucEnvironment.isDemo && root.GucEnvironment.demoRunning;
            for (const id of ["addGatewayPlugin", "addGatewayPluginPage"]) document.getElementById(id).disabled = offline || locked;
            for (const button of document.querySelectorAll(".plugin-delete")) button.disabled = locked;
        }
        async function refresh() {
            if (pending) return pending;
            pending = (async () => {
                try { catalogue = await root.apiRequest("/api/gateway/management/status"); model.setGatewayPlugins?.(catalogue.plugins.filter(p => p.source !== "removed")); }
                catch (exception) { catalogue = { plugins: catalogue?.plugins || [], runtimeAvailable: false, message: exception.message }; }
                render();
            })().finally(() => pending = null);
            return pending;
        }
        host.addEventListener("click", async event => {
            if (event.target.matches("[data-close]")) return close();
            const target = event.target.closest("button");
            if (!target) return;
            if (target.id === "pluginBrowseFolders") return showFolder(pathInput.value.trim() || browsing || (await stackJson("/api/stack/gateway/plugins").catch(() => ({}))).startFolder || "");
            if (target.id === "pluginCheckFolder") return checkFolder();
            if (target.dataset.folderUse !== undefined) return checkFolder(target.dataset.folderUse);
            if (target.dataset.folderOpen !== undefined) return showFolder(target.dataset.folderOpen);
            if (target.dataset.installPlugin !== undefined && checked) {
                error.textContent = "";
                try { await stackJson("/api/stack/gateway/plugins/install", "POST", { path: checked.path }); await refreshJob(); }
                catch (exception) { error.textContent = exception.message; }
            }
        });
        pathInput.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); checkFolder(); } });
        pathInput.addEventListener("input", () => { checked = null; renderInfo(); });
        jarDetails.addEventListener("toggle", () => { submit.hidden = !jarDetails.open; });
        document.addEventListener("keydown", event => { if (event.key === "Escape" && host.classList.contains("open")) close(); });
        input.addEventListener("change", () => { inspected = null; review.innerHTML = ""; error.textContent = ""; submit.textContent = "Validate package"; });
        form.addEventListener("submit", async event => {
            event.preventDefault(); const active = generation; submit.disabled = true; error.textContent = "";
            try {
                if (!inspected) {
                    file = input.files[0];
                    if (!file || !/\.jar$/i.test(file.name) || !file.size || file.size > 25 * 1024 * 1024) throw Error("Select a non-empty .jar package no larger than 25 MB.");
                    const descriptor = await root.apiRequest("/api/gateway/plugins/inspect?filename=" + encodeURIComponent(file.name), { method: "POST", headers: { "Content-Type": "application/java-archive" }, body: file });
                    if (active !== generation) return;
                    inspected = descriptor; input.disabled = true;
                    review.innerHTML = `<div class="detail-grid"><span>Plugin</span><strong>${esc(descriptor.name)} · ${esc(descriptor.id)}</strong><span>Protocol / version</span><strong>${esc(descriptor.protocol)} / ${esc(descriptor.version)}</strong><span>Adapter</span><code>${esc(descriptor.adapterClass)}</code><span>Translator</span><code>${esc(descriptor.translatorClass)}</code><span>SHA-256</span><code class="plugin-hash">${esc(descriptor.sha256)}</code></div><p>Installation stages the JAR for the next Gateway restart.</p><label><input type="checkbox" id="pluginTrust"> I trust this package and allow its Java code to execute in Gateway.</label>`;
                    submit.textContent = "Install plugin";
                } else {
                    if (!host.querySelector("#pluginTrust").checked) throw Error("Confirm that you trust this executable Java package.");
                    await root.apiRequest("/api/gateway/plugins?confirm=true&filename=" + encodeURIComponent(file.name), { method: "POST", headers: { "Content-Type": "application/java-archive" }, body: file });
                    close(); await refresh(); toast("Plugin staged. Restart this Gateway and check applied state.");
                }
            } catch (exception) { if (active === generation) error.textContent = exception.message; }
            finally { if (active === generation) submit.disabled = false; }
        });
        for (const id of ["addGatewayPlugin", "addGatewayPluginPage"]) document.getElementById(id).addEventListener("click", open);
        document.getElementById("refreshGatewayPlugins").addEventListener("click", async () => { await refresh(); toast(catalogue.runtimeAvailable && !catalogue.restartRequired ? "Gateway changes applied." : catalogue.message || "Gateway restart required."); });
        document.getElementById("pluginCatalog").addEventListener("click", event => {
            const button = event.target.closest(".plugin-delete"); if (!button) return;
            const plugin = catalogue.plugins.find(p => p.id === button.dataset.pluginId);
            root.openConfirmModal({ title: "Uninstall Gateway Plugin", message: plugin.references.length ? `<p>Cannot uninstall ${esc(plugin.name)}. Remove these connections first (including disabled ones):</p><p>${plugin.references.map(r => esc(r.machineId)).join(", ")}</p>` : plugin.source === "project" ? `<p>Uninstall ${esc(plugin.name)}? Its JARs are removed from the Gateway classpath; the plugin project stays unchanged. Restart the Gateway to stop loading it.</p>` : `<p>Uninstall ${esc(plugin.name)}? Its package will be archived for recovery. Restart Gateway to stop loading it.</p>`, submitLabel: plugin.references.length ? "Close" : "Uninstall", onSubmit: async () => { if (plugin.references.length) return; if (plugin.source === "project") await stackJson("/api/stack/gateway/plugins/" + encodeURIComponent(plugin.id), "DELETE"); else await root.apiRequest("/api/gateway/plugins/" + encodeURIComponent(plugin.id), { method: "DELETE" }); await refresh(); toast(plugin.source === "project" ? "Plugin removed. Restart the Gateway to finish." : "Plugin archived. Restart Gateway to finish uninstalling."); } });
        });
        render(); refresh();
        const timer = root.setInterval(() => { if (!catalogue?.runtimeAvailable || !catalogue.configurationLoaded || catalogue.restartRequired) refresh(); }, 5000);
        root.addEventListener("pagehide", () => root.clearInterval(timer), { once: true });
        return { refresh, render, protocols, snapshot: () => catalogue };
    }
    root.GucPluginFlow = { init };
})(window);
