(function (root) {
  'use strict';
  const MAX_UPLOAD = 16 * 1024 * 1024;
  function submodelsFromJson(input) {
    const parsed = input?.environment || input?.aasEnvironment || input;
    const type = typeof parsed?.modelType === 'string' ? parsed.modelType : parsed?.modelType?.name;
    if (type === 'Submodel' || Array.isArray(parsed?.submodelElements) || Array.isArray(parsed?.elements) && !Array.isArray(parsed?.submodels)) return [parsed];
    if (Array.isArray(parsed?.submodels)) return parsed.submodels.filter(sm => sm && (sm.modelType === 'Submodel' || sm.modelType?.name === 'Submodel' || Array.isArray(sm.submodelElements) || Array.isArray(sm.elements)));
    // Legacy browser AAS exports may wrap their Submodels in aasItems.
    if (Array.isArray(parsed) || Array.isArray(parsed?.aasItems)) return (Array.isArray(parsed) ? parsed : parsed.aasItems).flatMap(item => submodelsFromJson(item));
    return [];
  }
  async function read(file) {
    if (!file || !/\.(json|aasx)$/i.test(file.name)) throw Error('Choose a .json or .aasx Submodel template.');
    if (file.size > MAX_UPLOAD) throw Error('Template exceeds the 16 MiB upload limit.');
    if (/\.json$/i.test(file.name)) {
      const submodels = submodelsFromJson(JSON.parse(await file.text()));
      if (!submodels.length) throw Error('No Submodel definitions were found in this JSON file.');
      return {submodels,warnings:[]};
    }
    if (!['http:', 'https:'].includes(root.location.protocol)) throw Error('AASX parsing requires the UI controller. Open http://localhost:8090; JSON remains available offline.');
    // This route only parses a local upload and never accesses live backend data.
    // Native same-origin fetch intentionally allows Demo/Custom to use the parser.
    const response = await root.fetch('/api/aas/templates/parse?filename=' + encodeURIComponent(file.name), {method:'POST',headers:{'Content-Type':'application/octet-stream'},body:file});
    const result = await response.json();
    if (!response.ok) throw Error(result.detail || 'AASX parsing failed.');
    return result;
  }
  function instantiate(source, id, idShort) {
    if (source.modelType !== 'Submodel') throw Error('Backend templates must use the AAS V3 JSON Submodel format.');
    if (!id.trim()) throw Error('A global Submodel ID is required.');
    if (!/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(idShort)) throw Error('idShort must start with a letter and contain only letters, digits or underscores.');
    if (['Rules_SM','StateChart_SM','CPS_SM'].includes(idShort)) throw Error('Choose a custom idShort; this name is reserved for the Engine.');
    const result = JSON.parse(JSON.stringify(source)), oldId = result.id;
    result.id = id.trim(); result.idShort = idShort; result.kind = 'Instance';
    function walk(value) {
      if (!value || typeof value !== 'object') return;
      if (value.type === 'ModelReference') for (const key of value.keys || []) {
        if (key.type === 'Submodel' && key.value === oldId) key.value = result.id;
      }
      Object.values(value).forEach(walk);
    }
    walk(result);
    return result;
  }
  function open({openFormModal,onSave}) {
    const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    let models = [], currentWarnings = [], sequence = 0, reading = false;
    openFormModal({title:'Upload Submodel Template',submitLabel:'Create from Template',fields:[
      {name:'templateFile',label:'JSON / AASX Template (max 16 MiB)',type:'file',accept:'.json,.aasx,application/json',full:true},
      {name:'uploadedSubmodel',label:'Submodel from file',type:'select',options:[],full:true},
      {name:'idShort',label:'New Submodel idShort'},
      {name:'globalId',label:'New global Submodel ID',full:true}
    ],initial:{idShort:'ImportedSubmodel',globalId:'urn:guc:submodel:' + root.crypto.randomUUID()},onSubmit:async data => {
      const source = models[Number(data.uploadedSubmodel)];
      if (reading || !source) throw Error('Upload and select a valid JSON / AASX template first.');
      await onSave(instantiate(source,data.globalId,data.idShort.trim()));
    }});
    const body = root.document.getElementById('modalBody'), fileInput = body.querySelector('[name="templateFile"]'), select = body.querySelector('[name="uploadedSubmodel"]'), name = body.querySelector('[name="idShort"]'), submit = root.document.getElementById('modalSubmit');
    const preview = root.document.createElement('div'); preview.dataset.templatePreview = ''; body.appendChild(preview);
    const choose = () => {
      const source = models[Number(select.value)];
      if (!source) return;
      name.value = source.idShort || 'ImportedSubmodel';
      preview.innerHTML = `<p class="small">Preview only · ${(source.submodelElements || []).length} top-level elements. Creates a new Instance with the ID above; use Link to AAS afterwards.</p><details open><summary>Selected Submodel JSON</summary><pre style="max-height:220px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere">${esc(JSON.stringify(source,null,2))}</pre></details>`;
      for (const warning of currentWarnings) {const node = root.document.createElement('p');node.className='small';node.textContent=warning;preview.prepend(node);}
    };
    select.addEventListener('change',choose);
    fileInput.addEventListener('change',async () => {
      const current = ++sequence, file = fileInput.files?.[0];
      models = []; currentWarnings = []; select.innerHTML = ''; reading = Boolean(file); submit.disabled = reading;
      preview.removeAttribute('role');
      preview.textContent = file ? 'Reading template…' : 'Choose a JSON / AASX template.';
      body.querySelector('#modalError')?.remove();
      if (!file) return;
      try {
        const result = await read(file);
        if (current !== sequence || !fileInput.isConnected) return;
        models = result.submodels;
        currentWarnings = result.warnings || [];
        select.innerHTML = models.map((sm,i)=>`<option value="${i}">${esc(sm.idShort || sm.id)} · ${esc(sm.id || '')}</option>`).join('');
        choose();
      } catch (error) {
        if (current === sequence && fileInput.isConnected) {preview.textContent='Template could not be read: ' + error.message; preview.setAttribute('role','alert');}
      } finally {
        if (current === sequence && fileInput.isConnected) {reading=false;submit.disabled=false;}
      }
    });
  }
  const api = {read,submodelsFromJson,instantiate,open,MAX_UPLOAD};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GucSubmodelUpload = api;
})(typeof window !== 'undefined' ? window : globalThis);
