(function (root) {
    "use strict";

    const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

    function parseEngineState(text) {
        const match = String(text || "").match(/Current state:\s*([^|]+)\|\s*Rules loaded:\s*(\d+)\s*\|\s*Rejected pushes:\s*(\d+)/i);
        if (!match) throw Error("Java Engine returned an unknown state format.");
        return { state: match[1].trim(), rulesLoaded: Number(match[2]), rejectedPushes: Number(match[3]), raw: String(text).trim() };
    }

    function formatTime(value) {
        if (value === undefined || value === null || value === "") return "—";
        const date = new Date(typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value);
        return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
    }

    async function request(path, type = "text") {
        const response = await (root.GucEnvironment ? root.GucEnvironment.fetch(path) : root.fetch(path)), payload = type === "json" ? await response.json().catch(() => ({})) : await response.text();
        if (!response.ok) throw Error(typeof payload?.detail === "string" ? payload.detail : typeof payload === "string" && payload ? payload : "Request failed (" + response.status + ").");
        return payload;
    }

    function init({ onRegistry } = {}) {
        let engine = null, engineError = "", services = [], servicesError = "", registry = [], registryError = "", checkedAt = null, refreshPromise = null;
        const engineBadge = document.getElementById("javaEngineBackendStatus"), cardBadge = document.getElementById("engineStatusBadge");
        const historyElement = document.getElementById("javaEngineHistory"), dataElement = document.getElementById("javaEngineData"), summaryElement = document.getElementById("javaEngineSummary");
        const serviceBadge = document.getElementById("serviceBackendStatus"), serviceRows = document.getElementById("backendServiceExecutionRows");
        const serviceCardBadge = document.getElementById("servicesStatusBadge"), serviceRuntimes = document.getElementById("servicesRuntimeText"), serviceLastExecution = document.getElementById("servicesLastExecution");
        if (root.GucEnvironment && !root.GucEnvironment.isBackend) {
            const message = root.GucEnvironment.label + " · simulated Services; Java Engine disabled. Gateway is managed separately.";
            [engineBadge, cardBadge, serviceBadge, serviceCardBadge].filter(Boolean).forEach(badge => { badge.textContent = "Simulation"; badge.className = "badge draft"; });
            document.getElementById("engineJavaState").textContent = "Not connected";
            document.getElementById("engineLoadedRuleCount").textContent = "—";
            summaryElement.textContent = historyElement.textContent = dataElement.textContent = message;
            serviceRuntimes.textContent = "Browser simulation";
            serviceLastExecution.textContent = "No backend executions";
            serviceRows.innerHTML = '<tr><td colspan="6">' + esc(message) + '</td></tr>';
            ["refreshEngineBackend", "refreshEngineBackendPage", "serviceRefresh"].forEach(id => { const button = document.getElementById(id); if (button) { button.disabled = true; button.title = message; } });
            return { refresh: async () => {}, logLines: () => [message], serviceLogLines: () => [message], snapshot: () => ({ engine: null, services: [], registry: [], simulated: true }) };
        }

        function render() {
            if (engine) {
                engineBadge.textContent = "Connected · 8080";
                engineBadge.className = "badge";
                cardBadge.textContent = engine.state;
                cardBadge.className = "badge status";
                document.getElementById("engineJavaState").textContent = engine.state;
                document.getElementById("engineLoadedRuleCount").textContent = String(engine.rulesLoaded);
                summaryElement.innerHTML = '<span>State</span><strong>' + esc(engine.state) + '</strong><span>Repository rules</span><strong>' + engine.rulesLoaded + '</strong><span>Rejected pushes</span><strong>' + engine.rejectedPushes + '</strong><span>Last checked</span><strong>' + esc(formatTime(checkedAt)) + '</strong>';
                historyElement.textContent = engine.history;
                dataElement.textContent = engine.data;
            } else {
                const message = engineError || "Java Engine has not been checked.";
                engineBadge.textContent = "Unavailable · 8080";
                engineBadge.className = "badge offline";
                cardBadge.textContent = "Backend offline";
                cardBadge.className = "badge status offline";
                document.getElementById("engineJavaState").textContent = "Unavailable";
                document.getElementById("engineLoadedRuleCount").textContent = "—";
                summaryElement.innerHTML = '<span>Status</span><strong style="color:var(--danger)">' + esc(message) + '</strong><span>UI behavior</span><strong>Draft configuration and explicit Demo Auto Trigger remain available</strong>';
                historyElement.textContent = message;
                dataElement.textContent = message;
            }
            if (!servicesError) {
                serviceBadge.textContent = "Connected · " + services.length + " backend executions";
                serviceBadge.className = "badge";
                if (serviceCardBadge) { serviceCardBadge.textContent = "Connected"; serviceCardBadge.className = "badge status"; }
            } else {
                serviceBadge.textContent = "Services unavailable · 8082";
                serviceBadge.className = "badge offline";
                if (serviceCardBadge) { serviceCardBadge.textContent = "Backend offline"; serviceCardBadge.className = "badge status offline"; }
            }
            if (serviceRuntimes) serviceRuntimes.textContent = registryError ? (registry.length ? "Cached backend registry" : "Unavailable") : ([...new Set(registry.map(item => item.technologyAdapter).filter(Boolean))].join(", ") || "No adapters registered");
            const latestExecution = services[0];
            if (serviceLastExecution) serviceLastExecution.textContent = servicesError ? "Unavailable" : latestExecution ? (latestExecution.status || "Unknown") + (latestExecution.executionDurationMs == null ? "" : " · " + latestExecution.executionDurationMs + " ms") : "No executions";
            serviceRows.innerHTML = services.map(item => {
                const output = item.errorMessage || item.outputData || "—", failed = item.status === "FAILED" || item.success === false && !["ACCEPTED", "RUNNING"].includes(item.status);
                return '<tr><td>' + esc(formatTime(item.completedAt)) + '</td><td><code>' + esc(item.executionId || "—") + '</code></td><td>' + esc(item.serviceId || "—") + '</td><td><span class="badge ' + (failed ? "offline" : item.status === "RUNNING" ? "warning" : "") + '">' + esc(item.status || "Unknown") + '</span></td><td>' + esc(item.executionDurationMs == null ? "—" : item.executionDurationMs + " ms") + '</td><td>' + esc(output) + '</td></tr>';
            }).join("") || '<tr><td colspan="6">' + esc(servicesError || "No completed Service executions reported by the backend.") + '</td></tr>';
        }

        async function refresh() {
            if (refreshPromise) return refreshPromise;
            engineBadge.textContent = "Checking · 8080";
            serviceBadge.textContent = "Checking Services · 8082";
            refreshPromise = (async () => {
                const engineResults = await Promise.allSettled([request("/api/engine/state"), request("/api/engine/history"), request("/api/engine/submodel-data")]);
                checkedAt = new Date().toISOString();
                if (engineResults.every(result => result.status === "fulfilled")) {
                    try { engine = { ...parseEngineState(engineResults[0].value), history: engineResults[1].value, data: engineResults[2].value }; engineError = ""; }
                    catch (error) { engine = null; engineError = error.message; }
                } else {
                    engine = null;
                    engineError = engineResults.find(result => result.status === "rejected")?.reason?.message || "Java Engine request failed.";
                }
                const [historyResult, registryResult] = await Promise.allSettled([request("/api/services/history", "json"), request("/api/services/registry", "json")]);
                if (historyResult.status === "fulfilled" && Array.isArray(historyResult.value)) {
                    services = historyResult.value;
                    servicesError = "";
                } else {
                    services = [];
                    servicesError = historyResult.status === "rejected" ? historyResult.reason.message : "Services history response has an invalid shape.";
                }
                if (registryResult.status === "fulfilled" && Array.isArray(registryResult.value)) {
                    registry = registryResult.value;
                    registryError = "";
                    try { if (onRegistry) onRegistry(registry, null); }
                    catch (error) { registryError = error.message; if (onRegistry) onRegistry(null, registryError); }
                } else {
                    registryError = registryResult.status === "rejected" ? registryResult.reason.message : "Service Registry response has an invalid shape.";
                    if (onRegistry) onRegistry(null, registryError);
                }
                render();
            })().finally(() => { refreshPromise = null; });
            return refreshPromise;
        }

        document.getElementById("refreshEngineBackend")?.addEventListener("click", refresh);
        document.getElementById("refreshEngineBackendPage")?.addEventListener("click", refresh);
        refresh();
        setInterval(refresh, 5000);
        return {
            refresh,
            logLines() { return engine ? [engine.raw, engine.history, engine.data] : [engineError || "Java Engine unavailable."]; },
            serviceLogLines() { return servicesError ? [servicesError] : services.map(item => "[" + (item.status || "unknown") + "] " + (item.executionId || "—") + " · " + (item.serviceId || "—")); },
            snapshot() { return { engine, engineError, services, servicesError, registry, registryError, checkedAt }; }
        };
    }

    const exported = { parseEngineState, formatTime };
    if (typeof module !== "undefined" && module.exports) module.exports = exported;
    else root.GucEngineBackend = { init };
})(typeof window !== "undefined" ? window : globalThis);
