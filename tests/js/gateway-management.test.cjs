const {test} = require('node:test');
const assert = require('node:assert/strict');
const {connectionWorkspaceReferences} = require('../../frontend/assets/js/features/connection-management.js');
const {create:createModel} = require('../../frontend/assets/js/model/shared-model.js');
test('Server plugin identity and disabled signals survive catalogue synchronization', () => {
  const model = createModel({getItem:()=>null,setItem:()=>{}});
  model.setGatewayPlugins([{id:'plugin:vendor-modbus',protocol:'MODBUS'}]);
  model.syncGateway([{enabled:false,config:{machineId:'machine',protocol:'MODBUS',mappings:[{idShort:'Temperature',valueType:'xs:int'}]}}]);
  assert.equal(model.snapshot().connections[0].pluginId,'plugin:vendor-modbus');
  assert.equal(model.snapshot().signals[0].enabled,false);
  assert.deepEqual(model.validate(),[]);
});
test('Connection deletion finds both AAS mapping and rule input/output references', () => {
  const model = {signals:[{id:'signal:one',connectionId:'connection:machine'}],rules:[{id:'input',signalId:'signal:one'}, {id:'output',outputMapping:{targetId:'signal:one'}}, {id:'other',signalId:'elsewhere'}]};
  const refs = connectionWorkspaceReferences('machine',model,[{id:'aas',signalId:'signal:one'}]);
  assert.deepEqual(refs.map(r=>r.id),['aas','input','output']);
});
