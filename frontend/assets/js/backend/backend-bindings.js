(function(root){
 'use strict';
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 function init({toast}){
  let data={revision:0,bindings:[],states:{}},error='',refreshing=null;
  const host=document.querySelector('#bindingsTab .section');
  const nav=document.querySelector('[data-nav="bindings"]');nav.hidden=false;nav.removeAttribute('aria-hidden');
  async function request(path,method='GET',body){
   const response=await root.GucEnvironment.fetch(path,{method,...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});
   const result=await response.json();if(!response.ok)throw Error(typeof result.detail==='string'?result.detail:JSON.stringify(result.detail||result));return result;
  }
  function render(){
   const detailsOpen=host.querySelector('details')?.open;
   host.innerHTML=`<div class="section-head"><h3>Backend Bindings</h3><span class="badge">Server-persisted · ${data.bindings.length} mappings</span><button class="btn primary" data-backend-binding-mutation="add">Add Binding</button><button class="btn ghost" id="backendBindingsRefresh">Refresh</button></div><p class="small">Backend worker, not browser synchronization. STOPPED: edit, read/test or confirm one write. RUNNING: frozen mappings execute automatically even with every browser closed. Engine-owned AAS Properties and correction signals cannot have competing writers. Intervals are best-effort, not real-time guarantees.</p>
   ${error||data.workerError?`<p role="alert" style="color:var(--danger)">${esc(error||data.workerError)}</p>`:''}
   <div class="table-wrap"><table><thead><tr><th>Binding</th><th>Endpoints / Direction</th><th>Interval</th><th>Status</th><th>Actions</th></tr></thead><tbody>${data.bindings.map(b=>{
    const state=data.states[b.id];return `<tr><td><strong>${esc(b.name||b.id)}</strong><div class="small">${esc(b.id)} · ${b.enabled?'Enabled':'Disabled'}</div></td><td><code>${esc(b.signalKey)}</code><div class="small" style="overflow-wrap:anywhere">${esc(b.submodelId)} / ${esc(b.path)}</div><div>${esc(b.direction)} · ${esc(b.valueType)}</div></td><td>${b.intervalMs} ms</td><td><span class="badge">${esc(state?.status||'Idle')}</span><div class="small">${esc(state?.message||'')}</div><div>${state?esc('Gateway='+state.gatewayValue+' / AAS='+state.aasValue):''}</div></td><td><div class="row-actions"><button class="link-btn" data-backend-binding-mutation="test" data-id="${esc(b.id)}">Read / Test</button><button class="link-btn" data-backend-binding-mutation="write" data-id="${esc(b.id)}">Write Once</button><button class="link-btn" data-backend-binding-mutation="edit" data-id="${esc(b.id)}">Edit</button><button class="link-btn" data-backend-binding-mutation="delete" data-id="${esc(b.id)}">Delete</button></div></td></tr>`;
   }).join('')||'<tr><td colspan="5">No Backend bindings. Browser drafts are not imported automatically.</td></tr>'}</tbody></table></div>
   <details><summary>Last run snapshot and binding events</summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere;max-height:420px;overflow:auto">${esc(JSON.stringify({run:data.runSnapshot,events:data.events},null,2))}</pre></details>`;
   document.getElementById('backendBindingsRefresh').onclick=refresh;
   host.querySelector('details').open=Boolean(detailsOpen);
  }
  async function refresh(){
   if(refreshing)return refreshing;
   refreshing=(async()=>{try{data=await request('/api/bindings');error='';}catch(e){error=e.message;}render();})().finally(()=>refreshing=null);return refreshing;
  }
  async function edit(id){
   const original=await request('/api/bindings'),catalog=await request('/api/bindings/catalog'),b=original.bindings.find(b=>b.id===id);
   if(!catalog.signals.length||!catalog.properties.length)throw Error('A configured Gateway signal and a custom Repository Property are required. Create a custom Submodel first.');
   root.openFormModal({title:b?'Edit Backend Binding':'Create Backend Binding',submitLabel:'Save Backend Binding',
    initial:b?{...b,property:String(catalog.properties.findIndex(p=>p.submodelId===b.submodelId&&p.path===b.path)),enabled:String(b.enabled)}:{id:'binding_'+Date.now().toString(36),name:'',signalKey:catalog.signals[0].key,property:'0',direction:'gateway_to_aas',intervalMs:'1000',startupAuthority:'manual',enabled:'true'},fields:[
     {name:'id',label:'Binding ID (immutable on edit)'},{name:'name',label:'Display name'},
     {name:'signalKey',label:'Gateway signal',type:'select',options:catalog.signals.map(s=>s.key),full:true},
     {name:'property',label:'Custom AAS Property',type:'select',options:catalog.properties.map((p,i)=>({value:String(i),label:p.label+' · '+p.valueType})),full:true},
     {name:'direction',label:'Direction',type:'select',options:['gateway_to_aas','aas_to_gateway','bidirectional']},
     {name:'intervalMs',label:'Interval ms (500–60000)'},{name:'startupAuthority',label:'Bidirectional initial authority',type:'select',options:['manual','gateway','aas']},
     {name:'enabled',label:'Enabled',type:'select',options:['true','false']}
    ],onSubmit:async form=>{
     if(b&&form.id!==b.id)throw Error('Binding ID is immutable.');const p=catalog.properties[Number(form.property)];if(!p)throw Error('Select a Property.');
     const next={id:form.id,name:form.name,signalKey:form.signalKey,submodelId:p.submodelId,path:p.path,valueType:p.valueType,direction:form.direction,intervalMs:Number(form.intervalMs),startupAuthority:form.startupAuthority,enabled:form.enabled==='true'};
     await request('/api/bindings','PUT',{revision:original.revision,bindings:[...original.bindings.filter(item=>item.id!==b?.id),next]});await refresh();toast('Binding saved on Backend. Start Backend to enable automatic execution.');
    }});
  }
  host.addEventListener('click',async event=>{
   const button=event.target.closest('[data-backend-binding-mutation]');if(!button||button.disabled)return;
   try{
    if(root.gucBackendLifecycle?.isLocked())throw Error('Stop Backend first.');const action=button.dataset.backendBindingMutation,id=button.dataset.id;
    if(action==='add'||action==='edit')return await edit(id);
    if(action==='delete'){
     const original=await request('/api/bindings');root.openConfirmModal({title:'Delete Backend Binding',submitLabel:'Delete',message:'Delete '+esc(id)+'? No AAS model or Gateway config is deleted.',onSubmit:async()=>{await request('/api/bindings','PUT',{revision:original.revision,bindings:original.bindings.filter(b=>b.id!==id)});await refresh();}});return;
    }
    const execute=async()=>{const report=await request('/api/bindings/'+encodeURIComponent(id)+'/'+(action==='write'?'write':'test'),'POST',action==='write'?{confirm:true}:{});await refresh();toast(JSON.stringify(report));};
    if(action==='write')root.openConfirmModal({title:'Confirm Backend Value Write',submitLabel:'Write Once',message:'This performs one real write according to the saved direction. Device or AAS values may change. Conflicts do not overwrite either side.',onSubmit:execute});else await execute();
   }catch(e){toast(e.message);}
  });
  refresh();const timer=root.setInterval(refresh,2000);root.addEventListener('pagehide',()=>root.clearInterval(timer),{once:true});
  const unavailable=()=>{throw Error('Manage Backend mappings in the Bindings page. Browser-managed links are Demo-only.');};
  return {render:()=>{},setPaused:()=>{},stop:()=>root.clearInterval(timer),snapshot:()=>({mode:'backend',bindings:[],backendBindings:data.bindings}),gatewayLinks:()=>[],gatewayLink:()=>null,propertyLinks:()=>[],aasLink:()=>null,replaceGatewayLinks:unavailable,upsertGatewayLink:unavailable,removeGatewayLink:unavailable,upsertAasLink:unavailable,removeAasLink:unavailable,removePropertyLinks:unavailable,syncGatewayLink:unavailable,syncAasLink:unavailable,propagateGatewayValue:unavailable};
 }
 root.GucBackendBindings={init};
})(window);
