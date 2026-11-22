"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { validateBinding } = require("../../frontend/assets/js/features/bindings.js");

const writableSignal = { id: "signal:machine:temperature", valueType: "xs:double", writable: true };
const readOnlySignal = { id: "signal:machine:counter", valueType: "xs:double", writable: false };
const firstProperty = { id: "aas|sm|Temperature", valueType: "xs:double" };
const secondProperty = { id: "aas|sm|TemperatureCopy", valueType: "xs:double" };

function binding(overrides = {}) {
  return {
    id: "binding:one",
    signalId: writableSignal.id,
    propertyId: firstProperty.id,
    direction: "gateway_to_aas",
    intervalMs: 1000,
    startupAuthority: "gateway",
    ...overrides
  };
}

test("one Gateway signal may fan out to multiple AAS Properties", () => {
  const existing = [binding()];
  const candidate = binding({ id: "binding:two", propertyId: secondProperty.id });
  assert.deepEqual(validateBinding(candidate, [writableSignal], [firstProperty, secondProperty], existing), []);
});

test("an exact duplicate Gateway to AAS binding is rejected", () => {
  const existing = [binding()];
  const candidate = binding({ id: "binding:duplicate" });
  assert.match(validateBinding(candidate, [writableSignal], [firstProperty], existing).join(" "), /equivalent binding already exists/i);
});

test("read-only OPC UA nodes allow reads but reject directions that write to Gateway", () => {
  const signals = [readOnlySignal], properties = [firstProperty];
  const forward = binding({ signalId: readOnlySignal.id });
  const reverse = binding({ signalId: readOnlySignal.id, direction: "aas_to_gateway", startupAuthority: "aas" });
  const bidirectional = binding({ signalId: readOnlySignal.id, direction: "bidirectional" });
  assert.deepEqual(validateBinding(forward, signals, properties), []);
  assert.match(validateBinding(reverse, signals, properties).join(" "), /read-only/i);
  assert.match(validateBinding(bidirectional, signals, properties).join(" "), /read-only/i);
});
