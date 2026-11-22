(function(root){
 'use strict';
 // Editing is locked only while automatic execution runs. An unreachable Engine (state zero) cannot run.
 function isLocked(status){return !status||status.state!=='STOPPED'&&status.state!=='OFFLINE';}
 function init({toast}){
  let current=null,busy=false,pending=null;
  const originals=new Map();
  const selector='#createAas,#addService,#addRule,#saveServiceDetail,#deleteServiceDetail,#triggerServiceDetail,#addGateway,#addMapping,#saveGatewayConfig,#deleteGatewayConfig,[data-action*="aas"],[data-action*="property"],[data-action*="collection"],[data-action*="mapping"],[data-action*="service"],[data-engine-action],#serviceDetailSection input,#serviceDetailSection select,#serviceDetailSection textarea,#gatewayMachineId,#gatewayProtocol,#gatewayEndpoint,#gatewayMachineType,#gatewayReconnectInitial,#gatewayReconnectMax,#gatewayTopicFilter,#gatewayQuietWindow,#gatewaySecurityFields input,#gatewaySecurityFields select,#prepareOpcuaCertificates,.service-link-dialog button[type="submit"],.service-link-dialog [data-test],.service-link-dialog [data-delete]';
  function applyLocks(){
   const locked=busy||isLocked(current);
   for(const [node,old] of originals){
    if(!node.isConnected){originals.delete(node);continue;}
    if(!locked){node.disabled=old.disabled;node.title=old.title;originals.delete(node);}
   }
   if(locked)for(const node of document.querySelectorAll(selector+',#toggleGatewayConnection,#addGatewayPlugin,#addGatewayPluginPage,.plugin-delete,#pluginWizard input,#pluginWizard button[type="submit"]')){
    if(['export-selected-aas','view-aas','export-aas','template-info'].includes(node.dataset.action))continue;
    if(!originals.has(node))originals.set(node,{disabled:node.disabled,title:node.title});
    if(!node.disabled)node.disabled=true;
    if(node.title!=='Stop to edit or test.')node.title='Stop to edit or test.';
   }
  }
  function render(){
   const state=current?.state||'Unavailable';
   const start=document.getElementById('startAll'),stop=document.getElementById('stopAll');
   start.lastChild.textContent=' Start '+root.GucEnvironment.label;
   stop.lastChild.textContent=' Stop '+root.GucEnvironment.label;
   start.disabled=busy||state!=='STOPPED';stop.disabled=busy||state==='STOPPED'||state==='OFFLINE';
   start.title=state==='STOPPED'?'Validate and start automatic execution':state==='OFFLINE'?'Engine not reachable · start the stack on the System page':'Runtime: '+state;
   stop.title='Stop automatic execution; keep Repository and telemetry online';
   applyLocks();
  }
  async function request(action=''){
   return root.GucBackendWorkspace.request('/api/backend/runtime'+(action?'/'+action:''),action?'POST':'GET');
  }
  async function refresh(){
   if(busy)return;if(pending)return pending;
   pending=(async()=>{try{current=await request();}catch(error){if(current?.state!=='OFFLINE')toast('Engine not reachable · configuration stays editable. Start the stack on the System page.');current={state:'OFFLINE',message:error.message};}render();})().finally(()=>pending=null);
   return pending;
  }
  async function command(action){
   if(busy)return;busy=true;render();
   try{if(pending)await pending;current=await request(action);toast(action==='start'?'Automatic execution started · editing locked.':'Automatic execution stopped · editing and single tests available.');}
   catch(error){toast(error.message);}
   finally{busy=false;await refresh();root.gucBackendWorkspace?.refresh();root.gucEngineBackend?.refresh();}
  }
  const observer=new MutationObserver(applyLocks);observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['disabled']});
  refresh();const timer=root.setInterval(refresh,2000);root.addEventListener('pagehide',()=>{root.clearInterval(timer);observer.disconnect();},{once:true});
  return {command,refresh,snapshot:()=>current&&{...current},isLocked:()=>isLocked(current)};
 }
 if(typeof module!=='undefined'&&module.exports)module.exports={isLocked};
 else root.GucBackendLifecycle={init,isLocked};
})(typeof window!=='undefined'?window:globalThis);
