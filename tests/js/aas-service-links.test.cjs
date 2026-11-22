"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const links = require("../../frontend/assets/js/features/aas-service-links.js");
const serviceActions = require("../../frontend/assets/js/model/service-actions.js");

const services = [
  {
    id: "analysis",
    name: "Analysis Service",
    defaultArgs: "{\"value\":0}",
    operations: [{ id: "evaluate", name: "Evaluate", input: "value:number", output: "score:number", resultArg: "value" }]
  },
  {
    id: "control",
    name: "Control Service",
    defaultArgs: "{\"target\":0}",
    operations: [{ id: "apply", name: "Apply", input: "target:number", output: "applied:number", resultArg: "target" }]
  }
];

function properties(triggerValue = 80) {
  return [
    { id: "aas|sm|Temperature", aasName: "Machine", submodelName: "OperationalData", path: "Temperature", valueType: "xs:double", value: triggerValue },
    { id: "aas|sm|Limit", aasName: "Machine", submodelName: "OperationalData", path: "Limit", valueType: "xs:double", value: 50 },
    { id: "aas|sm|Target", aasName: "Machine", submodelName: "OperationalData", path: "Target", valueType: "xs:double", value: 0 }
  ];
}

function workflow() {
  return {
    id: "aas-service-link:temperature",
    name: "Temperature Control",
    propertyId: "aas|sm|Temperature",
    enabled: true,
    condition: { operator: ">=", right: { source: "constant", value: "50" } },
    serviceCall: { serviceId: "analysis", bindings: { value: { source: "property", propertyId: "aas|sm|Temperature" } } },
    onFalse: "nothing",
    output: { kind: "aas_property", propertyId: "aas|sm|Target" }
  };
}

test('stopping Demo during Service execution prevents late output writes, even after restart', async () => {
  let token = 1, finish;
  const writes = [], runtime = links.createRuntime({
    serviceActions, getServices: () => services, getProperties: () => properties(),
    setPropertyValue: async (id, value) => writes.push({ id, value }),
    getRunToken: () => token, isRunTokenValid: value => value === token,
    executeService: () => new Promise(resolve => { finish = resolve; })
  });
  const result = runtime.execute(workflow());
  token += 2;
  finish({ outputData: 80 });
  assert.equal((await result).status, 'Paused');
  assert.deepEqual(writes, []);
  assert.equal(runtime.state(workflow().id).status, 'Paused');
});

test("definitions, typed values and all six comparisons are supported", () => {
  assert.deepEqual(links.parseDefinition("value:number, enabled:boolean"), [{ name: "value", type: "number" }, { name: "enabled", type: "boolean" }]);
  assert.equal(links.parseDefinition("x:number, y:number, speed:number, mode:string").length, 4);
  assert.equal(links.castValue("12.5", "double"), 12.5);
  assert.equal(links.castValue("true", "xs:boolean"), true);
  assert.equal(links.compareValues(10, ">", 5), true);
  assert.equal(links.compareValues(5, "<", 10), true);
  assert.equal(links.compareValues("5", "=", 5), true);
  assert.equal(links.compareValues(5, ">=", 5), true);
  assert.equal(links.compareValues(5, "<=", 5), true);
  assert.equal(links.compareValues(5, "!=", 6), true);
});

test("Service parameters are derived from defaultArgs and can have any count", () => {
  const service = { id: "multi", defaultArgs: "{\"x\":1,\"y\":2,\"speed\":3,\"mode\":\"auto\"}", operations: [{ id: "run", input: "ignored:string" }] };
  assert.deepEqual(links.parametersForService(service, serviceActions), [
    { name: "x", type: "number", defaultValue: 1 },
    { name: "y", type: "number", defaultValue: 2 },
    { name: "speed", type: "number", defaultValue: 3 },
    { name: "mode", type: "string", defaultValue: "auto" }
  ]);
});

test("backend implementation arguments stay hidden from Engine parameter mappings", () => {
  const service = {
    id: "backend-lua",
    defaultArgs: JSON.stringify({
      testContent: "return tostring(tonumber(targetTemperature) or 0)",
      targetTemperature: 70,
      retryLimit: 3
    }),
    operations: [{ id: "run", input: "ignored:string" }]
  };
  assert.deepEqual(links.parametersForService(service, serviceActions), [
    { name: "targetTemperature", type: "number", defaultValue: 70 },
    { name: "retryLimit", type: "number", defaultValue: 3 }
  ]);
});

test("true condition invokes one Service and writes the selected output SME", async () => {
  const currentProperties = properties(80), writes = [];
  const runtime = links.createRuntime({
    serviceActions,
    getServices: () => services,
    getProperties: () => currentProperties,
    setPropertyValue: async (id, value, options) => writes.push({ id, value, options })
  });
  const result = await runtime.execute(workflow(), { test: true });
  assert.equal(result.status, "Success");
  assert.equal(result.conditionResult, true);
  assert.equal(result.serviceOutput, 80);
  assert.equal(result.finalOutput, 80);
  assert.deepEqual(writes, [{ id: "aas|sm|Target", value: 80, options: { source: "aas-service-link", suppressServiceLinks: true } }]);
  assert.deepEqual(result.trace.map(item => item.status), ["True", "Success", "Written"]);
});

test("false branch performs Nothing and does not write an SME", async () => {
  const currentProperties = properties(20), writes = [];
  const runtime = links.createRuntime({
    serviceActions,
    getServices: () => services,
    getProperties: () => currentProperties,
    setPropertyValue: async (...args) => writes.push(args)
  });
  const result = await runtime.execute(workflow());
  assert.equal(result.status, "No action");
  assert.equal(result.conditionResult, false);
  assert.equal(result.writtenTo, "Empty");
  assert.equal(writes.length, 0);
  assert.match(result.trace.at(-1).detail, /Nothing/);
});

test("multiple Monitored SMEs use AND to require every condition", async () => {
  const currentProperties = properties(80), writes = [];
  const current = workflow();
  current.monitors = [
    { propertyId: "aas|sm|Temperature", condition: { operator: ">=", right: { source: "constant", value: "70" } } },
    { propertyId: "aas|sm|Limit", condition: { operator: ">=", right: { source: "constant", value: "60" } } }
  ];
  current.conditionMode = "AND";
  const runtime = links.createRuntime({
    serviceActions,
    getServices: () => services,
    getProperties: () => currentProperties,
    setPropertyValue: async (...args) => writes.push(args)
  });
  const result = await runtime.execute(current);
  assert.equal(result.status, "No action");
  assert.equal(result.conditionResult, false);
  assert.equal(writes.length, 0);
  assert.deepEqual(result.trace.slice(0, 3).map(item => item.status), ["True", "False", "False"]);
  assert.match(result.trace[2].detail, /true AND false/);
});

test("multiple Monitored SMEs use OR to run when any condition matches", async () => {
  const currentProperties = properties(80), writes = [];
  const current = workflow();
  current.monitors = [
    { propertyId: "aas|sm|Temperature", condition: { operator: "<", right: { source: "constant", value: "0" } } },
    { propertyId: "aas|sm|Limit", condition: { operator: "=", right: { source: "constant", value: "50" } } }
  ];
  current.conditionMode = "OR";
  const runtime = links.createRuntime({
    serviceActions,
    getServices: () => services,
    getProperties: () => currentProperties,
    setPropertyValue: async (id, value) => writes.push({ id, value })
  });
  const result = await runtime.execute(current);
  assert.equal(result.status, "Success");
  assert.equal(result.conditionResult, true);
  assert.deepEqual(writes, [{ id: "aas|sm|Target", value: 80 }]);
  assert.match(result.trace[2].detail, /false OR true/);
});

test("Service parameters resolve another SME and a typed custom value", async () => {
  const currentProperties = properties(80), writes = [];
  const customServices = [
    { id: "combine", name: "Combine", defaultArgs: "{\"source\":0,\"offset\":0}", operations: [{ id: "run", name: "Run", input: "source:number, offset:number", output: "result:number", resultArg: "offset" }] },
    services[1]
  ];
  const current = workflow();
  current.serviceCall = {
    serviceId: "combine",
    bindings: {
      source: { source: "property", propertyId: "aas|sm|Limit" },
      offset: { source: "constant", value: "5.5" }
    }
  };
  current.condition = { operator: ">", right: { source: "constant", value: "5" } };
  const runtime = links.createRuntime({
    serviceActions,
    getServices: () => customServices,
    getProperties: () => currentProperties,
    setPropertyValue: async (id, value) => writes.push({ id, value })
  });
  const result = await runtime.execute(current);
  assert.equal(result.serviceOutput, 5.5);
  assert.equal(result.conditionResult, true);
  assert.deepEqual(writes, [{ id: "aas|sm|Target", value: 5.5 }]);
  assert.match(result.trace[1].detail, /"source":50/);
});

test("workflow validation reports missing Service, SME and threshold", () => {
  const broken = workflow();
  broken.serviceCall.serviceId = "missing";
  broken.condition.right = { source: "constant", value: "" };
  broken.output.propertyId = "missing";
  const errors = links.validateLink(broken, services, properties(), serviceActions).join(" ");
  assert.match(errors, /available Service/);
  assert.match(errors, /threshold is required/);
  assert.match(errors, /output SME/);
});

test("backend Service with an unknown output schema defers type checking to runtime", () => {
  const current = workflow();
  const backendService = {
    id: "backend-lua",
    name: "Backend Lua",
    status: "Backend",
    outputTypeKnown: false,
    defaultArgs: "{\"value\":0}",
    operations: [{ id: "execute", input: "value:number", output: "result:string", resultArg: "value" }]
  };
  current.serviceCall = { serviceId: backendService.id, bindings: { value: { source: "property", propertyId: current.propertyId } } };
  const errors = links.validateLink(current, [backendService], properties(), serviceActions).join(" ");
  assert.doesNotMatch(errors, /output type is incompatible/);
});

test("stale backend cache cannot turn the transport String into an output schema", () => {
  const current = workflow();
  const cachedBackendService = {
    id: "cached-backend-lua",
    name: "Cached Backend Lua",
    status: "Backend",
    outputTypeKnown: true,
    defaultArgs: "{\"value\":0}",
    operations: [{ id: "execute", input: "value:number", output: "result:string", resultArg: "value" }]
  };
  current.serviceCall = { serviceId: cachedBackendService.id, bindings: { value: { source: "property", propertyId: current.propertyId } } };
  const errors = links.validateLink(current, [cachedBackendService], properties(), serviceActions).join(" ");
  assert.doesNotMatch(errors, /output type is incompatible/);
});

test("workflow validation rejects incompatible final output SME types", () => {
  const current = workflow();
  const incompatibleProperties = properties();
  incompatibleProperties.find(item => item.id === "aas|sm|Target").valueType = "xs:string";
  const errors = links.validateLink(current, services, incompatibleProperties, serviceActions).join(" ");
  assert.match(errors, /output type is incompatible/);
});
