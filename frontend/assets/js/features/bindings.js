(function (root) {
    "use strict";

    const STORAGE_KEY = "guc-bindings-demo-v1";
    const DIRECTIONS = new Set(["gateway_to_aas", "aas_to_gateway", "bidirectional"]);
    const clone = value => JSON.parse(JSON.stringify(value));
    const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
    const equal = (a, b) => typeof a === "number" || typeof b === "number" ? Number(a) === Number(b) : String(a) === String(b);
    const writesToGateway = direction => ["aas_to_gateway", "bidirectional"].includes(direction);
    const accessLabel = signal => signal?.writable === true ? "Read / Write" : signal?.writable === false ? "Read only" : "Access unknown";

    function validateBinding(draft, signals, properties, existing = [], editingId = null) {
        const errors = [], id = String(draft.id || "").trim();
        const signal = signals.find(item => item.id === draft.signalId && !item.deleted);
        const property = properties.find(item => item.id === draft.propertyId);
        if (!/^[A-Za-z0-9:._-]+$/.test(id)) errors.push("Binding ID requires letters, numbers, colon, dot, underscore or hyphen.");
        if (existing.some(item => item.id === id && item.id !== editingId)) errors.push("Binding ID already exists.");
        if (editingId && id !== editingId) errors.push("Binding ID is immutable.");
        if (!signal) errors.push("Select an available Gateway signal.");
        if (!property) errors.push("Select an available AAS Property.");
        if (signal && property && signal.valueType !== property.valueType) errors.push("Gateway and AAS value types must match.");
        if (!DIRECTIONS.has(draft.direction)) errors.push("Select a supported synchronization direction.");
        if (signal?.writable === false && writesToGateway(draft.direction)) errors.push("The selected OPC UA node is read-only; choose Gateway → AAS.");
        const interval = Number(draft.intervalMs);
        if (!Number.isInteger(interval) || interval < 500 || interval > 60000) errors.push("Interval must be an integer between 500 and 60000 ms.");
        if (draft.direction === "bidirectional" && !["gateway", "aas", "manual"].includes(draft.startupAuthority)) errors.push("Choose Gateway, AAS or Manual startup authority.");
        if (signal && property && existing.some(item => item.id !== editingId && item.signalId === signal.id && item.propertyId === property.id && item.direction === draft.direction)) errors.push("An equivalent binding already exists.");
        return errors;
    }

    function planBidirectional({ initialized, startupAuthority, previousGateway, previousAas, gateway, aas }) {
        if (!initialized) {
            if (equal(gateway, aas)) return "none";
            if (startupAuthority === "gateway") return "gateway_to_aas";
            if (startupAuthority === "aas") return "aas_to_gateway";
            return "conflict";
        }
        const gatewayChanged = !equal(gateway, previousGateway), aasChanged = !equal(aas, previousAas);
        if (gatewayChanged && aasChanged) return equal(gateway, aas) ? "none" : "conflict";
        if (gatewayChanged) return "gateway_to_aas";
        if (aasChanged) return "aas_to_gateway";
        return "none";
    }

    function init({ model, liveData, getAasProperties, setDemoAasValue, toast, onChange, environment = root.GucEnvironment }) {
        if (environment?.isBackend) return root.GucBackendLinks.init({model,getAasProperties,onChange,toast});
        const storage = environment?.storage || root.localStorage;
        const dialog = document.getElementById("bindingDialog"), form = document.getElementById("bindingForm");
        // Preserve browser AAS bindings until the separate AAS backend is completed.
        let bindings = [], mode = "demo", running = false, editingId = null, timer = null;
        let paused = Boolean(environment?.isDemo && !environment.demoRunning), epoch = 0;
        const assertActive = token => { if (paused || token !== epoch) throw Error("Demo synchronization is paused."); };
        const baselines = new Map(), gatewayOverrides = new Map(), busy = new Set(), nextRuns = new Map();
        try {
            const saved = JSON.parse(storage.getItem(STORAGE_KEY) || "[]");
            if (Array.isArray(saved)) bindings = saved;
        } catch { bindings = []; }

        function properties() { return getAasProperties(); }
        function persist() { storage.setItem(STORAGE_KEY, JSON.stringify(bindings)); }
        function notifyChange() { if (typeof onChange === "function") onChange(); }
        function saveAndRender() { persist(); render(); notifyChange(); }
        function sourceBadge() {
            const badge = document.getElementById("bindingModeBadge");
            if (!badge) return;
            badge.textContent = mode === "demo" ? "Explicit Demo · browser data" : "Backend endpoints selected · unverified";
            if (mode === "demo" && environment?.hasLiveGateway) badge.textContent = "Browser AAS · live Gateway";
            badge.className = mode === "demo" ? "badge warning" : "badge draft";
        }
        function runtimeBadge() {
            const badge = document.getElementById("bindingRuntimeBadge"), button = document.getElementById("bindingRuntimeToggle");
            if (!badge || !button) return;
            badge.textContent = "Demo Sync · " + (paused ? "paused" : running ? "running" : "stopped");
            badge.className = running ? "badge warning" : "badge draft";
            button.textContent = running ? "Stop Demo Sync" : "Start Demo Sync";
            button.disabled = paused;
        }
        function directionLabel(direction) { return direction === "gateway_to_aas" ? "Gateway → AAS" : direction === "aas_to_gateway" ? "AAS → Gateway" : "Gateway ↔ AAS"; }
        function statusClass(status) { return status === "OK" ? "badge" : status === "Syncing" || status === "Conflict" ? "badge warning" : status === "Error" || status === "Invalid" ? "badge offline" : "badge draft"; }
        function bindingContext(binding) {
            const signal = model.snapshot().signals.find(item => item.id === binding.signalId && !item.deleted);
            const property = properties().find(item => item.id === binding.propertyId);
            return { signal, property };
        }
        function issuesFor(binding) {
            const draft = { ...binding };
            return validateBinding(draft, model.snapshot().signals, properties(), bindings, binding.id);
        }
        function render() {
            sourceBadge(); runtimeBadge();
            const issues = bindings.flatMap(binding => issuesFor(binding).map(message => binding.id + ": " + message));
            document.getElementById("bindingIssues").innerHTML = issues.length ? '<div class="empty-note" style="color:var(--danger)">' + issues.map(esc).join("<br>") + "</div>" : '<p class="small">No broken Gateway or AAS references. Automatic synchronization is Demo-only and stopped by default.</p>';
            document.getElementById("bindingRows").innerHTML = bindings.map(binding => {
                const { signal, property } = bindingContext(binding), invalid = issuesFor(binding).length;
                const status = invalid ? "Invalid" : binding.status || "Idle";
                return '<tr><td><strong>' + esc(binding.name || binding.id) + '</strong><div class="small"><code>' + esc(binding.id) + '</code></div></td><td>' + esc(directionLabel(binding.direction)) + '<div class="small">Startup: ' + esc(binding.startupAuthority || "—") + '</div></td><td>' + esc(signal ? signal.targetElement : "Missing signal") + '<div class="small">' + esc(signal?.valueType || "—") + ' · ' + esc(accessLabel(signal)) + '</div></td><td>' + esc(property ? (property.submodelName || property.submodelId) + " / " + property.path : "Missing Property") + '<div class="small">' + esc(property?.valueType || "—") + '</div></td><td>' + esc(binding.intervalMs) + ' ms</td><td><span class="' + statusClass(status) + '">' + esc(status) + '</span><div><strong>' + esc(binding.lastValue ?? "—") + '</strong></div><div class="small">' + esc(binding.lastSyncAt ? new Date(binding.lastSyncAt).toLocaleString() : "Never synchronized") + '</div><div class="small">' + esc(binding.message || "") + '</div></td><td><div class="row-actions"><button class="link-btn" data-binding-action="test" data-id="' + esc(binding.id) + '">Test</button><button class="link-btn" data-binding-action="read" data-id="' + esc(binding.id) + '">Read</button><button class="link-btn" data-binding-action="sync" data-id="' + esc(binding.id) + '" title="Write once according to the selected direction"' + (signal?.writable === false && writesToGateway(binding.direction) ? ' disabled' : '') + '>Write</button><button class="link-btn" data-binding-action="edit" data-id="' + esc(binding.id) + '">Edit</button><button class="link-btn" data-binding-action="delete" data-id="' + esc(binding.id) + '">Delete</button></div></td></tr>';
            }).join("") || '<tr><td colspan="7">No bindings. Add one to connect a Gateway signal and an AAS Property.</td></tr>';
            document.getElementById("bindingCount").textContent = bindings.length + " bindings";
        }

        function typed(value, valueType) { return root.GucMonitorHelpers.parseTyped(String(value), valueType); }
        async function responsePayload(response) {
            const type = response.headers.get("content-type") || "";
            return type.includes("json") ? response.json().catch(() => null) : response.text();
        }
        async function backendRequest(url, options) {
            const response = await (environment ? environment.fetch(url, options) : root.fetch(url, options)), payload = await responsePayload(response);
            if (!response.ok) throw Error(typeof payload?.detail === "string" ? payload.detail : typeof payload === "string" && payload ? payload : "Request failed (" + response.status + ").");
            return payload;
        }
        async function readGateway(signal) {
            if (mode === "backend") {
                const snapshot = await backendRequest("/api/gateway/live/snapshot"), property = snapshot?.[signal.targetElement];
                if (!property || typeof property !== "object" || !("value" in property)) throw Error("Gateway snapshot does not contain " + signal.targetElement + ".");
                const status = Array.isArray(property.qualifiers) ? property.qualifiers.find(item => item?.type === "StatusCode")?.value : "";
                if (/BAD|ERROR/i.test(String(status || ""))) throw Error("Gateway returned an abnormal data status: " + status + ".");
                return typed(property.value, signal.valueType);
            }
            if (gatewayOverrides.has(signal.id)) return gatewayOverrides.get(signal.id);
            const view = liveData.viewForSignal(signal.id);
            if (view.status !== "OK") throw Error("Gateway signal is " + view.status + ".");
            return typed(view.value, signal.valueType);
        }
        async function writeGateway(signal, value, token = epoch) {
            assertActive(token);
            if (signal.writable === false) throw Error("The OPC UA node is read-only and cannot accept Gateway writes.");
            const parsed = typed(value, signal.valueType);
            const current = liveData.viewForSignal(signal.id);
            if (current.status === "OK" && equal(current.value, parsed)) return parsed;
            if (mode === "demo" && !environment?.hasLiveGateway) {
                liveData.useDemo(false);
                gatewayOverrides.set(signal.id, parsed);
                liveData.setDemoValue(signal.id, parsed);
                return parsed;
            }
            await backendRequest("/api/gateway/live/value/" + encodeURIComponent(signal.targetElement), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(parsed) });
            assertActive(token);
            await liveData.refresh();
            return parsed;
        }
        async function readAas(property) {
            if (mode === "demo") return typed(property.value, property.valueType);
            const query = new URLSearchParams({ submodelId: property.submodelId, idShortPath: property.path });
            const value = typed(await backendRequest("/api/aas/value?" + query), property.valueType);
            setDemoAasValue(property.id, value);
            return value;
        }
        async function writeAas(property, value, token = epoch) {
            assertActive(token);
            const parsed = typed(value, property.valueType);
            if (mode === "demo") { setDemoAasValue(property.id, parsed); return parsed; }
            const query = new URLSearchParams({ submodelId: property.submodelId, idShortPath: property.path });
            await backendRequest("/api/aas/value?" + query, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(parsed) });
            assertActive(token);
            setDemoAasValue(property.id, parsed);
            return parsed;
        }
        function record(binding, action, status, value, message = "") {
            binding.status = status; binding.lastValue = value; binding.lastSyncAt = new Date().toISOString(); binding.message = message;
            saveAndRender();
        }
        async function execute(binding, testOnly = false, automatic = false) {
            if (paused) return { ok: false, skipped: true, message: "Start Demo before synchronizing." };
            const token = epoch;
            if (busy.has(binding.id)) return { ok: false, skipped: true, message: "Synchronization is already running." };
            const errors = issuesFor(binding); if (errors.length) { record(binding, "Validation", "Invalid", null, errors.join(" ")); return { ok: false, message: errors.join(" ") }; }
            busy.add(binding.id); binding.status = "Syncing"; binding.message = automatic ? "Automatic Demo cycle" : testOnly ? "Reading both endpoints" : "Manual synchronization"; render();
            try {
                const { signal, property } = bindingContext(binding);
                let gateway, aas;
                if (testOnly || binding.direction !== "aas_to_gateway") gateway = await readGateway(signal);
                if (testOnly || binding.direction !== "gateway_to_aas") aas = await readAas(property);
                assertActive(token);
                if (testOnly) {
                    record(binding, "Endpoint read", "OK", gateway, "Gateway=" + gateway + " · AAS=" + aas + (equal(gateway, aas) ? " · values match" : " · values differ"));
                    return { ok: true, value: gateway };
                }
                let action = binding.direction;
                if (binding.direction === "bidirectional") action = planBidirectional({ initialized: baselines.has(binding.id), startupAuthority: binding.startupAuthority, previousGateway: baselines.get(binding.id)?.gateway, previousAas: baselines.get(binding.id)?.aas, gateway, aas });
                if (action === "conflict") { record(binding, "Conflict guard", "Conflict", null, "Both sides differ; no value was overwritten."); return { ok: false, message: "Both sides differ; no value was overwritten." }; }
                let value = gateway;
                if (action === "gateway_to_aas") value = await writeAas(property, gateway, token);
                else if (action === "aas_to_gateway") value = await writeGateway(signal, aas, token);
                else value = gateway;
                assertActive(token);
                baselines.set(binding.id, { gateway: value, aas: value });
                record(binding, action === "none" ? "No change" : directionLabel(action), "OK", value, mode === "demo" ? (environment?.hasLiveGateway ? "Live Gateway / browser AAS synchronization" : "Browser demo synchronization") : "Backend write confirmed");
                return { ok: true, value };
            } catch (error) { if (paused || token !== epoch) return { ok: false, skipped: true, message: "Demo synchronization is paused." }; record(binding, "Synchronization", "Error", null, error.message); return { ok: false, message: error.message }; }
            finally { busy.delete(binding.id); }
        }

        function isManaged(binding) { return ["gateway_mapping", "aas_property"].includes(binding?.managedBy); }
        function removeManagedConflicts(signalId, propertyId, keepId = "", allowSharedGatewaySource = false) {
            const removed = bindings.filter(item => isManaged(item) && item.id !== keepId && (item.propertyId === propertyId || item.signalId === signalId && (!allowSharedGatewaySource || item.managedBy !== "gateway_mapping")));
            if (!removed.length) return;
            bindings = bindings.filter(item => !removed.includes(item));
            removed.forEach(item => { baselines.delete(item.id); nextRuns.delete(item.id); if (item.managedBy === "aas_property") gatewayOverrides.delete(item.signalId); });
        }
        function managedBindings(kind, key) {
            return bindings.filter(item => item.managedBy === kind && (kind === "gateway_mapping" ? item.signalId === key : item.propertyId === key));
        }
        function managedBinding(kind, key) {
            return managedBindings(kind, key)[0];
        }
        async function syncManaged(kind, key) {
            const binding = managedBinding(kind, key);
            if (!binding) return { ok: false, message: "The link no longer exists." };
            return execute(binding, false, false);
        }
        function executeSoon(binding) { queueMicrotask(() => execute(binding, false, false)); }

        async function propagateGatewayValue(signalId, value) {
            const token = epoch; assertActive(token);
            if (mode !== "demo") throw Error("Service Rule demo writes require Explicit Demo binding mode.");
            const signal = model.snapshot().signals.find(item => item.id === signalId && !item.deleted);
            if (!signal) throw Error("Output Gateway signal is missing.");
            const parsed = typed(value, signal.valueType);
            await writeGateway(signal, parsed, token);
            assertActive(token);
            const applied = [];
            for (const binding of bindings.filter(item => item.signalId === signal.id && ["gateway_to_aas", "bidirectional"].includes(item.direction))) {
                const errors = issuesFor(binding);
                if (errors.length) { record(binding, "Service Rule propagation", "Invalid", parsed, errors.join(" ")); continue; }
                const { property } = bindingContext(binding);
                try {
                    const aasValue = await writeAas(property, parsed, token);
                    assertActive(token);
                    baselines.set(binding.id, { gateway: parsed, aas: aasValue });
                    record(binding, "Service Rule · Gateway → AAS", "OK", aasValue, "Engine Demo output propagated through this Binding");
                    applied.push((property.submodelName || property.submodelId) + " / " + property.path);
                } catch (error) { record(binding, "Service Rule propagation", "Error", parsed, error.message); }
            }
            return { value: parsed, aasTargets: applied };
        }

        function gatewayLinks(signalId) {
            return managedBindings("gateway_mapping", signalId).map(binding => {
                const { property } = bindingContext(binding);
                return { ...clone(binding), property: property ? clone(property) : null };
            });
        }
        function gatewayLink(signalId) { return gatewayLinks(signalId)[0] || null; }

        function gatewayBindingId(signalId, propertyId) {
            const clean = value => String(value).replace(/[^A-Za-z0-9:._-]/g, "_");
            const base = "binding:gateway-mapping:" + clean(signalId) + ":" + clean(propertyId);
            let id = base, suffix = 2;
            while (bindings.some(item => item.id === id && (item.signalId !== signalId || item.propertyId !== propertyId))) id = base + ":" + suffix++;
            return id;
        }

        function replaceGatewayLinks(signalId, propertyIds) {
            const signal = model.snapshot().signals.find(item => item.id === signalId && !item.deleted);
            if (!signal) throw Error("Save or reload the Gateway configuration before linking this signal.");
            const selected = [...new Set((propertyIds || []).filter(Boolean))];
            const selectedProperties = selected.map(propertyId => properties().find(item => item.id === propertyId));
            if (selectedProperties.some(property => !property)) throw Error("One or more selected AAS Properties are unavailable.");
            const typeMismatch = selectedProperties.find(property => property.valueType !== signal.valueType);
            if (typeMismatch) throw Error("Gateway signal and every selected AAS Property must use the same value type.");

            const removed = bindings.filter(item => item.managedBy === "gateway_mapping" && item.signalId === signalId && !selected.includes(item.propertyId));
            bindings = bindings.filter(item => !removed.includes(item));
            removed.forEach(item => { baselines.delete(item.id); nextRuns.delete(item.id); });

            const added = [];
            selectedProperties.forEach(property => {
                const current = bindings.find(item => item.managedBy === "gateway_mapping" && item.signalId === signalId && item.propertyId === property.id);
                if (current) return;
                const next = {
                    id: gatewayBindingId(signalId, property.id),
                    name: signal.targetElement + " → " + (property.submodelName || property.submodelId) + " / " + property.path,
                    signalId,
                    propertyId: property.id,
                    direction: "gateway_to_aas",
                    intervalMs: 1000,
                    startupAuthority: "gateway",
                    managedBy: "gateway_mapping",
                    status: "Idle",
                    lastValue: null,
                    lastSyncAt: null,
                    message: "Linked from Gateway Signal Mapping"
                };
                const errors = validateBinding(next, model.snapshot().signals, properties(), bindings, next.id);
                if (errors.length) throw Error(errors.join(" "));
                removeManagedConflicts(signalId, property.id, next.id, true);
                bindings.push(next); added.push(next);
            });
            gatewayOverrides.delete(signalId);
            saveAndRender();
            added.forEach(executeSoon);
            return gatewayLinks(signalId);
        }

        function upsertGatewayLink(signalId, propertyId) {
            const selected = gatewayLinks(signalId).map(item => item.propertyId);
            if (!selected.includes(propertyId)) selected.push(propertyId);
            replaceGatewayLinks(signalId, selected);
            return gatewayLinks(signalId).find(item => item.propertyId === propertyId) || null;
        }

        function removeGatewayLink(signalId, propertyId = null) {
            const removed = bindings.filter(item => item.managedBy === "gateway_mapping" && item.signalId === signalId && (!propertyId || item.propertyId === propertyId));
            if (!removed.length) return false;
            bindings = bindings.filter(item => !removed.includes(item));
            removed.forEach(item => { baselines.delete(item.id); nextRuns.delete(item.id); });
            saveAndRender();
            return true;
        }

        async function syncGatewayLinks(signalId) {
            const targets = managedBindings("gateway_mapping", signalId);
            if (!targets.length) return { ok: false, message: "The link no longer exists." };
            const results = await Promise.all(targets.map(binding => execute(binding, false, false)));
            const failed = results.find(result => !result.ok);
            return failed || { ok: true, count: results.length };
        }

        function propertyLinks(propertyId) {
            return bindings.filter(item => isManaged(item) && item.propertyId === propertyId).map(binding => {
                const { signal, property } = bindingContext(binding);
                return { ...clone(binding), signal: signal ? clone(signal) : null, property: property ? clone(property) : null };
            });
        }

        function aasLink(propertyId) {
            const binding = managedBinding("aas_property", propertyId);
            if (!binding) return null;
            const { signal } = bindingContext(binding);
            return { ...clone(binding), signal: signal ? clone(signal) : null };
        }

        function upsertAasLink(propertyId, signalId) {
            const signal = model.snapshot().signals.find(item => item.id === signalId && !item.deleted);
            const property = properties().find(item => item.id === propertyId);
            if (!property) throw Error("Select an available AAS Property.");
            if (!signal) throw Error("Select an available Gateway signal.");
            if (signal.valueType !== property.valueType) throw Error("AAS Property and Gateway signal must use the same value type.");
            const currentIndex = bindings.findIndex(item => item.managedBy === "aas_property" && item.propertyId === propertyId);
            const current = currentIndex >= 0 ? bindings[currentIndex] : null;
            const next = {
                ...(current || {}),
                id: current?.id || "binding:aas-property:" + propertyId.replace(/[^A-Za-z0-9:._-]/g, "_"),
                name: (property.submodelName || property.submodelId) + " / " + property.path + " → " + signal.targetElement,
                signalId,
                propertyId,
                direction: "aas_to_gateway",
                intervalMs: 1000,
                startupAuthority: "aas",
                managedBy: "aas_property",
                status: "Idle",
                lastValue: current?.lastValue ?? null,
                lastSyncAt: current?.lastSyncAt ?? null,
                message: "Linked from AAS Property"
            };
            const validationPool = bindings.filter(item => item.id !== current?.id && !(isManaged(item) && (item.signalId === signalId || item.propertyId === propertyId)));
            const errors = validateBinding(next, model.snapshot().signals, properties(), validationPool, next.id);
            if (errors.length) throw Error(errors.join(" "));
            removeManagedConflicts(signalId, propertyId, current?.id || "");
            const nextIndex = bindings.findIndex(item => item.id === current?.id);
            if (nextIndex >= 0) bindings[nextIndex] = next; else bindings.push(next);
            baselines.delete(next.id); saveAndRender(); executeSoon(next);
            return aasLink(propertyId);
        }

        function removeAasLink(propertyId) {
            const removed = bindings.filter(item => item.managedBy === "aas_property" && item.propertyId === propertyId);
            if (!removed.length) return false;
            bindings = bindings.filter(item => !(item.managedBy === "aas_property" && item.propertyId === propertyId));
            removed.forEach(item => { baselines.delete(item.id); nextRuns.delete(item.id); gatewayOverrides.delete(item.signalId); });
            saveAndRender();
            return true;
        }

        function removePropertyLinks(propertyId) {
            const removed = bindings.filter(item => item.propertyId === propertyId && ["gateway_mapping", "aas_property"].includes(item.managedBy));
            if (!removed.length) return false;
            bindings = bindings.filter(item => !(item.propertyId === propertyId && ["gateway_mapping", "aas_property"].includes(item.managedBy)));
            removed.forEach(item => { baselines.delete(item.id); nextRuns.delete(item.id); if (item.managedBy === "aas_property") gatewayOverrides.delete(item.signalId); });
            saveAndRender();
            return true;
        }

        function openDialog(binding = null) {
            editingId = binding?.id || null;
            const signalOptions = model.snapshot().signals.filter(item => !item.deleted).map(item => '<option value="' + esc(item.id) + '">' + esc(item.targetElement + " · " + item.valueType + " · " + accessLabel(item)) + "</option>").join("");
            const propertyOptions = properties().map(item => '<option value="' + esc(item.id) + '">' + esc((item.submodelName || item.submodelId) + " / " + item.path + " · " + item.valueType) + "</option>").join("");
            form.innerHTML = '<div class="form-grid"><label class="field">Binding ID<input name="id" required></label><label class="field">Display Name<input name="name" required></label><label class="field full">Gateway Signal<select name="signalId" required>' + signalOptions + '</select></label><label class="field full">AAS Property<select name="propertyId" required>' + propertyOptions + '</select></label><label class="field">Direction<select name="direction"><option value="gateway_to_aas">Gateway → AAS</option><option value="aas_to_gateway">AAS → Gateway</option><option value="bidirectional">Gateway ↔ AAS</option></select></label><label class="field">Interval (ms)<input name="intervalMs" type="number" min="500" max="60000" step="100" value="1000"></label><label class="field full">Bidirectional startup authority<select name="startupAuthority"><option value="gateway">Gateway wins once</option><option value="aas">AAS wins once</option><option value="manual">Manual conflict guard</option></select></label></div><div class="empty-note" id="bindingDialogError" style="display:none;color:var(--danger)"></div><div class="modal-actions"><button class="btn" type="button" data-close-binding>Cancel</button><button class="btn primary" type="submit">Save Binding</button></div>';
            const values = binding || { id: "binding:" + Date.now().toString(36), name: "", signalId: model.snapshot().signals.find(item => !item.deleted)?.id || "", propertyId: properties()[0]?.id || "", direction: "gateway_to_aas", intervalMs: 1000, startupAuthority: "gateway" };
            Object.entries(values).forEach(([key, value]) => { if (form.elements[key]) form.elements[key].value = value; });
            form.elements.id.disabled = Boolean(binding);
            dialog.showModal();
        }
        function closeDialog() { dialog.close(); editingId = null; }
        function testBinding(binding) {
            const errors = issuesFor(binding);
            record(binding, "Validation", errors.length ? "Invalid" : "OK", null, errors.length ? errors.join(" ") : "References, data type, direction and interval are valid.");
        }

        form.addEventListener("submit", event => {
            event.preventDefault();
            const data = Object.fromEntries(new FormData(form)); data.id = editingId || data.id; data.intervalMs = Number(data.intervalMs);
            const errors = validateBinding(data, model.snapshot().signals, properties(), bindings, editingId);
            const errorElement = document.getElementById("bindingDialogError");
            if (errors.length) { errorElement.style.display = "block"; errorElement.textContent = errors.join(" "); return; }
            const next = { ...data, status: "Idle", lastValue: null, lastSyncAt: null, message: "Saved in browser demo state" };
            const index = bindings.findIndex(item => item.id === editingId);
            if (index < 0) bindings.push(next); else bindings[index] = { ...bindings[index], ...next };
            baselines.delete(next.id); persist(); render(); closeDialog(); toast("Binding saved in browser demo state.");
        });
        dialog.addEventListener("click", event => { if (event.target.matches("[data-close-binding]")) closeDialog(); });
        document.getElementById("addBinding").addEventListener("click", () => openDialog());
        document.getElementById("bindingRows").addEventListener("click", event => {
            const button = event.target.closest("[data-binding-action]"); if (!button) return;
            const binding = bindings.find(item => item.id === button.dataset.id); if (!binding) return;
            const action = button.dataset.bindingAction;
            if (action === "test") testBinding(binding);
            if (action === "read") execute(binding, true);
            if (action === "sync") execute(binding, false);
            if (action === "edit") openDialog(binding);
            if (action === "delete" && confirm("Delete binding '" + binding.id + "'?")) { bindings = bindings.filter(item => item.id !== binding.id); baselines.delete(binding.id); persist(); render(); toast("Binding deleted."); }
        });
        timer = setInterval(() => {
            if (mode !== "demo" || paused) return;
            const now = Date.now();
            bindings.filter(binding => running || isManaged(binding)).forEach(binding => { if (now >= (nextRuns.get(binding.id) || 0)) { nextRuns.set(binding.id, now + Number(binding.intervalMs || 1000)); execute(binding, false, true); } });
        }, 250);
        model.subscribe(render); liveData.subscribe(render); render();
        function setPaused(value) { paused = Boolean(value); epoch++; nextRuns.clear(); if (paused) bindings.filter(binding => busy.has(binding.id)).forEach(binding => { binding.status = "Paused"; binding.message = "Demo stopped"; }); render(); }
        return { render, execute, setPaused, propagateGatewayValue, gatewayLink, gatewayLinks, replaceGatewayLinks, upsertGatewayLink, removeGatewayLink, syncGatewayLink: syncGatewayLinks, propertyLinks, aasLink, upsertAasLink, removeAasLink, syncAasLink: propertyId => syncManaged("aas_property", propertyId), removePropertyLinks, snapshot: () => ({ mode, running, paused, bindings: clone(bindings) }), stop: () => { running = false; setPaused(true); clearInterval(timer); } };
    }

    const exported = { validateBinding, planBidirectional, STORAGE_KEY };
    if (typeof module !== "undefined" && module.exports) module.exports = exported;
    else root.GucBindings = { init };
})(typeof window !== "undefined" ? window : globalThis);
