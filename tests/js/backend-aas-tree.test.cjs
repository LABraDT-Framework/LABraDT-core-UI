const {test} = require('node:test');
const assert = require('node:assert/strict');
const tree = require('../../frontend/assets/js/backend/backend-aas-tree.js');
function fixture() {
  return {id:'urn:tree',idShort:'Custom',modelType:'Submodel',semanticId:{keys:[{value:'urn:semantic'}]},submodelElements:[
    {idShort:'Group',modelType:'SubmodelElementCollection',qualifiers:[{type:'source',value:'original'}],value:[
      {idShort:'Value',modelType:'Property',valueType:'xs:double',value:'1',description:[{language:'en',text:'Keep me'}],semanticId:{keys:[{value:'urn:property'}]}},
      {idShort:'Blob',modelType:'Blob',contentType:'text/plain',value:'YQ=='}
    ]}
  ]};
}
test('nested property edits preserve metadata, siblings, and original model', () => {
  const original = fixture(), saved = tree.mutate(original,{action:'edit',indexes:[0,0],data:{idShort:'Renamed',valueType:'xs:double',value:'12.5'}});
  assert.equal(original.submodelElements[0].value[0].value,'1');
  assert.deepEqual(saved.semanticId,original.semanticId);
  assert.deepEqual(saved.submodelElements[0].qualifiers,original.submodelElements[0].qualifiers);
  assert.deepEqual(saved.submodelElements[0].value[0].description,original.submodelElements[0].value[0].description);
  assert.deepEqual(saved.submodelElements[0].value[0].semanticId,original.submodelElements[0].value[0].semanticId);
  assert.deepEqual(saved.submodelElements[0].value[1],original.submodelElements[0].value[1]);
  assert.equal(saved.submodelElements[0].value[0].idShort,'Renamed');
});
test('collection rename retains children and qualifiers', () => {
  const original = fixture(), saved = tree.mutate(original,{action:'edit',indexes:[0],data:{idShort:'NewGroup'}});
  assert.deepEqual(saved.submodelElements[0].value,original.submodelElements[0].value);
  assert.deepEqual(saved.submodelElements[0].qualifiers,original.submodelElements[0].qualifiers);
});
test('add supports empty model and nested empty collections', () => {
  let model = {id:'urn:empty',idShort:'Empty',modelType:'Submodel'};
  model = tree.mutate(model,{action:'add',type:'SubmodelElementCollection',data:{idShort:'Group'}});
  model = tree.mutate(model,{action:'add',indexes:[0],type:'Property',data:{idShort:'Count',valueType:'xs:int',value:'12'}});
  assert.equal(tree.at(model,[0,0]).value,'12');
});
test('duplicate siblings rejected but matching names in other parents allowed', () => {
  assert.throws(() => tree.mutate(fixture(),{action:'add',indexes:[0],type:'Property',data:{idShort:'Value',valueType:'xs:string',value:''}}),/sibling/);
  assert.doesNotThrow(() => tree.mutate(fixture(),{action:'add',type:'Property',data:{idShort:'Value',valueType:'xs:string',value:''}}));
});
test('delete property retains unsupported siblings; collection delete includes children', () => {
  assert.equal(tree.mutate(fixture(),{action:'delete',indexes:[0,0]}).submodelElements[0].value[0].idShort,'Blob');
  assert.deepEqual(tree.mutate(fixture(),{action:'delete',indexes:[0]}).submodelElements,[]);
});
test('unsupported and engine-owned structures cannot be edited', () => {
  assert.throws(() => tree.mutate(fixture(),{action:'delete',indexes:[0,1]}),/advanced JSON/);
  for (const idShort of ['CPS_SM','Rules_SM','StateChart_SM']) assert.throws(() => tree.mutate({...fixture(),idShort},{action:'delete',indexes:[0]}),/Engine-owned/);
});
test('stale index and noncollection parent rejected', () => {
  assert.throws(() => tree.at(fixture(),[20]),/no longer exists/);
  assert.throws(() => tree.mutate(fixture(),{action:'add',indexes:[0,0],type:'Property',data:{idShort:'Bad'}}),/Collection/);
});
test('idShort syntax is validated without mutating original', () => {
  const model = fixture();
  assert.throws(() => tree.mutate(model,{action:'edit',indexes:[0],data:{idShort:'Bad-name'}}),/idShort/);
  assert.equal(model.submodelElements[0].idShort,'Group');
});
test('numeric/boolean lexical values validated including overflow', () => {
  for (const [type,value] of [['xs:double','NaN'],['xs:double','Infinity'],['xs:double','1e999'],['xs:float','1e100'],['xs:decimal','1e2'],['xs:int','1.1'],['xs:int','2147483648'],['xs:long','9223372036854775808'],['xs:boolean','yes']]) assert.throws(() => tree.validateValue(type,value));
  for (const [type,value] of [['xs:double','1e2'],['xs:decimal','.25'],['xs:long','9223372036854775807'],['xs:integer','123456789012345678901234567890'],['xs:boolean','0'],['xs:string','"unquoted text"']]) assert.doesNotThrow(() => tree.validateValue(type,value));
});
