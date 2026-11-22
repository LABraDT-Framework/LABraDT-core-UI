const {test} = require('node:test');
const assert = require('node:assert/strict');
const upload = require('../../frontend/assets/js/features/submodel-upload.js');
const source = {id:'urn:template',idShort:'Template',modelType:'Submodel',kind:'Template',semanticId:{type:'ExternalReference',keys:[{type:'GlobalReference',value:'urn:semantic'}]},qualifiers:[{type:'QA',value:'keep'}],submodelElements:[{modelType:'ReferenceElement',idShort:'Reference',value:{type:'ModelReference',keys:[{type:'Submodel',value:'urn:template'},{type:'Property',value:'Value'}]}}]};
test('JSON import reads standalone, environments, wrappers and legacy exports',()=>{
  for(const input of [source,{submodels:[source]},{environment:{submodels:[source]}},{aasEnvironment:{submodels:[source]}},[{id:'Shell',submodels:[source]}],{aasItems:[{id:'Shell',submodels:[source]}]}]) assert.deepEqual(upload.submodelsFromJson(input),[source]);
});
test('no Submodels does not become an empty template',()=>{
  for(const input of [{},{assetAdministrationShells:[{id:'urn:shell'}]},null]) assert.deepEqual(upload.submodelsFromJson(input),[]);
});
test('instancing preserves metadata and rebases internal model references only',()=>{
  const result = upload.instantiate(source,'urn:instance','Instance');
  assert.equal(result.kind,'Instance'); assert.equal(result.id,'urn:instance');
  assert.deepEqual(result.semanticId,source.semanticId); assert.deepEqual(result.qualifiers,source.qualifiers);
  assert.equal(result.submodelElements[0].value.keys[0].value,'urn:instance');
  assert.equal(source.submodelElements[0].value.keys[0].value,'urn:template');
});
test('reserved names, invalid names and non-V3 Backend templates rejected',()=>{
  for(const name of ['CPS_SM','Rules_SM','StateChart_SM','Bad-name','']) assert.throws(()=>upload.instantiate(source,'urn:new',name));
  assert.throws(()=>upload.instantiate({...source,modelType:{name:'Submodel'}},'urn:new','Valid'),/V3/);
});
test('unsupported suffix, oversized file and invalid JSON rejected',async()=>{
  await assert.rejects(upload.read({name:'template.xml',size:1}),/json or .aasx/);
  await assert.rejects(upload.read({name:'template.aasx',size:upload.MAX_UPLOAD+1}),/16 MiB/);
  await assert.rejects(upload.read({name:'template.json',size:2,text:async()=>'{bad'}));
  await assert.rejects(upload.read({name:'empty.json',size:2,text:async()=>'{}'}),/No Submodel/);
});
