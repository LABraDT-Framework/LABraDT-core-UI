const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

test('OPC UA browsing sends selected security mode and secret references without raw credentials', () => {
  const context = vm.createContext({
    gatewayConfig: {machineId:'lab-machine', endpoint:'opc.tcp://old:4840',securityPolicy:'Basic256Sha256'},
    gatewayServerCertificates: [],
    gatewayConnectionExtras:{securityMode:'Sign',serverCertificate:'server.der',usernameEnv:'LAB_USER',passwordEnv:'LAB_PASS',username:'reader',password:'secret'},
    document:{getElementById:()=>({value:'opc.tcp://current:4840'})}
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../../frontend/assets/js/features/opcua-setup.js'),'utf8'),context);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../../frontend/assets/js/pages/gateway.js'),'utf8'),context);
  const result = JSON.parse(JSON.stringify(context.gatewayDiscoveryPayload()));
  assert.equal(result.endpoint,'opc.tcp://current:4840');
  assert.equal(result.securityMode,'Sign'); assert.equal(result.serverCertificate,'server.der');
  assert.equal(result.usernameEnv,'LAB_USER'); assert.equal(result.passwordEnv,'LAB_PASS');
  assert.equal(result.machineId,'lab-machine'); assert.equal(result.securityPolicy,'Basic256Sha256');
  assert.equal('username' in result,false); assert.equal('password' in result,false);
});

function securityContext(extras) {
  const context = vm.createContext({ gatewayServerCertificates: [], gatewayConfig: {machineId:'lab',securityPolicy:'Basic256Sha256'},
    gatewayConnectionExtras: extras, document: {getElementById:()=>({value:'opc.tcp://localhost:4840'})} });
  for (const file of ['features/opcua-setup.js','pages/gateway.js']) vm.runInContext(fs.readFileSync(path.join(__dirname,'../../frontend/assets/js',file),'utf8'), context);
  return context;
}

test('draft username/password are used for connection testing but hidden in preview', () => {
  const context = securityContext({username:'reader',password:'fixture-secret',securityMode:'Sign',serverCertificate:'server.der'});
  const payload = context.gatewayDiscoveryPayload();
  assert.equal(payload.authentication,'UsernamePassword'); assert.equal(payload.password,'fixture-secret');
  const preview = context.gatewayPreviewConnection(payload);
  assert.equal(JSON.stringify(preview).includes('fixture-secret'),false);
});

test('saved password stays hidden and credential mode switches remove previous credentials', () => {
  const context = securityContext({username:'reader',passwordSet:true});
  assert.equal(context.gatewayDiscoveryPayload().passwordSet,true);
  assert.equal('password' in context.gatewayDiscoveryPayload(),false);
  const anonymous = context.gatewaySecurityConnection(context.gatewayConnectionExtras,{authentication:'Anonymous',securityPolicy:'None'},'OPC_UA');
  assert.equal('username' in anonymous,false); assert.equal('passwordSet' in anonymous,false);
  const environment = context.gatewaySecurityConnection({username:'old',password:'old-secret'},{authentication:'Environment',usernameEnv:'UA_USER',passwordEnv:'UA_PASS',securityPolicy:'None'},'OPC_UA');
  assert.equal(environment.passwordEnv,'UA_PASS'); assert.equal('password' in environment,false);
});

test('changed account carries only a saved-password marker so the server can require re-entry', () => {
  const context = securityContext({username:'reader',passwordSet:true});
  const changed = context.gatewaySecurityConnection(context.gatewayConnectionExtras,{authentication:'UsernamePassword',username:'other',securityPolicy:'None'},'OPC_UA');
  assert.equal(changed.passwordSet,true); assert.equal('password' in changed,false);
});
