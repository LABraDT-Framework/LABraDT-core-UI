(function(root){
 'use strict';
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 function init({openFormModal,openConfirmModal,toast}){
  let definitions=[];
  const host=document.createElement('section');host.className='section';host.style.gridColumn='1 / -1';
  document.getElementById('servicesTab').prepend(host);
  document.getElementById('addService').hidden=true;
  document.getElementById('addService').style.display='none';
  async function request(path,method='GET',body){
   const response=await root.GucEnvironment.fetch(path,{method,...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});
   const text=await response.text();let result;try{result=text?JSON.parse(text):null;}catch{result=text;}
   if(!response.ok)throw Error(typeof result?.detail==='string'?result.detail:JSON.stringify(result?.detail||result));return result;
  }
  async function refresh(){
   try{definitions=await request('/api/services/registry');definitions.sort((a,b)=>Number(Boolean(b.defaultArgs?.testContent))-Number(Boolean(a.defaultArgs?.testContent))||a.serviceId.localeCompare(b.serviceId));render();}catch(error){toast(error.message);}
  }
  function render(){
   host.innerHTML='<div class="section-head"><h3>Backend Service Definitions</h3><span class="badge">Persistent Service Manager registry</span><button class="btn primary" data-backend-service-mutation="add">Register Backend Service</button><button class="btn ghost" id="backendServiceDefinitionsRefresh">Refresh</button></div><p class="small">STOPPED: register, edit, delete and run Services below. Rules can override declared defaultArgs with constants or CPS Property inputs. Lua scripts run in the real Service Manager, not in browser simulation. Seed initialization preserves existing definitions.</p><div class="table-wrap"><table><thead><tr><th>Service</th><th>Adapter</th><th>Declared parameters</th><th>Actions</th></tr></thead><tbody>'+definitions.map(d=>'<tr><td><strong>'+esc(d.displayName||d.serviceId)+'</strong><div class="small">'+esc(d.serviceId)+'</div></td><td>'+esc(d.executionCategory)+' / '+esc(d.technologyAdapter)+'</td><td>'+esc(Object.keys(d.defaultArgs||{}).filter(k=>k!=='testContent').join(', ')||'None')+'</td><td><div class="row-actions"><button class="link-btn" data-backend-service-mutation="edit" data-id="'+esc(d.serviceId)+'">Edit Definition</button><button class="link-btn" data-backend-service-mutation="delete" data-id="'+esc(d.serviceId)+'">Delete Definition</button></div></td></tr>').join('')+'</tbody></table></div>';
   document.getElementById('backendServiceDefinitionsRefresh').onclick=refresh;
  }
  function edit(id){
   const definition=definitions.find(d=>d.serviceId===id);
   const sample={serviceId:'customService_'+Date.now().toString(36),displayName:'Custom Lua Service',description:'Engineering demo service',executionCategory:'SCRIPT',technologyAdapter:'LUA',fileReference:'',defaultArgs:{testContent:'return tostring(tonumber(value) + tonumber(offset))',value:'0',offset:'1.5'}};
   openFormModal({title:definition?'Edit Backend Service: '+id:'Register Backend Service',submitLabel:'Save Backend Service',initial:{json:JSON.stringify(definition||sample,null,2)},fields:[{name:'json',label:'Service definition JSON (Service ID is immutable on edit; defaultArgs values are strings)',type:'textarea',rows:18,full:true}],onSubmit:async form=>{
    let body;try{body=JSON.parse(form.json);}catch{throw Error('Invalid JSON.');}
    await request('/api/services/registry'+(definition?'/'+encodeURIComponent(id):''),definition?'PUT':'POST',body);
    await refresh();await root.gucEngineBackend?.refresh();toast('Service definition saved to Backend registry.');
   }});
  }
  host.addEventListener('click',event=>{
   const button=event.target.closest('[data-backend-service-mutation]');if(!button||button.disabled)return;
   if(root.gucBackendLifecycle?.isLocked()){toast('Stop Backend first.');return;}
   const id=button.dataset.id;
   if(button.dataset.backendServiceMutation!=='delete'){edit(id);return;}
   openConfirmModal({title:'Delete Backend Service',submitLabel:'Delete',message:'Delete '+esc(id)+'? Referenced Services must first be removed from their Rules.',onSubmit:async()=>{await request('/api/services/registry/'+encodeURIComponent(id),'DELETE');await refresh();await root.gucEngineBackend?.refresh();toast('Service definition deleted.');}});
  });
  refresh();return {refresh};
 }
 root.GucBackendServices={init};
})(window);
