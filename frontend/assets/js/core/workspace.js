// Classic script: function definitions only; shared state is initialized in app/state.js.

async function reloadWorkspace() {
  const activeNav = document.querySelector(".nav button.active")?.dataset.nav;
  location.hash = activeNav && activeNav !== "overview" ? activeNav : "";
  location.reload();
}

function showOverview() {
  document.querySelector(".content").classList.remove("page-mode");
  document.querySelector(".workspace").classList.add("overview-mode");
  document.querySelectorAll(".tab").forEach(tab => tab.classList.remove("active"));
  document.querySelectorAll(".workspace-body").forEach(body => body.classList.remove("active"));
  document.querySelectorAll(".nav button").forEach(btn => btn.classList.toggle("active", btn.dataset.nav === "overview"));
}

// Tabs without a navigation entry (legacy Engine / Bindings views) fall back to the overview.
const HIDDEN_TABS = new Set(["engineTab", "bindingsTab"]);

function setTab(tabId) {
  if (HIDDEN_TABS.has(tabId)) {
    showOverview();
    return;
  }
  document.querySelector(".content").classList.add("page-mode");
  document.querySelector(".workspace").classList.remove("overview-mode");
  document.querySelectorAll(".tab").forEach(tab => tab.classList.toggle("active", tab.dataset.tab === tabId));
  document.querySelectorAll(".workspace-body").forEach(body => body.classList.toggle("active", body.id === tabId));
  const navMap = { aasTab: "aas", rulesTab: "rules", engineTab: "engine", gatewayTab: "gateway", bindingsTab: "bindings", servicesTab: "services", systemTab: "system" };
  document.querySelectorAll(".nav button").forEach(btn => btn.classList.toggle("active", btn.dataset.nav === (navMap[tabId] || "overview")));
}

function showComponentLogs(component) {
  const recentServiceRuns = serviceExecutions.slice(0, 5).map(run => `[demo ${run.status.toLowerCase()}] ${run.serviceId} · ${new Date(run.startedAt).toLocaleTimeString()}`).join("\n");
  const lines = component === "Rules"
    ? [...(window.gucEngineBackend?.logLines() || ["Java Engine backend is checking…"]), ...(window.gucEngineRuntime?.logLines() || [])].join("\n")
    : [...(window.gucEngineBackend?.serviceLogLines() || ["Services backend is checking…"]), recentServiceRuns].filter(Boolean).join("\n");
  modalTitle.textContent = `${component} Logs`;
  modalCancel.style.display = "none";
  modalSubmit.textContent = "Close"; modalSubmit.className = "btn primary";
  modalBody.innerHTML = `<div class="small">What the UI observed from the Engine and the Service Manager.</div><pre class="empty-note" style="max-height:420px;overflow:auto;white-space:pre-wrap">${escapeHtml(lines)}</pre>`;
  modalSubmitHandler = closeModal; modalBackdrop.classList.add("open"); modalBackdrop.setAttribute("aria-hidden", "false");
}

async function setAllComponents(running) {
  await window.gucBackendLifecycle?.command(running ? "start" : "stop");
}

function renderConnectionOptions() {
  const select = document.getElementById("gatewayConfigSelect"), selected = select.value;
  select.innerHTML = sharedModel.snapshot().connections.filter(item => !item.deleted).map(item => '<option value="' + escapeHtml(item.id) + '">' + escapeHtml(item.name) + ' · ' + escapeHtml(item.machineId) + ' · ' + escapeHtml(item.protocol) + (item.enabled === false ? ' · Disabled' : '') + '</option>').join("") || '<option value="">No saved configuration</option>';
  if ([...select.options].some(option => option.value === selected)) select.value = selected;
}

function renderSharedModel() {
  const model = sharedModel.snapshot(), issues = sharedModel.validate();
  window.gucGatewayManagement?.render();
  const sync = model.gatewaySync;
  document.getElementById("sharedModelStatus").innerHTML = '<p>' + model.connections.filter(item => !item.deleted).length + ' connections · ' + model.signals.filter(item => !item.deleted).length + ' signals · ' + model.services.length + ' Services · ' + model.rules.length + ' rules (' + model.rules.filter(rule => rule.enabled).length + ' enabled)</p><p class="small">Gateway catalog: ' + escapeHtml(sync.status) + (sync.lastSuccessAt ? ' · Last successful load: ' + escapeHtml(sync.lastSuccessAt) : '') + (sync.error ? ' · ' + escapeHtml(sync.error) : '') + '. Cached configuration does not indicate a live connection.</p>' + (issues.length ? '<ul style="color:var(--danger)">' + issues.map(issue => '<li>' + escapeHtml(issue) + '</li>').join('') + '</ul>' : '<p>No missing signal/Service references.</p>');
  document.getElementById("sharedModelSnapshot").textContent = JSON.stringify(model, null, 2);
}

function updateClock() {
  const now = new Date();
  document.getElementById("systemTime").textContent = now.toLocaleString();
}
