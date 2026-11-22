const test = require('node:test');
const assert = require('node:assert/strict');
const actions = require('../../frontend/assets/js/model/service-actions.js');
const links = require('../../frontend/assets/js/features/aas-service-links.js');

test('registry refresh preserves editor parameter order without restoring stale values', () => {
    const original = {testContent: 'return a + b', a: '20', b: '30', result: '25', removed: 'old'};
    const actual = {result: '40', b: '50', a: '30', testContent: 'return (a + b)/2', added: true};
    const ordered = actions.orderedRegistryArgs(actual, JSON.stringify(original));
    assert.deepEqual(Object.keys(ordered), ['testContent', 'a', 'b', 'result', 'added']);
    assert.deepEqual(ordered, {testContent: actual.testContent, a: '30', b: '50', result: '40', added: true});
    assert.deepEqual(links.parametersForService({defaultArgs: JSON.stringify(ordered)}, actions).map(p => p.name), ['a', 'b', 'result', 'added']);
    assert.deepEqual(actual, {result: '40', b: '50', a: '30', testContent: 'return (a + b)/2', added: true});
});

test('registry parameters remain usable without saved editor metadata', () => {
    assert.deepEqual(actions.orderedRegistryArgs({a: 2, b: false}, undefined), {a: 2, b: false});
    assert.deepEqual(actions.orderedRegistryArgs({a: 2}, 'invalid JSON'), {a: 2});
    assert.deepEqual(actions.orderedRegistryArgs({}, '{"removed":1}'), {});
});

test('common Service form accepts actual REST URLs and inline Lua without requiring a fictitious file', () => {
    assert.equal(actions.hasExecutionLocation({runtimeType:'REST', file:'', defaultArgs:'{"url":"http://service-manager:8082/actuator/health"}'}), true);
    assert.equal(actions.hasExecutionLocation({runtimeType:'LUA', file:'', defaultArgs:'{"testContent":"return 25"}'}), true);
    assert.equal(actions.hasExecutionLocation({runtimeType:'LUA', file:'/storage/example.lua'}), true);
    assert.equal(actions.hasExecutionLocation({runtimeType:'REST', file:'', defaultArgs:'{"url":" "}'}), false);
    assert.equal(actions.hasExecutionLocation({runtimeType:'LUA', file:'', defaultArgs:'invalid JSON'}), false);
    assert.equal(actions.hasExecutionLocation({runtimeType:'CONTAINER', file:'', defaultArgs:'{"url":"http://ignored"}'}), false);
});
