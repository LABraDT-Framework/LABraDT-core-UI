(function(root){
 'use strict';
 // Adapter for the existing AAS/Gateway link controls. No independent page.
 function init({model,getAasProperties,onChange=()=>{},toast}){
  let data={revision:0,bindings:[],states:{}},pending=null;
  const request=(...args)=>root.GucBackendWorkspace.request(...args);
  function records(){
   const signals=model.snapshot().signals,properties=getAasProperties();
   return data.bindings.flatMap(binding=>{
    const signal=signals.find(item=>item.targetElement===binding.signalKey&&!item.deleted);
    const property=properties.find(item=>item.submodelId===binding.submodelId&&item.path===binding.path);
    if(!signal||!property)return [];
    return [{...binding,signalId:signal.id,propertyId:property.id,signal,property,managedBy:binding.direction==='aas_to_gateway'?'aas_property':'gateway_mapping',status:data.states[binding.id]?.status||'Idle',lastMessage:data.states[binding.id]?.message||''}];
   });
  }
  async function refresh(){
   if(pending)return pending;
   pending=(async()=>{try{data=await request('/api/bindings');onChange();}catch(error){toast(error.message);}})().finally(()=>pending=null);return pending;
  }
  async function save(items){data=await request('/api/bindings','PUT',{revision:data.revision,bindings:items});onChange();}
  function make(signalId,propertyId,direction){
   const signal=model.snapshot().signals.find(item=>item.id===signalId&&!item.deleted),property=getAasProperties().find(item=>item.id===propertyId);
   if(!signal||!property)throw Error('Select an existing Gateway signal and AAS Property.');
   if(signal.valueType!==property.valueType)throw Error('Gateway and AAS value types must match.');
   return {id:'link_'+crypto.randomUUID().replace(/-/g,''),name:signal.name+' → '+property.path,signalKey:signal.targetElement,submodelId:property.submodelId,path:property.path,valueType:property.valueType,direction,intervalMs:1000,startupAuthority:direction==='aas_to_gateway'?'aas':'gateway',enabled:true};
  }
  const gatewayLinks=id=>records().filter(item=>item.signalId===id&&item.managedBy==='gateway_mapping');
  const propertyLinks=id=>records().filter(item=>item.propertyId===id);
  async function remove(predicate){const ids=new Set(records().filter(predicate).map(item=>item.id));if(ids.size)await save(data.bindings.filter(item=>!ids.has(item.id)));}
  async function replaceGatewayLinks(signalId,propertyIds){
   const old=gatewayLinks(signalId),removeIds=new Set(old.filter(item=>!propertyIds.includes(item.propertyId)).map(item=>item.id));
   const additions=propertyIds.filter(id=>!old.some(item=>item.propertyId===id)).map(id=>make(signalId,id,'gateway_to_aas'));
   if(!removeIds.size&&!additions.length)return;
   await save([...data.bindings.filter(item=>!removeIds.has(item.id)),...additions]);
  }
  async function upsertAasLink(propertyId,signalId){
   if(propertyLinks(propertyId).some(item=>item.managedBy==='aas_property'&&item.signalId===signalId))return;
   const next=make(signalId,propertyId,'aas_to_gateway'),ids=new Set(propertyLinks(propertyId).map(item=>item.id));
   await save([...data.bindings.filter(item=>!ids.has(item.id)),next]);
  }
  async function sync(items){
   if(!items.length)return {ok:false,message:'No linked Property.'};
   for(const item of items)await request('/api/bindings/'+encodeURIComponent(item.id)+'/write','POST',{confirm:true});
   await refresh();await root.gucBackendWorkspace?.refresh();return {ok:true,count:items.length};
  }
  async function propagateGatewayValue(signalId,value){
   const signal=model.snapshot().signals.find(item=>item.id===signalId&&!item.deleted);if(!signal)throw Error('Gateway signal missing.');
   await request('/api/gateway/live/value/'+encodeURIComponent(signal.targetElement),'PATCH',value);
   const targets=gatewayLinks(signalId);if(targets.length)await sync(targets);return {ok:true,value,aasTargets:targets.map(item=>item.path)};
  }
  refresh();const timer=root.setInterval(refresh,2500);root.addEventListener('pagehide',()=>root.clearInterval(timer),{once:true});
  return {refresh,render:onChange,setPaused:()=>{},stop:()=>root.clearInterval(timer),snapshot:()=>({mode:'backend',bindings:records()}),gatewayLinks,gatewayLink:id=>gatewayLinks(id)[0]||null,propertyLinks,aasLink:id=>propertyLinks(id).find(item=>item.managedBy==='aas_property')||null,
   replaceGatewayLinks,upsertGatewayLink:async(id,pid)=>replaceGatewayLinks(id,[...gatewayLinks(id).map(item=>item.propertyId),pid]),removeGatewayLink:id=>remove(item=>item.signalId===id&&item.managedBy==='gateway_mapping'),upsertAasLink,removeAasLink:id=>remove(item=>item.propertyId===id&&item.managedBy==='aas_property'),removePropertyLinks:id=>remove(item=>item.propertyId===id),syncGatewayLink:id=>sync(gatewayLinks(id)),syncAasLink:id=>sync(propertyLinks(id).filter(item=>item.managedBy==='aas_property')),propagateGatewayValue};
 }
 root.GucBackendLinks={init};
})(window);
