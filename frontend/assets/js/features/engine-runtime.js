(function (root) {
    "use strict";

    const numericTypes = new Set(["xs:double", "xs:float", "xs:int", "xs:long"]);
    const clone = value => JSON.parse(JSON.stringify(value));

    function evaluateCondition(value, condition, threshold, valueType) {
        if (value === undefined || value === null) throw Error("A live value is required.");
        if (numericTypes.has(valueType)) {
            const current = Number(value), expected = Number(threshold);
            if (!Number.isFinite(current) || !Number.isFinite(expected)) throw Error("The live value or threshold is not numeric.");
            if (condition === "greater_than") return current > expected;
            if (condition === "less_than") return current < expected;
            if (condition === "equals") return current === expected;
        } else if (valueType === "xs:boolean") {
            const raw = String(value).toLowerCase();
            if (typeof value !== "boolean" && !["true", "false"].includes(raw)) throw Error("The live value is not boolean.");
            const current = typeof value === "boolean" ? value : raw === "true";
            if (condition === "equals") return current === (String(threshold).toLowerCase() === "true");
        } else if (valueType === "xs:dateTime") {
            const current = Date.parse(String(value)), expected = Date.parse(String(threshold));
            if (!Number.isFinite(current) || !Number.isFinite(expected)) throw Error("The live value or threshold is not a valid date/time.");
            if (condition === "greater_than") return current > expected;
            if (condition === "less_than") return current < expected;
            if (condition === "equals") return current === expected;
        } else if (condition === "equals") return String(value) === String(threshold);
        throw Error("Unsupported comparison for this signal type.");
    }

    function shouldTrigger(previous, current, lastTriggeredAt, now, cooldownMs) {
        return previous === false && current === true && (!lastTriggeredAt || now - lastTriggeredAt >= cooldownMs);
    }

    function init({ model, liveData, triggerService, executeServiceRule, toast, cooldownMs = 5000 }) {
        const listeners = new Set(), states = new Map(), executions = [];
        let running = false;

        function notify() { listeners.forEach(listener => listener()); }
        function stateFor(id) {
            if (!states.has(id)) states.set(id, { condition: false, display: "Not evaluated", lastValue: null, lastEvaluatedAt: null, lastTriggeredAt: null, lastResult: "Never run", executionId: null, error: "" });
            return states.get(id);
        }

        async function applyServiceRule(rule, event, test = false) {
            const state = stateFor(rule.id), now = Date.now();
            if (state.lastResult === "Running") return false;
            state.lastTriggeredAt = now;
            state.lastResult = "Running";
            state.display = test ? "Service completed (test)" : "Service completed";
            state.error = "";
            const execution = { id: "engine:" + now.toString(36) + ":" + Math.random().toString(36).slice(2, 7), ruleId: rule.id, ruleType: "service", serviceId: event.serviceId, operationId: event.operationId, signalId: rule.signalId, value: event.outputData, unit: "", source: test ? "service-rule-test" : "service-completion", test, startedAt: new Date(now).toISOString(), status: "Running", completedAt: null, error: "", outputData: event.outputData, outputAppliedTo: "" };
            executions.unshift(execution);
            executions.splice(50);
            notify();
            try {
                if (typeof executeServiceRule !== "function") throw Error("Service Rule Gateway writer is unavailable.");
                const result = await executeServiceRule(rule, event);
                execution.status = result?.status || "Success";
                execution.completedAt = new Date().toISOString();
                execution.outputData = result?.outputData ?? event.outputData;
                execution.outputAppliedTo = result?.outputAppliedTo || "Gateway signal";
                state.executionId = execution.id;
                state.lastResult = execution.status;
                state.lastValue = { value: event.outputData, source: event.source || "service" };
                state.lastEvaluatedAt = execution.completedAt;
            } catch (error) {
                execution.status = "Failed";
                execution.error = error.message;
                execution.completedAt = new Date().toISOString();
                state.lastResult = "Failed";
                state.error = error.message;
            }
            notify();
            return execution.status !== "Failed";
        }

        async function serviceCompleted(event, options = {}) {
            if (!event || !event.serviceId || !event.operationId) return [];
            const matching = model.snapshot().rules.filter(rule => rule.type === "service" && rule.serviceId === event.serviceId && rule.operationId === event.operationId && (options.forceRuleId === rule.id || (!options.forceRuleId && running && rule.enabled)));
            const results = [];
            for (const rule of matching) results.push(await applyServiceRule(rule, event, Boolean(options.test)));
            return results;
        }

        async function fire(rule, signal, view, test = false) {
            const state = stateFor(rule.id), now = Date.now();
            if (state.lastResult === "Running") return;
            state.lastTriggeredAt = now;
            state.lastResult = "Running";
            state.error = "";
            const execution = { id: "engine:" + now.toString(36) + ":" + Math.random().toString(36).slice(2, 7), ruleId: rule.id, serviceId: rule.serviceId, operationId: rule.operationId, signalId: signal.id, value: view.value, unit: view.unit || signal.unit || "", source: view.source, test, startedAt: new Date(now).toISOString(), status: "Running", completedAt: null, error: "", outputData: null, outputAppliedTo: "" };
            executions.unshift(execution);
            executions.splice(50);
            notify();
            try {
                const result = await triggerService(rule.serviceId, { ruleId: rule.id, signalId: signal.id, value: view.value, threshold: rule.threshold, operationId: rule.operationId, dynamicArgs: rule.dynamicArgs || {}, outputMapping: rule.outputMapping || { kind: "none", targetId: "" }, test, executionId: execution.id });
                execution.status = result?.status || "Success";
                execution.id = result?.executionId || execution.id;
                execution.completedAt = new Date().toISOString();
                state.executionId = execution.id;
                state.lastResult = execution.status;
                execution.outputData = result?.outputData;
                execution.outputAppliedTo = result?.outputAppliedTo || "Result only";
                await serviceCompleted({ serviceId: rule.serviceId, operationId: rule.operationId, outputData: result?.outputData, executionId: execution.id, source: test ? "gateway-rule-test" : "gateway-rule" });
            } catch (error) {
                execution.status = "Failed";
                execution.error = error.message;
                execution.completedAt = new Date().toISOString();
                state.lastResult = "Failed";
                state.error = error.message;
            }
            notify();
        }

        function evaluateRule(rule, allowTrigger = true) {
            const snapshot = model.snapshot(), state = stateFor(rule.id);
            const signal = snapshot.signals.find(item => item.id === rule.signalId && !item.deleted);
            const errors = root.GucSharedModel.validateRuleDraft(rule, snapshot, rule.id);
            if (errors.length || !signal) {
                state.display = "Invalid";
                state.error = errors.join(" ");
                notify();
                return false;
            }
            if (!rule.enabled) {
                state.display = "Disabled";
                notify();
                return false;
            }
            if (rule.type === "service") {
                state.display = running ? "Waiting for Service completion" : "Runtime stopped";
                state.error = "";
                notify();
                return false;
            }
            const view = liveData.viewForSignal(rule.signalId);
            state.lastValue = view;
            if (!running) {
                state.display = "Runtime stopped";
                notify();
                return false;
            }
            if (view.status !== "OK") {
                state.display = "No data · " + view.status;
                state.error = view.message || "";
                notify();
                return false;
            }
            const previous = state.condition;
            try {
                const current = evaluateCondition(view.value, rule.condition, rule.threshold, signal.valueType);
                state.condition = current;
                state.display = current ? "True" : "False";
                state.lastEvaluatedAt = new Date().toISOString();
                state.error = "";
                if (allowTrigger && shouldTrigger(previous, current, state.lastTriggeredAt, Date.now(), cooldownMs)) fire(rule, signal, view, false);
                notify();
                return current;
            } catch (error) {
                state.display = "Invalid value";
                state.error = error.message;
                notify();
                return false;
            }
        }

        function evaluateAll() {
            const snapshot = model.snapshot(), ids = new Set(snapshot.rules.map(rule => rule.id));
            [...states.keys()].filter(id => !ids.has(id)).forEach(id => states.delete(id));
            snapshot.rules.forEach(rule => evaluateRule(rule));
        }

        async function testRule(id) {
            const snapshot = model.snapshot(), rule = snapshot.rules.find(item => item.id === id), state = stateFor(id);
            if (!rule) throw Error("Rule is missing.");
            const signal = snapshot.signals.find(item => item.id === rule.signalId && !item.deleted), errors = root.GucSharedModel.validateRuleDraft(rule, snapshot, rule.id);
            if (errors.length || !signal) throw Error(errors.join(" ") || "Signal is missing.");
            if (rule.type === "service") {
                const result = await triggerService(rule.serviceId, { ruleId: rule.id, signalId: rule.signalId, value: null, threshold: null, operationId: rule.operationId, dynamicArgs: {}, outputMapping: { kind: "none", targetId: "" }, test: true, executionId: "engine:" + Date.now().toString(36) });
                const applied = await serviceCompleted({ serviceId: rule.serviceId, operationId: rule.operationId, outputData: result?.outputData, executionId: result?.executionId, source: "service-rule-test" }, { forceRuleId: rule.id, test: true });
                return Boolean(applied[0]);
            }
            const view = liveData.viewForSignal(rule.signalId);
            if (view.status !== "OK") throw Error("Rule test requires an OK live value; current status is " + view.status + ".");
            const result = evaluateCondition(view.value, rule.condition, rule.threshold, signal.valueType);
            state.lastValue = view;
            state.condition = result;
            state.display = result ? "True (test)" : "False (test)";
            state.lastEvaluatedAt = new Date().toISOString();
            notify();
            if (result) await fire(rule, signal, view, true);
            return result;
        }

        model.subscribe(evaluateAll);
        liveData.subscribe(evaluateAll);
        evaluateAll();
        return {
            subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
            setRunning(value) { running = Boolean(value); evaluateAll(); },
            isRunning: () => running,
            enableRule(id, enabled) { stateFor(id).condition = false; model.setRuleEnabled(id, enabled); },
            testRule,
            serviceCompleted,
            state(id) { return clone(stateFor(id)); },
            executions() { return clone(executions); },
            evaluateAll,
            logLines() {
                const header = "[runtime] Browser IF/THEN runtime " + (running ? "running" : "stopped");
                return [header, ...executions.slice(0, 20).map(item => "[" + item.status.toLowerCase() + "] " + item.ruleId + " -> " + item.serviceId + " · " + new Date(item.startedAt).toLocaleTimeString())];
            }
        };
    }

    const exported = { evaluateCondition, shouldTrigger, init };
    if (typeof module !== "undefined" && module.exports) module.exports = exported;
    else { root.GucEngineRuntimeHelpers = exported; root.GucEngineRuntime = { init }; }
})(typeof window !== "undefined" ? window : globalThis);
