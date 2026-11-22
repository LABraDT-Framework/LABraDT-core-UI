// OPC UA security forms share the same saved connection schema as Java Gateway.
function gatewayAuthentication(connection) {
  return connection.authentication || (connection.usernameEnv || connection.passwordEnv ? "Environment" : connection.username || connection.password || connection.passwordSet ? "UsernamePassword" : "Anonymous");
}

function gatewaySecurityInitial(connection = {}) {
  return { securityPolicy: connection.securityPolicy || "None", securityMode: connection.securityMode === "Sign" ? "Sign" : "SignAndEncrypt",
    authentication: gatewayAuthentication(connection), serverCertificate: connection.serverCertificate || "",
    username: connection.username || "", password: connection.password || "",
    usernameEnv: connection.usernameEnv || "", passwordEnv: connection.passwordEnv || "" };
}

function gatewaySecurityFields(connection = {}) {
  const filenames = [...new Set([connection.serverCertificate, ...gatewayServerCertificates.map(cert => cert.fileName)].filter(Boolean))];
  return [
    { name: "securityPolicy", label: "Security Policy", type: "select", options: ["None", "Basic256Sha256"] },
    { name: "securityMode", label: "Security Mode", type: "select", options: ["Sign", "SignAndEncrypt"] },
    { name: "authentication", label: "Authentication", type: "select", full: true, options: [
      { value: "Anonymous", label: "Anonymous" }, { value: "UsernamePassword", label: "Username and password" }, { value: "Environment", label: "Environment variables" }] },
    { name: "username", label: "Username", autocomplete: "off" },
    { name: "password", label: "Password", type: "password", autocomplete: "new-password", placeholder: connection.passwordSet ? "Saved password · leave blank to keep" : "Enter password" },
    { name: "usernameEnv", label: "Username environment variable", placeholder: "GUC_LAB_OPCUA_USERNAME" },
    { name: "passwordEnv", label: "Password environment variable", placeholder: "GUC_LAB_OPCUA_PASSWORD" },
    { name: "serverCertificate", label: "Verified Server Certificate", type: "select", full: true,
      options: [{ value: "", label: "Select a certificate · use Prepare Certificates to add one" }, ...filenames] }
  ];
}

function gatewaySecurityInputId(prefix, name) {
  return prefix === "modal-" ? prefix + name : prefix + name[0].toUpperCase() + name.slice(1);
}

function gatewaySecurityValues(prefix) {
  return Object.fromEntries(gatewaySecurityFields().map(field => [field.name, document.getElementById(gatewaySecurityInputId(prefix, field.name))?.value || ""]));
}

function gatewaySecurityVisibility(prefix, protocol) {
  const values = gatewaySecurityValues(prefix), opcua = protocol === "OPC_UA", secured = opcua && values.securityPolicy !== "None";
  for (const field of gatewaySecurityFields()) {
    const input = document.getElementById(gatewaySecurityInputId(prefix, field.name));
    if (!input) continue;
    const visible = opcua && (!["securityMode", "serverCertificate"].includes(field.name) || secured)
      && (!["username", "password"].includes(field.name) || values.authentication === "UsernamePassword")
      && (!["usernameEnv", "passwordEnv"].includes(field.name) || values.authentication === "Environment");
    input.closest("label").classList.add("opcua-field");
    input.closest("label").hidden = !visible;
    // Hidden inputs are intentionally still read, so switching controls preserves drafts.
  }
  const section = prefix === "gateway" && document.getElementById("gatewaySecuritySection");
  if (section) section.hidden = !opcua;
}

function gatewaySecurityConnection(previous, values, protocol) {
  const connection = { ...previous };
  if (protocol !== "OPC_UA") return connection;
  for (const key of ["securityPolicy", "securityMode", "serverCertificate", "authentication", "username", "password", "usernameEnv", "passwordEnv", "passwordSet"]) delete connection[key];
  connection.securityPolicy = values.securityPolicy || "None";
  connection.securityMode = connection.securityPolicy === "None" ? "None" : values.securityMode || "SignAndEncrypt";
  if (connection.securityPolicy !== "None" && values.serverCertificate) connection.serverCertificate = values.serverCertificate;
  connection.authentication = values.authentication || "Anonymous";
  if (connection.authentication === "UsernamePassword") {
    connection.username = String(values.username || "").trim();
    if (values.password) connection.password = values.password;
    else if (previous.passwordSet) connection.passwordSet = true;
    else if (previous.password && previous.username === connection.username) connection.password = previous.password;
  } else if (connection.authentication === "Environment") {
    connection.usernameEnv = String(values.usernameEnv || "").trim(); connection.passwordEnv = String(values.passwordEnv || "").trim();
  }
  return connection;
}

function gatewayPreviewConnection(connection) {
  const { authentication, passwordSet, ...preview } = connection;
  if ((preview.password && !/^\$\{[^}]+\}$/.test(preview.password)) || passwordSet) preview.password = "•••••• (hidden)";
  return preview;
}

function renderGatewaySecurityForm() {
  const container = document.getElementById("gatewaySecurityFields");
  if (!container) return;
  const connection = { ...gatewayConnectionExtras, securityPolicy: gatewayConfig.securityPolicy || "None" }, initial = gatewaySecurityInitial(connection);
  container.innerHTML = gatewaySecurityFields(connection).map(field => {
    const id = gatewaySecurityInputId("gateway", field.name);
    return fieldHtml(field, initial[field.name]).replaceAll('id="modal-' + field.name + '"', 'id="' + id + '"').replaceAll('for="modal-' + field.name + '"', 'for="' + id + '"');
  }).join("");
  gatewaySecurityVisibility("gateway", gatewayConfig.protocol);
}

function updateGatewayCertificateOptions(selected) {
  const select = document.getElementById("gatewayServerCertificate");
  if (!select) return;
  const current = selected === undefined ? select.value || gatewayConnectionExtras.serverCertificate || "" : selected;
  const field = gatewaySecurityFields({ serverCertificate: current }).find(field => field.name === "serverCertificate");
  select.innerHTML = field.options.map(option => { const value = typeof option === "object" ? option.value : option, label = typeof option === "object" ? option.label : option; return `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`; }).join("");
  select.value = current;
}

async function refreshGatewayCertificates() {
  if (!environment.hasLiveGateway && !environment.isBackend) return;
  try {
    const status = await apiRequest("/api/gateway/opcua/security");
    gatewayServerCertificates = status.serverCertificates || [];
    updateGatewayCertificateOptions();
    return status;
  } catch (_) { /* Detailed errors are shown when Prepare Certificates is opened. */ }
}

async function openOpcuaCertificateSetup() {
  if (environment.isDemo && environment.demoRunning) return showToast("Stop Demo before preparing certificates.");
  if (!environment.hasLiveGateway && !environment.isBackend) return showToast("Certificate preparation needs the running UI controller. Browser simulation does not connect to equipment.");
  gatewayPayload();
  modalTitle.textContent = "Prepare OPC UA Certificates"; modalCancel.style.display = "none"; modalSubmit.textContent = "Done"; modalSubmit.className = "btn primary"; modalSubmitHandler = closeModal;
  modalBody.innerHTML = `<section class="certificate-section"><h3>1. Client identity</h3><div id="opcuaClientStatus" class="small">Loading…</div><div class="component-actions"><button type="button" class="btn blue" id="opcuaGenerateIdentity">Generate / reuse client certificate</button><button type="button" class="btn ghost" id="opcuaDownloadClient">Download public certificate</button></div><p class="small">The machine may require its administrator to approve this client certificate. Existing identities are preserved.</p></section>
    <section class="certificate-section"><h3>2. Server certificate</h3><div class="form-grid"><label class="field full">Import certificate from the machine<input id="opcuaServerFile" type="file" accept=".der,.cer,.crt,.pem" /></label></div><div class="component-actions"><button type="button" class="btn ghost" id="opcuaDiscoverCertificate">Get certificate from current endpoint</button></div><p class="small">Endpoint: <span id="opcuaCertificateEndpoint">${escapeHtml(gatewayConfig.endpoint)}</span> · ${escapeHtml(gatewayConnectionExtras.securityMode === "Sign" ? "Sign" : "SignAndEncrypt")}</p><div id="opcuaServerCandidate" class="certificate-info small">Import a public certificate or retrieve a candidate from the machine.</div><label class="field">SHA-256 fingerprint confirmed with the administrator<input id="opcuaExpectedFingerprint" placeholder="64 hex digits, with or without colons" autocomplete="off" /></label><button type="button" class="btn primary" id="opcuaConfirmCertificate" disabled>Confirm and use server certificate</button><p class="small">Retrieving a certificate does not make it trusted. Confirm the fingerprint independently before using it.</p></section>`;
  modalBackdrop.classList.add("open"); modalBackdrop.setAttribute("aria-hidden", "false");
  const clientStatus = document.getElementById("opcuaClientStatus"), targetMachine = gatewayConfig.machineId, targetEndpoint = gatewayConfig.endpoint;
  const active = () => clientStatus.isConnected && modalBackdrop.classList.contains("open");
  let candidate = null;
  const error = error => active() ? showModalError(error, "Certificate preparation failed.") : showToast(error.message || "Certificate preparation failed.");
  const displayClient = info => {
    if (!active()) return;
    const target = document.getElementById("opcuaClientStatus");
    if (!target) return;
    target.innerHTML = info.state === "ready" ? `<strong>Ready</strong><div class="certificate-info">Application URI: ${escapeHtml(info.applicationUri)}<br>SHA-256: ${escapeHtml(info.fingerprint)}<br>Valid until: ${escapeHtml(info.validUntil)}</div>` : escapeHtml(info.message || info.state);
    document.getElementById("opcuaDownloadClient").disabled = info.state !== "ready";
  };
  const displayCandidate = data => {
    if (!active()) return;
    candidate = data;
    document.getElementById("opcuaExpectedFingerprint").value = "";
    document.getElementById("opcuaServerCandidate").innerHTML = `Subject: ${escapeHtml(data.subject)}<br>Application URI: ${escapeHtml(data.applicationUri)}<br>Hostnames / IPs: ${escapeHtml((data.hosts || []).join(', '))}<br>SHA-256: ${escapeHtml(data.fingerprint)}<br>Valid until: ${escapeHtml(data.validUntil)}`;
    document.getElementById("opcuaConfirmCertificate").disabled = false;
  };
  const post = (action, data = {}) => apiRequest('/api/gateway/opcua/' + action, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
  document.getElementById("opcuaGenerateIdentity").onclick = async event => {
    modalBody.querySelector("#modalError")?.remove();
    event.target.disabled = true;
    try { displayClient(await post("identity")); } catch (failure) { error(failure); } finally { event.target.disabled = false; }
  };
  document.getElementById("opcuaDownloadClient").onclick = async () => {
    try {
      const response = await environment.fetch('/api/gateway/opcua/client-certificate');
      if (!response.ok) throw Error((await response.json()).detail || "Certificate download failed");
      const url = URL.createObjectURL(await response.blob()), link = document.createElement("a"); link.href = url; link.download = "guc-client.der"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (failure) { error(failure); }
  };
  document.getElementById("opcuaServerFile").onchange = async event => {
    modalBody.querySelector("#modalError")?.remove();
    candidate = null; document.getElementById("opcuaConfirmCertificate").disabled = true;
    try {
      const file = event.target.files[0]; if (!file) return;
      if (file.size > 64 * 1024) throw Error("Server certificate exceeds 64 KiB");
      const certificateBase64 = btoa(String.fromCharCode(...new Uint8Array(await file.arrayBuffer())));
      displayCandidate({ ...await post("server-certificate/inspect", { certificateBase64 }), certificateBase64 });
    } catch (failure) { error(failure); }
  };
  document.getElementById("opcuaDiscoverCertificate").onclick = async event => {
    modalBody.querySelector("#modalError")?.remove();
    candidate = null; document.getElementById("opcuaConfirmCertificate").disabled = true; event.target.disabled = true;
    try { displayCandidate(await post("server-certificate/discover", { endpoint: gatewayConfig.endpoint, securityMode: gatewayConnectionExtras.securityMode === "Sign" ? "Sign" : "SignAndEncrypt" })); }
    catch (failure) { error(failure); } finally { event.target.disabled = false; }
  };
  document.getElementById("opcuaConfirmCertificate").onclick = async event => {
    modalBody.querySelector("#modalError")?.remove();
    if (!candidate) return;
    event.target.disabled = true;
    try {
      const cert = await post("server-certificate/confirm", { certificateBase64: candidate.certificateBase64, expectedFingerprint: document.getElementById("opcuaExpectedFingerprint").value });
      if (!active() || gatewayConfig.machineId !== targetMachine || gatewayConfig.endpoint !== targetEndpoint) { showToast("Server certificate confirmed. Select it in the intended machine connection."); return; }
      gatewayConnectionExtras.serverCertificate = cert.fileName;
      gatewayServerCertificates = gatewayServerCertificates.filter(item => item.fileName !== cert.fileName).concat(cert);
      updateGatewayCertificateOptions(cert.fileName); renderMappings(); markGatewayDirty();
      showToast("Server certificate confirmed and selected. Test the connection, then save the machine configuration."); closeModal();
    } catch (failure) { error(failure); event.target.disabled = false; }
  };
  try { const status = await refreshGatewayCertificates(); if (!status) throw Error("Certificate status is unavailable. Check the UI controller."); displayClient(status.client); }
  catch (failure) { error(failure); }
}
