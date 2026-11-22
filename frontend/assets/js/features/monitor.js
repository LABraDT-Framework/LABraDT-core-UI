(function (root) {
    "use strict";

    const clone = value => JSON.parse(JSON.stringify(value));
    const numericTypes = new Set(["xs:double", "xs:float", "xs:int", "xs:long"]);
    const STALE_AFTER_MS = 30000;

    function qualifierMap(property) {
        if (property?.qualifiers == null) return {};
        if (!Array.isArray(property.qualifiers)) throw Error("Gateway Property qualifiers must be an array.");
        const result = {};
        for (const qualifier of property.qualifiers) {
            if (!qualifier || typeof qualifier !== "object" || Array.isArray(qualifier) || typeof qualifier.type !== "string" || !qualifier.type.trim() || !("value" in qualifier) || qualifier.value === null || typeof qualifier.value === "object") throw Error("Gateway Property contains an invalid qualifier.");
            if (Object.prototype.hasOwnProperty.call(result, qualifier.type)) throw Error("Gateway Property contains duplicate qualifier type '" + qualifier.type + "'.");
            result[qualifier.type] = qualifier.value;
        }
        return result;
    }

    function normalizeProperty(property) {
        if (!property || typeof property !== "object" || Array.isArray(property)) throw Error("Gateway Property has an invalid shape.");
        return { property: clone(property), qualifiers: qualifierMap(property) };
    }

    function normalizeSnapshot(payload) {
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw Error("Gateway snapshot has an invalid shape.");
        return Object.entries(payload).map(([key, property]) => {
            if (!key) throw Error("Gateway snapshot contains an empty routing key.");
            return { key, ...normalizeProperty(property) };
        });
    }

    function parseTyped(raw, valueType) {
        const original = String(raw), text = original.trim();
        if (valueType !== "xs:string" && !text) throw Error("Value is required.");
        if (["xs:double", "xs:float"].includes(valueType)) {
            const value = Number(text);
            if (!Number.isFinite(value)) throw Error("Enter a finite number.");
            return value;
        }
        if (valueType === "xs:int") {
            if (!/^-?\d+$/.test(text)) throw Error("Enter an integer.");
            const value = Number(text);
            if (value < -2147483648 || value > 2147483647) throw Error("Integer is outside the xs:int range.");
            return value;
        }
        if (valueType === "xs:long") {
            let value;
            try { value = BigInt(text); } catch { throw Error("Enter an integer."); }
            if (value < -9223372036854775808n || value > 9223372036854775807n) throw Error("Integer is outside the xs:long range.");
            return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : text;
        }
        if (valueType === "xs:boolean") {
            if (!["true", "false"].includes(text.toLowerCase())) throw Error("Enter true or false.");
            return text.toLowerCase() === "true";
        }
        if (valueType === "xs:dateTime") {
            if (Number.isNaN(Date.parse(text))) throw Error("Enter a valid date/time.");
            return text;
        }
        return valueType === "xs:string" ? original : text;
    }

    function validateWrite(raw, signal) {
        const value = parseTyped(raw, signal.valueType);
        if (signal.validRange) {
            const numeric = typeof value === "number" ? value : Number(value);
            if (!Number.isFinite(numeric) || numeric < signal.validRange[0] || numeric > signal.validRange[1]) throw Error("Value must be within [" + signal.validRange.join(", ") + "].");
        }
        return value;
    }

    function demoValue(signal, index, tick) {
        if (signal.valueType === "xs:boolean") return (tick + index) % 2 === 0;
        if (numericTypes.has(signal.valueType)) {
            const range = signal.validRange;
            let value = range ? range[0] + ((tick + index) % 10) / 9 * (range[1] - range[0]) : 40 + index + tick % 10;
            if (["xs:int", "xs:long"].includes(signal.valueType)) value = Math.round(value);
            return value;
        }
        if (signal.valueType === "xs:dateTime") return new Date().toISOString();
        return "DEMO_" + (index + 1) + "_" + tick;
    }

    // The Docker Gateway emits UTC LocalDateTime strings without an offset.
    // Do not interpret those timestamps in the user's desktop timezone.
    function gatewayTimestamp(value) {
        const text = String(value || "");
        return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(text) ? text + "Z" : text;
    }

    function liveStatus(entry, context = {}, now = Date.now()) {
        if (context.fatalError) return "ERROR";
        if (!entry) return "Unavailable";
        const code = String(entry.qualifiers?.StatusCode || "").toUpperCase();
        if (code.includes("ERROR") || code.includes("BAD")) return "ERROR";
        const timestamp = entry.qualifiers?.ObservedAt || entry.qualifiers?.Timestamp || entry.receivedAt;
        const age = timestamp ? now - Date.parse(gatewayTimestamp(timestamp)) : 0;
        if (code.includes("STALE") || (context.mode === "real" && (!context.streamAvailable || (Number.isFinite(age) && age > (context.staleAfterMs || STALE_AFTER_MS))))) return "STALE";
        return "OK";
    }

    function init({ model, environment = root.GucEnvironment }) {
        const backendFetch = (...args) => environment ? environment.fetch(...args) : root.fetch(...args);
        const statusElement = document.getElementById("monitorStatus"), messageElement = document.getElementById("monitorMessage");
        const listeners = new Set();
        let mode = "real", generation = 0, source = null, healthTimer = null, staleTimer = null, demoTimer = null;
        let paused = Boolean(environment?.isDemo && !environment.demoRunning), refreshing = null;
        let health = null, streamAvailable = false, snapshotLoaded = false, fatalError = "", streamError = "", values = new Map(), demoOverrides = new Map(), demoTick = 0;
        const context = () => ({ mode, streamAvailable, snapshotLoaded, fatalError, streamError, staleAfterMs: STALE_AFTER_MS });

        const closeSource = () => {
            if (source) source.close();
            source = null;
            [healthTimer, staleTimer, demoTimer].forEach(timer => timer && clearInterval(timer));
            healthTimer = staleTimer = demoTimer = null;
        };

        function updateSourceLabel() {
            const realButton = document.getElementById("monitorReal");
            if (realButton && environment?.isDemo) { realButton.textContent = "Demo Gateway"; realButton.disabled = paused; }
            if (!statusElement || !messageElement) return;
            if (paused) {
                statusElement.textContent = "Demo stopped";
                statusElement.className = "badge draft";
                messageElement.textContent = "Collection and automatic synchronization paused. Last values are preserved.";
            } else if (mode === "demo") {
                statusElement.textContent = "Explicit Demo · synthetic";
                statusElement.className = "badge warning";
                messageElement.textContent = "Synthetic browser values; no machine data or real Service is changed.";
            } else if (fatalError) {
                statusElement.textContent = "Real Gateway · unavailable";
                statusElement.className = "badge offline";
                messageElement.textContent = fatalError;
            } else if (streamAvailable) {
                statusElement.textContent = environment && !environment.isBackend ? "Mock devices · Gateway live" : "Real Gateway · live";
                statusElement.className = "badge";
                messageElement.textContent = "Mapped signals update from the Gateway event stream.";
            } else if (health?.status === "UP") {
                statusElement.textContent = streamError ? "Real Gateway · reconnecting" : "Real Gateway · stream pending";
                statusElement.className = "badge warning";
                messageElement.textContent = streamError || "Snapshot loaded; waiting for the event stream.";
            } else {
                statusElement.textContent = "Real Gateway · connecting";
                statusElement.className = "badge draft";
                messageElement.textContent = "Connecting to Gateway snapshot, health and event stream.";
            }
        }

        function notify() {
            updateSourceLabel();
            listeners.forEach(listener => listener());
        }

        function setEvent(key, property) {
            if (typeof key !== "string" || !key) throw Error("Gateway stream event is missing a routing key.");
            values.set(key, { key, ...normalizeProperty(property), receivedAt: new Date().toISOString() });
        }

        function viewForTarget(targetElement, fallbackUnit = "") {
            if (model.snapshot().signals.some(signal => signal.targetElement === targetElement && !signal.deleted && signal.enabled === false)) return { targetElement, value: null, unit: fallbackUnit, status: "Disabled", updatedAt: null, source: mode, message: "Connection disabled. Configuration and links retained; restart Gateway to apply." };
            const entry = values.get(targetElement), state = paused ? "Paused" : liveStatus(entry, context());
            const rawTimestamp = entry?.qualifiers?.ObservedAt || entry?.qualifiers?.Timestamp || entry?.receivedAt;
            const updatedAt = rawTimestamp ? gatewayTimestamp(rawTimestamp) : null;
            return { targetElement, value: entry?.property?.value, unit: entry?.qualifiers?.Unit || fallbackUnit || "", status: state, updatedAt, source: mode, message: state === "ERROR" ? (fatalError || entry?.qualifiers?.StatusCode || "Gateway value error") : streamError };
        }

        async function loadHealth(active) {
            try {
                const response = await backendFetch("/api/gateway/live/health"), payload = await response.json().catch(() => ({}));
                if (!response.ok) throw Error(typeof payload.detail === "string" ? payload.detail : "Health request failed (" + response.status + ").");
                if (active !== generation || mode !== "real") return;
                if (payload.status !== "UP" || !payload.adapters || typeof payload.adapters !== "object" || Array.isArray(payload.adapters) || typeof payload.safeMode !== "boolean") throw Error("Gateway health is not UP or has an invalid shape.");
                health = payload;
                if (snapshotLoaded) fatalError = "";
                notify();
            } catch (error) {
                if (active !== generation || mode !== "real") return;
                health = null;
                streamAvailable = false;
                fatalError = error.message;
                notify();
            }
        }

        async function useReal() {
            if (paused) return;
            if (mode === "real" && source) return refreshSnapshot();
            if (environment && !environment.hasLiveGateway) return useDemo(false);
            generation++;
            const active = generation;
            closeSource();
            mode = "real";
            health = null;
            streamAvailable = snapshotLoaded = false;
            fatalError = streamError = "";
            values.clear();
            demoOverrides.clear();
            notify();
            try {
                const response = await backendFetch("/api/gateway/live/snapshot");
                if (!response.ok) {
                    const payload = await response.json().catch(() => ({}));
                    throw Error(typeof payload.detail === "string" ? payload.detail : "Snapshot request failed (" + response.status + ").");
                }
                const entries = normalizeSnapshot(await response.json());
                if (active !== generation || mode !== "real") return;
                entries.forEach(entry => values.set(entry.key, { ...entry, receivedAt: new Date().toISOString() }));
                snapshotLoaded = true;
                notify();
            } catch (error) {
                if (active === generation && mode === "real") { fatalError = error.message; notify(); }
            }
            await loadHealth(active);
            if (active !== generation || mode !== "real" || paused) return;
            source = new EventSource(environment?.gatewayUrl("/api/gateway/live/stream") || "/api/gateway/live/stream");
            ["snapshot", "update", "keyframe"].forEach(name => source.addEventListener(name, event => {
                if (active !== generation || mode !== "real") return;
                try {
                    const item = JSON.parse(event.data);
                    setEvent(item.key, item.property);
                    streamAvailable = true;
                    snapshotLoaded = true;
                    fatalError = streamError = "";
                    notify();
                } catch (error) { streamError = "Ignored an invalid Gateway stream event: " + error.message; notify(); }
            }));
            source.onerror = () => {
                if (active !== generation || mode !== "real") return;
                streamAvailable = false;
                streamError = "Live stream interrupted; the last values are marked STALE while reconnecting.";
                notify();
            };
            healthTimer = setInterval(() => loadHealth(active), 10000);
            staleTimer = setInterval(notify, 5000);
        }

        function useDemo(resetOverrides = true) {
            if (paused) return;
            if (environment?.hasLiveGateway) return;
            generation++;
            closeSource();
            mode = "demo";
            if (resetOverrides) demoOverrides.clear();
            health = { status: "DEMO", safeMode: true, adapters: {} };
            streamAvailable = snapshotLoaded = true;
            fatalError = streamError = "";
            const tick = () => {
                demoTick++;
                values.clear();
                model.snapshot().signals.filter(item => !item.deleted && item.enabled !== false).forEach((signal, index) => setEvent(signal.targetElement, { value: demoOverrides.has(signal.id) ? demoOverrides.get(signal.id) : demoValue(signal, index, demoTick), qualifiers: [{ type: "Unit", value: signal.unit || "" }, { type: "StatusCode", value: "OK" }, { type: "ObservedAt", value: new Date().toISOString() }] }));
                notify();
            };
            tick();
            demoTimer = setInterval(tick, 3000);
        }

        // Snapshot refresh never tears down a healthy event stream after a write.
        function refreshSnapshot() {
            if (paused) return Promise.resolve();
            if (mode === "demo") { notify(); return Promise.resolve(); }
            if (refreshing) return refreshing;
            const active = generation;
            const pending = (async () => {
                const response = await backendFetch("/api/gateway/live/snapshot");
                if (!response.ok) throw Error("Snapshot refresh failed (" + response.status + ").");
                const entries = normalizeSnapshot(await response.json());
                if (active !== generation || paused) return;
                entries.forEach(entry => values.set(entry.key, { ...entry, receivedAt: new Date().toISOString() }));
                snapshotLoaded = true;
                notify();
            })();
            refreshing = pending;
            return pending.finally(() => { if (refreshing === pending) refreshing = null; });
        }

        function pause() { paused = true; generation++; refreshing = null; closeSource(); streamAvailable = false; notify(); }
        function resume() { if (!paused) return; paused = false; return environment?.hasLiveGateway ? useReal() : useDemo(false); }

        document.getElementById("monitorReal")?.addEventListener("click", () => useReal().catch(error => { streamError = error.message; notify(); }));
        if (environment) {
            const realButton = document.getElementById("monitorReal");
            if (realButton) realButton.disabled = !environment.hasLiveGateway;
        }
        model.subscribe(() => { if (mode === "demo") useDemo(false); else notify(); });
        const api = {
            subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
            viewForMapping(machineId, mapping) { return viewForTarget(String(machineId || "") + "." + String(mapping?.idShort || ""), mapping?.unit); },
            viewForSignal(signalId) {
                const signal = model.snapshot().signals.find(item => item.id === signalId && !item.deleted);
                return signal ? viewForTarget(signal.targetElement, signal.unit) : { value: undefined, unit: "", status: "Unavailable", updatedAt: null, source: mode, message: "Signal is missing." };
            },
            setDemoValue(signalId, value) {
                if (mode !== "demo") throw Error("Gateway output mapping is restricted to Explicit Demo data.");
                const signal = model.snapshot().signals.find(item => item.id === signalId && !item.deleted);
                if (!signal) throw Error("Output Gateway signal is missing.");
                const parsed = validateWrite(value, signal);
                demoOverrides.set(signal.id, parsed);
                setEvent(signal.targetElement, { value: parsed, qualifiers: [{ type: "Unit", value: signal.unit || "" }, { type: "StatusCode", value: "OK" }, { type: "ObservedAt", value: new Date().toISOString() }] });
                notify();
                return parsed;
            },
            snapshot() { return { mode, paused, streamAvailable, snapshotLoaded, fatalError, streamError, values: [...values.values()].map(clone) }; },
            pause, resume,
            useReal,
            useDemo,
            refresh: refreshSnapshot
        };
        if (paused) notify(); else if (environment && !environment.hasLiveGateway) useDemo(); else useReal();
        return api;
    }

    const exported = { qualifierMap, normalizeSnapshot, parseTyped, validateWrite, demoValue, liveStatus, gatewayTimestamp, STALE_AFTER_MS };
    if (typeof module !== "undefined" && module.exports) module.exports = exported;
    else { root.GucMonitorHelpers = exported; root.GucMonitor = { init }; }
})(typeof window !== "undefined" ? window : globalThis);
