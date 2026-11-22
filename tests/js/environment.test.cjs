const assert = require('node:assert/strict');
const { test } = require('node:test');
const { create } = require('../../frontend/assets/js/model/environment.js');
const { gatewayTimestamp, liveStatus } = require('../../frontend/assets/js/features/monitor.js');
function memory() {
  const data = new Map();
  return { get length() { return data.size; }, key: index => [...data.keys()][index], getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, String(value)), removeItem: key => data.delete(key) };
}
test('Backend default starts blank and ignores data of earlier UI versions', () => {
  const storage = memory(); storage.setItem('guc-aas-demo', '["old"]'); storage.setItem('guc:ui-v0.9:backend:guc-aas-demo', '["old"]');
  const backend = create(storage); assert.equal(backend.mode, 'backend');
  assert.equal(backend.storage.getItem('guc-aas-demo'), null);
  backend.storage.setItem('guc-aas-demo', '["new"]');
  assert.equal(create(storage).storage.getItem('guc-aas-demo'), '["new"]');
  assert.equal(storage.getItem('guc-aas-demo'), '["old"]');
});
test('Docker Gateway timestamps are UTC regardless of browser timezone', () => {
  const now = Date.parse('2026-10-03T12:00:00Z');
  assert.equal(gatewayTimestamp('2026-10-03T12:00:00.123456789'), '2026-10-03T12:00:00.123456789Z');
  assert.equal(gatewayTimestamp('2026-10-03T14:00:00+02:00'), '2026-10-03T14:00:00+02:00');
  assert.equal(liveStatus({ qualifiers: { ObservedAt: '2026-10-03T12:00:00' } }, { mode: 'real', streamAvailable: true }, now), 'OK');
  assert.equal(liveStatus({ qualifiers: { ObservedAt: '2026-10-03T11:59:00' } }, { mode: 'real', streamAvailable: true }, now), 'STALE');
});


test('There is only the Backend environment: no Demo / Custom, nothing is blocked or redirected', () => {
  const storage = memory();
  storage.setItem('labradt-ui-environment', 'demo');
  const environment = create(storage);
  assert.equal(environment.mode, 'backend'); assert.equal(environment.isBackend, true); assert.equal(environment.isDemo, false);
  assert.equal(environment.gatewayUrl('/api/gateway/live/stream'), '/api/gateway/live/stream');
  assert.doesNotThrow(() => environment.authorizeRequest('/api/services/registry'));
  assert.equal(environment.select, undefined); assert.equal(environment.exportCustom, undefined);
});
