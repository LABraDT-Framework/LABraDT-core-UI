// Classic script: function definitions only; shared state is initialized in app/state.js.

function runtimeTypeFor(service) {
  if (serviceRuntimeTypes[service.runtimeType]) return service.runtimeType;
  return Object.keys(serviceRuntimeTypes).find(key => serviceRuntimeTypes[key].adapter === service.adapter) || String(service.adapter || "LUA");
}

function serviceTechnologyOptions() {
  return Object.entries(serviceRuntimeTypes).map(([value, technology]) => ({ value, label: `${technology.category} / ${technology.adapter} · ${technology.label}` }));
}

function renderServiceTechnologyOptions() {
  const select = document.getElementById("serviceDetailRuntime");
  if (!select) return;
  const selected = select.value;
  select.innerHTML = serviceTechnologyOptions().map(option => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`).join("");
  if ([...select.options].some(option => option.value === selected)) select.value = selected;
}

function renderOverviewServiceTechnologies() {
  const runtimes = window.GucServicePlugins;
  const overview = document.getElementById("overviewServiceTechnologies");
  if (overview) overview.innerHTML = runtimes ? runtimes.renderRunnerGroups(serviceRuntimeTypes, services, { compact: true }) : "";
  const tab = document.getElementById("serviceRunnerGroups");
  if (tab) tab.innerHTML = runtimes ? runtimes.renderRunnerGroups(serviceRuntimeTypes, services) : "";
  const count = document.getElementById("serviceRunnerCount");
  if (count) {
    const total = Object.values(serviceRuntimeTypes).filter(t => !t.via).length;
    count.textContent = `${total} runtime${total === 1 ? "" : "s"}`;
    count.className = total ? "badge" : "badge draft";
  }
}

function openServiceTechnologyModal() {
  window.gucServicePlugins?.open();
}

function normalizeService(service) {
  const runtimeType = runtimeTypeFor(service), mapping = serviceRuntimeTypes[runtimeType], operations = GucServiceActions.normalizeOperations(service), operation = operations[0];
  const outputTypeKnown = typeof service.outputTypeKnown === "boolean" ? service.outputTypeKnown : service.status !== "Backend";
  return { ...service, runtimeType, category: mapping?.category || service.category, adapter: mapping?.adapter || service.adapter, name: service.name || service.id, description: service.description || "", defaultArgs: service.defaultArgs || "{}", outputTypeKnown, operations, operationId: operation.id, operationName: operation.name, input: operation.input, output: operation.output, resultArg: operation.resultArg };
}

function serviceRuntimeSupportText(service) {
  const runtime = serviceRuntimeTypes[service.runtimeType];
  if (!runtime) return "No runtime installed";
  if (!runtime.backend) return "Runtime unavailable";
  return runtime.source === "plugin" && runtime.status && runtime.status !== "Loaded" ? `Runtime ${runtime.status.toLowerCase()}` : "Runtime ready";
}

function serviceTechnologyText(service) {
  const runtime = serviceRuntimeTypes[service.runtimeType];
  return `${runtime?.category || service.category || "?"} / ${runtime?.adapter || service.adapter || service.runtimeType}`;
}

function updateServiceRuntimeSupport(runtimeType) {
  const target = document.getElementById("serviceRuntimeSupport"), runtime = serviceRuntimeTypes[runtimeType];
  if (!target) return;
  if (!runtime) target.textContent = `No runtime for ${runtimeType || "this technology"} is installed: add its service plugin.`;
  else target.textContent = runtime.backend ? `Runtime ${runtime.category} / ${runtime.adapter}${runtime.via ? " (via " + runtime.via + ")" : ""}${runtime.status && runtime.status !== "Loaded" ? " · " + runtime.status : ""}` : `${runtime.label || runtimeType} is not available on the Runtime`;
}

function applyBackendServiceRegistry(items, error, metadata) {
  if (!environment.isBackend) return;
  if (!metadata && window.gucBackendWorkspace) return;
  if (error) {
    serviceRegistryError = String(error);
    serviceRegistrySource = "backend-cache";
    renderServices();
    return;
  }
  if (!Array.isArray(items) || items.some(item => !item || typeof item.serviceId !== "string" || !item.serviceId)) throw new Error("Service Registry returned invalid definitions.");
  const ordered = [...items].sort((a,b) => Number(Boolean(b.defaultArgs?.testContent)) - Number(Boolean(a.defaultArgs?.testContent)) || a.serviceId.localeCompare(b.serviceId));
  const next = ordered.map(item => normalizeService({ ...(metadata?.[item.serviceId] || {}), id: item.serviceId, name: item.displayName || item.serviceId, description: item.description || "", category: item.executionCategory, adapter: item.technologyAdapter, file: item.fileReference || (item.defaultArgs?.image ? "[image] " + item.defaultArgs.image : item.technologyAdapter === "LUA" ? "[inline Lua]" : ""), defaultArgs: JSON.stringify(GucServiceActions.orderedRegistryArgs(item.defaultArgs || {}, metadata?.[item.serviceId]?.defaultArgs), null, 2), input: metadata?.[item.serviceId]?.input || "", output: metadata?.[item.serviceId]?.output || "result:any", outputTypeKnown: metadata?.[item.serviceId]?.outputTypeKnown || false, status: metadata?.[item.serviceId]?.status || "Ready" }));
  serviceRegistrySource = window.gucProjectStatus && !window.gucProjectStatus.runtime ? "project" : "backend";
  serviceRegistryError = "";
  if (JSON.stringify(next) !== JSON.stringify(services)) {
    services = next;
    sharedModel.replaceServices(services);
    renderServices();
    renderSharedModel();
  } else renderServices();
}

async function persistServices() {
  if (environment.isBackend && window.gucBackendWorkspace) await window.gucBackendWorkspace.saveServices(services);
  sharedModel.replaceServices(services);
}

function validateServiceData(data, index = -1) {
  if (!validateRequiredId(data.id, "Service ID") || !validateRequiredId(data.name, "Display Name")) return false;
  if (!GucServiceActions.hasExecutionLocation(data)) { showToast("Provide File / Endpoint, REST defaultArgs.url, or inline Lua defaultArgs.testContent."); return false; }
  if (services.some((service, serviceIndex) => serviceIndex !== index && service.id === data.id)) { showToast(`Service ID '${data.id}' already exists.`); return false; }
  if (!serviceRuntimeTypes[data.runtimeType]) { showToast("Select an installed runtime (technology). Add its service plugin first."); return false; }
  try { JSON.parse(data.defaultArgs || "{}"); } catch { showToast("Default Args must contain valid JSON."); return false; }
  const operation = data.operations?.[0];
  if (!operation?.id || !/^[A-Za-z_$][A-Za-z0-9_$.-]*$/.test(operation.id)) { showToast("Function / Operation ID is required and must be a valid entry-point name."); return false; }
  if (!operation.name || !operation.output || !operation.resultArg) { showToast("Function display name, output definition and result argument are required."); return false; }
  return true;
}

function renderServiceDetail() {
  const service = services.find(entry => entry.id === selectedServiceId);
  const section = document.getElementById("serviceDetailSection");
  if (!service) { section.style.display = "none"; return; }
  section.style.display = "block";
  const normalized = normalizeService(service);
  const set = (id, value) => { document.getElementById(id).value = value || ""; };
  set("serviceDetailId", normalized.id); set("serviceDetailName", normalized.name);
  const runtimeSelect = document.getElementById("serviceDetailRuntime");
  runtimeSelect.querySelectorAll("option[data-missing]").forEach(option => option.remove());
  if (normalized.runtimeType && !serviceRuntimeTypes[normalized.runtimeType]) runtimeSelect.insertAdjacentHTML("beforeend", `<option value="${escapeHtml(normalized.runtimeType)}" data-missing>${escapeHtml(serviceTechnologyText(normalized))} (no runtime)</option>`);
  set("serviceDetailRuntime", normalized.runtimeType);
  set("serviceDetailFile", normalized.file); set("serviceDetailDescription", normalized.description);
  set("serviceDetailArgs", normalized.defaultArgs); set("serviceDetailOperationId", normalized.operationId); set("serviceDetailOperationName", normalized.operationName); set("serviceDetailInput", normalized.input); set("serviceDetailOutput", normalized.output); set("serviceDetailResultArg", normalized.resultArg);
  const detailBadge = document.getElementById("serviceDetailBadge");
  detailBadge.textContent = normalized.status;
  detailBadge.className = normalized.status === "Draft" ? "badge draft" : "badge";
  updateServiceRuntimeSupport(normalized.runtimeType);
  window.gucServiceDetailFile?.update();
  section.querySelectorAll("input, select, textarea").forEach(control => control.disabled = false);
  document.getElementById("saveServiceDetail").disabled = false;
  document.getElementById("deleteServiceDetail").disabled = false;
  document.getElementById("triggerServiceDetail").textContent = "Test Trigger";
}

function renderServices() {
  renderServiceTechnologyOptions();
  renderOverviewServiceTechnologies();
  services = services.map(normalizeService);
  if (!services.some(service => service.id === selectedServiceId)) selectedServiceId = services[0]?.id || null;
  document.getElementById("serviceRows").innerHTML = services.map(row => `
    <tr class="${row.id === selectedServiceId ? "selected" : ""}" data-service-index="${services.indexOf(row)}"><td>${escapeHtml(row.id)}<div class="small">Function: ${escapeHtml(row.operationId)}</div></td><td><code>${escapeHtml(serviceTechnologyText(row))}</code><div class="small">${escapeHtml(serviceRuntimeTypes[row.runtimeType]?.label || "")}</div></td><td>${escapeHtml(row.file)}</td><td><span class="badge ${!serviceRuntimeTypes[row.runtimeType] || serviceRuntimeTypes[row.runtimeType].backend === false ? "warning" : serviceRuntimeSupportText(row) === "Runtime ready" ? "" : "warning"}">${escapeHtml(serviceRuntimeSupportText(row))}</span></td><td>${badge(row.status)}</td>
    <td><div class="row-actions"><button class="link-btn" data-action="edit-service" data-index="${services.indexOf(row)}">Edit</button><button class="link-btn" data-action="trigger-service" data-index="${services.indexOf(row)}">Test Trigger</button><button class="link-btn" data-action="delete-service" data-index="${services.indexOf(row)}">Delete</button></div></td></tr>
  `).join("");
  document.getElementById("serviceCount").textContent = `${services.length} services`;
  const source = document.getElementById("serviceRegistrySource");
  source.textContent = serviceRegistrySource === "backend" ? "Live registry" : serviceRegistrySource === "project" ? "Saved in runtime project" : serviceRegistrySource === "backend-cache" ? "Registry unavailable" : "Checking…";
  source.title = serviceRegistrySource === "project" ? "Changes are kept in the runtime project (config/services.json) and registered when the Runtime starts." : serviceRegistryError;
  source.className = serviceRegistrySource === "backend" ? "badge" : serviceRegistrySource === "project" ? "badge draft" : "badge warning";
  document.getElementById("addService").disabled = false;
  renderServiceDetail();
}

function serviceFromDetail() {
  const runtimeType = document.getElementById("serviceDetailRuntime").value, mapping = serviceRuntimeTypes[runtimeType];
  return {
    id: document.getElementById("serviceDetailId").value.trim(),
    name: document.getElementById("serviceDetailName").value.trim(),
    runtimeType,
    category: mapping.category,
    adapter: mapping.adapter,
    file: document.getElementById("serviceDetailFile").value.trim(),
    description: document.getElementById("serviceDetailDescription").value.trim(),
    defaultArgs: document.getElementById("serviceDetailArgs").value.trim() || "{}",
    operations: [{ id: document.getElementById("serviceDetailOperationId").value.trim(), name: document.getElementById("serviceDetailOperationName").value.trim(), input: document.getElementById("serviceDetailInput").value.trim(), output: document.getElementById("serviceDetailOutput").value.trim(), resultArg: document.getElementById("serviceDetailResultArg").value.trim() }],
    status: services.find(service => service.id === selectedServiceId)?.status || "Draft"
  };
}

function normalizeBackendOutput(outputData) {
  if (typeof outputData !== "string") return outputData;
  const value = outputData.trim();
  if (!value) return outputData;
  if (/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) return Number(value);
  if (/^(?:true|false|null)$/i.test(value) || /^[\[{]/.test(value)) {
    try { return JSON.parse(value); } catch {}
  }
  return outputData;
}

async function executeBackendService(serviceId, dynamicArgs = {}, onStatus = () => {}) {
  const accepted = await apiRequest("/api/services/trigger", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serviceIds: [serviceId], dynamicArgs: Object.fromEntries(Object.entries(dynamicArgs).map(([key, value]) => [key, String(value)])) })
  });
  const execution = accepted?.triggered?.[0];
  if (!execution?.executionId) throw new Error("Service Manager accepted the request without an execution ID.");
  onStatus(execution.status || "ACCEPTED", execution.executionId);
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const status = await apiRequest(`/api/services/status?executionId=${encodeURIComponent(execution.executionId)}`);
    onStatus(status.status, execution.executionId);
    if (["COMPLETED", "FAILED", "CANCELLED", "NOT_FOUND"].includes(status.status)) {
      if (status.status === "NOT_FOUND") throw new Error("Service execution disappeared from the backend tracker.");
      const result = await apiRequest(`/api/services/result?executionId=${encodeURIComponent(execution.executionId)}`);
      if (status.status !== "COMPLETED" || result.success === false) throw new Error(result.errorMessage || `Service execution ${status.status.toLowerCase()}.`);
      const outputData = normalizeBackendOutput(result.outputData);
      return { ...result, outputData, executionId: execution.executionId, status: status.status, output: { result: outputData } };
    }
    await new Promise(resolve => window.setTimeout(resolve, 150));
  }
  throw new Error("Service execution timed out while waiting for the backend result.");
}

async function triggerService(index) {
  const service = services[index]; if (!service) return;
  const operation = GucServiceActions.normalizeOperations(service)[0];
  const mutableDemoDefinition = !environment.isBackend;
  if (mutableDemoDefinition) service.status = "Running";
  selectedServiceId = service.id;
  if (mutableDemoDefinition) persistServices();
  renderServices();
  const started = new Date();
  const execution = { serviceId: service.id, operationId: operation.id, startedAt: started.toISOString(), status: "Running", output: null };
  serviceExecutions.unshift(execution);
  modalTitle.textContent = `Test Function: ${service.id} → ${operation.id}`;
  modalCancel.style.display = "none";
  modalSubmit.textContent = "Close"; modalSubmit.className = "btn primary";
  modalBody.innerHTML = `<div class="detail-grid"><span>Status</span><strong id="serviceRunStatus">Running</strong><span>Execution</span><strong id="serviceRunExecution">Waiting for ID</strong><span>Started</span><strong>${escapeHtml(started.toLocaleTimeString())}</strong></div><pre class="empty-note" id="serviceRunLog" style="max-height:320px;overflow:auto;white-space:pre-wrap">[queued] ${mutableDemoDefinition ? "Demo invocation" : "Backend invocation"} accepted</pre>`;
  modalSubmitHandler = closeModal; modalBackdrop.classList.add("open"); modalBackdrop.setAttribute("aria-hidden", "false");
  try {
    const result = mutableDemoDefinition
      ? await new Promise(resolve => window.setTimeout(() => resolve(GucServiceActions.simulate(service, operation.id, {}, { value: null, ruleId: "manual-service-test" })), 350))
      : await executeBackendService(service.id, {}, (status, executionId) => {
          const statusNode = document.getElementById("serviceRunStatus"), executionNode = document.getElementById("serviceRunExecution");
          if (statusNode) statusNode.textContent = status;
          if (executionNode) executionNode.textContent = executionId;
        });
    execution.status = "Success"; execution.output = result.output;
    execution.executionId = result.executionId || execution.executionId;
    if (mutableDemoDefinition) { service.status = "Ready"; persistServices(); }
    renderServices();
    const status = document.getElementById("serviceRunStatus"), log = document.getElementById("serviceRunLog");
    if (status) status.textContent = "Success";
    if (log) log.textContent += `\n[success] Completed in ${Math.max(1, Date.now() - started.getTime())} ms\n[output] ${JSON.stringify(result.outputData)}`;
    showToast(`${service.id}.${operation.id} completed successfully.`);
    window.gucEngineRuntime?.serviceCompleted({ serviceId: service.id, operationId: operation.id, outputData: result.outputData, source: "manual-service-test" }).catch(error => showToast(error.message));
    window.gucEngineBackend?.refresh();
  } catch (error) {
    execution.status = "Failed"; execution.output = { error: error.message };
    if (mutableDemoDefinition) { service.status = "Ready"; persistServices(); }
    renderServices();
    const status = document.getElementById("serviceRunStatus"), log = document.getElementById("serviceRunLog");
    if (status) status.textContent = "Failed";
    if (log) log.textContent += `\n[failed] ${error.message}`;
    showToast(error.message);
  }
}

async function triggerServiceFromEngine(serviceId, context) {
  const service = services.find(item => item.id === serviceId);
  if (!service) throw new Error(`Service '${serviceId}' is not registered.`);
  const started = new Date(), executionId = context.executionId || `browser:${Date.now().toString(36)}`;
  const mutableDemoDefinition = !environment.isBackend;
  if (mutableDemoDefinition) service.status = "Running";
  const execution = { executionId, serviceId, operationId: context.operationId, ruleId: context.ruleId, startedAt: started.toISOString(), status: "Running", output: null, source: context.test ? "Rule test" : "Engine runtime" };
  serviceExecutions.unshift(execution);
  if (mutableDemoDefinition) persistServices();
  renderServices();
  try {
    const result = mutableDemoDefinition
      ? await new Promise(resolve => window.setTimeout(() => resolve(GucServiceActions.simulate(service, context.operationId, context.dynamicArgs, context)), 350))
      : await executeBackendService(serviceId, context.dynamicArgs);
    const outputAppliedTo = await applyDemoServiceOutput(context.outputMapping, context.signalId, result.outputData);
    execution.executionId = result.executionId || executionId;
    execution.status = "Success"; execution.output = result.output; execution.outputAppliedTo = outputAppliedTo;
    if (mutableDemoDefinition) { service.status = "Ready"; persistServices(); }
    renderServices(); window.gucEngineBackend?.refresh();
    showToast(`${serviceId} completed for ${context.ruleId}.`);
    return { executionId: execution.executionId, status: mutableDemoDefinition ? "Simulated Success" : "Backend Success", output: result.output, outputData: result.outputData, outputAppliedTo };
  } catch (error) {
    execution.status = "Failed"; execution.output = { error: error.message };
    if (mutableDemoDefinition) { service.status = "Ready"; persistServices(); }
    renderServices(); throw error;
  }
}

async function applyGatewayDemoValue(signalId, outputData) {
  const signal = sharedModel.snapshot().signals.find(item => item.id === signalId && !item.deleted);
  if (!signal) throw new Error("Output Gateway signal is missing.");
  if (window.gucBindings?.propagateGatewayValue) {
    const propagated = await window.gucBindings.propagateGatewayValue(signal.id, outputData);
    return `Gateway · ${signal.targetElement}` + (propagated.aasTargets.length ? ` → AAS · ${propagated.aasTargets.join(", ")}` : "");
  }
  window.gucLiveData.useDemo(false);
  window.gucLiveData.setDemoValue(signal.id, outputData);
  return `Gateway · ${signal.targetElement}`;
}

async function executeServiceRuleFromEngine(rule, event) {
  const outputAppliedTo = await applyGatewayDemoValue(rule.signalId, event.outputData);
  return { status: "Simulated Success", outputData: event.outputData, outputAppliedTo };
}

async function applyDemoServiceOutput(mapping, triggeringSignalId, outputData) {
  const kind = mapping?.kind || "none";
  if (kind === "none") return "Result only";
  if (kind === "trigger_signal") {
    return applyGatewayDemoValue(triggeringSignalId, outputData);
  }
  if (kind === "gateway_signal") {
    return applyGatewayDemoValue(mapping.targetId, outputData);
  }
  if (kind === "aas_property") {
    const property = aasBindingProperties().find(item => item.id === mapping.targetId);
    if (!property) throw new Error("Output AAS Property is missing.");
    const parsed = GucMonitorHelpers.parseTyped(String(outputData), property.valueType);
    await setDemoAasBindingValue(property.id, parsed);
    return `AAS · ${property.submodelName || property.submodelId} / ${property.path}`;
  }
  throw new Error("Unsupported output mapping.");
}

function openServiceModal(item = null, index = -1) {
  const types = serviceTechnologyOptions();
  if (!item && !types.length) return showToast("No runtime installed yet: Add Service Plugin first (Services → Runtimes).");
  openFormModal({
    title: item ? `Edit Service: ${item.id}` : "Register Service",
    submitLabel: item ? "Save Service" : "Register Service",
    initial: normalizeService(item || { id: "new-service", name: "New Service", runtimeType: types[0].value, file: "", description: "", defaultArgs: "{}", operationId: "execute", operationName: "Execute", input: "", output: "result:string", resultArg: "result", status: "Draft" }),
    fields: [
      { name: "id", label: "Service ID" },
      { name: "name", label: "Display Name" },
      { name: "runtimeType", label: "Runtime (technology)", type: "select", options: serviceTechnologyOptions() },
      { name: "file", label: "File / Endpoint (file, folder, URL or any value)", full: true },
      { name: "description", label: "Description", type: "textarea", rows: 3, full: true },
      { name: "defaultArgs", label: "Default Args (JSON)", type: "textarea", rows: 4, full: true },
      { name: "operationId", label: "Function / Operation ID" },
      { name: "operationName", label: "Function Display Name" },
      { name: "input", label: "Input Definition" },
      { name: "output", label: "Output Definition" },
      { name: "resultArg", label: "Result Argument", full: true },
      { name: "status", label: "Status", type: "select", options: ["Ready", "Draft"] }
    ],
    onSubmit: async data => {
      Object.keys(data).forEach(key => data[key] = data[key].trim());
      const mapping = serviceRuntimeTypes[data.runtimeType]; data.category = mapping?.category; data.adapter = mapping?.adapter;
      data.operations = [{ id: data.operationId, name: data.operationName, input: data.input, output: data.output, resultArg: data.resultArg }];
      if (!validateServiceData(data, index)) return false;
      try { data = GucServiceFiles.apply(data, await GucServiceFiles.prepare(data, GucServiceFiles.progress(modalBody))); }
      catch (error) { showToast(error.message); return false; }
      if (index >= 0) services[index] = data; else services.unshift(data);
      selectedServiceId = data.id; await persistServices(); renderServices();
      showToast(index >= 0 ? "Service updated." : "Service registered.");
    }
  });
  const runtimeSelect = document.getElementById("modal-runtimeType");
  const chooser = GucServiceFiles.attach(document.getElementById("modal-file"), () => runtimeSelect.value);
  runtimeSelect.addEventListener("change", chooser.update);
}
