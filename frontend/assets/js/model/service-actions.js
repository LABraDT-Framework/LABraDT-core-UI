(function (root) {
    "use strict";

    const clone = value => JSON.parse(JSON.stringify(value));
    const safeId = value => String(value || "execute")
        .trim()
        .replace(/\.[^.]+$/, "")
        .replace(/[^A-Za-z0-9_$]+(.)?/g, (_, next) => next ? next.toUpperCase() : "") || "execute";

    function parseObject(value, label = "JSON object") {
        if (value == null || value === "") return {};
        const parsed = typeof value === "string" ? JSON.parse(value) : clone(value);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw Error(label + " must be a JSON object.");
        return parsed;
    }

    function firstDefinitionName(definition, fallback) {
        const first = String(definition || "").split(",")[0].trim();
        const name = first.split(":")[0].trim();
        return name || fallback;
    }

    function orderedRegistryArgs(actual, saved) {
        const values = parseObject(actual, "Registry default arguments");
        let previous = {};
        try { previous = parseObject(saved); } catch {}
        // The registry's map may reorder keys. Preserve the editor's parameter
        // order, but always take values and available keys from the real registry.
        const names = [...new Set([...Object.keys(previous), ...Object.keys(values)])];
        return Object.fromEntries(names.filter(name => Object.prototype.hasOwnProperty.call(values, name)).map(name => [name, values[name]]));
    }

    function hasExecutionLocation(service) {
        if (String(service?.file || "").trim()) return true;
        let args;
        try { args = parseObject(service?.defaultArgs); } catch { return false; }
        const location = service?.runtimeType === "REST" ? args.url : service?.runtimeType === "LUA" ? args.testContent : "";
        return typeof location === "string" && Boolean(location.trim());
    }

    function firstDefinitionType(definition) {
        const first = String(definition || "").split(",")[0].trim();
        return first.includes(":") ? first.split(":").slice(1).join(":").trim().toLowerCase() : "";
    }

    function compatibleOutput(definition, valueType) {
        const type = firstDefinitionType(definition);
        if (!type || !valueType) return true;
        if (["number", "float", "double", "integer", "int", "long"].includes(type)) return ["xs:double", "xs:float", "xs:int", "xs:long"].includes(valueType);
        if (["bool", "boolean"].includes(type)) return valueType === "xs:boolean";
        if (["string", "text"].includes(type)) return valueType === "xs:string";
        if (["datetime", "date-time", "date"].includes(type)) return valueType === "xs:dateTime";
        return true;
    }

    function normalizeOperations(service) {
        const source = Array.isArray(service?.operations) && service.operations.length
            ? service.operations
            : [{
                id: service?.operationId || safeId(service?.file || service?.id),
                name: service?.operationName || service?.operationId || "Execute",
                input: service?.input || "",
                output: service?.output || "result:string",
                resultArg: service?.resultArg || firstDefinitionName(service?.input, "currentValue")
            }];
        return source.map((operation, index) => ({
            id: String(operation?.id || (index ? "execute" + (index + 1) : "execute")).trim(),
            name: String(operation?.name || operation?.id || "Execute").trim(),
            input: String(operation?.input || "").trim(),
            output: String(operation?.output || "result:string").trim(),
            resultArg: String(operation?.resultArg || firstDefinitionName(operation?.input, "currentValue")).trim()
        }));
    }

    function simulate(service, operationId, dynamicArgs, context = {}) {
        const operations = normalizeOperations(service);
        const operation = operations.find(item => item.id === operationId) || operations[0];
        if (!operation || (operationId && operation.id !== operationId)) throw Error("Function / Operation '" + operationId + "' is not available in Service '" + service.id + "'.");
        const args = {
            ...parseObject(service?.defaultArgs, "Service default arguments"),
            ...parseObject(dynamicArgs, "Rule dynamic arguments"),
            currentValue: context.value,
            threshold: context.threshold,
            signalId: context.signalId,
            ruleId: context.ruleId
        };
        const outputName = firstDefinitionName(operation.output, "result");
        const sourceName = operation.resultArg || "currentValue";
        const outputData = Object.prototype.hasOwnProperty.call(args, sourceName) ? args[sourceName] : context.value;
        return {
            serviceId: service.id,
            operationId: operation.id,
            functionName: operation.name,
            args,
            outputData,
            output: { [outputName]: outputData }
        };
    }

    const exported = { parseObject, orderedRegistryArgs, hasExecutionLocation, normalizeOperations, simulate, firstDefinitionName, firstDefinitionType, compatibleOutput };
    if (typeof module !== "undefined" && module.exports) module.exports = exported;
    else root.GucServiceActions = exported;
})(typeof window !== "undefined" ? window : globalThis);
