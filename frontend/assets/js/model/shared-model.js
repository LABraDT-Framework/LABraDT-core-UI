(function (root) {
    "use strict";
    const KEY = "guc-shared-model-v1";
    const clone = value => JSON.parse(JSON.stringify(value));
    const connectionId = machineId => "connection:" + encodeURIComponent(machineId);
    const signalId = (machineId, idShort) => "signal:" + encodeURIComponent(machineId) + ":" + encodeURIComponent(idShort);
    // Blank canvas: protocol plugins are added explicitly (Add GW Plugin).
    const bundledPlugins = [];
    const validEntities = items => Array.isArray(items) && items.every(item => item && typeof item === "object" && typeof item.id === "string" && item.id.trim()) && new Set(items.map(item => item.id)).size === items.length;
    const allowedDefinitionTypes = new Set(["xs:string", "xs:boolean", "xs:int", "xs:long", "xs:double", "xs:dateTime"]);
    const validLibrary = library => library && typeof library.name === "string" && /\.jar$/i.test(library.name) && Number.isFinite(library.size) && library.size > 0 && library.size <= 25 * 1024 * 1024 && library.bytesStored === false;
    const validDemoPlugins = items => Array.isArray(items) && items.every(plugin => plugin && plugin.source === "demo" && /^plugin:[A-Za-z0-9._-]+$/.test(plugin.id) && typeof plugin.name === "string" && plugin.name.trim() && typeof plugin.protocol === "string" && plugin.protocol.trim() && typeof plugin.clientClass === "string" && plugin.clientClass.trim() && plugin.installation === "not installed" && validLibrary(plugin.library) && Array.isArray(plugin.definitions) && plugin.definitions.length && plugin.definitions.every(definition => definition && ["data", "guard"].includes(definition.kind) && typeof definition.localId === "string" && /^definition:[A-Za-z0-9._-]+$/.test(definition.localId) && definition.id === plugin.id + "/" + definition.localId && typeof definition.name === "string" && definition.name.trim() && allowedDefinitionTypes.has(definition.valueType) && (definition.kind !== "guard" || (definition.valueType === "xs:boolean" && definition.writable === false))) && new Set(plugin.definitions.map(definition => definition.id)).size === plugin.definitions.length) && new Set(items.map(plugin => plugin.id)).size === items.length;
    function parseRange(value) {
        if (Array.isArray(value) && value.length === 2 && value.every(Number.isFinite)) return value;
        if (typeof value === "string") { const match = value.match(/^\s*\[?\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]?\s*$/); if (match) return [Number(match[1]), Number(match[2])]; }
        return null;
    }
    function serviceOperations(service) {
        if (Array.isArray(service?.operations) && service.operations.length) return service.operations;
        return [{ id: service?.operationId || "execute", name: service?.operationName || "Execute" }];
    }
    function validateRuleDraft(draft, state, editingId = null) {
        const errors = [], rawId = String(draft.id || ""), id = rawId.trim(), type = draft.type || "gateway", signal = state.signals.find(item => item.id === draft.signalId && !item.deleted), service = state.services.find(item => item.id === draft.serviceId), isEditing = editingId !== null;
        if (!id) errors.push("Rule ID is required.");
        else if (!isEditing && !/^[A-Za-z0-9:._-]+$/.test(id)) errors.push("Rule ID requires letters, numbers, colon, dot, underscore or hyphen.");
        if (isEditing && rawId !== String(editingId)) errors.push("Rule ID is immutable; create a new rule to use another ID.");
        if (state.rules.some(item => item.id === id && item.id !== editingId)) errors.push("Rule ID already exists.");
        const operationId = draft.operationId || serviceOperations(service)[0]?.id || "";
        if (!["gateway", "service"].includes(type)) errors.push("Select a supported rule type.");
        if (!signal) errors.push(type === "service" ? "Select an available output Gateway signal." : "Select an available Gateway signal.");
        if (!service) errors.push("Select an available Service.");
        else if (!serviceOperations(service).some(operation => operation.id === operationId)) errors.push("Select an available Function / Operation.");
        if (type === "gateway") {
            if (draft.dynamicArgs != null && (typeof draft.dynamicArgs !== "object" || Array.isArray(draft.dynamicArgs))) errors.push("Dynamic arguments must be a JSON object.");
            const outputKind = draft.outputMapping?.kind || "none", outputTargetId = String(draft.outputMapping?.targetId || "");
            if (!["none", "trigger_signal", "gateway_signal", "aas_property"].includes(outputKind)) errors.push("Select a supported output mapping.");
            if (outputKind === "gateway_signal" && !state.signals.some(item => item.id === outputTargetId && !item.deleted)) errors.push("Select an available output Gateway signal.");
            if (outputKind === "aas_property" && !outputTargetId) errors.push("Select an output AAS Property.");
            if (!["greater_than", "less_than", "equals"].includes(draft.condition)) errors.push("Select a supported comparison.");
            const numeric = signal && ["xs:double", "xs:float", "xs:int", "xs:long"].includes(signal.valueType);
            if (numeric) { const raw = String(draft.threshold ?? "").trim(), value = Number(raw); if (!raw || !Number.isFinite(value)) errors.push("Enter a numeric threshold for this signal."); else if (Array.isArray(signal.validRange) && signal.validRange.length === 2 && Number.isFinite(Number(signal.validRange[0])) && Number.isFinite(Number(signal.validRange[1])) && (value < Number(signal.validRange[0]) || value > Number(signal.validRange[1]))) errors.push("Comparison value must be within [" + signal.validRange.join(", ") + "]."); }
            else if (signal?.valueType === "xs:boolean") { if (draft.condition !== "equals") errors.push("Boolean signals support equals only."); if (!["true", "false"].includes(String(draft.threshold).toLowerCase())) errors.push("Boolean comparison value must be true or false."); }
            else if (signal) { if (draft.condition !== "equals") errors.push("Non-numeric signals support equals only."); if (String(draft.threshold ?? "").trim() === "") errors.push("Enter a comparison value."); if (signal.valueType === "xs:dateTime" && Number.isNaN(Date.parse(String(draft.threshold)))) errors.push("Enter a valid date/time comparison value."); }
            const thresholdKey = numeric ? String(Number(String(draft.threshold).trim())) : String(draft.threshold ?? "").trim().toLowerCase();
            if (signal && service && state.rules.some(item => item.id !== editingId && (item.type || "gateway") === "gateway" && item.signalId === draft.signalId && item.serviceId === draft.serviceId && (item.operationId || serviceOperations(service)[0]?.id) === operationId && item.condition === draft.condition && (numeric ? String(Number(String(item.threshold).trim())) : String(item.threshold ?? "").trim().toLowerCase()) === thresholdKey)) errors.push("An equivalent Gateway Rule already exists.");
        } else if (signal && service && state.rules.some(item => item.id !== editingId && item.type === "service" && item.signalId === draft.signalId && item.serviceId === draft.serviceId && (item.operationId || serviceOperations(service)[0]?.id) === operationId)) errors.push("An equivalent Service Rule already exists.");
        return errors;
    }
    function create(storage, defaults = []) {
        let warning = "", readOnly = false;
        let state = { schemaVersion: 1, plugins: clone(bundledPlugins), connections: [], signals: [], services: [], rules: [], gatewaySync: { status: "unverified", lastSuccessAt: null } };
        try {
            const raw = storage.getItem(KEY);
            if (raw !== null) {
                const saved = JSON.parse(raw);
                if (saved.schemaVersion !== 1 || !["connections", "signals", "services", "rules"].every(key => validEntities(saved[key]))) throw new Error("Unsupported or invalid shared model; saved data preserved.");
                const demoPlugins = Array.isArray(saved.plugins) ? saved.plugins.filter(plugin => plugin && plugin.source === "demo") : [];
                if (!validDemoPlugins(demoPlugins) || demoPlugins.some(plugin => bundledPlugins.some(bundled => bundled.id === plugin.id))) throw new Error("Invalid saved demo plugin metadata; saved data preserved.");
                state = { ...state, ...saved, plugins: [...clone(bundledPlugins), ...clone(demoPlugins)], gatewaySync: { ...saved.gatewaySync, status: "unverified" } };
            } else {
                const legacy = JSON.parse(storage.getItem("guc-services-demo") || "null");
                if (legacy !== null && !validEntities(legacy)) throw new Error("Invalid legacy Services; saved data preserved.");
                state.services = clone(legacy !== null ? legacy : defaults);
            }
        } catch (error) { warning = error.message; readOnly = true; state.services = clone(defaults); }
        const listeners = new Set();
        let gatewayPlugins = null; // Runtime catalogue is server-owned, never persisted as browser-only descriptors.
        const persist = () => {
            if (!readOnly) {
                try { storage.setItem(KEY, JSON.stringify(state)); } catch (error) { warning = "Browser persistence failed: " + error.message; }
            }
            listeners.forEach(listener => listener());
        };
        function validate() {
            const issues = [];
            if (warning) issues.push(warning);
            for (const connection of state.connections.filter(item => !item.deleted)) {
                if (!(gatewayPlugins || state.plugins).some(plugin => plugin.protocol === connection.protocol)) issues.push("Connection " + connection.id + ": missing protocol plugin '" + connection.protocol + "'.");
            }
            for (const rule of state.rules) {
                const type = rule.type || "gateway";
                const signal = state.signals.find(item => item.id === rule.signalId && !item.deleted);
                const service = state.services.find(item => item.id === rule.serviceId);
                if (!signal) issues.push("Rule " + rule.id + ": missing/deleted " + (type === "service" ? "output " : "") + "signal '" + (rule.signalId || "(not selected)") + "'.");
                if (!service) issues.push("Rule " + rule.id + ": missing/deleted Service '" + (rule.serviceId || "(not selected)") + "'.");
                else if (!serviceOperations(service).some(operation => operation.id === (rule.operationId || serviceOperations(service)[0]?.id))) issues.push("Rule " + rule.id + ": missing Function / Operation '" + (rule.operationId || "(not selected)") + "'.");
                if (type === "gateway" && rule.outputMapping?.kind === "gateway_signal" && !state.signals.some(item => item.id === rule.outputMapping.targetId && !item.deleted)) issues.push("Rule " + rule.id + ": missing output Gateway signal '" + (rule.outputMapping.targetId || "(not selected)") + "'.");
                if (signal && !state.connections.some(item => item.id === signal.connectionId && !item.deleted)) issues.push("Rule " + rule.id + ": missing/deleted connection '" + signal.connectionId + "'.");
            }
            return issues;
        }
        const api = {
            snapshot: () => clone(state), validate, connectionId, signalId,
            setGatewayPlugins(items) {
                gatewayPlugins = clone(items);
                for (const connection of state.connections) {
                    const plugin = gatewayPlugins.find(item => item.protocol === connection.protocol);
                    if (plugin) connection.pluginId = plugin.id;
                }
            },
            subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
            replaceServices(items) {
                const ids = items.map(item => item.id);
                if (ids.some(id => typeof id !== "string" || !id.trim()) || new Set(ids).size !== ids.length) throw new Error("Services require unique, non-empty IDs.");
                state.services = clone(items); persist();
            },
            addDemoPlugin(draft) {
                const id = String(draft.id || "").trim(), name = String(draft.name || "").trim(), protocol = String(draft.protocol || "").trim(), clientClass = String(draft.clientClass || "").trim();
                if (!id || !/^plugin:[A-Za-z0-9._-]+$/.test(id)) throw new Error("Plugin ID must start with plugin: and contain only letters, numbers, dot, underscore or hyphen.");
                if (!name || !protocol || !clientClass) throw new Error("Name, protocol and Java client class are required.");
                if (state.plugins.some(plugin => plugin.id === id)) throw new Error("Plugin ID already exists.");
                const definitions = Array.isArray(draft.definitions) ? draft.definitions.map(item => { const localId = String(item.id || "").trim(); return { id: id + "/" + localId, localId, name: String(item.name || "").trim(), kind: item.kind, valueType: item.valueType, readable: item.readable !== false, writable: Boolean(item.writable) }; }) : [];
                if (!definitions.length || definitions.some(item => !["data", "guard"].includes(item.kind) || !/^definition:[A-Za-z0-9._-]+$/.test(item.localId) || !item.name || !allowedDefinitionTypes.has(item.valueType) || (item.kind === "guard" && (item.valueType !== "xs:boolean" || item.writable))) || new Set(definitions.map(item => item.localId)).size !== definitions.length) throw new Error("Exposed definitions require unique definition: IDs, names, supported types, and boolean read-only guards.");
                if (!validLibrary({ name: String(draft.libraryName || ""), size: Number(draft.librarySize), bytesStored: false })) throw new Error("Validated JAR library metadata is required.");
                const plugin = { id, name, protocol, clientClass, source: "demo", installation: "not installed", library: { name: String(draft.libraryName || ""), size: Number(draft.librarySize || 0), validatedAs: "JAR/ZIP signature only", bytesStored: false }, definitions };
                state.plugins.push(plugin); persist(); return clone(plugin);
            },
            deleteDemoPlugin(id) {
                const plugin = state.plugins.find(item => item.id === id);
                if (!plugin || plugin.source !== "demo") throw new Error("Only demo plugin definitions can be deleted.");
                if (state.connections.some(item => item.pluginId === id && !item.deleted)) throw new Error("Plugin is referenced by a machine connection.");
                state.plugins = state.plugins.filter(item => item.id !== id); persist();
            },
            syncGateway(entries) {
                if (!Array.isArray(entries) || entries.some(entry => !entry.config || typeof entry.config.machineId !== "string" || !entry.config.machineId.trim() || !Array.isArray(entry.config.mappings) || entry.config.mappings.some(mapping => typeof mapping.idShort !== "string" || !mapping.idShort.trim()))) throw new Error("Invalid Gateway configuration response; cached identities preserved.");
                const connections = [], signals = [];
                for (const entry of entries) {
                    const config = entry.config, id = connectionId(config.machineId);
                    if (connections.some(item => item.id === id)) throw new Error("Duplicate machine identity '" + config.machineId + "'.");
                    const old = state.connections.find(item => item.id === id);
                    connections.push({ id, machineId: config.machineId, name: old?.name || config.machineId, pluginId: gatewayPlugins?.find(plugin => plugin.protocol === config.protocol)?.id || "plugin:" + config.protocol, protocol: config.protocol, fileName: entry.fileName, enabled: entry.enabled !== false, deleted: false });
                    for (const mapping of config.mappings) {
                        const sid = signalId(config.machineId, mapping.idShort);
                        if (signals.some(item => item.id === sid)) throw new Error("Duplicate signal identity '" + mapping.idShort + "'.");
                        const oldSignal = state.signals.find(item => item.id === sid);
                        const readable = typeof mapping.readable === "boolean" ? mapping.readable : typeof oldSignal?.readable === "boolean" ? oldSignal.readable : null;
                        const writable = typeof mapping.writable === "boolean" ? mapping.writable : typeof oldSignal?.writable === "boolean" ? oldSignal.writable : null;
                        signals.push({ id: sid, connectionId: id, enabled: entry.enabled !== false, idShort: mapping.idShort, name: oldSignal?.name || mapping.idShort, targetElement: config.machineId + "." + mapping.idShort, valueType: mapping.valueType, unit: mapping.unit || "", sourceAddress: mapping.sourceAddress, category: mapping.category || "VARIABLE", validRange: parseRange(mapping.validRange), readable, writable, accessLevel: mapping.accessLevel || oldSignal?.accessLevel || (writable === true ? "Read / Write" : writable === false ? "Read only" : "Access unknown"), deleted: false });
                    }
                }
                state.connections = [...connections, ...state.connections.filter(old => !connections.some(item => item.id === old.id)).map(old => ({ ...old, deleted: true }))];
                state.signals = [...signals, ...state.signals.filter(old => !signals.some(item => item.id === old.id)).map(old => ({ ...old, deleted: true }))];
                state.gatewaySync = { status: "synced", lastSuccessAt: new Date().toISOString() }; persist();
            },
            gatewayFailed(message) { state.gatewaySync = { ...state.gatewaySync, status: "unavailable", error: message }; persist(); },
            rename(kind, id, name) {
                if (!["connections", "signals"].includes(kind) || typeof name !== "string" || !name.trim()) throw new Error("A connection/signal and display name are required.");
                const item = state[kind].find(item => item.id === id && !item.deleted);
                if (!item) throw new Error("Missing/deleted item.");
                item.name = name.trim(); persist();
            },
            upsertRule(draft, editingId = null) {
                const errors = validateRuleDraft(draft, state, editingId); if (errors.length) throw new Error(errors.join(" "));
                const type = draft.type || "gateway", signal = state.signals.find(item => item.id === draft.signalId && !item.deleted), numeric = signal && ["xs:double", "xs:float", "xs:int", "xs:long"].includes(signal.valueType), id = editingId !== null ? editingId : String(draft.id).trim();
                const threshold = type === "gateway" ? (numeric ? Number(String(draft.threshold).trim()) : signal?.valueType === "xs:boolean" ? String(draft.threshold).toLowerCase() : String(draft.threshold ?? "").trim()) : null;
                const service = state.services.find(item => item.id === draft.serviceId);
                const rule = { id, type, name: String(draft.name || "").trim() || id, signalId: draft.signalId || "", serviceId: draft.serviceId || "", operationId: draft.operationId || serviceOperations(service)[0]?.id || "", dynamicArgs: type === "gateway" ? clone(draft.dynamicArgs || {}) : {}, outputMapping: type === "gateway" ? clone(draft.outputMapping || { kind: "none", targetId: "" }) : { kind: "gateway_signal", targetId: draft.signalId || "" }, condition: type === "gateway" ? draft.condition || "" : "service_completed", threshold, enabled: false };
                const index = state.rules.findIndex(item => item.id === (editingId || rule.id));
                if (index < 0) state.rules.push(rule); else state.rules[index] = rule;
                persist(); return clone(rule);
            },
            setRuleEnabled(id, enabled) {
                const rule = state.rules.find(item => item.id === id);
                if (!rule) throw new Error("Rule is missing.");
                if (enabled) {
                    const errors = validateRuleDraft(rule, state, rule.id);
                    if (errors.length) throw new Error(errors.join(" "));
                }
                rule.enabled = Boolean(enabled);
                persist();
                return clone(rule);
            },
            deleteRule(id) { state.rules = state.rules.filter(rule => rule.id !== id); persist(); }
        };
        persist();
        return api;
    }
    const exported = { create, connectionId, signalId, validateRuleDraft, parseRange, KEY };
    if (typeof module !== "undefined" && module.exports) module.exports = exported;
    else root.GucSharedModel = exported;
})(typeof window !== "undefined" ? window : globalThis);
