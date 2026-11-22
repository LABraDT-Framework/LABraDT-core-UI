// Connection lifecycle lives outside the form/page renderer. References stay intact on disable.
function connectionWorkspaceReferences(machine, model, bindings) {
    const signalIds = new Set(model.signals.filter(s => s.connectionId === "connection:" + encodeURIComponent(machine) && !s.deleted).map(s => s.id));
    const refs = (bindings || []).filter(b => signalIds.has(b.signalId)).map(b => ({ kind: "AAS mapping", id: b.id, name: b.property?.path || b.propertyId || b.id }));
    for (const rule of model.rules || []) {
        if (signalIds.has(rule.signalId) || signalIds.has(rule.outputMapping?.targetId) || Object.values(rule.dynamicArgs || {}).some(value => signalIds.has(value))) refs.push({ kind: "Gateway rule", id: rule.id, name: rule.name || rule.id });
    }
    return refs;
}

function renderConnectionState() {
    const entry = gatewayConfigs.find(e => e.config.machineId === document.getElementById("gatewayMachineId").value.trim());
    const badge = document.getElementById("gatewayEnabledBadge"), button = document.getElementById("toggleGatewayConnection");
    badge.textContent = !entry ? "Unsaved connection" : entry.enabled === false ? "Disabled · config retained" : "Enabled";
    badge.className = "badge " + (!entry || entry.enabled === false ? "draft" : "");
    button.textContent = entry?.enabled === false ? "Enable Connection" : "Disable Connection";
    const locked = environment.isDemo && environment.demoRunning;
    if (environment.isDemo) for (const node of document.querySelectorAll('#addGateway,#addMapping,#saveGatewayConfig,#gatewayMachineId,#gatewayProtocol,#gatewayEndpoint,#gatewayMachineType,#gatewayReconnectInitial,#gatewayReconnectMax,#gatewayTopicFilter,#gatewayQuietWindow,#gatewayMqttAuth,#gatewayMqttUserEnv,#gatewayMqttPassEnv,#gatewaySecurityFields input,#gatewaySecurityFields select,#prepareOpcuaCertificates,#mappingRows button')) node.disabled = locked;
    button.disabled = !entry || gatewayEditState === "dirty" || locked;
    document.getElementById("deleteGatewayConfig").disabled = !entry || locked;
    document.getElementById("discoverOpcuaNodes").disabled = !["OPC_UA", "MQTT"].includes(document.getElementById("gatewayProtocol").value);
    if (locked) { button.title = "Stop Demo before editing."; document.getElementById("deleteGatewayConfig").title = button.title; }
    else { button.title = "Configuration and links are retained; restart Gateway to apply."; document.getElementById("deleteGatewayConfig").title = "Check references before deleting."; }
}

async function openConnectionManagement(action) {
    const machine = document.getElementById("gatewayMachineId").value.trim(), entry = gatewayConfigs.find(e => e.config.machineId === machine);
    if (!entry) return showToast("Save this connection first.");
    if (environment.isDemo && environment.demoRunning) return showToast("Stop Demo before changing connections.");
    if (gatewayEditState === "dirty") return showToast("Save or reload your unsaved connection changes first.");
    try {
        const result = await apiRequest(`/api/gateway/configs/${encodeURIComponent(machine)}/references`);
        const refs = [...result.references, ...connectionWorkspaceReferences(machine, sharedModel.snapshot(), window.gucBindings?.snapshot?.().bindings)];
        const refsHtml = refs.length ? `<p>References retained on disable; remove them before deletion:</p><ul>${refs.map(r => `<li>${escapeHtml(r.kind)} · ${escapeHtml(r.name || r.id)}</li>`).join("")}</ul>` : "<p>No dependent AAS mappings or Gateway rules found.</p>";
        const blocked = action === "delete" && refs.length, enabled = entry.enabled === false;
        const label = action === "delete" ? "Delete" : enabled ? "Enable" : "Disable";
        openConfirmModal({ title: `${blocked ? "Cannot delete" : label} Machine Connection`, message: `<p>${escapeHtml(machine)}</p>${refsHtml}<p>${action === "delete" ? "Deletion archives the JSON for recovery. The runtime is updated after a Gateway restart." : "Disabling retains the endpoint, mappings and links but stops the adapter after a Gateway restart. Enable restores the same configuration. Linked rules may prevent Start while disabled."}</p>`, submitLabel: blocked ? "Close" : label, onSubmit: async () => {
            if (blocked) return;
            await apiRequest(`/api/gateway/configs/${encodeURIComponent(machine)}${action === "delete" ? "" : "/enabled"}`, action === "delete" ? { method: "DELETE" } : { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled }) });
            await loadGatewayConfigs(action === "delete" ? "" : machine);
            if (environment.hasLiveGateway) setGatewayEditState("restart");
            await window.gucGatewayManagement?.refresh(); refreshGatewayStatus();
            showToast(`${machine}: ${label.toLowerCase()} saved. ${environment.hasLiveGateway ? "Restart this Gateway to apply." : "Browser simulation updated."}`);
        } });
    } catch (error) { showToast(error.message); }
}

if (typeof module !== "undefined" && module.exports) module.exports = { connectionWorkspaceReferences };
