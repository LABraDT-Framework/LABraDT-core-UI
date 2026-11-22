(function (root) {
    "use strict";

    const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
    const numericTypes = new Set(["xs:double", "xs:float", "xs:int", "xs:long"]);
    const conditionLabels = { greater_than: "greater than", less_than: "less than", equals: "equals" };
    const timeText = value => value ? new Date(value).toLocaleTimeString() : "Never";

    function init({ model, liveData, runtime, getAasProperties = () => [], toast }) {
        const rows = document.querySelector("#engineRuleRows"), issues = document.querySelector("#ruleEditorIssues"), historyRows = document.querySelector("#engineExecutionRows");
        let editingId = null, ruleType = "gateway";
        const host = document.createElement("div");
        host.className = "modal-backdrop";
        host.id = "ruleDialog";
        host.setAttribute("aria-hidden", "true");
        host.innerHTML = '<div class="modal" role="dialog" aria-modal="true" aria-labelledby="ruleDialogTitle"><div class="modal-head"><h2 id="ruleDialogTitle">Gateway Rule</h2><button type="button" class="btn icon-only" data-close aria-label="Close rule dialog">×</button></div><form><div class="modal-body"><div data-errors role="alert" style="color:var(--danger)"></div><div class="form-grid"><label class="field">Stable Rule ID<input name="id" autocomplete="off"></label><label class="field">Name<input name="name" autocomplete="off"></label><div class="rule-config-grid full" data-gateway-input><label class="field full">IF Gateway Signal<select name="gatewaySignalId"></select></label><label class="field">Comparison<select name="condition"><option value="greater_than">greater than</option><option value="less_than">less than</option><option value="equals">equals</option></select></label><label class="field full" data-value><span>Comparison value</span><span class="rule-threshold-control has-range" data-threshold-control><span class="rule-range-bound" data-range-min>0</span><input name="thresholdSlider" type="range" min="0" max="1000" step="1"><span class="rule-range-bound" data-range-max>1000</span><input name="threshold" type="number"></span><span class="small" data-range-note>Select a Gateway signal to use its configured bounds.</span></label><label class="field" data-bool hidden>Boolean value<select name="booleanThreshold" disabled><option value="true">true</option><option value="false">false</option></select></label></div><div class="rule-config-grid full" data-service-input hidden><label class="field">WHEN Service<select name="inputServiceId"></select></label><label class="field">Function / Operation<select name="inputOperationId"></select></label><p class="small full">This rule receives the selected Function\'s completed <code>outputData</code> event. It does not call the whole Service.</p></div><div class="field full"><span>THEN Action</span><div class="rule-action-card" data-action-summary>Invoke Service Function</div><span class="small" data-action-note>The action is fixed by the rule type, so it is shown as a description instead of a disabled input.</span></div><div class="rule-config-grid full" data-gateway-action><label class="field">Service<select name="actionServiceId"></select></label><label class="field">Function / Operation<select name="actionOperationId"></select></label><label class="field full">Dynamic Arguments (JSON)<textarea name="dynamicArgs" rows="3" spellcheck="false">{}</textarea><span class="small">Merged over the Service default arguments for this Demo invocation.</span></label><label class="field">Service Result<select name="outputKind"><option value="none">Show result only</option><option value="trigger_signal">Write to triggering Gateway signal</option><option value="gateway_signal">Write to another Gateway signal</option><option value="aas_property">Write to AAS Property</option></select></label><label class="field" data-output-target hidden>Output Target<select name="outputTargetId"></select></label></div><div class="rule-config-grid full" data-service-output hidden><label class="field full">Output Gateway Signal<select name="targetSignalId"></select><span class="small">The Service Function <code>outputData</code> is written to this signal. A Gateway → AAS or bidirectional Binding propagates the same value to its AAS Property.</span></label></div></div><p class="small" data-dialog-note>A saved rule starts disabled. Demo Auto Trigger invokes the selected Function once on a false-to-true edge.</p></div><div class="modal-actions"><button type="button" class="btn" data-cancel>Cancel</button><button class="btn primary" data-save>Save Gateway Rule</button></div></form></div>';
        document.body.append(host);
        const form = host.querySelector("form"), thresholdInput = form.elements.threshold, thresholdSlider = form.elements.thresholdSlider;

        const close = () => {
            host.classList.remove("open");
            host.setAttribute("aria-hidden", "true");
            editingId = null;
        };

        function operationsFor(service) {
            return Array.isArray(service?.operations) && service.operations.length ? service.operations : [{ id: service?.operationId || "execute", name: service?.operationName || "Execute", output: service?.output }];
        }

        function fillServices(select, selected = "") {
            select.innerHTML = '<option value="">Select a Service</option>' + model.snapshot().services.map(item => '<option value="' + esc(item.id) + '">' + esc(item.name || item.id) + ' · ' + esc(item.id) + '</option>').join("");
            select.value = selected;
        }

        function fillOperations(serviceSelect, operationSelect, selected = "") {
            const service = model.snapshot().services.find(item => item.id === serviceSelect.value), operations = operationsFor(service);
            operationSelect.innerHTML = operations.map(operation => '<option value="' + esc(operation.id) + '">' + esc(operation.name || operation.id) + ' · ' + esc(operation.id) + '</option>').join("");
            operationSelect.value = operations.some(operation => operation.id === selected) ? selected : operations[0]?.id || "";
        }

        function gatewaySignalOptions() {
            return '<option value="">Select a Gateway signal</option>' + model.snapshot().signals.filter(item => !item.deleted).map(item => '<option value="' + esc(item.id) + '">' + esc(item.name) + ' · ' + esc(item.targetElement) + '</option>').join("");
        }

        function fallbackRange(value) {
            const number = Number(value), magnitude = Number.isFinite(number) ? Math.abs(number) : 0;
            const limit = Math.max(1000, Math.ceil(magnitude / 1000) * 1000);
            return number < 0 ? [-limit, limit] : [0, limit];
        }

        function adaptGatewayInput() {
            const signal = model.snapshot().signals.find(item => item.id === form.elements.gatewaySignalId.value && !item.deleted);
            const numeric = signal && numericTypes.has(signal.valueType), boolean = signal?.valueType === "xs:boolean", integer = ["xs:int", "xs:long"].includes(signal?.valueType);
            const rawRange = numeric && Array.isArray(signal.validRange) ? signal.validRange.map(Number) : null;
            const configuredRange = rawRange && rawRange.length === 2 && rawRange.every(Number.isFinite) && rawRange[0] < rawRange[1] ? rawRange : null;
            const range = configuredRange || fallbackRange(thresholdInput.value);
            const minLabel = host.querySelector("[data-range-min]"), maxLabel = host.querySelector("[data-range-max]"), rangeNote = host.querySelector("[data-range-note]");
            [...form.elements.condition.options].forEach(option => option.disabled = Boolean(signal) && !numeric && option.value !== "equals");
            if (signal && !numeric) form.elements.condition.value = "equals";
            host.querySelector("[data-value]").hidden = Boolean(boolean);
            host.querySelector("[data-bool]").hidden = !boolean;
            thresholdInput.disabled = Boolean(boolean);
            form.elements.booleanThreshold.disabled = !boolean;
            thresholdInput.type = signal?.valueType === "xs:dateTime" ? "datetime-local" : numeric || !signal ? "number" : "text";
            thresholdInput.step = integer ? "1" : numeric || !signal ? "any" : "";
            thresholdInput.removeAttribute("min"); thresholdInput.removeAttribute("max");
            thresholdSlider.hidden = Boolean(signal && !numeric);
            minLabel.hidden = thresholdSlider.hidden; maxLabel.hidden = thresholdSlider.hidden;
            if (!thresholdSlider.hidden) {
                const [min, max] = range, sliderStep = integer ? 1 : Math.max(10 ** Math.floor(Math.log10((max - min) / 1000)), 0.000001);
                thresholdSlider.min = String(min); thresholdSlider.max = String(max); thresholdSlider.step = String(sliderStep);
                thresholdSlider.disabled = !signal;
                minLabel.textContent = String(min); maxLabel.textContent = String(max);
                if (configuredRange) { thresholdInput.min = String(min); thresholdInput.max = String(max); }
                let value = String(thresholdInput.value).trim() === "" ? Number.NaN : Number(thresholdInput.value);
                if (!Number.isFinite(value)) value = integer ? Math.round((min + max) / 2) : (min + max) / 2;
                if (configuredRange) value = Math.min(max, Math.max(min, value));
                if (integer) value = Math.round(value);
                if (signal) thresholdInput.value = String(value);
                thresholdSlider.value = String(Math.min(max, Math.max(min, value)));
                rangeNote.textContent = configuredRange
                    ? "Configured bounds: " + min + " to " + max + (signal.unit ? " " + signal.unit : "") + "."
                    : signal ? "No validRange is configured; the slider uses Demo bounds " + min + " to " + max + ". The number remains directly editable."
                        : "Select a Gateway signal to use its configured bounds; the disabled preview uses 0 to 1000.";
            } else rangeNote.textContent = "This signal is not numeric, so enter the comparison value directly.";
        }

        function adaptOutput(selected = "") {
            const kind = form.elements.outputKind.value, field = host.querySelector("[data-output-target]");
            field.hidden = !["gateway_signal", "aas_property"].includes(kind);
            if (kind === "gateway_signal") form.elements.outputTargetId.innerHTML = gatewaySignalOptions();
            else if (kind === "aas_property") form.elements.outputTargetId.innerHTML = '<option value="">Select an AAS Property</option>' + getAasProperties().map(item => '<option value="' + esc(item.id) + '">' + esc((item.aasId || "AAS") + " · " + (item.submodelName || item.submodelId) + " / " + item.path) + '</option>').join("");
            else form.elements.outputTargetId.innerHTML = "";
            form.elements.outputTargetId.value = selected;
        }

        function operationForRule(rule, state) {
            const service = state.services.find(item => item.id === rule.serviceId);
            return operationsFor(service).find(item => item.id === rule.operationId);
        }

        function extraErrors(rule) {
            const errors = [], state = model.snapshot(), operation = operationForRule(rule, state);
            let target;
            if (rule.type === "service") target = state.signals.find(item => item.id === rule.signalId && !item.deleted);
            else {
                if (rule.outputMapping?.kind === "trigger_signal") target = state.signals.find(item => item.id === rule.signalId && !item.deleted);
                if (rule.outputMapping?.kind === "gateway_signal") target = state.signals.find(item => item.id === rule.outputMapping.targetId && !item.deleted);
                if (rule.outputMapping?.kind === "aas_property") {
                    target = getAasProperties().find(item => item.id === rule.outputMapping.targetId);
                    if (!target) errors.push("Output AAS Property is missing.");
                }
            }
            if (target && operation && !root.GucServiceActions.compatibleOutput(operation.output, target.valueType)) errors.push("Service Function output type is incompatible with the selected target.");
            return errors;
        }

        function setRuleType(type) {
            ruleType = type === "service" ? "service" : "gateway";
            host.querySelector("[data-gateway-input]").hidden = ruleType !== "gateway";
            host.querySelector("[data-gateway-action]").hidden = ruleType !== "gateway";
            host.querySelector("[data-service-input]").hidden = ruleType !== "service";
            host.querySelector("[data-service-output]").hidden = ruleType !== "service";
            host.querySelector("#ruleDialogTitle").textContent = ruleType === "service" ? "Service Rule" : "Gateway Rule";
            host.querySelector("[data-action-summary]").textContent = ruleType === "service" ? "Write Service outputData to Gateway Signal" : "Invoke Service Function";
            host.querySelector("[data-action-note]").textContent = ruleType === "service" ? "A Service Rule reacts to one Function completion event; it does not call the whole Service." : "A Gateway Rule invokes the selected Function / Operation; the action is intentionally shown as a description, not a disabled input.";
            host.querySelector("[data-dialog-note]").textContent = ruleType === "service" ? "A saved rule starts disabled. When Demo Auto Trigger is running, every matching Service Function completion writes outputData to the selected Gateway signal." : "A saved rule starts disabled. Demo Auto Trigger invokes the selected Function once on a false-to-true edge.";
            host.querySelector("[data-save]").textContent = ruleType === "service" ? "Save Service Rule" : "Save Gateway Rule";
        }

        thresholdSlider.addEventListener("input", () => { thresholdInput.value = thresholdSlider.value; });
        thresholdInput.addEventListener("input", () => {
            if (thresholdSlider.hidden) return;
            const value = Number(thresholdInput.value), min = Number(thresholdSlider.min), max = Number(thresholdSlider.max);
            if (Number.isFinite(value)) thresholdSlider.value = String(Math.min(max, Math.max(min, value)));
        });

        function renderRuntimeHeader() {
            const running = runtime.isRunning(), enabled = model.snapshot().rules.filter(rule => rule.enabled).length;
            const runtimeBadge = document.getElementById("engineDemoStatus"), button = document.getElementById("engineDemoToggle");
            if (runtimeBadge) { runtimeBadge.textContent = running ? "Demo Auto Trigger · running" : "Demo Auto Trigger · stopped"; runtimeBadge.className = "badge " + (running ? "warning" : "draft"); }
            if (button) { button.textContent = running ? "Stop Demo Auto Trigger" : "Start Demo Auto Trigger"; button.className = "btn " + (running ? "danger" : "ghost"); }
            document.querySelector("#overviewRuleCount").textContent = enabled + " / " + model.snapshot().rules.length + " enabled";
        }

        function render() {
            const state = model.snapshot();
            renderRuntimeHeader();
            rows.innerHTML = state.rules.map(rule => {
                const type = rule.type || "gateway", signal = state.signals.find(item => item.id === rule.signalId && !item.deleted), service = state.services.find(item => item.id === rule.serviceId), operation = operationForRule(rule, state);
                const errors = [...root.GucSharedModel.validateRuleDraft(rule, state, rule.id), ...extraErrors({ ...rule, type })], broken = errors.length > 0, run = runtime.state(rule.id);
                const live = type === "gateway" ? liveData.viewForSignal(rule.signalId) : null;
                const value = type === "gateway" ? (live.value === undefined || live.value === null ? "—" : String(live.value) + (live.unit ? " " + live.unit : "")) : (run.lastValue?.value ?? "Waiting for event");
                const status = broken ? "Invalid" : rule.enabled ? "Enabled" : "Disabled", statusClass = broken ? "offline" : rule.enabled ? "" : "draft";
                const testDisabled = broken || (type === "gateway" && live.status !== "OK") ? " disabled" : "";
                let input, action, inputMeta;
                if (type === "service") {
                    input = '<strong>Service Function completed</strong><div>' + esc(service?.name || service?.id || rule.serviceId || "Missing Service") + ' → ' + esc(operation?.name || rule.operationId || "Missing Function") + '</div>';
                    action = '<strong>Write Gateway Signal</strong><div>' + esc(signal?.name || rule.signalId || "Missing signal") + '</div><div class="small">outputData → ' + esc(signal?.targetElement || "") + '</div>';
                    inputMeta = '<span class="live-value ' + (run.lastValue ? "ok" : "unavailable") + '">' + esc(value) + '</span><div class="small">Last Service event ' + esc(timeText(run.lastEvaluatedAt)) + '</div>';
                } else {
                    const outputKind = rule.outputMapping?.kind || "none", outputLabel = outputKind === "trigger_signal" ? "triggering signal" : outputKind === "gateway_signal" ? "Gateway signal" : outputKind === "aas_property" ? "AAS Property" : "result only";
                    input = esc(signal?.name || rule.signalId || "Missing signal") + ' <strong>' + esc(conditionLabels[rule.condition] || rule.condition) + '</strong> ' + esc(rule.threshold);
                    action = '<strong>Invoke Service Function</strong><div>' + esc(service?.name || service?.id || rule.serviceId || "Missing Service") + ' → ' + esc(operation?.name || rule.operationId || "Missing Function") + '</div><div class="small">Output → ' + esc(outputLabel) + '</div>';
                    inputMeta = '<span class="live-value ' + esc(String(live.status).toLowerCase()) + '">' + esc(value) + ' · ' + esc(live.status) + '</span><div class="small">Updated ' + esc(timeText(live.updatedAt)) + '</div>';
                }
                return '<tr><td><span class="badge draft">' + (type === "service" ? "Service" : "Gateway") + '</span><strong>' + esc(rule.name) + '</strong><div class="small">' + esc(rule.id) + '</div></td><td>' + input + '</td><td>' + action + '</td><td>' + inputMeta + '</td><td><span class="badge ' + statusClass + '">' + status + '</span><div class="small">State: ' + esc(run.display) + ' · Last result: ' + esc(run.lastResult) + '</div>' + (broken || run.error ? '<div class="small" style="color:var(--danger)">' + esc(errors.join(" ") || run.error) + '</div>' : '') + '</td><td><div class="row-actions"><button class="link-btn" data-toggle="' + esc(rule.id) + '"' + (broken ? ' disabled' : '') + '>' + (rule.enabled ? 'Disable' : 'Enable') + '</button><button class="link-btn" data-test="' + esc(rule.id) + '"' + testDisabled + '>Test</button><button class="link-btn" data-edit="' + esc(rule.id) + '">Edit</button><button class="link-btn" data-delete="' + esc(rule.id) + '">Delete</button></div></td></tr>';
            }).join("") || '<tr><td colspan="6">No rules. Add a Gateway Rule or Service Rule, then enable it when its references are valid.</td></tr>';
            const referenceIssues = model.validate().filter(issue => issue.startsWith("Rule "));
            issues.innerHTML = referenceIssues.length ? '<ul style="color:var(--danger)">' + referenceIssues.map(issue => '<li>' + esc(issue) + '</li>').join("") + '</ul>' : '';
            historyRows.innerHTML = runtime.executions().map(item => '<tr><td>' + esc(timeText(item.startedAt)) + '</td><td>' + esc(item.ruleId) + '</td><td>' + esc(item.value ?? "—") + (item.unit ? ' ' + esc(item.unit) : '') + '</td><td>' + esc(item.serviceId) + '<div class="small">' + esc(item.operationId || "execute") + '</div></td><td><span class="badge ' + (item.status === "Failed" ? "offline" : item.status === "Running" ? "warning" : "") + '">' + esc(item.status) + '</span><div class="small">' + esc(item.ruleType === "service" ? "Service Rule · Function completion event" : item.test ? "Manual test · Demo Function" : "Gateway Rule · Demo Function") + '</div>' + (item.outputData == null ? '' : '<div class="small">Output: ' + esc(item.outputData) + ' → ' + esc(item.outputAppliedTo) + '</div>') + '</td></tr>').join("") || '<tr><td colspan="5">No Demo rule execution in this browser session.</td></tr>';
        }

        function open(rule = null, requestedType = "gateway") {
            const type = rule?.type || requestedType || "gateway";
            editingId = rule?.id ?? null;
            setRuleType(type);
            form.elements.id.value = rule?.id ?? "rule:" + Date.now().toString(36);
            form.elements.id.readOnly = Boolean(rule);
            form.elements.name.value = rule?.name ?? "";
            form.elements.gatewaySignalId.innerHTML = gatewaySignalOptions();
            form.elements.targetSignalId.innerHTML = gatewaySignalOptions();
            fillServices(form.elements.actionServiceId, type === "gateway" ? rule?.serviceId || "" : "");
            fillServices(form.elements.inputServiceId, type === "service" ? rule?.serviceId || "" : "");
            fillOperations(form.elements.actionServiceId, form.elements.actionOperationId, type === "gateway" ? rule?.operationId || "" : "");
            fillOperations(form.elements.inputServiceId, form.elements.inputOperationId, type === "service" ? rule?.operationId || "" : "");
            form.elements.gatewaySignalId.value = type === "gateway" ? rule?.signalId || "" : "";
            form.elements.targetSignalId.value = type === "service" ? rule?.signalId || "" : "";
            form.elements.dynamicArgs.value = JSON.stringify(rule?.dynamicArgs || {}, null, 2);
            form.elements.outputKind.value = rule?.outputMapping?.kind || "none";
            adaptOutput(rule?.outputMapping?.targetId || "");
            form.elements.condition.value = rule?.condition === "service_completed" ? "greater_than" : rule?.condition || "greater_than";
            thresholdInput.value = rule?.threshold ?? "";
            form.elements.booleanThreshold.value = String(rule?.threshold ?? "true");
            host.querySelector("[data-errors]").textContent = "";
            adaptGatewayInput();
            host.classList.add("open");
            host.setAttribute("aria-hidden", "false");
            form.elements.name.focus();
        }

        form.elements.gatewaySignalId.addEventListener("change", adaptGatewayInput);
        form.elements.actionServiceId.addEventListener("change", () => fillOperations(form.elements.actionServiceId, form.elements.actionOperationId));
        form.elements.inputServiceId.addEventListener("change", () => fillOperations(form.elements.inputServiceId, form.elements.inputOperationId));
        form.elements.outputKind.addEventListener("change", () => adaptOutput());
        form.addEventListener("submit", event => {
            event.preventDefault();
            try {
                let draft;
                if (ruleType === "service") {
                    draft = { id: form.elements.id.value, type: "service", name: form.elements.name.value, signalId: form.elements.targetSignalId.value, serviceId: form.elements.inputServiceId.value, operationId: form.elements.inputOperationId.value };
                } else {
                    const signal = model.snapshot().signals.find(item => item.id === form.elements.gatewaySignalId.value && !item.deleted);
                    const dynamicArgs = root.GucServiceActions.parseObject(form.elements.dynamicArgs.value, "Dynamic arguments");
                    draft = { id: form.elements.id.value, type: "gateway", name: form.elements.name.value, signalId: form.elements.gatewaySignalId.value, condition: form.elements.condition.value, threshold: signal?.valueType === "xs:boolean" ? form.elements.booleanThreshold.value : thresholdInput.value, serviceId: form.elements.actionServiceId.value, operationId: form.elements.actionOperationId.value, dynamicArgs, outputMapping: { kind: form.elements.outputKind.value, targetId: form.elements.outputTargetId.value } };
                }
                const additional = extraErrors(draft); if (additional.length) throw Error(additional.join(" "));
                model.upsertRule(draft, editingId);
                close();
                toast((ruleType === "service" ? "Service Rule" : "Gateway Rule") + " saved disabled. Enable it to start Demo evaluation.");
            } catch (error) { host.querySelector("[data-errors]").textContent = error.message; }
        });

        host.querySelector("[data-close]").addEventListener("click", close);
        host.querySelector("[data-cancel]").addEventListener("click", close);
        document.getElementById("addEngineRule").addEventListener("click", () => open(null, "gateway"));
        document.getElementById("addServiceRule").addEventListener("click", () => open(null, "service"));
        rows.addEventListener("click", async event => {
            const id = event.target.dataset.toggle || event.target.dataset.test || event.target.dataset.edit || event.target.dataset.delete;
            if (!id) return;
            const rule = model.snapshot().rules.find(item => item.id === id);
            try {
                if (event.target.dataset.toggle) { runtime.enableRule(id, !rule.enabled); toast(rule.enabled ? "Rule disabled." : "Rule enabled in the browser runtime."); }
                if (event.target.dataset.test) { const result = await runtime.testRule(id); toast(rule.type === "service" ? (result ? "Service Function tested; outputData was written to the Gateway signal." : "Service Rule test failed.") : result ? "Test condition is true; Demo Service Function invoked." : "Test condition is false; no Action invoked."); }
                if (event.target.dataset.edit) open(rule, rule.type || "gateway");
                if (event.target.dataset.delete && confirm("Delete rule " + id + "?")) model.deleteRule(id);
            } catch (error) { toast(error.message); }
        });
        document.getElementById("engineDemoToggle")?.addEventListener("click", () => { runtime.setRunning(!runtime.isRunning()); toast("Demo Auto Trigger " + (runtime.isRunning() ? "started. Gateway and Service Rules are active." : "stopped.")); });
        model.subscribe(render);
        liveData.subscribe(render);
        runtime.subscribe(render);
        render();
        return { render, open };
    }

    root.GucRuleEditor = { init };
})(typeof window !== "undefined" ? window : globalThis);
