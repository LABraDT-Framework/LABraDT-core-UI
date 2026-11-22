(function (root) {
    "use strict";

    const STORAGE_KEY = "guc-aas-service-links-v1";
    const VERSION = 3;
    const clone = value => JSON.parse(JSON.stringify(value));
    const backendConfigArgs = new Set(["testContent", "url", "httpMethod", "headers", "payload"]);
    const numericTypes = new Set(["number", "float", "double", "integer", "int", "long", "short", "decimal", "xs:double", "xs:float", "xs:int", "xs:integer", "xs:long", "xs:short", "xs:decimal"]);
    const booleanTypes = new Set(["bool", "boolean", "xs:boolean"]);
    const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
    // Where a saved rule runs: rules the Engine can run are written into the engine AASX (Rules_SM).
    const executorNote = link => link.executor === "engine"
        ? ' <span class="badge" title="Saved in the engine project AASX; the Engine runs it.">Engine · ' + esc(link.engineRule || "AASX") + '</span>'
        : link.executor === "ui" ? ' <span class="badge draft" title="' + esc(link.executorReason || "") + '">UI only · ' + esc(link.executorReason || "") + '</span>' : "";

    function parseDefinition(definition) {
        return String(definition || "")
            .split(",")
            .map(item => item.trim())
            .filter(Boolean)
            .map((item, index) => {
                const separator = item.indexOf(":");
                const name = (separator < 0 ? item : item.slice(0, separator)).trim() || "arg" + (index + 1);
                const type = (separator < 0 ? "string" : item.slice(separator + 1)).trim().toLowerCase() || "string";
                return { name, type };
            });
    }

    function castValue(value, type = "string") {
        const normalized = String(type || "string").toLowerCase();
        if (numericTypes.has(normalized)) {
            const number = Number(value);
            if (!Number.isFinite(number)) throw Error("Value '" + value + "' is not a valid " + type + ".");
            return ["integer", "int", "long", "short", "xs:int", "xs:integer", "xs:long", "xs:short"].includes(normalized) ? Math.trunc(number) : number;
        }
        if (booleanTypes.has(normalized)) {
            if (typeof value === "boolean") return value;
            const raw = String(value).trim().toLowerCase();
            if (!["true", "false"].includes(raw)) throw Error("Value '" + value + "' is not a valid boolean.");
            return raw === "true";
        }
        return String(value ?? "");
    }

    function compareValues(left, operator, right) {
        const leftNumber = Number(left), rightNumber = Number(right);
        const numeric = String(left).trim() !== "" && String(right).trim() !== "" && Number.isFinite(leftNumber) && Number.isFinite(rightNumber);
        const a = numeric ? leftNumber : left;
        const b = numeric ? rightNumber : right;
        if (operator === ">") return a > b;
        if (operator === "<") return a < b;
        if (operator === ">=") return a >= b;
        if (operator === "<=") return a <= b;
        if (operator === "=") return a === b || String(a) === String(b);
        if (operator === "!=") return !(a === b || String(a) === String(b));
        throw Error("Unsupported comparison operator '" + operator + "'.");
    }

    function operationsFor(service, serviceActions) {
        return service ? serviceActions.normalizeOperations(service) : [];
    }

    function normalizedCondition(condition) {
        return {
            operator: condition?.operator || ">=",
            right: { source: "constant", value: condition?.right?.source === "constant" ? condition.right.value : "0" }
        };
    }

    function monitorsForLink(link) {
        if (Array.isArray(link?.monitors) && link.monitors.length) {
            return link.monitors.map(item => ({ propertyId: item?.propertyId || "", condition: normalizedCondition(item?.condition) }));
        }
        return [{ propertyId: link?.propertyId || "", condition: normalizedCondition(link?.condition) }];
    }

    function conditionModeForLink(link) {
        return String(link?.conditionMode || "AND").toUpperCase() === "OR" ? "OR" : "AND";
    }

    function serviceOutputTypeKnown(service) {
        // The current Service Manager registry has no output-schema field and
        // ExecutionResponseDTO transports every output as a String.  Older
        // browser caches may still contain outputTypeKnown=true together with
        // the UI fallback "result:string"; neither is a real backend schema.
        if (service?.status === "Backend") return false;
        if (typeof service?.outputTypeKnown === "boolean") return service.outputTypeKnown;
        return true;
    }

    function parametersForService(service, serviceActions) {
        let defaults = {};
        try { defaults = serviceActions.parseObject(service?.defaultArgs || "{}"); } catch {}
        const configured = Object.entries(defaults).filter(([name]) => !backendConfigArgs.has(name)).map(([name, value]) => ({
            name,
            type: typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean" : "string",
            defaultValue: value
        }));
        if (configured.length) return configured;
        const operation = operationsFor(service, serviceActions)[0];
        return parseDefinition(operation?.input).map(parameter => ({ ...parameter, defaultValue: "" }));
    }

    function validateBindings(bindings, parameters, properties, label) {
        const errors = [], propertyIds = new Set(properties.map(item => item.id));
        for (const parameter of parameters) {
            const binding = bindings?.[parameter.name];
            if (!binding || !["property", "constant"].includes(binding.source)) {
                errors.push(label + " parameter '" + parameter.name + "' needs a source.");
                continue;
            }
            if (binding.source === "property" && !propertyIds.has(binding.propertyId)) errors.push(label + " parameter '" + parameter.name + "' references a missing SME.");
            if (binding.source === "constant") {
                try { castValue(binding.value, parameter.type); }
                catch (error) { errors.push(label + " parameter '" + parameter.name + ": " + error.message); }
            }
        }
        return errors;
    }

    function validateLink(link, services, properties, serviceActions) {
        const errors = [], propertyIds = new Set(properties.map(item => item.id));
        if (!String(link?.name || "").trim()) errors.push("Rule name is required.");
        const monitors = monitorsForLink(link), conditionMode = conditionModeForLink(link);
        if (!monitors.length) errors.push("Add at least one Monitored SME.");
        if (!["AND", "OR"].includes(conditionMode)) errors.push("Select AND or OR for the condition group.");
        const seenProperties = new Set();
        monitors.forEach((monitor, index) => {
            const monitoredProperty = properties.find(item => item.id === monitor.propertyId);
            const label = "Condition " + (index + 1);
            if (!monitoredProperty) errors.push(label + ": Monitored SME is missing.");
            else if (seenProperties.has(monitor.propertyId)) errors.push(label + ": the same Monitored SME cannot be added twice.");
            else seenProperties.add(monitor.propertyId);
            if (![">", "<", "=", ">=", "<=", "!="].includes(monitor.condition?.operator)) errors.push(label + ": select a supported operator.");
            if (!monitor.condition?.right || monitor.condition.right.source !== "constant" || String(monitor.condition.right.value ?? "").trim() === "") errors.push(label + ": threshold is required.");
            else if (monitoredProperty) {
                try { castValue(monitor.condition.right.value, monitoredProperty.valueType); }
                catch (error) { errors.push(label + ": " + error.message); }
            }
        });

        const service = services.find(item => item.id === link?.serviceCall?.serviceId);
        const operation = operationsFor(service, serviceActions)[0];
        if (!service) errors.push("Select an available Service.");
        else if (!operation) errors.push("The selected Service has no executable operation.");
        else errors.push(...validateBindings(link.serviceCall.bindings, parametersForService(service, serviceActions), properties, "Service"));

        if (!link?.output || !["none", "aas_property"].includes(link.output.kind)) errors.push("Select a supported final output.");
        if (link?.output?.kind === "aas_property") {
            const target = properties.find(item => item.id === link.output.propertyId);
            if (!target) errors.push("Select an available output SME.");
            else if (serviceOutputTypeKnown(service) && operation && !serviceActions.compatibleOutput(operation.output, target.valueType)) errors.push("Service output type is incompatible with the selected output SME.");
        }
        return errors;
    }

    function resolveBinding(binding, parameter, context) {
        if (binding.source === "constant") return castValue(binding.value, parameter.type);
        if (binding.source === "property") {
            const property = context.properties.find(item => item.id === binding.propertyId);
            if (!property) throw Error("Parameter SME is missing.");
            return castValue(property.value, parameter.type);
        }
        throw Error("Unsupported parameter source.");
    }

    function resolveArguments(bindings, parameters, context) {
        const result = {};
        for (const parameter of parameters) result[parameter.name] = resolveBinding(bindings[parameter.name], parameter, context);
        return result;
    }

    function createRuntime(options) {
        const { serviceActions, executeService, getServices, getProperties, setPropertyValue, parsePropertyValue = castValue, onChange = () => {}, getRunToken = () => 0, isRunTokenValid = () => true } = options;
        const running = new Set(), states = new Map();

        function state(engineId) {
            return clone(states.get(engineId) || { status: "Ready", message: "Not run", lastRunAt: null, conditionResult: null, trace: [] });
        }

        function update(engineId, patch) {
            states.set(engineId, { ...state(engineId), ...patch });
            onChange();
        }

        async function execute(link, executionOptions = {}) {
            if (options.executeRule) {
                if (running.has(link.id)) throw Error("This Rule is already running.");
                running.add(link.id); update(link.id,{status:"Running",trace:[]});
                try { const result=await options.executeRule(clone(link)); update(link.id,result); return result; }
                catch(error) { update(link.id,{status:"Failed",message:error.message,trace:[{label:"Error",detail:error.message,status:"Failed"}]}); throw error; }
                finally { running.delete(link.id); }
            }
            const token = getRunToken();
            if (!isRunTokenValid(token)) throw Error("Start Demo before running Rules.");
            const services = getServices(), properties = getProperties();
            const errors = validateLink(link, services, properties, serviceActions);
            if (errors.length) throw Error(errors.join(" "));
            if (running.has(link.id)) throw Error("This Rule is already running.");
            running.add(link.id);
            const startedAt = new Date().toISOString(), trace = [];
            update(link.id, { status: "Running", message: executionOptions.test ? "Test running" : "Triggered by SME update", lastRunAt: startedAt, trace: [] });
            let conditionResult = null;
            try {
                const monitors = monitorsForLink(link), conditionMode = conditionModeForLink(link);
                const evaluations = monitors.map((monitor, index) => {
                    const property = properties.find(item => item.id === monitor.propertyId);
                    const rightValue = castValue(monitor.condition.right.value, property.valueType);
                    const result = compareValues(property.value, monitor.condition.operator, rightValue);
                    trace.push({ label: monitors.length === 1 ? "Condition" : "Condition " + (index + 1), detail: (property.path || property.id) + ": " + String(property.value) + " " + monitor.condition.operator + " " + String(rightValue) + " → " + String(result), status: result ? "True" : "False" });
                    return { property, result };
                });
                conditionResult = conditionMode === "OR" ? evaluations.some(item => item.result) : evaluations.every(item => item.result);
                if (evaluations.length > 1) trace.push({ label: "Condition group", detail: evaluations.map(item => String(item.result)).join(" " + conditionMode + " ") + " → " + String(conditionResult), status: conditionResult ? "True" : "False" });
                update(link.id, { conditionResult, trace: clone(trace) });

                if (!conditionResult) {
                    trace.push({ label: "False branch", detail: "Nothing", status: "Skipped" });
                    const result = { status: "No action", conditionResult: false, serviceOutput: null, finalOutput: null, writtenTo: "Empty", trace, startedAt, completedAt: new Date().toISOString() };
                    update(link.id, { status: result.status, message: "Condition false · Nothing", conditionResult: false, lastRunAt: result.completedAt, trace });
                    return result;
                }

                const service = services.find(item => item.id === link.serviceCall.serviceId);
                const operation = operationsFor(service, serviceActions)[0];
                const parameters = parametersForService(service, serviceActions);
                const monitoredValues = Object.fromEntries(evaluations.map(item => [item.property.id, item.property.value]));
                const firstProperty = evaluations[0].property;
                const args = resolveArguments(link.serviceCall.bindings, parameters, { triggerValue: firstProperty.value, monitoredValues, properties });
                const context = { value: firstProperty.value, monitoredValues, ruleId: link.id, signalId: firstProperty.id, signalIds: evaluations.map(item => item.property.id), test: executionOptions.test };
                const serviceResult = executeService
                    ? await executeService(service, args, context)
                    : serviceActions.simulate(service, operation.id, args, context);
                if (!isRunTokenValid(token)) {
                    update(link.id, { status: "Paused", message: "Demo stopped · output not applied", trace });
                    return { status: "Paused", conditionResult, trace, writtenTo: "Empty" };
                }
                trace.push({ label: service.name, detail: JSON.stringify(args) + " → " + String(serviceResult.outputData), status: "Success" });

                let writtenTo = "Empty";
                if (link.output.kind === "aas_property") {
                    const target = properties.find(item => item.id === link.output.propertyId);
                    const typed = parsePropertyValue(serviceResult.outputData, target.valueType);
                    await setPropertyValue(target.id, typed, { source: "aas-service-link", suppressServiceLinks: true });
                    writtenTo = (target.submodelName || target.submodelId) + " / " + target.path;
                    trace.push({ label: "Output", detail: String(typed) + " → " + writtenTo, status: "Written" });
                } else trace.push({ label: "Output", detail: "Empty", status: "Skipped" });

                const result = { status: "Success", conditionResult: true, serviceOutput: serviceResult.outputData, finalOutput: serviceResult.outputData, writtenTo, trace, startedAt, completedAt: new Date().toISOString() };
                update(link.id, { status: "Success", message: "Service completed", conditionResult: true, lastRunAt: result.completedAt, trace });
                return result;
            } catch (error) {
                if (!isRunTokenValid(token)) { update(link.id, { status: "Paused", message: "Demo stopped", trace }); return { status: "Paused", conditionResult, trace, writtenTo: "Empty" }; }
                trace.push({ label: "Workflow failed", detail: error.message, status: "Failed" });
                update(link.id, { status: "Failed", message: error.message, conditionResult, lastRunAt: new Date().toISOString(), trace });
                throw error;
            } finally {
                running.delete(link.id);
            }
        }

        return { execute, state, isRunning: id => running.has(id) };
    }

    function init(options) {
        const { storage, serviceActions, executeService, getServices, getProperties, setPropertyValue, parsePropertyValue, summaryHost, addButton, toast = () => {}, onChange = () => {} } = options;
        const workflowHost = options.workflowHost || options.overviewHost;
        let links = [], acceptedLinks = [], backendStates = {}, currentEngineId = "";
        let runtimeRunning = !(root.GucEnvironment?.isDemo && !root.GucEnvironment.demoRunning), runtimeEpoch = 0;
        try {
            const saved = JSON.parse(storage.getItem(STORAGE_KEY) || "null");
            if (Array.isArray(saved?.links)) {
                links = saved.links.map((item, index) => {
                    const legacyCall = item.serviceCall || item.onTrue || item.firstCall || {};
                    const legacyBindings = Object.fromEntries(Object.entries(legacyCall.bindings || {}).map(([name, binding]) => [name, ["property", "constant"].includes(binding.source) ? binding : { source: "property", propertyId: item.propertyId, value: "" }]));
                    const monitors = monitorsForLink(item);
                    return {
                        id: item.id || "engine:migrated-" + index,
                        name: item.name || "Rule " + (index + 1),
                        monitors,
                        conditionMode: conditionModeForLink(item),
                        propertyId: monitors[0]?.propertyId || "",
                        enabled: item.enabled !== false,
                        condition: monitors[0]?.condition || normalizedCondition(),
                        serviceCall: { serviceId: legacyCall.serviceId || "", bindings: legacyBindings },
                        onFalse: "nothing",
                        output: item.output || { kind: "none", propertyId: "" },
                        updatedAt: item.updatedAt
                    };
                });
            }
        } catch {}

        const runtime = createRuntime({ executeRule: options.executeRule, serviceActions, executeService, getServices, getProperties, setPropertyValue, parsePropertyValue, getRunToken: () => runtimeEpoch, isRunTokenValid: token => runtimeRunning && token === runtimeEpoch, onChange: () => { renderOverview(); onChange(); } });
        const dialog = document.createElement("dialog");
        dialog.className = "binding-dialog service-link-dialog";
        dialog.setAttribute("aria-labelledby", "serviceLinkDialogTitle");
        dialog.innerHTML = `
            <div class="modal-head"><h2 id="serviceLinkDialogTitle">Add Rule</h2><button type="button" class="btn icon-only" data-close aria-label="Close Rule dialog">×</button></div>
            <form>
                <div class="service-link-error" data-errors role="alert"></div>
                <section class="service-link-section">
                    <div class="service-link-section-title"><span class="service-link-step">1</span><strong>Rule Setup</strong></div>
                    <div class="rule-setup-grid">
                        <label class="field">Rule Name<input name="ruleName" autocomplete="off"></label>
                        <div class="rule-monitor-group">
                            <div class="rule-monitor-head"><strong>Monitored SMEs</strong><button type="button" class="btn ghost" data-add-monitor>+ Add SME</button></div>
                            <div class="rule-monitor-list" data-monitors></div>
                        </div>
                    </div>
                    <label class="service-link-enable"><input type="checkbox" name="enabled" checked> Enabled</label>
                </section>
                <section class="service-link-section">
                    <div class="service-link-section-title condition-section-title"><span class="service-link-step">2</span><strong>Condition</strong><label class="condition-mode-field">Match<select name="conditionMode" aria-label="Condition logic"><option value="AND">AND · all conditions</option><option value="OR">OR · any condition</option></select></label></div>
                    <div class="rule-condition-list" data-conditions></div>
                </section>
                <section class="service-link-section">
                    <div class="service-link-section-title"><span class="service-link-step">3</span><strong>Service Trigger</strong></div>
                    <div class="service-trigger-grid"><label class="field">Service<select name="serviceId"></select></label></div>
                </section>
                <section class="service-link-section">
                    <div class="service-link-section-title"><span class="service-link-step">4</span><strong>Service Parameters</strong><span class="badge draft" data-count="service">0 parameters</span></div>
                    <div class="service-link-params" data-params="service"></div>
                </section>
                <section class="service-link-section">
                    <div class="service-link-section-title"><span class="service-link-step">5</span><strong>Output</strong></div>
                    <div class="form-grid"><label class="field">Result<select name="outputKind"><option value="none">Empty</option><option value="aas_property">Write to SME</option></select></label><label class="field" data-output-property>Target SME<div class="sme-tree-field"><input type="hidden" name="outputPropertyId"><button type="button" class="sme-tree-trigger" data-property-picker data-picker-title="Select Output SME" aria-label="Select Output SME"><span class="sme-tree-trigger-copy" data-sme-selection></span><span class="sme-tree-chevron" aria-hidden="true">⌄</span></button></div></label></div>
                    <p class="small" data-output-note hidden>Output schema is not declared by this backend Service. Test will validate conversion to the selected SME at runtime.</p>
                </section>
                <section class="service-link-result" data-result hidden></section>
                <div class="service-link-form-actions"><button type="button" class="btn danger" data-delete hidden>Delete Rule</button><span class="service-link-action-spacer"></span><button type="button" class="btn" data-cancel>Cancel</button><button type="button" class="btn blue" data-test>Test</button><button class="btn primary" type="submit">Save Rule</button></div>
            </form>`;
        document.body.append(dialog);
        const propertyDialog = document.createElement("dialog");
        propertyDialog.className = "binding-dialog engine-sme-dialog";
        propertyDialog.setAttribute("aria-labelledby", "engineSmeDialogTitle");
        propertyDialog.innerHTML = '<div class="modal-head"><h2 id="engineSmeDialogTitle">Select SME</h2><button type="button" class="btn icon-only" data-property-close aria-label="Close SME tree">×</button></div><div class="modal-body"><div class="link-tree engine-sme-tree" data-property-tree></div></div><div class="modal-actions"><button type="button" class="btn" data-property-cancel>Cancel</button><button type="button" class="btn primary" data-property-select>Select SME</button></div>';
        document.body.append(propertyDialog);
        const form = dialog.querySelector("form"), errorsNode = dialog.querySelector("[data-errors]"), resultNode = dialog.querySelector("[data-result]");

        async function save() {
            try { if(options.persistLinks) await options.persistLinks(clone(links)); acceptedLinks=clone(links); }
            catch(error) { links=clone(acceptedLinks); renderOverview(); toast(error.message); throw error; }
            storage.setItem(STORAGE_KEY, JSON.stringify({ version: VERSION, links }));
            renderOverview();
            onChange();
        }
        function linkFor(engineId) { return clone(links.find(item => item.id === engineId) || null); }
        function propertyLabel(item) { return (item.aasName || item.aasId) + " · " + (item.submodelName || item.submodelId) + " / " + item.path; }
        function setPropertyField(field, propertyId) {
            if (!field) return;
            const input = field.querySelector('input[type="hidden"]'), label = field.querySelector("[data-sme-selection]"), property = getProperties().find(item => item.id === propertyId);
            input.value = property?.id || "";
            label.innerHTML = property
                ? '<strong>' + esc(propertyLabel(property)) + '</strong><span>' + esc(property.valueType || "xs:string") + (property.unit ? " · " + esc(property.unit) : "") + '</span>'
                : '<strong>Select SME</strong><span>AAS / Submodel / Property</span>';
        }
        function readMonitorDrafts() {
            const conditionRows = [...dialog.querySelectorAll("[data-condition-row]")];
            return [...dialog.querySelectorAll("[data-monitor-row]")].map((row, index) => {
                const conditionRow = conditionRows[index];
                return {
                    propertyId: row.querySelector("[data-monitor-property]").value,
                    condition: {
                        operator: conditionRow?.querySelector("[data-condition-operator]")?.value || ">=",
                        right: { source: "constant", value: conditionRow?.querySelector("[data-condition-value]")?.value ?? "0" }
                    }
                };
            });
        }
        function firstMonitoredPropertyId() {
            return dialog.querySelector("[data-monitor-property]")?.value || getProperties()[0]?.id || "";
        }
        function renderConditions(monitors) {
            const host = dialog.querySelector("[data-conditions]");
            host.innerHTML = monitors.map((monitor, index) => {
                const property = getProperties().find(item => item.id === monitor.propertyId);
                const label = property ? propertyLabel(property) : "Select Monitored SME " + (index + 1);
                const condition = normalizedCondition(monitor.condition);
                return '<div class="rule-condition-row" data-condition-row data-monitor-index="' + index + '"><span class="service-output-pill" title="' + esc(label) + '"><strong>SME ' + (index + 1) + '</strong><span>' + esc(label) + '</span></span><select data-condition-operator aria-label="Condition ' + (index + 1) + ' operator">' + [">", "<", "=", ">=", "<=", "!="].map(operator => '<option' + (condition.operator === operator ? " selected" : "") + '>' + esc(operator) + '</option>').join("") + '</select><input data-condition-value aria-label="Condition ' + (index + 1) + ' threshold" placeholder="Threshold" value="' + esc(condition.right.value) + '"></div>';
            }).join("");
        }
        function renderMonitors(monitors) {
            const host = dialog.querySelector("[data-monitors]");
            host.innerHTML = monitors.map((monitor, index) => '<div class="rule-monitor-row" data-monitor-row data-monitor-index="' + index + '"><span class="rule-monitor-index">' + (index + 1) + '</span><div class="sme-tree-field"><input type="hidden" data-monitor-property value="' + esc(monitor.propertyId) + '"><button type="button" class="sme-tree-trigger" data-property-picker data-picker-title="Select Monitored SME ' + (index + 1) + '" aria-label="Select Monitored SME ' + (index + 1) + '"><span class="sme-tree-trigger-copy" data-sme-selection></span><span class="sme-tree-chevron" aria-hidden="true">⌄</span></button></div><button type="button" class="btn icon-only rule-monitor-remove" data-remove-monitor aria-label="Remove Monitored SME ' + (index + 1) + '">×</button></div>').join("");
            host.querySelectorAll("[data-monitor-row]").forEach(row => setPropertyField(row.querySelector(".sme-tree-field"), row.querySelector("[data-monitor-property]").value));
            host.querySelectorAll("[data-remove-monitor]").forEach(button => { button.disabled = monitors.length === 1; });
        }
        function propertyTreeHtml(selectedId = "") {
            const aasGroups = [];
            for (const property of getProperties()) {
                const aasKey = property.aasId || property.aasName || "AAS", submodelKey = property.submodelId || property.submodelName || "Submodel";
                let aas = aasGroups.find(item => item.key === aasKey);
                if (!aas) { aas = { key: aasKey, name: property.aasName || property.aasId || "AAS", submodels: [] }; aasGroups.push(aas); }
                let submodel = aas.submodels.find(item => item.key === submodelKey);
                if (!submodel) { submodel = { key: submodelKey, name: property.submodelName || property.submodelId || "Submodel", properties: [] }; aas.submodels.push(submodel); }
                submodel.properties.push(property);
            }
            function renderProperties(properties) {
                const root = { children: new Map() };
                for (const property of properties) {
                    let node = root;
                    for (const segment of String(property.path || property.id).split(".")) {
                        if (!node.children.has(segment)) node.children.set(segment, { name: segment, children: new Map(), property: null });
                        node = node.children.get(segment);
                    }
                    node.property = property;
                }
                const containsSelected = node => node.property?.id === selectedId || [...node.children.values()].some(containsSelected);
                const renderNode = node => {
                    const property = node.property;
                    if (property && !node.children.size) return '<button type="button" class="link-tree-leaf' + (property.id === selectedId ? " selected" : "") + '" data-property-id="' + esc(property.id) + '"><span class="link-tree-leaf-copy"><strong>' + esc(node.name) + '</strong><span class="small">' + esc(property.path) + " · " + esc(property.valueType || "xs:string") + (property.unit ? " · " + esc(property.unit) : "") + '</span></span>' + (property.id === selectedId ? '<span class="badge">Selected</span>' : "") + '</button>';
                    return '<details' + (containsSelected(node) ? " open" : "") + '><summary>' + esc(node.name) + ' <span class="small">Collection</span></summary>' + (property ? renderNode({ ...node, children: new Map() }) : "") + [...node.children.values()].map(renderNode).join("") + '</details>';
                };
                return [...root.children.values()].map(renderNode).join("") || '<div class="link-tree-empty">No Properties</div>';
            }
            return aasGroups.map((aas, aasIndex) => {
                const aasSelected = aas.submodels.some(submodel => submodel.properties.some(property => property.id === selectedId));
                return '<details' + (aasSelected || (!selectedId && aasIndex === 0) ? " open" : "") + '><summary>' + esc(aas.name) + ' <span class="small">AAS</span></summary>' + aas.submodels.map((submodel, submodelIndex) => {
                    const submodelSelected = submodel.properties.some(property => property.id === selectedId);
                    return '<details' + (submodelSelected || (!selectedId && aasIndex === 0 && submodelIndex === 0) ? " open" : "") + '><summary>' + esc(submodel.name) + ' <span class="small">Submodel</span></summary>' + renderProperties(submodel.properties) + '</details>';
                }).join("") + '</details>';
            }).join("") || '<div class="link-tree-empty">No AAS Properties available.</div>';
        }
        let activePropertyField = null, selectedPropertyId = "";
        function openPropertyPicker(field, title) {
            activePropertyField = field;
            selectedPropertyId = field.querySelector('input[type="hidden"]').value;
            propertyDialog.querySelector("#engineSmeDialogTitle").textContent = title || "Select SME";
            propertyDialog.querySelector("[data-property-tree]").innerHTML = propertyTreeHtml(selectedPropertyId);
            propertyDialog.querySelector("[data-property-select]").disabled = !selectedPropertyId;
            if (!propertyDialog.open) propertyDialog.showModal();
        }
        function serviceOptions(selected = "") { return getServices().map(item => '<option value="' + esc(item.id) + '"' + (item.id === selected ? " selected" : "") + '>' + esc(item.name || item.id) + " · " + esc(item.id) + "</option>").join(""); }
        function selectedService() { return getServices().find(item => item.id === form.elements.serviceId.value) || null; }
        function readBindings() {
            const bindings = {};
            dialog.querySelectorAll('[data-params="service"] [data-parameter]').forEach(row => {
                bindings[row.dataset.parameter] = { source: row.querySelector("[data-source]").value, propertyId: row.querySelector("[data-property]").value, value: row.querySelector("[data-constant]").value };
            });
            return bindings;
        }
        function updateBindingRow(row) {
            const source = row.querySelector("[data-source]").value;
            row.querySelector("[data-property-container]").hidden = source !== "property";
            row.querySelector("[data-constant]").hidden = source !== "constant";
        }
        function renderBindings(bindings = {}) {
            const service = selectedService(), host = dialog.querySelector('[data-params="service"]'), parameters = parametersForService(service, serviceActions);
            dialog.querySelector('[data-count="service"]').textContent = parameters.length + (parameters.length === 1 ? " parameter" : " parameters");
            if (!parameters.length) { host.innerHTML = '<div class="empty-note">No parameters</div>'; return; }
            host.innerHTML = '<div class="service-param-head"><span>Parameter</span><span>Source</span><span>Value / SME</span></div>' + parameters.map((parameter, index) => {
                const binding = bindings[parameter.name] || { source: index === 0 ? "property" : "constant", propertyId: firstMonitoredPropertyId(), value: parameter.defaultValue ?? "" };
                const sources = [["property", "SME"], ["constant", "Custom"]];
                return '<div class="service-param-row" data-parameter="' + esc(parameter.name) + '"><div><strong>' + esc(parameter.name) + '</strong><span class="small">' + esc(parameter.type) + '</span></div><select data-source>' + sources.map(item => '<option value="' + item[0] + '"' + (binding.source === item[0] ? " selected" : "") + '>' + item[1] + '</option>').join("") + '</select><div class="service-param-value"><div class="sme-tree-field" data-property-container><input type="hidden" data-property value="' + esc(binding.propertyId || firstMonitoredPropertyId()) + '"><button type="button" class="sme-tree-trigger" data-property-picker data-picker-title="Select Parameter SME" aria-label="Select Parameter SME"><span class="sme-tree-trigger-copy" data-sme-selection></span><span class="sme-tree-chevron" aria-hidden="true">⌄</span></button></div><input data-constant value="' + esc(binding.value ?? "") + '" placeholder="Value"></div></div>';
            }).join("");
            host.querySelectorAll("[data-parameter]").forEach(row => { const field = row.querySelector(".sme-tree-field"); setPropertyField(field, field.querySelector("[data-property]").value); row.querySelector("[data-source]").addEventListener("change", () => updateBindingRow(row)); updateBindingRow(row); });
        }
        function updateConditionalFields() {
            dialog.querySelector("[data-output-property]").hidden = form.elements.outputKind.value !== "aas_property";
            dialog.querySelector("[data-output-note]").hidden = form.elements.outputKind.value !== "aas_property" || serviceOutputTypeKnown(selectedService());
        }
        function readDraft() {
            const monitors = readMonitorDrafts();
            return {
                id: currentEngineId,
                name: form.elements.ruleName.value.trim(),
                monitors,
                conditionMode: form.elements.conditionMode.value,
                propertyId: monitors[0]?.propertyId || "",
                enabled: form.elements.enabled.checked,
                condition: monitors[0]?.condition || normalizedCondition(),
                serviceCall: { serviceId: form.elements.serviceId.value, bindings: readBindings() },
                onFalse: "nothing",
                output: { kind: form.elements.outputKind.value, propertyId: form.elements.outputKind.value === "aas_property" ? form.elements.outputPropertyId.value : "" },
                updatedAt: new Date().toISOString()
            };
        }
        function showErrors(messages) { errorsNode.textContent = messages.join(" "); errorsNode.hidden = !messages.length; }
        function showResult(result) {
            resultNode.hidden = false;
            resultNode.innerHTML = '<div class="service-link-result-head"><strong>' + esc(result.status) + '</strong><span class="badge ' + (result.status === "Success" ? "" : result.status === "No action" ? "draft" : "offline") + '">' + esc(result.conditionResult === null ? "—" : "Condition " + result.conditionResult) + '</span></div>' + result.trace.map(item => '<div class="service-trace-row"><span class="badge ' + (item.status === "Failed" ? "offline" : item.status === "Skipped" ? "draft" : "") + '">' + esc(item.status) + '</span><div><strong>' + esc(item.label) + '</strong><div class="small">' + esc(item.detail) + '</div></div></div>').join("");
        }
        function serviceLabel(call) {
            const service = getServices().find(item => item.id === call?.serviceId);
            return { name: service?.name || call?.serviceId || "Missing Service", parameterCount: parametersForService(service, serviceActions).length };
        }
        function nodeIcon(type) {
            const icons = {
                input: '<svg viewBox="0 0 24 24"><path d="M4 7h16M4 12h10M4 17h7"/></svg>',
                sme: '<svg viewBox="0 0 24 24"><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9"/></svg>',
                service: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.4 1a7 7 0 0 0-2-1.1L14.2 3h-4.4l-.3 2.8a7 7 0 0 0-2 1.1l-2.4-1-2 3.4 2 1.5A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.5 2 3.4 2.4-1a7 7 0 0 0 2 1.1l.3 2.8h4.4l.3-2.8a7 7 0 0 0 2-1.1l2.4 1 2-3.4-2-1.5c.1-.4.1-.8.1-1.2Z"/></svg>',
                condition: '<svg viewBox="0 0 24 24"><path d="m12 3 8 9-8 9-8-9 8-9Z"/><path d="M9 12h6"/></svg>',
                result: '<svg viewBox="0 0 24 24"><path d="M6 3h12v18H6zM9 8h6M9 12h6M9 16h4"/></svg>',
                output: '<svg viewBox="0 0 24 24"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v7c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12v7c0 1.7 3.6 3 8 3s8-1.3 8-3v-7"/></svg>'
            };
            return icons[type];
        }
        function flowNode(type, title, detail, state) {
            return '<div class="engine-flow-node ' + esc(state) + '"><span class="engine-flow-icon">' + nodeIcon(type) + '</span><strong>' + esc(title) + '</strong><span>' + esc(detail) + '</span></div>';
        }
        function connector() { return '<span class="engine-flow-connector" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 12h15m-5-5 5 5-5 5"/></svg></span>'; }
        function renderOverview() {
            const properties = getProperties();
            const enabled = links.filter(item => item.enabled).length;
            const pageCount = document.getElementById("rulesPageCount"), summaryCount = document.getElementById("overviewRulesCount");
            if (pageCount) pageCount.textContent = enabled + " / " + links.length + " enabled";
            const aasx = (typeof window !== "undefined" && window.gucAasxRules) || { total: 0, enabled: 0 }; // Engine rules of the AASX (stack-control.js)
            if (summaryCount) summaryCount.textContent = (enabled + aasx.enabled) + " / " + (links.length + aasx.total) + " enabled";
            if (summaryHost) {
                summaryHost.innerHTML = links.map(link => {
                    const state = backendStates[link.id] || runtime.state(link.id), service = serviceLabel(link.serviceCall), monitoredCount = monitorsForLink(link).length;
                    const status = link.enabled ? state.status : "Disabled";
                    const badgeClass = state.status === "Failed" ? "offline" : state.status === "Running" ? "warning" : link.enabled && state.status === "Success" ? "" : "draft";
                    return '<button type="button" class="overview-entity-row" data-overview-rule-id="' + esc(link.id) + '"><span class="overview-entity-copy"><strong>' + esc(link.name) + '</strong><span class="small">' + monitoredCount + (monitoredCount === 1 ? ' monitored SME' : ' monitored SMEs') + ' · ' + esc(service.name) + '</span></span><span class="badge ' + badgeClass + '">' + esc(status) + '</span></button>';
                }).join("") || '<div class="overview-entity-empty">No Rules</div>';
            }
            if (!workflowHost) return;
            if (!links.length) {
                workflowHost.innerHTML = '<div class="engine-empty"><strong>No Rules</strong><button class="btn primary" data-engine-action="add">Add Rule</button></div>';
                return;
            }
            workflowHost.innerHTML = links.map(link => {
                const state = backendStates[link.id] || runtime.state(link.id), service = serviceLabel(link.serviceCall), monitors = monitorsForLink(link), triggers = monitors.map(monitor => properties.find(item => item.id === monitor.propertyId)), output = properties.find(item => item.id === link.output?.propertyId);
                const ran = Boolean(state.lastRunAt), success = state.status === "Success", falseBranch = state.status === "No action", failed = state.status === "Failed", active = state.status === "Running";
                const nodeState = index => {
                    if (index === 0) return "complete";
                    if (success) return "complete";
                    if (falseBranch) return index === 1 ? "complete" : "skipped";
                    if (active) return state.conditionResult === true ? index === 1 ? "complete" : index === 2 ? "active" : "pending" : index === 1 ? "active" : "pending";
                    if (failed) return state.conditionResult === false ? index === 1 ? "failed" : "pending" : index === 1 ? "complete" : index === 2 ? "failed" : "pending";
                    return "pending";
                };
                const badgeClass = failed ? "offline" : active ? "warning" : link.enabled ? (success ? "" : "draft") : "draft";
                const monitoredDetail = monitors.length === 1 ? triggers[0]?.path || "Missing SME" : monitors.length + " SMEs · " + triggers.map((property, index) => property?.path || "Missing SME " + (index + 1)).join(", ");
                const conditionDetail = monitors.map((monitor, index) => (triggers[index]?.path || "SME " + (index + 1)) + " " + monitor.condition.operator + " " + monitor.condition.right.value).join(" " + conditionModeForLink(link) + " ");
                return '<article class="engine-instance" data-engine-id="' + esc(link.id) + '"><div class="engine-instance-head"><div><h3>' + esc(link.name) + '</h3><span class="small">' + esc(link.id) + '</span>' + executorNote(link) + '</div><span class="badge ' + badgeClass + '">' + esc(link.enabled ? state.status : "Disabled") + '</span><div class="engine-instance-actions"><button class="link-btn" data-engine-action="run">Run</button><button class="link-btn" data-engine-action="edit">Edit</button><button class="link-btn" data-engine-action="toggle">' + (link.enabled ? "Disable" : "Enable") + '</button><button class="link-btn danger-text" data-engine-action="delete">Delete</button></div></div><div class="engine-flow">' +
                    flowNode("sme", monitors.length === 1 ? "Monitored SME" : "Monitored SMEs", monitoredDetail, nodeState(0)) + connector() +
                    flowNode("condition", "Condition", conditionDetail, nodeState(1)) + connector() +
                    flowNode("service", "Service Trigger", falseBranch ? "Conditions not matched" : service.name + " · " + service.parameterCount + (service.parameterCount === 1 ? " parameter" : " parameters"), nodeState(2)) + connector() +
                    flowNode("result", "Result", falseBranch ? "Skipped" : success ? String(state.finalOutput ?? state.trace.find(item => item.label === service.name)?.detail?.split(" → ").pop() ?? "Ready") : "Pending", nodeState(3)) + connector() +
                    flowNode("output", "Output SME", falseBranch ? "Nothing" : link.output.kind === "aas_property" ? output?.path || "Missing SME" : "Empty", nodeState(4)) +
                    '</div></article>';
            }).join("");
        }
        function open(engineId = null) {
            const properties = getProperties();
            if (!properties.length) { toast("Add an AAS Property before creating a Rule."); return; }
            const existing = engineId ? linkFor(engineId) : null;
            currentEngineId = existing?.id || "engine:" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
            dialog.querySelector("#serviceLinkDialogTitle").textContent = existing ? "Edit Rule" : "Add Rule";
            form.elements.ruleName.value = existing?.name || "New Rule";
            const monitors = existing ? monitorsForLink(existing) : [{ propertyId: properties[0].id, condition: normalizedCondition() }];
            renderMonitors(monitors);
            renderConditions(monitors);
            form.elements.conditionMode.value = conditionModeForLink(existing);
            form.elements.enabled.checked = existing?.enabled !== false;
            const serviceId = existing?.serviceCall?.serviceId || getServices()[0]?.id || "";
            form.elements.serviceId.innerHTML = serviceOptions(serviceId); form.elements.serviceId.value = serviceId;
            renderBindings(existing?.serviceCall?.bindings || {});
            form.elements.outputKind.value = existing?.output?.kind || "none";
            setPropertyField(form.elements.outputPropertyId.closest(".sme-tree-field"), existing?.output?.propertyId || properties[0].id);
            dialog.querySelector("[data-delete]").hidden = !existing;
            resultNode.hidden = true; resultNode.innerHTML = ""; showErrors([]); updateConditionalFields();
            if (!dialog.open) dialog.showModal();
            form.elements.ruleName.focus();
        }

        dialog.addEventListener("click", event => {
            const addMonitor = event.target.closest("[data-add-monitor]");
            if (addMonitor) {
                const monitors = readMonitorDrafts(), used = new Set(monitors.map(item => item.propertyId));
                const nextProperty = getProperties().find(item => !used.has(item.id)) || getProperties()[0];
                monitors.push({ propertyId: nextProperty?.id || "", condition: normalizedCondition() });
                renderMonitors(monitors); renderConditions(monitors);
                return;
            }
            const removeMonitor = event.target.closest("[data-remove-monitor]");
            if (removeMonitor) {
                const monitors = readMonitorDrafts();
                if (monitors.length <= 1) return;
                monitors.splice(Number(removeMonitor.closest("[data-monitor-row]").dataset.monitorIndex), 1);
                renderMonitors(monitors); renderConditions(monitors);
                return;
            }
            const button = event.target.closest("[data-property-picker]");
            if (button) openPropertyPicker(button.closest(".sme-tree-field"), button.dataset.pickerTitle);
        });
        propertyDialog.querySelector("[data-property-tree]").addEventListener("click", event => {
            const leaf = event.target.closest("[data-property-id]");
            if (!leaf) return;
            selectedPropertyId = leaf.dataset.propertyId;
            propertyDialog.querySelector("[data-property-tree]").innerHTML = propertyTreeHtml(selectedPropertyId);
            propertyDialog.querySelector("[data-property-select]").disabled = false;
        });
        propertyDialog.querySelector("[data-property-close]").addEventListener("click", () => propertyDialog.close());
        propertyDialog.querySelector("[data-property-cancel]").addEventListener("click", () => propertyDialog.close());
        propertyDialog.querySelector("[data-property-select]").addEventListener("click", () => {
            if (!activePropertyField || !selectedPropertyId) return;
            const monitoredField = Boolean(activePropertyField.closest("[data-monitor-row]"));
            setPropertyField(activePropertyField, selectedPropertyId);
            if (monitoredField) renderConditions(readMonitorDrafts());
            propertyDialog.close();
        });
        form.elements.serviceId.addEventListener("change", () => { renderBindings(); updateConditionalFields(); });
        form.elements.outputKind.addEventListener("change", updateConditionalFields);
        dialog.querySelector("[data-close]").addEventListener("click", () => dialog.close());
        dialog.querySelector("[data-cancel]").addEventListener("click", () => dialog.close());
        form.addEventListener("submit", async event => {
            event.preventDefault();
            const draft = readDraft(), validation = validateLink(draft, getServices(), getProperties(), serviceActions);
            showErrors(validation); if (validation.length) return;
            const index = links.findIndex(item => item.id === draft.id);
            if (index < 0) links.push(draft); else links[index] = draft;
            try { await save(); dialog.close(); toast("Rule saved."); } catch(error) { showErrors([error.message]); }
        });
        dialog.querySelector("[data-test]").addEventListener("click", async event => {
            const draft = readDraft(), validation = validateLink(draft, getServices(), getProperties(), serviceActions);
            showErrors(validation); if (validation.length) return;
            const testButton = event.currentTarget;
            testButton.disabled = true; resultNode.hidden = false; resultNode.textContent = "Running…";
            try { showResult(await runtime.execute(draft, { test: true })); }
            catch (error) { showErrors([error.message]); showResult({ status: "Failed", conditionResult: null, trace: runtime.state(draft.id).trace }); }
            finally { testButton.disabled = false; }
        });
        dialog.querySelector("[data-delete]").addEventListener("click", async () => { links = links.filter(item => item.id !== currentEngineId); try { await save(); dialog.close(); toast("Rule deleted."); } catch(error) { showErrors([error.message]); } });
        addButton?.addEventListener("click", () => open());
        workflowHost?.addEventListener("click", async event => {
            const action = event.target.closest("[data-engine-action]")?.dataset.engineAction;
            if (!action) return;
            const card = event.target.closest("[data-engine-id]"), engineId = card?.dataset.engineId;
            if (action === "add") open();
            if (action === "edit" && engineId) open(engineId);
            if (action === "run" && engineId) test(engineId).catch(error => toast(error.message));
            if (action === "toggle" && engineId) { const link = links.find(item => item.id === engineId); link.enabled = !link.enabled; link.updatedAt = new Date().toISOString(); await save().catch(()=>{}); }
            if (action === "delete" && engineId && confirm("Delete Rule '" + (links.find(item => item.id === engineId)?.name || engineId) + "'?")) { links = links.filter(item => item.id !== engineId); await save().then(()=>toast("Rule deleted.")).catch(()=>{}); }
        });

        async function test(engineId) {
            const link = linkFor(engineId); if (!link) throw Error("Rule is missing.");
            const result = await runtime.execute(link, { test: true });
            toast(result.status === "Paused" ? "Demo stopped · output not applied." : result.conditionResult ? "Rule completed." : "Conditions not matched · Nothing.");
            return result;
        }
        function propertyChanged(propertyId) {
            if (options.executeRule || !runtimeRunning) return Promise.resolve([]);
            const matching = links.filter(item => monitorsForLink(item).some(monitor => monitor.propertyId === propertyId) && item.enabled && !runtime.isRunning(item.id));
            return Promise.all(matching.map(link => runtime.execute(clone(link), { test: false }).catch(error => { toast(link.name + ": " + error.message); return null; })));
        }
        async function removePropertyLinks(propertyId) {
            const before = links.length;
            links = links.filter(item => !monitorsForLink(item).some(monitor => monitor.propertyId === propertyId) && item.output?.propertyId !== propertyId && !Object.values(item.serviceCall?.bindings || {}).some(binding => binding.propertyId === propertyId));
            if (links.length !== before) await save(); return before - links.length;
        }
        async function removeServiceLinks(serviceId) {
            const before = links.length; links = links.filter(item => item.serviceCall?.serviceId !== serviceId);
            if (links.length !== before) await save(); return before - links.length;
        }

        renderOverview();
        return { replace(items,states={}) { links=clone(items); acceptedLinks=clone(items); backendStates=clone(states); renderOverview(); }, open, test, propertyChanged, linkFor, removePropertyLinks, removeServiceLinks, state: runtime.state, render: renderOverview, snapshot: () => clone(links), setRunning(value) { runtimeRunning = Boolean(value); runtimeEpoch++; }, isRunning: () => runtimeRunning };
    }

    const exported = { init, createRuntime, parseDefinition, parametersForService, castValue, compareValues, validateLink, STORAGE_KEY };
    if (typeof module !== "undefined" && module.exports) module.exports = exported;
    else root.GucAasServiceLinks = exported;
})(typeof window !== "undefined" ? window : globalThis);
