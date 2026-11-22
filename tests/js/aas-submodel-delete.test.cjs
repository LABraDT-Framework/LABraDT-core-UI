const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const script = name => fs.readFileSync(path.join(__dirname,'../../frontend/assets/js',name),'utf8');
const copy = value => JSON.parse(JSON.stringify(value));

function editor(backend=false) {
 const aas={id:'Machine',name:'Machine',submodels:[{id:'Custom',identifier:'urn:custom',elements:[{kind:'Collection',id:'Nested',elements:[{kind:'Property',id:'Value',value:1}]}]},{id:'Keep',identifier:'urn:keep',elements:[]}]};
 const calls=[], context={aasItems:[aas],selectedAasId:'Machine',environment:{isBackend:backend},window:{gucBindings:{removePropertyLinks:async id=>calls.push(['binding',id])},gucAasServiceLinks:{removePropertyLinks:async id=>calls.push(['rule',id])}},document:{getElementById:()=>({value:''})},escapeHtml:String,showToast:message=>calls.push(['toast',message]),openConfirmModal:modal=>context.modal=modal};
 vm.createContext(context); vm.runInContext(script('pages/aas.js'),context);
 context.persistAas=async()=>calls.push(['save',copy(context.aasItems)]);
 context.renderAas=()=>{};
 return {context,calls,aas};
}

test('Submodel confirmation keeps the AAS and other Submodels, removing nested property links only on confirm',async()=>{
 const {context,calls,aas}=editor();
 context.openDeleteSubmodelModal(0);
 assert.equal(context.modal.title,'Delete Submodel');
 assert.equal(aas.submodels.length,2); assert.equal(calls.length,0);
 await context.modal.onSubmit();
 assert.equal(aas.id,'Machine'); assert.equal(aas.submodels.length,1); assert.equal(aas.submodels[0].id,'Keep');
 assert.deepEqual(calls.filter(item=>['rule','binding'].includes(item[0])),[['rule','Machine|urn%3Acustom|Nested.Value'],['binding','Machine|urn%3Acustom|Nested.Value']]);
 assert.equal(calls.filter(item=>item[0]==='save').length,1);
});

test('Backend protected Submodels do not open a deletion dialog',()=>{
 const {context,aas}=editor(true); aas.submodels[0].id='CPS_SM';
 context.openDeleteSubmodelModal(0); assert.equal(context.modal,undefined); assert.equal(aas.submodels.length,2);
});

test('Backend runtime locking and failed DELETE do not remove a Submodel from the editor',async()=>{
 const {context,aas}=editor(true);
 context.window.gucBackendLifecycle={isLocked:()=>true};
 let attempted=0; context.window.gucBackendWorkspace={deleteSubmodel:async()=>{attempted++;throw Error('Repository unavailable');}};
 context.openDeleteSubmodelModal(0);
 await assert.rejects(context.modal.onSubmit(),/Stop Backend/); assert.equal(attempted,0);
 context.window.gucBackendLifecycle.isLocked=()=>false;
 await assert.rejects(context.modal.onSubmit(),/Repository unavailable/);
 assert.equal(aas.submodels.length,2);
});

async function backend({bindings=[],rules=[],fail=false}={}) {
 const id='https://example.org/sm/custom?rev=1#data', calls=[];
 let models={assetAdministrationShells:['A','B'].map(name=>({id:'urn:'+name,idShort:name,modelType:'AssetAdministrationShell',assetInformation:{assetKind:'Instance'},submodels:[{type:'ModelReference',keys:[{type:'Submodel',value:id}]}]})),submodels:[{id,idShort:'Custom',modelType:'Submodel',submodelElements:[]}]};
 const root={GucEnvironment:{fetch:async(url,options={})=>{
  calls.push([options.method||'GET',url]);
  if(options.method==='DELETE'){
   if(fail)return {ok:false,text:async()=>' {"detail":"Delete rejected"}'};
   models={assetAdministrationShells:models.assetAdministrationShells.map(shell=>({...shell,submodels:[]})),submodels:[]};
   return {ok:true,text:async()=>''};
  }
  const body=url==='/api/aas/environment'?models:url==='/api/services/registry'?[]:url==='/api/workspace'?{revision:0,services:{},rules,states:{}}:{revision:0,bindings,states:{}};
  return {ok:true,text:async()=>JSON.stringify(body)};
 }}};
 const context={window:root,document:{querySelector:()=>null,activeElement:null}};
 vm.createContext(context); vm.runInContext(script('model/aas-templates.js'),context); vm.runInContext(script('backend/backend-workspace.js'),context);
 let rendered;
 const api=root.GucBackendWorkspace.create({onAas:value=>rendered=value,onServices:()=>{},onRules:()=>{},toast:()=>{}});
 await api.refresh();
 return {api,id,calls,rendered:()=>copy(rendered)};
}

test('Backend deletion uses the global ID and reloads shared AAS references from Repository',async()=>{
 const state=await backend(); await state.api.deleteSubmodel(state.id);
 assert.deepEqual(state.calls.filter(item=>item[0]==='DELETE'),[['DELETE','/api/aas/models/submodels?identifier='+encodeURIComponent(state.id)]]);
 assert.equal(state.rendered().length,2); assert.ok(state.rendered().every(aas=>aas.submodels.length===0));
});

test('Backend deletion refuses Gateway or Rule references before sending DELETE',async()=>{
 const id='https://example.org/sm/custom?rev=1#data', propertyId='A|'+encodeURIComponent(id)+'|Nested.Value';
 for(const options of [{bindings:[{submodelId:id}]},{rules:[{monitors:[{propertyId}]}]},{rules:[{serviceCall:{bindings:{input:{propertyId}}}}]},{rules:[{output:{propertyId}}]}]) {
  const state=await backend(options);
  await assert.rejects(state.api.deleteSubmodel(id),/Gateway bindings or Rules/);
  assert.equal(state.calls.filter(item=>item[0]==='DELETE').length,0);
  assert.ok(state.rendered().every(aas=>aas.submodels.length===1));
 }
});

test('a rejected Backend DELETE is surfaced and retains the server model after refresh',async()=>{
 const state=await backend({fail:true});
 await assert.rejects(state.api.deleteSubmodel(state.id),/Delete rejected/);
 assert.ok(state.rendered().every(aas=>aas.submodels.length===1));
});
