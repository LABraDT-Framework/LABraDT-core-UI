(function (root) {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const clone = value => JSON.parse(JSON.stringify(value));
  const reserved = new Set(['Rules_SM', 'StateChart_SM', 'CPS_SM']);
  async function request(path, method = 'GET', data, options = {}) {
    const response = await root.GucEnvironment.fetch(path, {method, headers: {...(data === undefined ? {} : {'Content-Type':'application/json'}), ...(options.revision ? {'If-Match':options.revision} : {})}, ...(data === undefined ? {} : {body: JSON.stringify(data)})});
    const result = await response.text();
    let payload; try { payload = result ? JSON.parse(result) : null; } catch { payload = result; }
    if (!response.ok) throw Error(payload?.detail || payload?.message || payload?.repositoryError || payload?.error || result || `Request failed (${response.status})`);
    return options.snapshot ? {model:payload, revision:response.headers.get('ETag')} : payload;
  }
  function init({openFormModal, openConfirmModal, toast, onEnvironment}) {
    const tab = document.getElementById('aasTab');
    document.getElementById('engineLoadedRuleCount').previousElementSibling.textContent = 'Repository Rules';
    document.getElementById('rulesPageCount').previousElementSibling.textContent = 'Backend Rules';
    // Preserve Demo DOM for shared render helpers, but never expose local drafts as backend data.
    [...tab.children].forEach(section => section.style.display = 'none');
    const host = document.createElement('section'); host.className = 'section'; host.style.gridColumn = '1 / -1'; host.id = 'backendRepository'; tab.prepend(host);
    let environment = {assetAdministrationShells: [], submodels: [], conceptDescriptions: []}, rules = [], selected = '', error = '', loading = false;
    const keys = {'shells':'assetAdministrationShells', 'submodels':'submodels', 'concept-descriptions':'conceptDescriptions'};
    const modelList = kind => environment[keys[kind]] || [];
    const path = (kind, id = '') => '/api/aas/models/' + kind + (id ? '?identifier=' + encodeURIComponent(id) : '');
    function label(kind) { return {'shells':'AAS', 'submodels':'Submodel', 'concept-descriptions':'Concept Description'}[kind]; }
    function references(shell) { return (shell?.submodels || []).flatMap(ref => (ref.keys || []).filter(key => key.type === 'Submodel').map(key => key.value)); }
    const tree = root.GucBackendAasTree;
    const ruleTest = root.GucBackendRuleTest.init({openFormModal,request,toast});
    function treeButton(action, sm, indexes, type, text) {
      return `<button class="btn ${action === 'delete' ? 'danger' : 'ghost'}" data-tree-action="${action}" data-tree-sm="${esc(sm.id)}" data-tree-indexes="${indexes.join(',')}" data-tree-type="${type}">${text}</button>`;
    }
    function addButtons(sm, indexes) {
      if (reserved.has(sm.idShort)) return '';
      return treeButton('add', sm, indexes, 'SubmodelElementCollection', 'Add Collection') + treeButton('add', sm, indexes, 'Property', 'Add Property');
    }
    function drawElements(elements, prefix = '', submodel = null, parentIndexes = []) {
      return (elements || []).map((element, index) => {
        const indexes = [...parentIndexes, index], structural = !reserved.has(submodel.idShort);
        const name = prefix + element.idShort, collection = element.modelType === 'SubmodelElementCollection';
        const controls = structural && (collection || element.modelType === 'Property') ? treeButton('edit', submodel, indexes, element.modelType, 'Edit element') + treeButton('delete', submodel, indexes, element.modelType, 'Delete element') : '';
        if (collection) return `<details open style="margin:10px 0 10px 14px"><summary><code>${esc(name)}</code> · Collection</summary><div class="toolbar">${controls}${addButtons(submodel, indexes)}</div>${drawElements(element.value, name + '.', submodel, indexes)}</details>`;
        const editable = element.modelType === 'Property' && !reserved.has(submodel?.idShort) || element.modelType === 'Property' && submodel?.idShort === 'CPS_SM';
        return `<div style="display:flex;align-items:center;gap:12px;margin:8px 0;flex-wrap:wrap"><code>${esc(name)}</code><span>${esc(element.value ?? element.modelType)}</span><span class="small">${esc(element.valueType || element.modelType)}</span>${controls}${editable ? `<button class="btn ghost" data-value-sm="${esc(submodel.id)}" data-value-path="${esc(name)}">Write value</button>` : ''}</div>`;
      }).join('');
    }
    function modelCard(kind, model) {
      const owned = kind === 'submodels' && reserved.has(model.idShort);
      const activeShell = kind === 'shells' && modelList('submodels').some(sm => reserved.has(sm.idShort) && references(model).includes(sm.id));
      const linked = references(modelList('shells').find(shell => shell.id === selected)).includes(model.id);
      const link = kind === 'submodels' && selected ? `<button class="btn ghost" data-link-sm="${esc(model.id)}" ${owned && linked ? 'disabled' : ''}>${linked ? 'Unlink from AAS' : 'Link to AAS'}</button>` : '';
      return `<article data-repository-model="${esc(model.id)}" style="border:1px solid var(--line);border-radius:12px;padding:16px;margin:12px 0"><div class="section-head"><h3>${esc(model.idShort || model.id)}</h3><span class="badge ${owned ? 'draft' : ''}">${owned ? 'Engine-owned' : 'Repository'}</span><span>${link}<button class="btn ghost" data-model-view="${kind}" data-id="${esc(model.id)}">Inspect JSON</button><button class="btn blue" data-model-edit="${kind}" data-id="${esc(model.id)}" ${owned ? 'disabled' : ''}>Edit JSON</button><button class="btn danger" data-model-delete="${kind}" data-id="${esc(model.id)}" ${owned || activeShell ? 'disabled' : ''}>Delete</button></span></div><p class="small" style="overflow-wrap:anywhere">${esc(model.id)}</p>${kind === 'submodels' ? `<div class="toolbar">${addButtons(model, [])}</div>` + drawElements(model.submodelElements, '', model) : ''}</article>`;
    }
    function render() {
      const shells = modelList('shells'), shell = shells.find(item => item.id === selected) || shells[0]; if (!loading) selected = shell?.id || '';
      host.innerHTML = `<div class="section-head"><h3>AAS Repository · BaSyx</h3><span class="badge ${error ? 'offline' : ''}" id="backendRepositoryStatus">${error ? 'Unavailable' : loading ? 'Loading…' : 'Connected · MongoDB'}</span><button class="btn ghost" id="backendAasRefresh">Refresh Repository</button></div><p class="small">Live backend models, not browser drafts. Collection / Property forms preserve model metadata; advanced JSON supports other AAS V3 element types. Global IDs remain unchanged. Engine-owned structures are protected; CPS values are continuously updated by fake OPC UA.</p>${error ? `<p role="alert" style="color:var(--danger)">${esc(error)} · Last successfully loaded models are retained.</p>` : ''}<div class="toolbar"><label>AAS <select id="backendShellSelect">${shells.map(item => `<option value="${esc(item.id)}" ${item.id === selected ? 'selected' : ''}>${esc(item.idShort || item.id)}</option>`).join('') || '<option>No AAS shells</option>'}</select></label><button class="btn primary" data-model-create="shells">Create AAS</button><button class="btn blue" data-model-create="submodels">Create Submodel</button><button class="btn ghost" data-model-create="concept-descriptions">Create Concept Description</button></div>${shell ? modelCard('shells', shell) : '<p>No shells in the backend Repository. Create an AAS to begin.</p>'}<h3>Submodels</h3><p class="small">${references(shell).length} referenced by the selected AAS. Use Link / Unlink on a Submodel to manage references; shared Submodels are not copied or deleted.</p>${modelList('submodels').map(model => `<div class="small">${references(shell).includes(model.id) ? 'Linked to selected AAS' : 'Not linked to selected AAS'}</div>` + modelCard('submodels', model)).join('') || '<p>No Submodels</p>'}<details><summary>Concept Descriptions (${modelList('concept-descriptions').length})</summary>${modelList('concept-descriptions').map(model => modelCard('concept-descriptions', model)).join('')}</details>`;
      document.getElementById('backendAasRefresh').onclick = () => refresh();
      const upload = document.createElement('button'); upload.className = 'btn blue'; upload.textContent = 'Upload Submodel Template'; upload.id = 'backendSubmodelUpload';
      host.querySelector('.toolbar').appendChild(upload);
      upload.onclick = () => root.GucSubmodelUpload.open({openFormModal,onSave:async model => {
        await request(path('submodels'), 'POST', model); await refresh(); toast('Submodel Instance saved to Repository. Use Link to AAS to attach it.');
      }});
      document.getElementById('backendShellSelect').onchange = event => {selected = event.target.value; render();};
    }
    async function refresh() {
      if (loading) return; loading = true; render();
      try { environment = await request('/api/aas/environment'); error = ''; onEnvironment?.(environment); }
      catch (failure) {error = failure.message;}
      finally { loading = false; render(); }
    }
    async function editModel(kind, id, inspect = false) {
      const snapshot = id ? await request(path(kind, id), 'GET', undefined, {snapshot:true}) : null;
      const model = snapshot?.model, stamp = Date.now().toString(36);
      const sample = kind === 'shells' ? {id:`urn:guc:aas:Custom_${stamp}`, idShort:`Custom_${stamp}`, modelType:'AssetAdministrationShell', assetInformation:{assetKind:'Instance', globalAssetId:`urn:guc:asset:${stamp}`}, submodels:[]} : kind === 'submodels' ? {id:`urn:guc:submodel:Custom_${stamp}`, idShort:`Custom_${stamp}`, modelType:'Submodel', submodelElements:[{modelType:'Property', idShort:'Value', valueType:'xs:string', value:'0'}]} : {id:`urn:guc:concept:Custom_${stamp}`, idShort:`Custom_${stamp}`, modelType:'ConceptDescription'};
      openFormModal({title: `${inspect ? 'Inspect' : model ? 'Edit' : 'Create'} ${label(kind)}`, submitLabel: inspect ? 'Close' : 'Save to Repository', fields:[{name:'json', label:'Complete AAS V3 JSON', type:'textarea', full:true, rows:20}], initial:{json:JSON.stringify(model || sample, null, 2)}, onSubmit: async data => {
        if (inspect) return;
        let parsed; try { parsed = JSON.parse(data.json); } catch {throw Error('Invalid JSON; nothing was saved.');}
        await request(path(kind, model?.id), model ? 'PUT' : 'POST', parsed, {revision:snapshot?.revision});
        selected = kind === 'shells' ? parsed.id : selected;
        await refresh(); toast(`${label(kind)} saved to BaSyx Repository.`);
      }});
    }
    async function editElement(button) {
      const id = button.dataset.treeSm, indexes = button.dataset.treeIndexes ? button.dataset.treeIndexes.split(',').map(Number) : [];
      const snapshot = await request(path('submodels', id), 'GET', undefined, {snapshot:true});
      const rendered = modelList('submodels').find(model => model.id === id);
      if (JSON.stringify(rendered) !== JSON.stringify(snapshot.model)) {
        await refresh(); throw Error('Model changed. Repository has been refreshed; reopen the element form.');
      }
      const action = button.dataset.treeAction, existing = action === 'add' ? null : tree.at(snapshot.model, indexes);
      const type = existing?.modelType || button.dataset.treeType, friendly = type === 'Property' ? 'Property' : 'Collection';
      const save = async data => {
        const model = tree.mutate(snapshot.model, {action, indexes, type, data});
        await request(path('submodels', id), 'PUT', model, {revision:snapshot.revision});
        await refresh(); toast(`${friendly} ${action === 'delete' ? 'deleted' : 'saved'} in Repository.`);
      };
      if (action === 'delete') {
        openConfirmModal({title:`Delete ${friendly}`, message:`Delete <strong>${esc(existing.idShort)}</strong>${type === 'SubmodelElementCollection' ? ' and all its children' : ''} from the Repository?`, onSubmit:save}); return;
      }
      const fields = [{name:'idShort',label:'idShort (unique within this parent)',full:true}];
      if (type === 'Property') {
        if (existing && !tree.types.includes(existing.valueType)) throw Error('This valueType requires Edit JSON; no model fields were changed.');
        fields.push({name:'valueType',label:'Value type',type:'select',options:tree.types}, {name:'value',label:'Value (lexical text; do not JSON-quote strings)',type:'textarea',full:true});
      }
      openFormModal({title:`${existing ? 'Edit' : 'Add'} ${friendly}`, submitLabel:'Save to Repository', fields, initial:existing || {idShort:friendly + '_' + Date.now().toString(36),valueType:'xs:string',value:''}, onSubmit:save});
    }
    async function linkSubmodel(button) {
      const id = button.dataset.linkSm, shellId = selected;
      const snapshot = await request(path('shells', shellId), 'GET', undefined, {snapshot:true});
      const linked = references(snapshot.model).includes(id), model = clone(snapshot.model);
      if (linked) model.submodels = (model.submodels || []).filter(ref => !references({submodels:[ref]}).includes(id));
      else model.submodels = [...(model.submodels || []), {type:'ModelReference',keys:[{type:'Submodel',value:id}]}];
      openConfirmModal({title:linked ? 'Unlink Submodel' : 'Link Submodel',submitLabel:linked ? 'Unlink' : 'Link',message:`${linked ? 'Remove the reference from' : 'Add a reference to'} <strong>${esc(model.idShort || model.id)}</strong>? The shared Submodel itself is unchanged.`,onSubmit:async () => {
        await request(path('shells', shellId), 'PUT', model, {revision:snapshot.revision}); await refresh(); toast(linked ? 'Submodel unlinked.' : 'Submodel linked to selected AAS.');
      }});
    }
    host.addEventListener('click', event => {
      const button = event.target.closest('button'); if (!button || button.disabled) return;
      if (button.dataset.modelCreate) editModel(button.dataset.modelCreate).catch(failure => toast(failure.message));
      if (button.dataset.modelEdit) editModel(button.dataset.modelEdit, button.dataset.id).catch(failure => toast(failure.message));
      if (button.dataset.modelView) editModel(button.dataset.modelView, button.dataset.id, true).catch(failure => toast(failure.message));
      if (button.dataset.treeAction) editElement(button).catch(failure => toast(failure.message));
      if (button.dataset.linkSm) linkSubmodel(button).catch(failure => toast(failure.message));
      if (button.dataset.modelDelete) {
        const kind = button.dataset.modelDelete, model = modelList(kind).find(item => item.id === button.dataset.id);
        openConfirmModal({title:`Delete ${label(kind)}`, message:`Delete <strong>${esc(model.idShort || model.id)}</strong> from the Repository? ${kind === 'submodels' ? 'Shell references to it will be detached.' : 'Deleting a shell does not delete shared Submodels.'}`, onSubmit:async () => {await request(path(kind, model.id), 'DELETE'); await refresh(); toast(`${label(kind)} deleted from Repository.`);}});
      }
      if (button.dataset.valueSm) {
        const sm = modelList('submodels').find(item => item.id === button.dataset.valueSm), elementPath = button.dataset.valuePath;
        openFormModal({title:`Write ${elementPath}`, submitLabel:'Write Backend Value', fields:[{name:'value', label:'JSON primitive (quote strings)', full:true}], initial:{value:'"0"'}, onSubmit:async data => {
          let value; try {value = JSON.parse(data.value);} catch {throw Error('Enter a valid JSON primitive.');}
          await request('/api/aas/value?submodelId=' + encodeURIComponent(sm.id) + '&idShortPath=' + encodeURIComponent(elementPath), 'PATCH', value);
          toast(sm.idShort === 'CPS_SM' ? 'Accepted by Engine; fake telemetry may overwrite this test value on its next update.' : 'Value saved to Repository.');
          // The Engine mirror is deliberately asynchronous; a refresh reads its latest durable snapshot.
          await refresh(); root.gucEngineBackend?.refresh();
        }});
      }
    });
    function renderRules(ruleError = '') {
      const enabled = rules.filter(rule => rule.enabled !== 'false').length;
      ['rulesPageCount','overviewRulesCount','overviewRuleCount'].forEach(id => {const node = document.getElementById(id); if (node) node.textContent = `${enabled} / ${rules.length} enabled · backend`;});
      const cards = rules.map(rule => `<article style="border:1px solid var(--line);border-radius:12px;padding:16px;margin:12px 0"><div class="section-head"><h3>${esc(rule.idShort)}</h3><span class="badge ${rule.enabled === 'false' ? 'draft' : ''}">${rule.enabled === 'false' ? 'Disabled' : 'Enabled'}</span>${root.GucBackendRuleTest.buttons(rule.idShort)}<button class="btn blue" data-rule-edit="${esc(rule.idShort)}">Edit Rule</button><button class="btn ghost" data-rule-toggle="${esc(rule.idShort)}">${rule.enabled === 'false' ? 'Enable' : 'Disable'}</button><button class="btn danger" data-rule-delete="${esc(rule.idShort)}">Delete</button></div><p>${esc(rule.description || '')}</p><p><code>IF ${esc(rule.targetSubmodel)}.${esc(rule.targetElement || rule.inputs)} ${esc(rule.condition)} ${esc(rule.threshold)}</code></p><p><code>THEN ${esc(rule.action)}</code> · cooldown ${esc(rule.cooldownMs || '0')} ms</p></article>`).join('');
      document.getElementById('rulesWorkflows').innerHTML = `<p class="small">Java Engine rules stored in Rules_SM on BaSyx. Stop Backend to edit; Start validates and freezes the active rules for that run. Service outputs are written to the rule’s target. Unknown operators and invalid numeric thresholds are rejected.</p>${ruleError ? `<p role="alert" style="color:var(--danger)">${esc(ruleError)}</p>` : ''}${cards || '<p>No backend rules.</p>'}`;
      document.getElementById('overviewRulesList').innerHTML = rules.map(rule => `<button type="button" class="overview-entity-row" data-backend-rule="${esc(rule.idShort)}"><span class="overview-entity-copy"><strong>${esc(rule.idShort)}</strong><span class="small">${esc(rule.targetSubmodel)}.${esc(rule.targetElement || rule.inputs)} → ${esc(rule.action)}</span></span><span class="badge ${rule.enabled === 'false' ? 'draft' : ''}">${rule.enabled === 'false' ? 'Disabled' : 'Enabled'}</span></button>`).join('') || '<p>No backend rules.</p>';
    }
    async function refreshRules() {
      try {await request('/api/engine/health'); rules = await request('/api/engine/rules'); renderRules();}
      catch (failure) {renderRules(failure.message + ' · Last successful rules retained.');}
    }
    function editRule(id) {
      const rule = rules.find(item => item.idShort === id), initial = {...(rule || {idShort:'Rule_' + Date.now().toString(36), targetSubmodel:'CPS_SM', targetElement:'Temperature', condition:'greater_than', threshold:'90', action:'cooling-service', cooldownMs:'30000', enabled:'false', description:''}),parameters:rule?.parameters||'{}'};
      openFormModal({title: rule ? `Edit Rule: ${id}` : 'Create Backend Rule', submitLabel:'Save Backend Rule', initial, fields:[{name:'idShort', label:'Rule idShort (immutable when editing)'},{name:'description', label:'Description', full:true},{name:'targetSubmodel', label:'Target Submodel idShort'},{name:'targetElement', label:'Target Property path'},{name:'condition', label:'Condition', type:'select', options:['greater_than','less_than','equals','out_of_bounds','wear_average']},{name:'threshold',label:'Threshold (bounds: xmin,xmax,ymin,ymax,zmin,zmax)'},{name:'action',label:'Registered Service IDs (comma-separated)', full:true},{name:'inputs',label:'Inputs for wear_average (comma-separated)', full:true},{name:'parameters',label:'Service parameters JSON: literals or {"value":{"input":"Temperature"}}. Keys must exist in Service defaultArgs. {} keeps defaults.',type:'textarea',full:true,rows:4},{name:'cooldownMs',label:'Cooldown ms'},{name:'enabled',label:'Enabled',type:'select',options:['false','true']}], onSubmit:async data => {
        const next = {...clone(rule || {}), ...data};
        try {const params=JSON.parse(next.parameters);if(!params||Array.isArray(params)||typeof params!=='object')throw Error();}catch{throw Error('Parameters must be a JSON object.');}
        const registered = await request('/api/services/registry');
        const ids = new Set((Array.isArray(registered) ? registered : registered?.services || []).map(service => service.serviceId || service.id));
        if (next.action.split(',').map(value => value.trim()).some(value => !ids.has(value))) throw Error('Every action must name a registered backend Service ID.');
        await request('/api/engine/rules' + (rule ? '/' + encodeURIComponent(id) : ''), rule ? 'PUT' : 'POST', next);
        await refreshRules(); await refresh(); root.gucEngineBackend?.refresh(); toast('Rule saved to Repository and Java Engine.');
      }});
    }
    document.getElementById('addRule').onclick = () => editRule();
    document.getElementById('refreshEngineBackend').addEventListener('click', () => {refreshRules(); refresh();});
    document.getElementById('rulesWorkflows').addEventListener('click', event => {
      const button = event.target.closest('button'); if (!button) return;
      if (button.dataset.ruleTest) {try {ruleTest.open(button.dataset.ruleTestId,button.dataset.ruleTest);} catch (error) {toast(error.message);} return;}
      if (button.dataset.ruleEdit) editRule(button.dataset.ruleEdit);
      if (button.dataset.ruleDelete) openConfirmModal({title:'Delete Backend Rule', message:`Delete <strong>${esc(button.dataset.ruleDelete)}</strong> from Rules_SM?`, onSubmit: async () => {await request('/api/engine/rules/' + encodeURIComponent(button.dataset.ruleDelete), 'DELETE'); await refreshRules(); await refresh(); root.gucEngineBackend?.refresh(); toast('Backend rule deleted.');}});
      if (button.dataset.ruleToggle) {
        const rule = rules.find(item => item.idShort === button.dataset.ruleToggle); button.disabled = true;
        request('/api/engine/rules/' + encodeURIComponent(rule.idShort), 'PUT', {...rule, enabled: rule.enabled === 'false' ? 'true' : 'false'}).then(async () => {await refreshRules(); root.gucEngineBackend?.refresh();}).catch(failure => {button.disabled = false; toast(failure.message);});
      }
    });
    document.getElementById('overviewRulesList').addEventListener('click', event => {const button = event.target.closest('[data-backend-rule]'); if (button) editRule(button.dataset.backendRule);});
    renderRules(); refresh(); refreshRules();
    // Read-only refresh of rule configuration, including changes made through official BaSyx APIs.
    const timer = setInterval(refreshRules, 5000); root.addEventListener('pagehide', () => clearInterval(timer), {once:true});
    return {refresh, refreshRules, snapshot: () => ({environment:clone(environment), rules:clone(rules)})};
  }
  root.GucBackendRepository = {init};
})(window);
