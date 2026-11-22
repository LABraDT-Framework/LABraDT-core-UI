// Classic script: function definitions only; shared state is initialized in app/state.js.

function liveValueHtml(view) {
  const status = view?.status || "Unavailable";
  const value = view?.value === undefined || view?.value === null ? (status === "ERROR" ? "Read failed" : "—") : String(view.value) + (view.unit ? ` ${view.unit}` : "");
  const updated = view?.updatedAt ? new Date(view.updatedAt).toLocaleTimeString() : "Never updated";
  return `<div class="live-cell" title="${escapeHtml(view?.message || "")}"><span class="live-cell-label">Live Value</span><span class="live-value ${escapeHtml(status.toLowerCase())}">${escapeHtml(value)} · ${escapeHtml(status)}</span><span class="small">${view?.updatedAt ? "Updated " : ""}${escapeHtml(updated)}</span></div>`;
}

function bindingStatusHtml(link) {
  const status = link?.status || "Idle";
  const style = status === "OK" ? "" : status === "Error" || status === "Invalid" ? "offline" : status === "Syncing" ? "warning" : "draft";
  const when = link?.lastSyncAt ? new Date(link.lastSyncAt).toLocaleTimeString() : "Not synchronized";
  return `<span class="badge ${style}" title="${escapeHtml(`${when}${link?.message ? ` · ${link.message}` : ""}`)}">${escapeHtml(status)}</span>`;
}

function gatewayAccessLabel(signal) {
  return signal?.writable === true ? "Read / Write" : signal?.writable === false ? "Read only" : "Access unknown";
}

function gatewayAccessBadge(signal) {
  const label = gatewayAccessLabel(signal), style = signal?.writable === true ? "" : signal?.writable === false ? "warning" : "draft";
  return `<span class="badge ${style}" title="Effective OPC UA access for the connected user">${escapeHtml(label)}</span>`;
}

// ── MQTT (plugin from gateway-implementations/mqtt-plugin) ─────────────────────
const XS_VALUE_TYPES = ["xs:double", "xs:float", "xs:int", "xs:long", "xs:boolean", "xs:string", "xs:dateTime"];

function mqttCredentialNames(machineId) {
  const stem = String(machineId || "machine").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return [`DT_${stem}_USERNAME`, `DT_${stem}_PASSWORD`];
}

function mqttAuthFromConnection(connection = {}) {
  const env = value => (String(value || "").match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)(?::[^}]*)?\}$/) || [])[1] || "";
  const userEnv = env(connection.username), passEnv = env(connection.password);
  return userEnv || passEnv ? { auth: "Environment", userEnv, passEnv } : { auth: "Anonymous", userEnv: "", passEnv: "" };
}

function mqttConnection(previous, machineId, auth, userEnv, passEnv) {
  const connection = { ...previous };
  for (const key of ["securityPolicy", "securityMode", "serverCertificate", "authentication", "username", "password", "usernameEnv", "passwordEnv", "passwordSet"]) delete connection[key];
  if (auth === "Environment") {
    const [user, pass] = mqttCredentialNames(machineId);
    connection.username = "${" + (String(userEnv || "").trim() || user) + "}";
    connection.password = "${" + (String(passEnv || "").trim() || pass) + "}";
  }
  return connection;
}

function setGatewayEmpty(empty) {
  document.getElementById("gatewayTab").classList.toggle("gateway-empty", Boolean(empty));
}

function renderGatewayProtocolUi() {
  const protocol = document.getElementById("gatewayProtocol").value || gatewayConfig.protocol, mqtt = protocol === "MQTT";
  document.getElementById("gatewayMqttSection").hidden = !mqtt;
  document.getElementById("gatewayEndpointLabel").textContent = mqtt ? "Broker URL" : protocol === "OPC_UA" ? "OPC UA endpoint" : "Endpoint";
  document.getElementById("gatewayEndpoint").placeholder = mqtt ? "tcp://localhost:1883" : protocol === "OPC_UA" ? "opc.tcp://host:4840" : "";
  const browse = document.getElementById("discoverOpcuaNodes");
  browse.textContent = "Explore Address Space";
  browse.title = mqtt ? "Subscribe to the broker and show the topic tree" : protocol === "OPC_UA" ? "Browse the OPC UA address space" : "No explorer for this protocol yet";
  const auth = document.getElementById("gatewayMqttAuth").value, [user, pass] = mqttCredentialNames(document.getElementById("gatewayMachineId").value.trim());
  document.querySelectorAll("#gatewayMqttSection .mqtt-auth-field").forEach(el => el.hidden = auth !== "Environment");
  document.getElementById("gatewayMqttUserEnv").placeholder = user; document.getElementById("gatewayMqttPassEnv").placeholder = pass;
}

async function stackRequest(path, body) {
  const response = await fetch(path, { method: body ? "POST" : "GET", headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const payload = (response.headers.get("content-type") || "").includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) throw new Error(typeof payload?.detail === "string" ? payload.detail : payload?.detail?.message || String(payload));
  return payload;
}

function mqttBrowsePayload(listenSeconds) {
  const userEnv = document.getElementById("gatewayMqttUserEnv").value.trim(), passEnv = document.getElementById("gatewayMqttPassEnv").value.trim(), [user, pass] = mqttCredentialNames(gatewayConfig.machineId);
  const auth = document.getElementById("gatewayMqttAuth").value === "Environment";
  return { protocol: "MQTT", endpoint: document.getElementById("gatewayEndpoint").value.trim(), topicFilter: document.getElementById("gatewayTopicFilter").value.trim() || "#", listenSeconds,
    ...(auth ? { usernameEnv: userEnv || user, passwordEnv: passEnv || pass } : {}) };
}

function mappingSignalId(row) { return sharedModel.signalId(gatewayConfig.machineId, row.idShort); }

function mappingSignal(row) { return sharedModel.snapshot().signals.find(signal => signal.id === mappingSignalId(row) && !signal.deleted) || row; }

function mappingLinks(row) { return window.gucBindings?.gatewayLinks?.(mappingSignalId(row)) || []; }

function mappingManagedLinks(row) { return window.gucBindings?.snapshot?.().bindings.filter(link => ["gateway_mapping", "aas_property"].includes(link.managedBy) && link.signalId === mappingSignalId(row)) || []; }

function mappingLink(row) { return mappingLinks(row)[0] || null; }

function isNumericMapping(row) { return ["xs:double", "xs:float", "xs:decimal", "xs:int", "xs:integer", "xs:long", "xs:short"].includes(row.valueType); }

function mappingRangeText(row) {
  if (!Array.isArray(row.validRange) || row.validRange.length !== 2) return "No limits";
  return `${row.validRange[0]} – ${row.validRange[1]}${row.unit ? ` ${row.unit}` : ""}${Number(row.deadband) > 0 ? ` · deadband ${row.deadband}` : ""}`;
}

function mappingLinkText(row) {
  const links = mappingLinks(row);
  if (!links.length) return "Not linked";
  return links.length === 1 ? `${links[0].property?.submodelName || links[0].property?.submodelId} / ${links[0].property?.path}` : `${links.length} linked SMEs`;
}

function renderMappings() {
  document.getElementById("mappingRows").innerHTML = mappings.map((row, index) => {
    const links = mappingLinks(row), managedLinks = mappingManagedLinks(row);
    const aasSourceLinks = managedLinks.filter(link => link.managedBy === "aas_property");
    const linkSummaries = links.map(link => `<span class="binding-link-summary"><span class="small binding-target" title="${escapeHtml(link.property ? `${link.property.submodelName || link.property.submodelId} / ${link.property.path}` : "Missing Property")}">Gateway → ${escapeHtml(link.property ? `${link.property.submodelName || link.property.submodelId} / ${link.property.path}` : "Missing Property")}</span></span>`).join("");
    const linkedBadge = managedLinks.length ? `<span class="badge">OK · ${managedLinks.length} SME${managedLinks.length === 1 ? "" : "s"} linked</span>` : "";
    return `
    <div class="mapping-row signal-mapping-row${aasSourceLinks.length ? " linked-node" : ""}">
      <div class="mapping-copy"><strong>${escapeHtml(row.idShort)}</strong><div class="small">${escapeHtml(row.sourceAddress)} · ${escapeHtml(row.valueType)} · ${escapeHtml(row.unit || "unitless")}</div><div class="mapping-inline-actions"><button class="link-btn" data-action="link-mapping" data-index="${index}">Link AAS SMEs</button>${linkedBadge}${linkSummaries}${links.length ? `<button class="link-btn" data-action="sync-mapping-link" data-index="${index}">Sync all</button><button class="link-btn" data-action="unlink-mapping-link" data-index="${index}">Unlink all</button>` : managedLinks.length ? "" : '<span class="small">Not linked</span>'}${isNumericMapping(row) ? `<button class="link-btn" data-action="limits-mapping" data-index="${index}">Set Limits</button><span class="small">${escapeHtml(mappingRangeText(row))}</span>` : ""}</div></div>
      ${liveValueHtml(window.gucLiveData?.viewForMapping(gatewayConfig.machineId, row))}
      <div class="mapping-row-actions"><button class="link-btn" data-action="edit-mapping" data-index="${index}">Edit</button><button class="link-btn" data-action="delete-mapping" data-index="${index}">Delete</button></div>
    </div>
  `; }).join("") || '<div class="empty-note">No Signal Mappings selected for this machine.</div>';
  document.getElementById("configPreview").textContent = JSON.stringify({
    ...gatewayTopLevelExtras,
    machineId: gatewayConfig.machineId,
    machineType: gatewayConfig.machineType,
    protocol: gatewayConfig.protocol,
    connection: gatewayPreviewConnection({ ...gatewayConnectionExtras, endpoint: gatewayConfig.endpoint, ...(gatewayConfig.protocol === "MQTT" ? {} : { securityPolicy: gatewayConfig.securityPolicy || "None" }), reconnectInitialBackoffMs: Number(gatewayConfig.reconnectInitialBackoffMs || 1000), reconnectMaxBackoffMs: Number(gatewayConfig.reconnectMaxBackoffMs || 30000), ...(gatewayConfig.topicFilter ? { topicFilter: gatewayConfig.topicFilter } : {}), quietWindowMs: Number(gatewayConfig.quietWindowMs || 0) }),
    mappings: mappings.map(persistedGatewayMapping)
  }, null, 2);
  renderConnectionState();
}

function persistedGatewayMapping(row) {
  const { readable, writable, accessLevel, ...persisted } = row;
  return { ...persisted, category: persisted.category || "VARIABLE", unit: persisted.unit || "" };
}

function setGatewayEditState(state) {
  gatewayEditState = state;
  const badge = document.getElementById("gatewayDraftBadge"), hint = document.getElementById("gatewayConfigHint");
  const values = {
    loaded: ["Loaded", "Loaded from Gateway configuration on disk.", "badge"],
    dirty: ["Unsaved", "UI draft changed. Validate and save to write the Gateway JSON file.", "badge draft"],
    restart: ["Restart required", "Saved to disk. Restart this environment’s Gateway, then check applied state.", "badge warning"]
  }[state];
  if (!environment.hasLiveGateway) values[1] = state === "dirty" ? "Browser draft changed. Save to keep it in this workspace." : "Saved browser configuration · no real Gateway is changed.";
  badge.textContent = values[0]; badge.className = values[2]; hint.textContent = values[1];
  renderConnectionState();
}

function markGatewayDirty() { setGatewayEditState("dirty"); renderSharedModel(); renderConnectionState(); }

function syncGatewayForm() {
  const set = (id, value) => { const el = document.getElementById(id); if (el) el.value = value || ""; };
  set("gatewayDisplayName", sharedModel.snapshot().connections.find(item => item.id === sharedModel.connectionId(gatewayConfig.machineId) && !item.deleted)?.name || gatewayConfig.machineId);
  set("gatewayMachineId", gatewayConfig.machineId); set("gatewayMachineType", gatewayConfig.machineType);
  set("gatewayProtocol", gatewayConfig.protocol); set("gatewayEndpoint", gatewayConfig.endpoint);
  set("gatewayReconnectInitial", gatewayConfig.reconnectInitialBackoffMs ?? 1000); set("gatewayReconnectMax", gatewayConfig.reconnectMaxBackoffMs ?? 30000);
  set("gatewayTopicFilter", gatewayConfig.topicFilter || ""); set("gatewayQuietWindow", gatewayConfig.quietWindowMs ?? 15000);
  const mqttAuth = mqttAuthFromConnection(gatewayConnectionExtras);
  set("gatewayMqttAuth", mqttAuth.auth); set("gatewayMqttUserEnv", mqttAuth.userEnv); set("gatewayMqttPassEnv", mqttAuth.passEnv);
  renderGatewaySecurityForm();
  renderGatewayProtocolUi();
  renderMappings(); renderSharedModel();
  renderConnectionState();
}

function gatewayPayload() {
  gatewayConfig = { ...gatewayConfig, machineId: document.getElementById("gatewayMachineId").value.trim(), machineType: document.getElementById("gatewayMachineType").value.trim() || "Generic", protocol: document.getElementById("gatewayProtocol").value, endpoint: document.getElementById("gatewayEndpoint").value.trim(), reconnectInitialBackoffMs: Number(document.getElementById("gatewayReconnectInitial").value || 1000), reconnectMaxBackoffMs: Number(document.getElementById("gatewayReconnectMax").value || 30000), topicFilter: document.getElementById("gatewayTopicFilter").value.trim(), quietWindowMs: Number(document.getElementById("gatewayQuietWindow").value || 0) };
  gatewayConnectionExtras = gatewaySecurityConnection(gatewayConnectionExtras, gatewaySecurityValues("gateway"), gatewayConfig.protocol);
  if (gatewayConfig.protocol === "OPC_UA") gatewayConfig.securityPolicy = gatewayConnectionExtras.securityPolicy;
  if (gatewayConfig.protocol === "MQTT") gatewayConnectionExtras = mqttConnection(gatewayConnectionExtras, gatewayConfig.machineId, document.getElementById("gatewayMqttAuth").value, document.getElementById("gatewayMqttUserEnv").value, document.getElementById("gatewayMqttPassEnv").value);
  return { ...gatewayTopLevelExtras, machineId: gatewayConfig.machineId, machineType: gatewayConfig.machineType, protocol: gatewayConfig.protocol, connection: { ...gatewayConnectionExtras, endpoint: gatewayConfig.endpoint, ...(gatewayConfig.protocol === "MQTT" ? {} : { securityPolicy: gatewayConfig.securityPolicy || gatewayConnectionExtras.securityPolicy || "None" }), reconnectInitialBackoffMs: gatewayConfig.reconnectInitialBackoffMs, reconnectMaxBackoffMs: gatewayConfig.reconnectMaxBackoffMs, ...(gatewayConfig.topicFilter ? { topicFilter: gatewayConfig.topicFilter } : {}), quietWindowMs: gatewayConfig.quietWindowMs }, mappings: mappings.map(persistedGatewayMapping) };
}

function syncCurrentGatewayDraft() {
  const current = gatewayPayload();
  if (!current.machineId) throw new Error("Machine ID is required before linking a Gateway signal.");
  const browserDraft = { ...current, mappings: mappings.map(row => ({ ...row, category: row.category || "VARIABLE", unit: row.unit || "" })) };
  const entries = gatewayConfigs
    .filter(entry => entry?.config?.machineId !== current.machineId)
    .concat({ fileName: `browser-draft-${current.machineId}.json`, config: browserDraft, enabled: gatewayConfigs.find(e => e.config.machineId === current.machineId)?.enabled !== false });
  sharedModel.syncGateway(entries);
}

async function loadGatewayConfigs(preferredMachineId = "") {
  try {
    const loaded = await apiRequest("/api/gateway/configs");
    sharedModel.syncGateway(loaded);
    gatewayConfigs = loaded;
    const select = document.getElementById("gatewayConfigSelect");
    renderConnectionOptions();
    const preferredId = sharedModel.connectionId((gatewayConfigs.find(entry => entry.config.machineId === preferredMachineId) || gatewayConfigs[0])?.config.machineId || "");
    if (gatewayConfigs.length) { setGatewayEmpty(false); select.value = preferredId; selectGatewayConfig(preferredId); } else { gatewayConfig = { machineId: "", protocol: "MQTT", endpoint: "", quietWindowMs: 15000, reconnectInitialBackoffMs: 1000, reconnectMaxBackoffMs: 30000, topicFilter: "" }; mappings = []; gatewayTopLevelExtras = {}; gatewayConnectionExtras = {}; syncGatewayForm(); setGatewayEditState("dirty"); setGatewayEmpty(true); }
    window.gucGatewayManagement?.refresh();
    refreshGatewayCertificates();
  } catch (error) { sharedModel.gatewayFailed(error.message); showToast(error.message); }
}

async function refreshMappingAccess() {
  const generation = ++mappingAccessRefresh;
  if (gatewayConfig.protocol !== "OPC_UA" || !gatewayConfig.endpoint) return;
  try {
    const result = await apiRequest("/api/gateway/discover/opcua", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(gatewayDiscoveryPayload()) });
    if (generation !== mappingAccessRefresh) return;
    const accessByAddress = new Map((result.nodes || []).map(node => [node.sourceAddress, node]));
    let changed = false;
    mappings = mappings.map(row => {
      const access = accessByAddress.get(row.sourceAddress);
      if (!access) return row;
      changed ||= row.readable !== access.readable || row.writable !== access.writable || row.accessLevel !== access.accessLevel;
      return { ...row, readable: access.readable, writable: access.writable, accessLevel: access.accessLevel };
    });
    if (changed) {
      syncCurrentGatewayDraft();
      renderMappings();
      renderAas(document.getElementById("aasSearch").value);
    }
  } catch (_) {
    // The saved configuration remains usable when the OPC UA server is offline.
  }
}

function selectGatewayConfig(connectionId) {
  const config = gatewayConfigs.find(entry => sharedModel.connectionId(entry.config.machineId) === connectionId)?.config; if (!config) return;
  const { machineId, machineType, protocol, connection = {}, mappings: configMappings = [], ...topLevelExtras } = config;
  const { endpoint = "", securityPolicy = "None", reconnectInitialBackoffMs = 1000, reconnectMaxBackoffMs = 30000, topicFilter = "", quietWindowMs = 15000, ...connectionExtras } = connection;
  gatewayTopLevelExtras = topLevelExtras; gatewayConnectionExtras = connectionExtras;
  gatewayConfig = { machineId, machineType: machineType || "Generic", protocol, endpoint, securityPolicy, reconnectInitialBackoffMs, reconnectMaxBackoffMs, topicFilter, quietWindowMs };
  mappings = configMappings.map(mapping => ({ ...mapping })); syncGatewayForm(); setGatewayEditState("loaded"); refreshMappingAccess();
}

async function validateGatewayConfig() {
  const payload = gatewayPayload();
  if (payload.connection.reconnectInitialBackoffMs > payload.connection.reconnectMaxBackoffMs) return showToast("Initial reconnect backoff cannot exceed the maximum backoff.");
  try { const result = await apiRequest("/api/gateway/configs/validate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }); showToast(result.valid ? "Configuration is valid." : result.errors.join(" ")); } catch (error) { showToast(error.message); }
}

async function saveGatewayConfig() {
  if (environment.isDemo && environment.demoRunning) return showToast("Stop Demo before changing connections.");
  const payload = gatewayPayload(); if (!payload.machineId) return showToast("Machine ID is required.");
  try { const result = await apiRequest(`/api/gateway/configs/${encodeURIComponent(payload.machineId)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }); await loadGatewayConfigs(payload.machineId); setGatewayEditState(environment.hasLiveGateway ? "restart" : "loaded"); showToast(environment.hasLiveGateway ? `${result.fileName} saved. Restart ${environment.isDemo ? "demo-gateway" : "gateway"} to apply it.` : `${result.fileName} saved in ${environment.label}.`); refreshGatewayStatus(); } catch (error) { showToast(error.message); }
}

async function testGatewayConnection() {
  const payload = gatewayPayload();
  if (!payload.connection.endpoint) return showToast("Enter an endpoint before testing the connection.");
  showToast("Testing connection…");
  try {
    if (payload.protocol === "OPC_UA") {
      const result = await apiRequest("/api/gateway/discover/opcua", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(gatewayDiscoveryPayload()) });
      showToast(environment.hasLiveGateway ? `Connection successful · ${result.nodes.length} readable OPC UA nodes.` : `Simulated node catalog · ${result.nodes.length} nodes. No real connection tested.`);
    } else if (payload.protocol === "MQTT") {
      const result = await stackRequest("/api/stack/gateway/browse", mqttBrowsePayload(3));
      showToast(`Broker reachable · ${result.count} topic${result.count === 1 ? "" : "s"} with messages on ${mqttBrowsePayload(3).topicFilter}.`);
    } else {
      const status = await apiRequest("/api/process/gateway/status"), health = parseGatewayHealth(status.health), adapterState = health?.adapters?.[payload.machineId];
      showToast(adapterState ? `${payload.machineId}: ${adapterState}` : status.running ? `No loaded ${payload.protocol} adapter for this machine. Enable and save the connection, then restart Gateway.` : "Gateway is offline; start it to test the connection.");
    }
  } catch (error) { showToast(`Connection failed: ${error.message}`); }
}

function openNodeBrowser(nodes, endpoint, title = "Browse OPC UA Nodes") {
  modalCancel.style.display = "";
  const tracked = new Set(mappings.map(mapping => mapping.sourceAddress));
  modalTitle.textContent = title;
  modalSubmit.className = "btn primary";
  modalBody.innerHTML = `<div class="small">${escapeHtml(endpoint)}</div><label class="field" for="nodeBrowserSearch">Search name or address<input id="nodeBrowserSearch" placeholder="${title.includes("MQTT") ? "e.g. temperature, factory/machine-1" : "e.g. feedrate, spindle, ns=2"}" autocomplete="off" /></label><div class="node-browser-summary"><span id="nodeBrowserSummary"></span><button class="link-btn" type="button" id="selectVisibleNodes">Select visible</button></div><div class="node-browser-list" id="nodeBrowserList"></div>`;
  const search = document.getElementById("nodeBrowserSearch"), list = document.getElementById("nodeBrowserList"), summary = document.getElementById("nodeBrowserSummary");
  const visibleNodes = () => nodes.filter(node => `${node.name} ${node.sourceAddress}`.toLowerCase().includes(search.value.trim().toLowerCase()));
  const updateSubmit = () => { const count = modalBody.querySelectorAll("input[data-node-address]:checked").length; modalSubmit.textContent = count ? `Track ${count} selected` : "Track selected"; };
  const render = () => { const visible = visibleNodes(); summary.textContent = `${visible.length} of ${nodes.length} signals · ${tracked.size} already tracked`; list.innerHTML = visible.map(node => `<label class="node-option"><input type="checkbox" data-node-address="${escapeHtml(node.sourceAddress)}" data-node-index="${nodes.indexOf(node)}" ${tracked.has(node.sourceAddress) ? "checked disabled" : ""}/><span><strong>${escapeHtml(node.name)}</strong><span class="small">${escapeHtml(node.sourceAddress)} · ${escapeHtml(node.valueType)}</span><span class="node-live-value"><span class="small">Live Value (browse snapshot)</span>${escapeHtml(node.value ?? "—")}</span></span></label>`).join("") || '<div class="empty-note">No matching signals.</div>'; updateSubmit(); };
  search.addEventListener("input", render);
  document.getElementById("selectVisibleNodes").addEventListener("click", () => { list.querySelectorAll("input[data-node-address]:not(:disabled)").forEach(input => input.checked = true); updateSubmit(); });
  list.addEventListener("change", updateSubmit);
  modalSubmitHandler = () => { const selected = [...modalBody.querySelectorAll("input[data-node-address]:checked:not(:disabled)")].map(input => nodes[Number(input.dataset.nodeIndex)]).filter(Boolean); selected.forEach(node => mappings.push({ sourceAddress: node.sourceAddress, idShort: node.name.replace(/[^a-zA-Z0-9_]/g, "_") || "NewSignal", valueType: node.valueType, unit: "", readable: node.readable, writable: node.writable, accessLevel: node.accessLevel })); if (selected.length) { syncCurrentGatewayDraft(); markGatewayDirty(); } renderMappings(); closeModal(); showToast(selected.length ? `${selected.length} node(s) added. Save to Gateway to persist.` : "No new nodes selected."); };
  modalBackdrop.classList.add("open"); modalBackdrop.setAttribute("aria-hidden", "false"); render(); search.focus();
}

// Generic address-space explorer (features/address-explorer.js) for every protocol plugin with an explorer.
function discoverOpcuaNodes() {
  gatewayPayload();
  const protocol = gatewayConfig.protocol, endpoint = document.getElementById("gatewayEndpoint").value.trim();
  if (!endpoint) return showToast(protocol === "MQTT" ? "Enter the MQTT broker URL first." : "Enter the endpoint first.");
  if (!["MQTT", "OPC_UA"].includes(protocol)) return showToast(`No address-space explorer for ${protocol} yet.`);
  const payload = protocol === "MQTT" ? mqttBrowsePayload(0) : { ...gatewayDiscoveryPayload(), protocol };
  GucExplorer.open({
    protocol, payload, title: protocol === "MQTT" ? "Explore MQTT Topics" : "Explore OPC UA Address Space",
    tracked: new Set(mappings.map(mapping => mapping.sourceAddress)),
    onAdd: leaves => {
      const used = new Set(mappings.map(mapping => mapping.idShort));
      const idFor = leaf => {
        const parts = String(leaf.address || leaf.name).split("/").filter(Boolean);
        const clean = text => String(text || "").replace(/[^A-Za-z0-9_]/g, "_").replace(/^([^A-Za-z])/, "s$1") || "Signal";
        let id = clean(leaf.name), depth = 2;
        while (used.has(id) && protocol === "MQTT" && depth <= parts.length) id = clean(parts.slice(-depth++).join("_"));
        for (let n = 2; used.has(id); n++) id = clean(leaf.name) + "_" + n;
        used.add(id); return id;
      };
      for (const leaf of leaves) mappings.push({ sourceAddress: leaf.address, idShort: idFor(leaf), valueType: leaf.valueType || "xs:string", unit: "",
        ...(protocol === "OPC_UA" ? { readable: true, writable: leaf.writable ?? undefined, accessLevel: leaf.writable ? "Read / Write" : leaf.writable === false ? "Read only" : undefined } : {}) });
      try { syncCurrentGatewayDraft(); } catch (_) { /* Machine ID missing: the mappings stay in the draft */ }
      markGatewayDirty(); renderMappings();
      showToast(`${leaves.length} signal${leaves.length === 1 ? "" : "s"} added. Save to Gateway to persist.`);
    }
  });
}

function gatewayDiscoveryPayload() {
  const authentication = gatewayAuthentication(gatewayConnectionExtras);
  const keys = authentication === "Environment" ? ["usernameEnv", "passwordEnv"] : authentication === "UsernamePassword" ? ["username", "password", "passwordSet"] : [];
  return { machineId: gatewayConfig.machineId, endpoint: document.getElementById("gatewayEndpoint").value.trim(),
    securityPolicy: gatewayConfig.securityPolicy || "None", securityMode: gatewayConnectionExtras.securityMode || "SignAndEncrypt", authentication,
    ...Object.fromEntries(["serverCertificate", ...keys].filter(key => gatewayConnectionExtras[key]).map(key => [key, gatewayConnectionExtras[key]])) };
}

function setGatewayPreviewCollapsed(collapsed, persist = true) {
  gatewayTabElement?.classList.toggle("preview-collapsed", collapsed);
  if (gatewayPreviewBody) gatewayPreviewBody.hidden = collapsed;
  if (gatewayPreviewToggle) {
    gatewayPreviewToggle.setAttribute("aria-expanded", String(!collapsed));
    gatewayPreviewToggle.title = collapsed ? "Expand generated machine config" : "Collapse generated machine config";
    gatewayPreviewToggle.innerHTML = collapsed
      ? '<span class="gateway-preview-toggle-icon" aria-hidden="true">‹</span><span>Show Config</span>'
      : '<span class="gateway-preview-toggle-icon" aria-hidden="true">›</span><span>Hide</span>';
  }
  if (persist) appStorage.setItem(GATEWAY_PREVIEW_COLLAPSED_KEY, collapsed ? "1" : "0");
}

function parseGatewayHealth(health) {
  if (!health || !health.reachable || !health.body) return null;
  if (typeof health.body === "object") return health.body;
  try {
    return JSON.parse(health.body);
  } catch {
    return null;
  }
}

function renderGatewayMachines(healthBody, running) {
  const storeText = document.getElementById("gatewayStoreText");
  const connectedText = document.getElementById("gatewayConnectedText");
  const machineList = document.getElementById("gatewayMachineList");
  const adapters = healthBody?.adapters || {};
  const entries = Object.entries(adapters);
  const paused = environment.isDemo && !environment.demoRunning;

  const mappings = healthBody?.mappings ?? 0;
  const storeSize = healthBody?.storeSize ?? 0;
  storeText.textContent = healthBody ? `${storeSize} / ${mappings} mappings${paused ? " · last snapshot" : ""}` : "—";

  if (paused && !entries.length) {
    connectedText.textContent = "Collection paused";
    machineList.innerHTML = '<div class="machine-chip"><div><div class="machine-name">Demo paused</div><div class="machine-meta">Start Demo to collect device data</div></div><span class="machine-state waiting">Paused</span></div>';
    return;
  }

  if (!running && !paused) {
    connectedText.textContent = "Gateway stopped";
    machineList.innerHTML = `<div class="machine-chip"><div><div class="machine-name">No live connections</div><div class="machine-meta">Start Gateway to read adapter health</div></div><span class="machine-state waiting">Idle</span></div>`;
    return;
  }

  if (!entries.length) {
    connectedText.textContent = "Waiting for health";
    machineList.innerHTML = `<div class="machine-chip"><div><div class="machine-name">Gateway starting</div><div class="machine-meta">Waiting for /api/submodel/health</div></div><span class="machine-state waiting">Waiting</span></div>`;
    return;
  }

  const connected = entries.filter(([, state]) => state === "CONNECTED" || state === "SIMULATED").length;
  connectedText.textContent = paused ? `${entries.length} machines · collection paused` : `${connected} / ${entries.length} ${environment.hasLiveGateway ? "connected" : "simulated"}`;
  machineList.innerHTML = entries.map(([name, state]) => {
    const config = gatewayConfigs.find(entry => entry.config.machineId === name)?.config;
    const meta = environment.hasLiveGateway ? { protocol: config?.protocol || gatewayMachineMeta[name]?.protocol || "Machine", endpoint: config?.connection?.endpoint || gatewayMachineMeta[name]?.endpoint || "configured endpoint" } : { protocol: config?.protocol || "Simulation", endpoint: "Browser only" };
    const stateClass = paused ? "waiting" : state === "CONNECTED" ? "connected" : state === "DISCONNECTED" ? "disconnected" : "waiting";
    return `
      <div class="machine-chip">
        <div>
          <div class="machine-name">${escapeHtml(name)}</div>
          <div class="machine-meta">${escapeHtml(meta.protocol)} · ${escapeHtml(meta.endpoint)}</div>
        </div>
        <span class="machine-state ${stateClass}">${paused ? "Paused" : escapeHtml(state)}</span>
      </div>
    `;
  }).join("");
}

function updateGatewayCard(status) {
  lastGatewayStatus = status;
  const badge = document.getElementById("gatewayStatusBadge");
  const button = document.getElementById("gatewayStartStop");
  const processText = document.getElementById("gatewayProcessText");
  const health = status?.health;
  const healthReachable = Boolean(health && health.reachable);
  const healthBody = parseGatewayHealth(health);
  const running = Boolean(status && status.running);
  const tracked = Boolean(status && status.tracked !== false);
  const detectedOnly = running && !tracked;

  badge.classList.toggle("warning", !running);
  badge.textContent = running ? (healthReachable ? "Running" : "Starting") : "Stopped";
  button.textContent = detectedOnly ? "Detected" : running ? "Stop" : "Start";
  button.disabled = detectedOnly;
  processText.textContent = running
    ? `${detectedOnly ? "External process" : `PID ${status.pid || "-"}`} · health ${healthReachable ? "UP" : "waiting"}`
    : (status ? "Stopped" : "UI backend not connected");
  if (status?.simulated) {
    badge.textContent = running ? "Simulation running" : "Simulation stopped";
    processText.textContent = environment.label + " · browser only; no backend process";
  }
  if (environment.isDemo) {
    const active = environment.demoRunning;
    badge.textContent = active ? (running ? "Demo running" : "Demo connecting") : "Demo stopped";
    badge.classList.toggle("warning", !active || !running);
    button.textContent = active ? "Stop" : "Start";
    button.disabled = false;
    processText.textContent = active ? "Isolated Demo Gateway · " + (healthReachable ? "health UP" : "waiting for Docker") : "Collection paused · Docker devices still running";
    if (!environment.hasLiveGateway) processText.textContent = active ? "Browser-only Demo · simulation active" : "Browser-only Demo · simulation paused";
    document.getElementById("gatewayRefresh").disabled = !active;
    document.getElementById("startAll").disabled = active;
    document.getElementById("stopAll").disabled = !active;
  }
  renderGatewayMachines(healthBody, running && (!environment.isDemo || environment.demoRunning));
}

async function refreshGatewayStatus(showMessage = false) {
  if (environment.isDemo && !environment.demoRunning) { updateGatewayCard(lastGatewayStatus); return; }
  try {
    const status = await apiRequest("/api/process/gateway/status");
    if (environment.isDemo && !environment.demoRunning) return;
    updateGatewayCard(status);
    if (showMessage) showToast(status.running ? "Gateway status refreshed." : "Gateway is stopped.");
  } catch (error) {
    if (environment.isDemo && !environment.demoRunning) return;
    updateGatewayCard(null);
    if (showMessage) showToast(error.message);
  }
}

async function toggleGatewayProcess() {
  if (environment.isDemo) return setAllComponents(!environment.demoRunning);
  const button = document.getElementById("gatewayStartStop");
  const shouldStop = button.textContent.trim() === "Stop";
  button.disabled = true;
  button.textContent = shouldStop ? "Stopping..." : "Starting...";
  try {
    const status = await apiRequest(`/api/process/gateway/${shouldStop ? "stop" : "start"}`, { method: "POST" });
    updateGatewayCard(status);
    showToast(status.message || (shouldStop ? "Gateway stopped." : "Gateway start command sent."));
  } catch (error) {
    showToast(error.message);
    await refreshGatewayStatus(false);
  } finally {
    button.disabled = false;
  }
}

async function showGatewayLogs() {
  try {
    const logs = await apiRequest("/api/process/gateway/logs?lines=180");
    modalTitle.textContent = "Gateway Logs";
    modalCancel.style.display = "none";
    modalSubmit.textContent = "Close";
    modalSubmit.className = "btn primary";
    modalBody.innerHTML = `<pre class="empty-note" style="max-height:520px; overflow:auto; white-space:pre-wrap">${escapeHtml(logs)}</pre>`;
    modalSubmitHandler = closeModal;
    modalBackdrop.classList.add("open");
    modalBackdrop.setAttribute("aria-hidden", "false");
  } catch (error) {
    showToast(error.message);
  }
}

function openGatewayModal(item = null) {
  if (environment.isDemo && environment.demoRunning) return showToast("Stop Demo before changing connections.");
  openFormModal({
    title: item ? "Edit Machine Connection Draft" : "Add Machine Connection",
    submitLabel: item ? "Update Draft" : "Create Draft",
    initial: { ...gatewaySecurityInitial(item ? gatewayConnectionExtras : {}), ...(item ? { mqttAuth: mqttAuthFromConnection(gatewayConnectionExtras).auth, mqttUserEnv: mqttAuthFromConnection(gatewayConnectionExtras).userEnv, mqttPassEnv: mqttAuthFromConnection(gatewayConnectionExtras).passEnv } : { mqttAuth: "Anonymous" }),
      ...(item || { machineId: "machine-1", machineType: "Generic", protocol: "MQTT", endpoint: "tcp://localhost:1883", topicFilter: "", quietWindowMs: 15000, securityPolicy: "None", pollInterval: "2000 ms" }) },
    fields: [
      { name: "machineId", label: "Machine ID" },
      { name: "machineType", label: "Machine Type" },
      { name: "protocol", label: "Protocol", type: "select", options: window.gucGatewayManagement?.protocols() || ["MQTT"] },
      { name: "endpoint", label: "Broker URL / endpoint", full: true },
      { name: "topicFilter", label: "Topic filter (optional, e.g. factory/machine-1/#)" },
      { name: "quietWindowMs", label: "Quiet window (ms)" },
      { name: "mqttAuth", label: "Broker authentication", type: "select", full: true, options: [{ value: "Anonymous", label: "Anonymous" }, { value: "Environment", label: "Username / password from environment variables" }] },
      { name: "mqttUserEnv", label: "Username variable (default DT_MACHINE_USERNAME)" },
      { name: "mqttPassEnv", label: "Password variable (default DT_MACHINE_PASSWORD)" },
      ...gatewaySecurityFields(item ? gatewayConnectionExtras : {})
    ],
    onSubmit: async data => {
      if (environment.isDemo && environment.demoRunning) throw Error("Stop Demo before changing connections.");
      if (!validateRequiredId(data.machineId, "Machine ID") || !validateRequiredId(data.endpoint, "Endpoint")) return false;
      if (data.protocol === "OPC_UA" && data.authentication === "UsernamePassword" && !data.username.trim()) throw Error("Enter a username or choose Anonymous authentication.");
      if (data.protocol === "OPC_UA" && data.authentication === "Environment" && (!data.usernameEnv.trim() || !data.passwordEnv.trim())) throw Error("Enter both credential environment variable names.");
      if (data.protocol === "MQTT" && !/^(tcp|ssl|ws|wss|mqtt):\/\//.test(data.endpoint.trim())) throw Error("The broker URL starts with tcp:// (e.g. tcp://localhost:1883).");
      if (data.protocol === "MQTT" && data.topicFilter.trim() === "#") throw Error("Do not subscribe to # · leave the topic filter empty or scope it to this machine.");
      if (!item) { gatewayConnectionExtras = {}; gatewayTopLevelExtras = {}; mappings = []; }
      gatewayConnectionExtras = data.protocol === "MQTT" ? mqttConnection(gatewayConnectionExtras, data.machineId, data.mqttAuth, data.mqttUserEnv, data.mqttPassEnv) : gatewaySecurityConnection(gatewayConnectionExtras, data, data.protocol);
      const quiet = Number(data.quietWindowMs);
      gatewayConfig = { ...gatewayConfig, machineId: data.machineId, machineType: data.machineType, protocol: data.protocol, endpoint: data.endpoint.trim(), securityPolicy: data.securityPolicy,
        reconnectInitialBackoffMs: item?.reconnectInitialBackoffMs ?? 1000, reconnectMaxBackoffMs: item?.reconnectMaxBackoffMs ?? 30000, topicFilter: data.protocol === "MQTT" ? data.topicFilter.trim() : item?.topicFilter || "", quietWindowMs: Number.isFinite(quiet) && quiet >= 0 ? quiet : (data.protocol === "MQTT" ? 15000 : 0) };
      setGatewayEmpty(false); syncGatewayForm(); document.getElementById("gatewayConfigSelect").value = ""; markGatewayDirty();
      showToast("Machine Connection draft created. Validate and save it to persist the JSON file.");
    }
  });
  const updateSecurity = () => {
    const protocol = document.getElementById("modal-protocol").value, mqtt = protocol === "MQTT", env = document.getElementById("modal-mqttAuth").value === "Environment";
    gatewaySecurityVisibility("modal-", protocol);
    for (const name of ["topicFilter", "quietWindowMs", "mqttAuth"]) document.getElementById("modal-" + name).closest("label").hidden = !mqtt;
    for (const name of ["mqttUserEnv", "mqttPassEnv"]) document.getElementById("modal-" + name).closest("label").hidden = !mqtt || !env;
    document.getElementById("stackModalHint").textContent = mqtt ? "MQTT: the broker URL is the endpoint; each Signal Mapping's source address is a topic. Credentials are stored as ${VARIABLE} placeholders only — enter the values on the System page." : "Security policy and account authentication are separate settings. After creating the draft, use Prepare Certificates before testing a secured connection.";
  };
  modalBody.insertAdjacentHTML("beforeend", '<p class="small" id="stackModalHint"></p>');
  for (const name of ["protocol", "securityPolicy", "authentication", "mqttAuth"]) document.getElementById("modal-" + name).addEventListener("change", updateSecurity);
  updateSecurity();
}

function openMappingModal(item = null, index = -1) {
  if (environment.isDemo && environment.demoRunning) return showToast("Stop Demo before changing mappings.");
  openFormModal({
    title: item ? `Edit Mapping: ${item.idShort}` : "Add Signal Mapping",
    submitLabel: item ? "Save Mapping" : "Add Mapping",
    initial: { category: "VARIABLE", semanticId: "", sourceUnit: "", targetUnit: "", ...(item || { sourceAddress: gatewayConfig.protocol === "MQTT" ? `factory/${gatewayConfig.machineId || "machine-1"}/Temperature` : "ns=2;i=400", idShort: "Temperature", valueType: "xs:double", unit: "" }) },
    fields: [
      { name: "sourceAddress", label: gatewayConfig.protocol === "MQTT" ? "MQTT topic" : "Source Address", full: true },
      { name: "idShort", label: "AAS idShort" },
      { name: "valueType", label: "Value Type", type: "select", options: XS_VALUE_TYPES },
      { name: "unit", label: "Unit" },
      { name: "category", label: "Category", type: "select", options: ["VARIABLE", "PARAMETER", "CONSTANT"] },
      { name: "semanticId", label: "Semantic ID (optional)" },
      { name: "sourceUnit", label: "Source unit (optional, converts to target unit)" },
      { name: "targetUnit", label: "Target unit (optional)" }
    ],
    onSubmit: async data => {
      if (environment.isDemo && environment.demoRunning) throw Error("Stop Demo before changing mappings.");
      if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(data.idShort.trim())) throw Error("idShort must match [a-zA-Z][a-zA-Z0-9_]*.");
      if (gatewayConfig.protocol === "MQTT" && /[#+]/.test(data.sourceAddress)) throw Error("A mapping needs one exact topic (no + or # wildcards).");
      for (const key of ["semanticId", "sourceUnit", "targetUnit"]) { data[key] = data[key].trim(); if (!data[key]) delete data[key]; }
      data.sourceAddress = data.sourceAddress.trim(); data.idShort = data.idShort.trim();
      if (index >= 0) {
        const previousSignalId = mappingSignalId(mappings[index]);
        mappings[index] = { ...mappings[index], ...data };
        if (previousSignalId !== mappingSignalId(mappings[index])) window.gucBindings?.removeGatewayLink?.(previousSignalId);
      }
      else mappings.push(data);
      renderMappings(); markGatewayDirty();
      showToast(index >= 0 ? "Mapping updated." : "Mapping added in demo state.");
    }
  });
}

function openMappingLimitsModal(item, index) {
  if (!isNumericMapping(item)) { showToast("Limits are available only for numeric Signal Mappings."); return; }
  const range = Array.isArray(item.validRange) && item.validRange.length === 2 ? item.validRange : [0, 100];
  openFormModal({
    title: `Set Limits: ${item.idShort}`,
    submitLabel: "Save Limits",
    initial: { minimum: range[0], maximum: range[1], deadband: item.deadband ?? 0 },
    fields: [
      { name: "minimum", label: `Minimum${item.unit ? ` (${item.unit})` : ""}` },
      { name: "maximum", label: `Maximum${item.unit ? ` (${item.unit})` : ""}` },
      { name: "deadband", label: "Deadband", full: true }
    ],
    onSubmit: async data => {
      const minimum = Number(data.minimum), maximum = Number(data.maximum), deadband = Number(data.deadband || 0);
      if (![minimum, maximum, deadband].every(Number.isFinite)) { showToast("Limits and deadband must be valid numbers."); return false; }
      if (minimum >= maximum) { showToast("Minimum must be lower than maximum."); return false; }
      if (deadband < 0 || deadband > maximum - minimum) { showToast("Deadband must be between 0 and the configured range width."); return false; }
      mappings[index] = { ...mappings[index], validRange: [minimum, maximum], deadband };
      renderMappings(); markGatewayDirty(); showToast("Mapping limits updated. Save to Gateway to persist them.");
    }
  });
}

function openMappingLinkModal(item) {
  try { syncCurrentGatewayDraft(); }
  catch (error) { showToast(error.message); return; }
  const signalId = mappingSignalId(item);
  const signal = sharedModel.snapshot().signals.find(entry => entry.id === signalId && !entry.deleted);
  if (!signal) { showToast("Save or reload this Gateway configuration before linking its signal."); return; }
  const currentIds = mappingLinks(item).map(link => link.propertyId);
  openMultiLinkTreeModal({
    title: `Link AAS SMEs: ${item.idShort}`,
    help: `Select one or more AAS Properties. Their value types will be changed to ${item.valueType} when necessary. This Gateway node writes to every selected SME.`,
    treeHtml: aasPropertyMultiTreeHtml(currentIds, item.valueType),
    currentIds,
    onSubmit: async propertyIds => {
      try {
        let changed = 0; for (const propertyId of propertyIds) changed += Number(await forceAasPropertyType(propertyId, item.valueType));
        // A Property is fed by one signal: move links of newly selected Properties away from their old signal.
        const bindings = window.gucBindings, moved = [];
        for (const propertyId of propertyIds.filter(id => !currentIds.includes(id))) {
          for (const link of (bindings.propertyLinks?.(propertyId) || []).filter(l => l.managedBy === "gateway_mapping" && l.signalId !== signalId)) {
            await bindings.replaceGatewayLinks(link.signalId, bindings.gatewayLinks(link.signalId).map(l => l.propertyId).filter(id => id !== propertyId));
            moved.push(link.signal?.targetElement || link.signalId);
          }
        }
        await bindings.replaceGatewayLinks(signalId, propertyIds);
        renderMappings(); renderAas(document.getElementById("aasSearch").value);
        showToast((moved.length ? `Moved from ${moved.join(", ")}: ` : "") + (propertyIds.length ? `${propertyIds.length} Gateway → AAS link${propertyIds.length === 1 ? "" : "s"} saved${changed ? `; ${changed} Property type${changed === 1 ? "" : "s"} changed to ${item.valueType}` : ""}.` : "All AAS SME links removed."));
      } catch (error) { showToast(error.message); return false; }
    }
  });
}

function openAasGatewayLinkModal(propertyId) {
  const property = aasBindingProperties().find(item => item.id === propertyId);
  if (!property) { showToast("AAS Property is unavailable."); return; }
  try { syncCurrentGatewayDraft(); }
  catch (error) { showToast(error.message); return; }
  const bindings = window.gucBindings;
  const links = () => bindings?.propertyLinks?.(propertyId) || [];
  const readLink = () => links().find(link => link.managedBy === "gateway_mapping") || null;   // machine → AAS
  const writeLink = () => links().find(link => link.managedBy === "aas_property") || null;     // AAS → machine
  let direction = writeLink() && !readLink() ? "write" : "read", selectedId = "";
  modalTitle.textContent = `Link Gateway: ${property.path}`;
  modalCancel.style.display = "";
  modalSubmit.className = "btn primary";
  function render() {
    const current = (direction === "read" ? readLink() : writeLink())?.signalId || "";
    selectedId = current;
    modalSubmit.textContent = "Save Link";
    modalBody.innerHTML = `<div class="link-direction" role="radiogroup" aria-label="Direction">
        <label><input type="radio" name="linkDirection" value="read" ${direction === "read" ? "checked" : ""}> <strong>Machine → AAS</strong> <span class="small">the Gateway signal's value is written into this Property (any protocol)</span></label>
        <label><input type="radio" name="linkDirection" value="write" ${direction === "write" ? "checked" : ""}> <strong>AAS → Machine</strong> <span class="small">this Property's value is written to the machine (writable OPC UA nodes only)</span></label>
      </div>
      <p class="small">Select a ${escapeHtml(property.valueType)} Gateway signal${direction === "read" ? "." : ". Read-only nodes and protocols without writes cannot be selected."}</p>
      <div class="link-tree"><button type="button" class="link-tree-leaf${current ? "" : " selected"}" data-link-tree-value=""><span class="link-tree-leaf-copy"><strong>No link</strong><span class="small">Remove the ${direction === "read" ? "Machine → AAS" : "AAS → Machine"} link</span></span></button>${gatewaySignalTreeHtml(current, property.valueType, { write: direction === "write" })}</div>`;
  }
  modalBody.onchange = event => { if (event.target.name === "linkDirection") { direction = event.target.value; render(); } };
  modalBody.onclick = event => {
    const leaf = event.target.closest("[data-link-tree-value]"); if (!leaf) return;
    selectedId = leaf.dataset.linkTreeValue;
    modalBody.querySelectorAll("[data-link-tree-value]").forEach(item => item.classList.toggle("selected", item === leaf));
  };
  modalSubmitHandler = async () => {
    try {
      if (direction === "write") {
        if (!selectedId) await bindings.removeAasLink(propertyId);
        else await bindings.upsertAasLink(propertyId, selectedId);
      } else {
        // One signal writes into a Property: drop other Machine → AAS links of this Property first.
        for (const link of links().filter(item => item.managedBy === "gateway_mapping" && item.signalId !== selectedId)) {
          await bindings.replaceGatewayLinks(link.signalId, bindings.gatewayLinks(link.signalId).map(item => item.propertyId).filter(id => id !== propertyId));
        }
        if (selectedId && !readLink()) await bindings.replaceGatewayLinks(selectedId, [...bindings.gatewayLinks(selectedId).map(item => item.propertyId), propertyId]);
      }
      modalBody.onchange = modalBody.onclick = null;
      closeModal();
      renderAas(document.getElementById("aasSearch").value); renderMappings();
      showToast(selectedId ? `${direction === "read" ? "Machine → AAS" : "AAS → Machine"} link saved.` : "Gateway link removed.");
    } catch (error) { showToast(error.message); }
  };
  render();
  modalBackdrop.classList.add("open"); modalBackdrop.setAttribute("aria-hidden", "false");
}
