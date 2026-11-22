const {test} = require('node:test');
const assert = require('node:assert/strict');
const {isLocked} = require('../../frontend/assets/js/backend/backend-lifecycle.js');
test('only an authoritative STOPPED state unlocks Backend configuration',()=>{
  assert.equal(isLocked({state:'STOPPED'}),false);
  assert.equal(isLocked({state:'OFFLINE'}),false); // Engine unreachable: state zero stays editable
  for(const status of [null,{}, {state:'RUNNING'},{state:'STARTING'},{state:'STOPPING'},{state:'ERROR'}]) assert.equal(isLocked(status),true);
});
