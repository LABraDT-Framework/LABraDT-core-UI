// UI event registration and startup. This must be the final script.


let gatewayConfigs = [], gatewayConnectionExtras = {}, gatewayTopLevelExtras = {};
let mappingAccessRefresh = 0;


document.querySelectorAll(".tab").forEach(tab => tab.addEventListener("click", () => setTab(tab.dataset.tab)));

const GATEWAY_PREVIEW_COLLAPSED_KEY = "guc-gateway-preview-collapsed-v1";
const gatewayTabElement = document.getElementById("gatewayTab");
const gatewayPreviewBody = document.getElementById("gatewayPreviewBody");
const gatewayPreviewToggle = document.getElementById("toggleGatewayPreview");
gatewayPreviewToggle?.addEventListener("click", () => setGatewayPreviewCollapsed(!gatewayTabElement.classList.contains("preview-collapsed")));
setGatewayPreviewCollapsed(appStorage.getItem(GATEWAY_PREVIEW_COLLAPSED_KEY) === "1", false);

const apiBase = location.protocol === "file:" ? null : "";


const gatewayMachineMeta = {};


let lastGatewayStatus = null;


document.getElementById("gatewayStartStop").addEventListener("click", toggleGatewayProcess);
document.getElementById("gatewayRefresh").addEventListener("click", () => refreshGatewayStatus(true));
document.getElementById("gatewayLogs").addEventListener("click", showGatewayLogs);


document.getElementById("engineLogs").addEventListener("click", () => showComponentLogs("Rules"));
document.getElementById("serviceLogs").addEventListener("click", () => showComponentLogs("Services"));


document.getElementById("startAll").addEventListener("click", () => setAllComponents(true));
document.getElementById("stopAll").addEventListener("click", () => setAllComponents(false));


document.getElementById("aasSearch").addEventListener("input", event => renderAas(event.target.value));
document.getElementById("aasTypeFilter").addEventListener("change", () => renderAas(document.getElementById("aasSearch").value));
document.querySelectorAll("[data-repository-mode]").forEach(button => button.addEventListener("click", () => { aasRepositoryMode = button.dataset.repositoryMode; document.getElementById("aasSearch").value = ""; renderAas(); }));
document.getElementById("importAas").addEventListener("click", () => document.getElementById("aasImportFile").click());
document.getElementById("aasImportFile").addEventListener("change", handleAasImport);
document.getElementById("createAas").addEventListener("click", () => openAasModal());
document.getElementById("addGateway").addEventListener("click", () => openGatewayModal());
document.getElementById("addMapping").addEventListener("click", () => openMappingModal());
document.getElementById("loadGatewayConfigs").addEventListener("click", () => loadGatewayConfigs(gatewayConfig.machineId));
document.getElementById("gatewayConfigSelect").addEventListener("change", event => selectGatewayConfig(event.target.value));
document.getElementById("validateGatewayConfig").addEventListener("click", validateGatewayConfig);
document.getElementById("testGatewayConnection").addEventListener("click", testGatewayConnection);
document.getElementById("saveGatewayConfig").addEventListener("click", saveGatewayConfig);
document.getElementById("discoverOpcuaNodes").addEventListener("click", discoverOpcuaNodes);
["gatewayMachineId", "gatewayProtocol", "gatewayEndpoint", "gatewayMachineType", "gatewayReconnectInitial", "gatewayReconnectMax", "gatewayTopicFilter", "gatewayQuietWindow", "gatewayMqttAuth", "gatewayMqttUserEnv", "gatewayMqttPassEnv"].forEach(id => document.getElementById(id).addEventListener("input", () => { gatewayPayload(); renderGatewayProtocolUi(); renderMappings(); markGatewayDirty(); }));
document.getElementById("gatewaySecurityFields").addEventListener("input", () => { gatewayPayload(); gatewaySecurityVisibility("gateway", gatewayConfig.protocol); renderMappings(); markGatewayDirty(); });
document.getElementById("gatewayProtocol").addEventListener("change", () => { gatewaySecurityVisibility("gateway", gatewayConfig.protocol); renderGatewayProtocolUi(); });
document.getElementById("gatewayMqttAuth").addEventListener("change", () => { gatewayPayload(); renderGatewayProtocolUi(); renderMappings(); markGatewayDirty(); });
document.getElementById("prepareOpcuaCertificates").addEventListener("click", openOpcuaCertificateSetup);
document.getElementById("deleteGatewayConfig").addEventListener("click", () => openConnectionManagement("delete"));
document.getElementById("toggleGatewayConnection").addEventListener("click", () => openConnectionManagement("toggle"));
document.getElementById("addService").addEventListener("click", () => openServiceModal());
document.getElementById("addServiceTechnology").addEventListener("click", openServiceTechnologyModal);
document.getElementById("addServiceRunner")?.addEventListener("click", openServiceTechnologyModal);
const serviceDetailFileChooser = GucServiceFiles.attach(document.getElementById("serviceDetailFile"), () => document.getElementById("serviceDetailRuntime").value);
window.gucServiceDetailFile = serviceDetailFileChooser;
document.getElementById("serviceDetailRuntime").addEventListener("change", event => { updateServiceRuntimeSupport(event.target.value); serviceDetailFileChooser.update(); });
document.getElementById("saveServiceDetail").addEventListener("click", async () => {
  const index = services.findIndex(service => service.id === selectedServiceId);
  let data = serviceFromDetail();
  if (index < 0 || !validateServiceData(data, index)) return;
  const button = document.getElementById("saveServiceDetail");
  try {
    button.disabled = true;
    data = GucServiceFiles.apply(data, await GucServiceFiles.prepare(data, job => { if (job.state === "running") showToast(job.step || "Preparing…"); }));
    services[index] = data; selectedServiceId = data.id; await persistServices(); renderServices(); showToast("Service details saved.");
  } catch(error) { showToast(error.message); } finally { button.disabled = false; }
});
document.getElementById("triggerServiceDetail").addEventListener("click", () => triggerService(services.findIndex(service => service.id === selectedServiceId)));
document.getElementById("deleteServiceDetail").addEventListener("click", () => { const index = services.findIndex(service => service.id === selectedServiceId); if (index >= 0) handleAction("delete-service", index); });

document.getElementById("modalClose").addEventListener("click", closeModal);
document.getElementById("modalCancel").addEventListener("click", closeModal);
modalBackdrop.addEventListener("click", event => {
  if (event.target === modalBackdrop) closeModal();
});
modalForm.addEventListener("submit", event => {
  event.preventDefault();
  if (modalSubmitHandler) Promise.resolve(modalSubmitHandler()).catch(error=>showToast(error.message));
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && modalBackdrop.classList.contains("open")) closeModal();
});

document.body.addEventListener("click", event => {
  const action = event.target.dataset.action;
  if (action) { window.lastActionTrigger = event.target; handleAction(action, Number(event.target.dataset.index)).catch(error=>showToast(error.message)); }
  const overviewAasRow = event.target.closest("[data-overview-aas-index]");
  if (overviewAasRow) {
    const item = aasItems[Number(overviewAasRow.dataset.overviewAasIndex)];
    if (item) { selectedAasId = item.id; renderAas(); setTab("aasTab"); }
  }
  const overviewRuleRow = event.target.closest("[data-overview-rule-id]");
  if (overviewRuleRow) {
    setTab("rulesTab");
    requestAnimationFrame(() => document.querySelector(`[data-engine-id="${CSS.escape(overviewRuleRow.dataset.overviewRuleId)}"]`)?.scrollIntoView({ block: "center" }));
  }
  const row = event.target.closest("[data-aas-index]");
  if (row) {
    const item = aasItems[Number(row.dataset.aasIndex)];
    if (item) {
      selectedAasId = item.id;
      document.querySelectorAll("[data-aas-index]").forEach(entry => entry.classList.remove("selected"));
      row.classList.add("selected");
      renderAasDetail(item);
    }
  }
  const serviceRow = event.target.closest("[data-service-index]");
  if (serviceRow) {
    const service = services[Number(serviceRow.dataset.serviceIndex)];
    if (service) { selectedServiceId = service.id; renderServices(); }
  }
});

document.querySelectorAll(".nav button").forEach(btn => btn.addEventListener("click", () => {
  const tabByNav = { aas: "aasTab", gateway: "gatewayTab", bindings: "bindingsTab", engine: "engineTab", services: "servicesTab", rules: "rulesTab", system: "systemTab" };
  if (tabByNav[btn.dataset.nav]) setTab(tabByNav[btn.dataset.nav]);
  else showOverview();
}));


document.getElementById("saveConnectionName").addEventListener("click", () => {
  try { sharedModel.rename("connections", sharedModel.connectionId(document.getElementById("gatewayMachineId").value.trim()), document.getElementById("gatewayDisplayName").value); renderConnectionOptions(); showToast("Display name saved locally; identity unchanged."); }
  catch (error) { showToast(error.message + " Save the machine configuration first."); }
});


try { const savedAas = !environment.isBackend && JSON.parse(appStorage.getItem("guc-aas-demo") || "null"); if (Array.isArray(savedAas)) aasItems = savedAas; } catch {}
sharedModel.subscribe(renderSharedModel);
persistServices();
renderSharedModel();
renderAas();
renderMappings();
renderServices();
updateClock();
setInterval(updateClock, 1000);
const initialTab = { "#aas": "aasTab", "#gateway": "gatewayTab", "#bindings": "bindingsTab", "#engine": "engineTab", "#services": "servicesTab", "#rules": "rulesTab", "#system": "systemTab" }[location.hash];
if (initialTab) setTab(initialTab); else showOverview();
refreshGatewayStatus(false);
loadGatewayConfigs();
if (environment.hasLiveGateway) setInterval(() => refreshGatewayStatus(false), 5000);

window.gucGatewayManagement = GucPluginFlow.init({ model: window.gucModel, toast: showToast });

window.gucLiveData = GucMonitor.init({ model: window.gucModel });
window.gucLiveData.subscribe(renderMappings);
window.gucEngineRuntime = GucEngineRuntime.init({ model: window.gucModel, liveData: window.gucLiveData, triggerService: triggerServiceFromEngine, executeServiceRule: executeServiceRuleFromEngine, toast: showToast });
window.gucEngineBackend = GucEngineBackend.init({ onRegistry: applyBackendServiceRegistry });
window.gucServicePlugins = GucServicePlugins.init({ toast: showToast });
document.getElementById("serviceRefresh")?.addEventListener("click", () => window.gucEngineBackend.refresh());
window.gucBindings = GucBindings.init({ model: window.gucModel, liveData: window.gucLiveData, getAasProperties: aasBindingProperties, setDemoAasValue: setDemoAasBindingValue, toast: showToast, onChange: () => { renderMappings(); renderAas(document.getElementById("aasSearch").value); } });
window.gucAasServiceLinks = GucAasServiceLinks.init({ storage: environment.isBackend ? {getItem:()=>null,setItem:()=>{}} : appStorage, serviceActions: GucServiceActions, persistLinks: environment.isBackend ? links => window.gucBackendWorkspace.saveRules(links) : null, executeRule: environment.isBackend ? rule => window.gucBackendWorkspace.testRule(rule) : null, executeService: async (service, args, context) => {
  if (environment.isBackend) {
    const result = await executeBackendService(service.id, args);
    window.gucEngineBackend?.refresh();
    return result;
  }
  const operation = GucServiceActions.normalizeOperations(service)[0];
  return GucServiceActions.simulate(service, operation.id, args, context);
}, getServices: () => services.map(normalizeService), getProperties: aasBindingProperties, setPropertyValue: setDemoAasBindingValue, parsePropertyValue: (value, valueType) => GucMonitorHelpers.parseTyped(String(value), valueType), workflowHost: document.getElementById("rulesWorkflows"), summaryHost: document.getElementById("overviewRulesList"), addButton: document.getElementById("addRule"), toast: showToast });
if (environment.isBackend) {
  window.gucBackendLifecycle = GucBackendLifecycle.init({toast:showToast});
  aasItems = []; renderAas();
  window.gucBackendWorkspace = GucBackendWorkspace.create({toast:showToast,onAas: items => {
    aasItems = items; if (!items.some(item=>item.id===selectedAasId)) selectedAasId=items[0]?.id || null;
    renderAas(document.getElementById("aasSearch").value);
  }, onServices: (items, metadata) => applyBackendServiceRegistry(items, null, metadata), onRules: (rules,states) => window.gucAasServiceLinks.replace(rules,states) });
  window.gucBackendWorkspace.start();
}
renderMappings(); renderAas(document.getElementById("aasSearch").value);

// Where AAS changes go: always into the engine project's AASX, and into the AAS repository while it runs.
window.addEventListener("labradt:project-status", event => {
  const badge = document.getElementById("aasSourceBadge"); if (!badge) return;
  const live = event.detail?.repository;
  badge.style.display = "";
  badge.textContent = live ? "Repository + engine AASX" : "Saved in engine AASX";
  badge.className = live ? "badge" : "badge draft";
  badge.title = event.detail?.aasx || "";
});
