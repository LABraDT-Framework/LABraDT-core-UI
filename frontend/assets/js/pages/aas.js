// Classic script: function definitions only; shared state is initialized in app/state.js.

function renderOverviewAasList() {
  const count = document.getElementById("overviewAasCount"), list = document.getElementById("overviewAasList");
  if (!count || !list) return;
  count.textContent = aasItems.length + (aasItems.length === 1 ? " entry" : " entries");
  list.innerHTML = aasItems.map((item, index) => `<button type="button" class="overview-entity-row" data-overview-aas-index="${index}"><span class="overview-entity-copy"><strong>${escapeHtml(item.name || item.id)}</strong><span class="small">${escapeHtml(item.id)} · ${(item.submodels || []).length} submodels</span></span>${badge(item.status)}</button>`).join("") || '<div class="overview-entity-empty">No AAS entries</div>';
}

function renderAas(filter = "") {
  renderOverviewAasList();
  const rows = document.getElementById("aasRows");
  const normalized = filter.trim().toLowerCase();
  const typeFilter = document.getElementById("aasTypeFilter")?.value || "All Types";
  const title = document.getElementById("aasRepositoryTitle"), actions = document.getElementById("aasRepositoryActions"), typeSelect = document.getElementById("aasTypeFilter"), search = document.getElementById("aasSearch");
  document.querySelectorAll("[data-repository-mode]").forEach(button => { const active = button.dataset.repositoryMode === aasRepositoryMode; button.classList.toggle("active", active); button.setAttribute("aria-selected", String(active)); });
  title.textContent = aasRepositoryMode === "templates" ? "Template Repository" : "AAS Repository";
  actions.hidden = aasRepositoryMode === "templates";
  typeSelect.hidden = aasRepositoryMode === "templates";
  search.placeholder = aasRepositoryMode === "templates" ? "Search Templates..." : "Search AAS...";
  if (aasRepositoryMode === "templates") {
    const filteredTemplates = aasTemplateCatalog.filter(template => [template.id, template.name, template.shortName, template.version, GucAasTemplates.referenceValue(template.semanticId)].join(" ").toLowerCase().includes(normalized));
    document.getElementById("aasResultCount").textContent = `${filteredTemplates.length} of ${aasTemplateCatalog.length} bundled demo templates`;
    rows.innerHTML = filteredTemplates.map(template => `
      <article class="aas-repository-item">
        <div class="aas-repository-select" title="${escapeHtml(`${template.id} — ${template.name}`)}">
          <span class="aas-repository-id">${escapeHtml(template.id)}</span><span class="badge draft">Template</span>
          <strong class="aas-repository-name">${escapeHtml(template.shortName)}</strong>
          <span class="aas-repository-meta">Version ${escapeHtml(template.version)} · ${escapeHtml(template.description)}</span>
        </div>
        <div class="row-actions"><button class="link-btn" data-action="preview-template" data-template-id="${escapeHtml(template.id)}">Preview</button><button class="link-btn" data-action="use-template" data-template-id="${escapeHtml(template.id)}">Use</button></div>
      </article>
    `).join("") || '<div class="empty-note">No Templates match the current search.</div>';
    renderAasDetail(aasItems.find(item => item.id === selectedAasId) || null);
    return;
  }
  const elementSearchText = elements => (elements || []).map(element => [element.id, element.kind, element.valueType, element.value, element.unit, elementSearchText(element.elements)].join(" ")).join(" ");
  const aasSearchText = item => [item.id, item.name, item.type, item.version, item.status, ...(item.submodels || []).map(submodel => `${submodel.id} ${elementSearchText(submodel.elements)}`)].join(" ").toLowerCase();
  const filtered = aasItems
    .filter(item => aasSearchText(item).includes(normalized))
    .filter(item => typeFilter === "All Types" || item.type === (typeFilter === "Concept Description" ? "Concept Dict." : typeFilter));
  if (!aasItems.some(item => item.id === selectedAasId)) selectedAasId = aasItems[0]?.id || null;
  document.getElementById("aasResultCount").textContent = `${filtered.length} of ${aasItems.length} AAS entries`;
  rows.innerHTML = filtered
    .map((item) => {
      const index = aasItems.indexOf(item);
      return `
      <article class="aas-repository-item ${item.id === selectedAasId ? "selected" : ""}" data-aas-index="${index}">
        <button class="aas-repository-select" data-action="view-aas" data-index="${index}" title="${escapeHtml(`${item.id} — ${item.name}`)}">
          <span class="aas-repository-id">${escapeHtml(item.id)}</span>${badge(item.status)}
          <strong class="aas-repository-name">${escapeHtml(item.name)}</strong>
          <span class="aas-repository-meta">${escapeHtml(item.type)} · ${escapeHtml(item.version)}</span>
        </button>
        <div class="row-actions"><button class="link-btn" data-action="view-aas" data-index="${index}">View</button><button class="link-btn" data-action="edit-aas" data-index="${index}">Edit</button><button class="link-btn" data-action="delete-aas" data-index="${index}">Delete</button></div>
      </article>
    `}).join("");
  if (!filtered.length) rows.innerHTML = '<div class="empty-note">No AAS entries match the current filters.</div>';
  renderAasDetail(aasItems.find(item => item.id === selectedAasId) || null);
}

function renderAasDetail(item) {
  if (!item) {
    document.getElementById("aasDetail").innerHTML = `<div class="empty-note">No AAS entry selected.</div>`;
    return;
  }
  selectedAasId = item.id;
  item.submodels ||= [];
  const templatedCount = item.submodels.filter(submodel => submodel.templateOrigin?.id).length;
  const tree = (elements, submodelIndex, path = []) => elements.map((element, index) => {
    const elementPath = [...path, index];
    const children = element.kind === "Collection" ? `<div class="aas-tree-children">${tree(element.elements || [], submodelIndex, elementPath) || '<div class="aas-tree-empty">Empty collection</div>'}</div>` : "";
    const meta = element.kind === "Property" ? `${element.valueType} · ${element.value ?? "(empty)"}${element.unit ? ` ${element.unit}` : ""}` : `${(element.elements || []).length} child elements`;
    const addChildren = element.kind === "Collection" ? `<button class="link-btn" data-action="add-child-property" data-submodel="${submodelIndex}" data-path="${elementPath.join('.')}">+ Property</button><button class="link-btn" data-action="add-child-collection" data-submodel="${submodelIndex}" data-path="${elementPath.join('.')}">+ Collection</button>` : "";
    const semanticPath = aasSemanticPath(item.submodels[submodelIndex], elementPath.join("."));
    const propertyId = element.kind === "Property" ? aasPropertyId(item, item.submodels[submodelIndex], semanticPath) : "";
    const propertyLinks = propertyId ? window.gucBindings?.propertyLinks?.(propertyId) || [] : [];
    const aasGatewayLink = propertyLinks.find(link => link.managedBy === "aas_property") || null;
    const gatewaySourceLinks = propertyLinks.filter(link => link.managedBy === "gateway_mapping" && link.signal);
    const sourceSummaries = gatewaySourceLinks.map(link => `<span class="binding-link-summary"><span class="small binding-target" title="${escapeHtml(link.signal.targetElement)}">${escapeHtml(link.signal.targetElement)} → AAS</span>${gatewayAccessBadge(link.signal)}<span class="badge">Linked</span></span>`).join("");
    const reverseSummary = aasGatewayLink?.signal ? `<span class="binding-link-summary"><span class="small binding-target" title="${escapeHtml(aasGatewayLink.signal.targetElement)}">AAS → ${escapeHtml(aasGatewayLink.signal.targetElement)}</span>${gatewayAccessBadge(aasGatewayLink.signal)}<span class="badge">Linked</span><button class="link-btn" data-action="sync-aas-link" data-property-id="${escapeHtml(propertyId)}">Sync now</button><button class="link-btn" data-action="unlink-aas-link" data-property-id="${escapeHtml(propertyId)}">Unlink</button></span>` : "";
    const linkAction = propertyId ? `<button class="link-btn" data-action="link-aas-gateway" data-property-id="${escapeHtml(propertyId)}">Link Gateway</button>${sourceSummaries}${reverseSummary}` : "";
    return `<article class="aas-tree-node ${element.kind === "Collection" ? "collection" : `property${gatewaySourceLinks.length ? " linked-sme" : ""}`}"><div class="aas-tree-node-row"><div class="aas-tree-copy" title="${escapeHtml(element.id)}"><span class="aas-tree-kind">${escapeHtml(element.kind)}</span><strong>${escapeHtml(element.id)}</strong><div class="small">${escapeHtml(meta)}</div></div><div class="aas-tree-actions">${addChildren}${linkAction}<button class="link-btn" data-action="edit-aas-element" data-submodel="${submodelIndex}" data-path="${elementPath.join('.')}">Edit</button><button class="link-btn" data-action="delete-aas-element" data-submodel="${submodelIndex}" data-path="${elementPath.join('.')}">Delete</button></div></div>${children}</article>`;
  }).join("");
  document.getElementById("aasDetail").innerHTML = `
    <div class="detail-title">
      <h3>AAS Detail: ${escapeHtml(item.name)}</h3>
      ${badge(item.status)}
    </div>
    <div class="detail-grid">
      <span>ID Short</span><strong>${escapeHtml(item.id)}</strong>
      <span>Display Name</span><strong>${escapeHtml(item.name)}</strong>
      <span>Type</span><strong>${escapeHtml(item.type)}</strong>
      <span>Specification</span><strong>IEC 63278 / IDTA 01001</strong>
      <span>Version</span><strong>${escapeHtml(item.version)}</strong>
      <span>Submodels</span><strong>${item.submodels.length}</strong>
      <span>Template Status</span><strong>${templatedCount ? `${templatedCount} template-based / ${item.submodels.length - templatedCount} custom` : "Custom structure"}</strong>
      <span>Description</span><strong>AAS model editor. ${environment.isBackend ? "Saved in the engine project AASX and, while it runs, in the AAS repository." : "Data is saved in this Demo workspace."}</strong>
    </div>
    <div class="section-head" style="margin-top:18px"><h3>Submodels &amp; Elements</h3><button class="btn blue" data-action="add-submodel">Add Submodel</button></div>
    <div class="aas-tree">${item.submodels.map((submodel, submodelIndex) => {
      const origin = submodel.templateOrigin;
      const uploadedOrigin = /^Uploaded (JSON|AASX) template/.test(origin?.source || "");
      const templateState = uploadedOrigin ? { label: /AASX/.test(origin.source) ? "Uploaded AASX" : "Uploaded JSON", modified: false } : GucAasTemplates.templateStatus(submodel);
      const originLabel = uploadedOrigin ? (origin.name || origin.id.replace(/^upload:/, "")) : origin?.id;
      const originMeta = uploadedOrigin ? "Local file" : `v${origin?.version || "—"}`;
      const protectedSubmodel = environment.isBackend && ["Rules_SM", "StateChart_SM", "CPS_SM"].includes(submodel.id);
      const deleteAction = `<button class="btn danger" data-action="delete-aas-submodel" data-submodel="${submodelIndex}"${protectedSubmodel ? ' disabled title="Engine-owned Submodels cannot be deleted."' : ''}>Delete Submodel</button>`;
      return `<section class="aas-submodel-node"><div class="aas-submodel-head"><div class="aas-submodel-name" title="${escapeHtml(submodel.id)}"><span class="aas-tree-kind">Submodel</span><strong>${escapeHtml(submodel.id)}</strong>${origin ? `<div class="template-summary"><span class="badge ${templateState.modified ? "warning" : ""}">${escapeHtml(originLabel)} · ${escapeHtml(templateState.label)}</span><span class="template-source">${escapeHtml(originMeta)}</span></div>` : ""}</div><div class="aas-tree-actions">${origin ? `<button class="btn ghost" data-action="template-info" data-submodel="${submodelIndex}">Template Info</button>` : ""}<button class="btn ghost" data-action="add-property" data-submodel="${submodelIndex}">Add Property</button><button class="btn ghost" data-action="add-collection" data-submodel="${submodelIndex}">Add Collection</button>${deleteAction}</div></div><div class="aas-tree-children">${tree(submodel.elements || [], submodelIndex) || '<div class="aas-tree-empty">No elements yet.</div>'}</div></section>`;
    }).join("") || '<div class="empty-note">Add a Submodel to begin modelling AAS elements.</div>'}</div>
    <div class="component-actions">
      <button class="btn primary" data-action="edit-selected-aas">Edit AAS</button>
      <button class="btn blue" data-action="export-selected-aas">Export JSON</button>
      <button class="btn danger" data-action="delete-selected-aas">Delete</button>
    </div>
  `;
}

async function handleAasImport(event) {
  const file = event.target.files?.[0]; if (!file) return;
  try {
    let valid;
    if (file.name.toLowerCase().endsWith(".json")) {
      const parsed = JSON.parse(await file.text());
      valid = GucAasTemplates.normalizeImport(parsed, file.name);
    } else throw new Error("AASX structure parsing is not enabled in this browser-only demo yet. Import a standard AAS JSON environment.");
    if (!valid.length) throw new Error("No valid AAS entries were found in this file.");
    valid.forEach(item => {
      let candidate = item.id, suffix = 2;
      while (aasItems.some(existing => existing.id === candidate)) candidate = `${item.id}_${suffix++}`;
      item.id = candidate;
      if (aasItems.some(existing=>existing.identifier===item.identifier)) item.identifier=`urn:guc:aas:import:${encodeURIComponent(candidate)}:${Date.now().toString(36)}`;
      // Import creates instances; it cannot overwrite a same-ID Repository template.
      const replacements=new Map((item.submodels||[]).map(sm=>[sm.identifier,`urn:guc:submodel:import:${crypto.randomUUID()}`]));
      for(const sm of item.submodels||[]) {
        const id=replacements.get(sm.identifier);
        if(sm._raw?.modelType==='Submodel') Object.assign(sm,GucAasTemplates.normalizeSubmodel(GucSubmodelUpload.instantiate(sm._raw,id,sm.id)));
        else sm.identifier=id;
      }
      aasItems.unshift(item);
    });
    selectedAasId = valid.at(-1).id; await persistAas(); renderAas(document.getElementById("aasSearch").value);
    showToast(`${valid.length} AAS entr${valid.length === 1 ? "y" : "ies"} imported.`);
  } catch (error) { showToast(`Import failed: ${error.message}`); }
  finally { event.target.value = ""; }
}

function selectedAasIndex() {
  const index = aasItems.findIndex(item => item.id === selectedAasId);
  return index >= 0 ? index : 0;
}

function selectedAas() { return aasItems[selectedAasIndex()]; }

function openDeleteSubmodelModal(submodelIndex) {
  const aas = selectedAas(), submodel = aas?.submodels?.[submodelIndex];
  if (!submodel) { showToast("Select an existing Submodel."); return; }
  if (environment.isBackend && ["Rules_SM", "StateChart_SM", "CPS_SM"].includes(submodel.id)) {
    showToast("Engine-owned Submodels cannot be deleted."); return;
  }
  const identifier = submodel.identifier || submodel.id;
  openConfirmModal({
    title: "Delete Submodel",
    message: `Delete <strong>${escapeHtml(submodel.id)}</strong> and all of its elements? ${environment.isBackend ? "This deletes the Submodel from the Repository and removes its references from every AAS. Gateway bindings and Rules using it must be removed first." : "Its Gateway links and Rules in this workspace will also be removed. The AAS itself is kept."}`,
    submitLabel: "Delete Submodel",
    onSubmit: async () => {
      if (environment.isBackend) {
        if (window.gucBackendLifecycle?.isLocked()) throw new Error("Stop Backend before deleting a Submodel.");
        await window.gucBackendWorkspace.deleteSubmodel(identifier);
      } else {
        const current = aasItems.find(item => item.id === aas.id);
        const index = current?.submodels.findIndex(item => (item.identifier || item.id) === identifier) ?? -1;
        if (index < 0) throw new Error("This Submodel is no longer available. Refresh the AAS view.");
        for (const element of current.submodels[index].elements || []) {
          for (const propertyId of aasElementPropertyIds(current, current.submodels[index], element, element.id)) {
            await window.gucAasServiceLinks?.removePropertyLinks?.(propertyId);
            await window.gucBindings?.removePropertyLinks?.(propertyId);
          }
        }
        current.submodels.splice(index, 1);
        await persistAas();
      }
      renderAas(document.getElementById("aasSearch").value);
      showToast("Submodel deleted.");
    }
  });
}

function templateTreeHtml(elements) {
  return `<div class="template-preview-tree">${(elements || []).map(element => `<div class="template-preview-node"><strong>${escapeHtml(element.id)}</strong><div class="small">${escapeHtml(element.kind === "Collection" ? `Collection · ${(element.elements || []).length} children` : `${element.valueType || "xs:string"}${element.unit ? ` · ${element.unit}` : ""}`)}</div>${element.kind === "Collection" ? templateTreeHtml(element.elements) : ""}</div>`).join("")}</div>`;
}

function templateDetailsHtml(template) {
  return `<div class="detail-grid"><span>Template</span><strong>${escapeHtml(template.id)}</strong><span>Name</span><strong>${escapeHtml(template.name)}</strong><span>Version</span><strong>${escapeHtml(template.version)}</strong><span>Semantic ID</span><strong>${escapeHtml(GucAasTemplates.referenceValue(template.semanticId) || "—")}</strong><span>Profile</span><strong>Bundled representative demo structure</strong></div><p class="small" style="margin-top:14px">${escapeHtml(template.description)}</p>${templateTreeHtml(template.submodel.elements)}`;
}

function openTemplatePreview(templateId) {
  const template = GucAasTemplates.find(templateId);
  if (!template) { showToast("Template is unavailable."); return; }
  modalTitle.textContent = `${template.id}: ${template.shortName}`;
  modalCancel.style.display = "";
  modalSubmit.textContent = "Use Template";
  modalSubmit.className = "btn primary";
  modalBody.innerHTML = templateDetailsHtml(template);
  modalSubmitHandler = () => { closeModal(); openAddSubmodelModal(template.id); };
  modalBackdrop.classList.add("open");
  modalBackdrop.setAttribute("aria-hidden", "false");
}

function openTemplateInfo(submodel) {
  const origin = submodel?.templateOrigin;
  const template = origin && GucAasTemplates.find(origin.id);
  if (!origin) { showToast("Template information is unavailable."); return; }
  const state = template ? GucAasTemplates.templateStatus(submodel) : { label: "Uploaded", modified: false };
  modalTitle.textContent = `Template Information: ${submodel.id}`;
  modalCancel.style.display = "none";
  modalSubmit.textContent = "Close";
  modalSubmit.className = "btn primary";
  modalBody.innerHTML = `<div class="detail-grid"><span>Template</span><strong>${escapeHtml(origin.id)}</strong><span>Name</span><strong>${escapeHtml(origin.name)}</strong><span>Version</span><strong>${escapeHtml(origin.version)}</strong><span>Semantic ID</span><strong>${escapeHtml(GucAasTemplates.referenceValue(origin.semanticId) || "—")}</strong><span>Source</span><strong>${escapeHtml(origin.source || "Bundled demo profile")}</strong><span>Structure status</span><strong><span class="badge ${state.modified ? "warning" : ""}">${escapeHtml(state.label)}</span></strong></div><p class="small" style="margin-top:14px">${template ? "Value changes keep the bundled template structurally compatible. Structural changes mark it Modified." : "This Submodel was created from a user-uploaded JSON / AASX template."}</p>`;
  modalSubmitHandler = closeModal;
  modalBackdrop.classList.add("open");
  modalBackdrop.setAttribute("aria-hidden", "false");
}

function uploadedSubmodelsFromJson(parsed, fileName) {
  const root = parsed?.environment || parsed?.aasEnvironment || parsed;
  const modelType = typeof root?.modelType === "string" ? root.modelType : root?.modelType?.name || "";
  if (modelType === "Submodel" || Array.isArray(root?.submodelElements) || (Array.isArray(root?.elements) && !Array.isArray(root?.submodels))) {
    return [GucAasTemplates.normalizeSubmodel(root)];
  }
  return GucAasTemplates.normalizeImport(parsed, fileName).flatMap(item => item.submodels || []);
}

function openAddSubmodelModal() {
  const aas = selectedAas();
  if (!aas) { showToast("Select an AAS first."); return; }
  modalTitle.textContent = "Add Submodel";
  modalCancel.style.display = "";
  modalSubmit.textContent = "Add Submodel";
  modalSubmit.className = "btn primary";
  modalSubmit.disabled = false;
  modalBody.innerHTML = `<div class="form-grid"><label class="field">Creation Mode<select name="submodelMode"><option value="manual">Create manually</option><option value="upload">Upload JSON / AASX Template</option></select></label><label class="field" data-template-file hidden>JSON / AASX Template<input name="templateFile" type="file" accept=".json,.aasx,application/json"></label><label class="field full" data-upload-select hidden>Submodel from file<select name="uploadedSubmodel"></select></label><label class="field full">Submodel idShort<input name="submodelId" value="NewSubmodel"></label></div><div data-template-preview></div>`;
  const mode = modalBody.querySelector('[name="submodelMode"]'), fileInput = modalBody.querySelector('[name="templateFile"]'), uploadSelect = modalBody.querySelector('[name="uploadedSubmodel"]'), idInput = modalBody.querySelector('[name="submodelId"]'), fileField = modalBody.querySelector("[data-template-file]"), selectField = modalBody.querySelector("[data-upload-select]"), preview = modalBody.querySelector("[data-template-preview]");
  let uploadedSubmodels = [], uploadedFileName = "", uploadedWarnings = [], readSequence = 0, reading = false;
  const renderUploadedSelection = () => {
    const selected = uploadedSubmodels[Number(uploadSelect.value || 0)];
    if (!selected) { preview.innerHTML = '<div class="empty-note">Choose a JSON / AASX file containing Submodels.</div>'; return; }
    idInput.value = selected.id || "ImportedSubmodel";
    preview.innerHTML = `<p class="small" style="margin:14px 0 0"><strong>${escapeHtml(uploadedFileName)}</strong> · ${escapeHtml(selected.id)} · ${(selected.elements || []).length} top-level elements</p>${uploadedWarnings.map(warning => `<p class="small">${escapeHtml(warning)}</p>`).join('')}${templateTreeHtml(selected.elements)}`;
  };
  const update = () => {
    const upload = mode.value === "upload";
    fileField.hidden = !upload;
    selectField.hidden = !upload || !uploadedSubmodels.length;
    preview.hidden = !upload;
    modalSubmit.disabled = upload && reading;
    if (!upload) { idInput.value = "NewSubmodel"; preview.innerHTML = ""; }
    else renderUploadedSelection();
  };
  mode.addEventListener("change", () => update());
  uploadSelect.addEventListener("change", renderUploadedSelection);
  fileInput.addEventListener("change", async () => {
    const sequence = ++readSequence;
    const file = fileInput.files?.[0];
    uploadedSubmodels = []; uploadedWarnings = []; uploadedFileName = file?.name || ""; selectField.hidden = true;
    reading = Boolean(file); modalSubmit.disabled = mode.value === 'upload' && reading;
    if (!file) { renderUploadedSelection(); return; }
    preview.innerHTML = '<p class="small">Reading template…</p>';
    try {
      const parsed = await GucSubmodelUpload.read(file);
      if (sequence !== readSequence || !fileInput.isConnected) return;
      uploadedWarnings = parsed.warnings || [];
      uploadedSubmodels = parsed.submodels.map((submodel, index) => GucAasTemplates.normalizeSubmodel(submodel, index));
      if (!uploadedSubmodels.length) throw new Error("No Submodel definition was found.");
      uploadSelect.innerHTML = uploadedSubmodels.map((submodel, index) => `<option value="${index}">${escapeHtml(submodel.id)} · ${(submodel.elements || []).length} elements</option>`).join("");
      selectField.hidden = mode.value !== 'upload'; if (mode.value === 'upload') renderUploadedSelection();
    } catch (error) { if (sequence === readSequence && fileInput.isConnected) preview.innerHTML = `<div class="empty-note" role="alert" style="color:var(--danger)">Template could not be read: ${escapeHtml(error.message)}</div>`; }
    finally { if (sequence === readSequence && fileInput.isConnected) {reading = false; modalSubmit.disabled = false;} }
  });
  update();
  modalSubmitHandler = async () => {
    const id = idInput.value.trim();
    if (!validateRequiredId(id, "Submodel idShort")) return;
    if (aas.submodels.some(submodel => submodel.id === id)) { showToast(`Submodel '${id}' already exists.`); return; }
    let submodel;
    if (mode.value === "upload") {
      const uploaded = uploadedSubmodels[Number(uploadSelect.value || 0)];
      if (reading || !uploaded) { showToast("Upload and select a valid JSON / AASX Submodel template first."); return; }
      const identifier = `urn:guc:submodel:${encodeURIComponent(aas.id)}:${encodeURIComponent(id)}:${Date.now().toString(36)}`;
      submodel = uploaded._raw?.modelType === 'Submodel'
        ? GucAasTemplates.normalizeSubmodel(GucSubmodelUpload.instantiate(uploaded._raw,identifier,id))
        : { ...JSON.parse(JSON.stringify(uploaded)),id,identifier };
      submodel.templateOrigin = { id: `upload:${uploadedFileName.replace(/\.(json|aasx)$/i, "")}`, name: uploadedFileName, version: uploaded.administration?.version || "uploaded", source: `Uploaded ${/\.aasx$/i.test(uploadedFileName) ? 'AASX' : 'JSON'} template · ${uploadedFileName}` };
    } else submodel = { id, identifier: `urn:guc:submodel:${encodeURIComponent(aas.id)}:${encodeURIComponent(id)}`, elements: [] };
    aas.submodels.push(submodel);
    await rerenderAasDetail();
    closeModal();
    showToast(mode.value === "upload" ? `${uploadedFileName} added as a Submodel template.` : "Submodel added.");
  };
  modalBackdrop.classList.add("open");
  modalBackdrop.setAttribute("aria-hidden", "false");
  mode.focus();
}

function elementAt(submodel, path) {
  const indexes = String(path).split(".").map(Number);
  let list = submodel.elements;
  let element;
  indexes.forEach((index, position) => { element = list[index]; if (position < indexes.length - 1) list = element.elements; });
  return { element, list, index: indexes.at(-1) };
}

function aasSemanticPath(submodel, indexPath) {
  let elements = submodel.elements || [], ids = [];
  for (const position of String(indexPath).split(".").map(Number)) {
    const element = elements[position]; if (!element) break;
    ids.push(element.id); elements = element.elements || [];
  }
  return ids.join(".");
}

function aasElementPropertyIds(aas, submodel, element, prefix) {
  if (!element) return [];
  if (element.kind === "Property") return [aasPropertyId(aas, submodel, prefix)];
  return (element.elements || []).flatMap(child => aasElementPropertyIds(aas, submodel, child, `${prefix}.${child.id}`));
}

async function persistAas() {
  if (environment.isBackend && window.gucBackendWorkspace) await window.gucBackendWorkspace.saveAas(aasItems);
  appStorage.setItem("guc-aas-demo", JSON.stringify(aasItems)); queueMicrotask(() => window.gucBindings?.render());
}

function aasPropertyId(aas, submodel, path) { return `${encodeURIComponent(aas.id)}|${encodeURIComponent(submodel.identifier || submodel.id)}|${path}`; }

function aasBindingProperties() {
  const result = [];
  const visit = (aas, submodel, elements, prefix = "") => (elements || []).forEach(element => {
    const path = prefix ? `${prefix}.${element.id}` : element.id;
    if (element.kind === "Property") result.push({ id: aasPropertyId(aas, submodel, path), aasId: aas.id, aasName: aas.name, submodelId: submodel.identifier || submodel.id, submodelName: submodel.id, path, valueType: element.valueType || "xs:string", unit: element.unit || "", value: element.value });
    else if (Array.isArray(element.elements)) visit(aas, submodel, element.elements, path);
  });
  aasItems.forEach(aas => (aas.submodels || []).forEach(submodel => visit(aas, submodel, submodel.elements)));
  return result;
}

function aasPropertyElement(propertyId) {
  let match = null;
  const visit = (aas, submodel, elements, prefix = "") => (elements || []).some(element => {
    const path = prefix ? `${prefix}.${element.id}` : element.id;
    if (element.kind === "Property" && aasPropertyId(aas, submodel, path) === propertyId) { match = element; return true; }
    return Array.isArray(element.elements) && visit(aas, submodel, element.elements, path);
  });
  aasItems.some(aas => (aas.submodels || []).some(submodel => visit(aas, submodel, submodel.elements)));
  return match;
}

async function forceAasPropertyType(propertyId, valueType) {
  const element = aasPropertyElement(propertyId);
  if (!element) throw new Error("AAS Property is missing.");
  if (element.valueType === valueType) return false;
  await window.gucBindings?.removePropertyLinks?.(propertyId);
  try { element.value = GucMonitorHelpers.parseTyped(String(element.value ?? ""), valueType); }
  catch { element.value = isNumericMapping({ valueType }) ? 0 : valueType === "xs:boolean" ? false : ""; }
  element.valueType = valueType;
  await persistAas();
  return true;
}

function aasPropertyTreeHtml(selectedId = "", forcedType = "") {
  const renderElements = (aas, submodel, elements, prefix = "") => (elements || []).map(element => {
    const path = prefix ? `${prefix}.${element.id}` : element.id;
    if (element.kind === "Collection") return `<details><summary>${escapeHtml(element.id)} <span class="small">Collection · ${(element.elements || []).length}</span></summary>${renderElements(aas, submodel, element.elements || [], path)}</details>`;
    const id = aasPropertyId(aas, submodel, path), mismatch = forcedType && forcedType !== (element.valueType || "xs:string");
    return `<button type="button" class="link-tree-leaf${id === selectedId ? " selected" : ""}" data-link-tree-value="${escapeHtml(id)}"><span class="link-tree-leaf-copy"><strong>${escapeHtml(element.id)}</strong><span class="small">${escapeHtml(path)} · ${escapeHtml(element.valueType || "xs:string")}${mismatch ? ` → will become ${escapeHtml(forcedType)}` : ""}</span></span>${id === selectedId ? '<span class="badge">Linked</span>' : ""}</button>`;
  }).join("");
  return aasItems.map((aas, aasIndex) => `<details ${selectedId.startsWith(`${encodeURIComponent(aas.id)}|`) || (!selectedId && aasIndex === 0) ? "open" : ""}><summary>${escapeHtml(aas.name || aas.id)} <span class="small">AAS</span></summary>${(aas.submodels || []).map(submodel => `<details ${selectedId.includes(`|${encodeURIComponent(submodel.identifier || submodel.id)}|`) ? "open" : ""}><summary>${escapeHtml(submodel.id)} <span class="small">Submodel</span></summary>${renderElements(aas, submodel, submodel.elements || []) || '<div class="link-tree-empty">No Properties</div>'}</details>`).join("") || '<div class="link-tree-empty">No Submodels</div>'}</details>`).join("") || '<div class="link-tree-empty">No AAS Properties available.</div>';
}

function aasPropertyMultiTreeHtml(selectedIds = [], forcedType = "") {
  const selected = new Set(selectedIds);
  const renderElements = (aas, submodel, elements, prefix = "") => (elements || []).map(element => {
    const path = prefix ? `${prefix}.${element.id}` : element.id;
    if (element.kind === "Collection") return `<details><summary>${escapeHtml(element.id)} <span class="small">Collection · ${(element.elements || []).length}</span></summary>${renderElements(aas, submodel, element.elements || [], path)}</details>`;
    const id = aasPropertyId(aas, submodel, path), mismatch = forcedType && forcedType !== (element.valueType || "xs:string"), checked = selected.has(id);
    const feeder = checked ? null : (window.gucBindings?.propertyLinks?.(id) || []).find(link => link.managedBy === "gateway_mapping");
    return `<label class="link-tree-leaf multi${checked ? " selected" : ""}"><input class="link-tree-check" type="checkbox" data-link-tree-multi-value="${escapeHtml(id)}"${checked ? " checked" : ""}><span class="link-tree-leaf-copy"><strong>${escapeHtml(element.id)}</strong><span class="small">${escapeHtml(path)} · ${escapeHtml(element.valueType || "xs:string")}${mismatch ? ` → will become ${escapeHtml(forcedType)}` : ""}${feeder ? ` · fed by ${escapeHtml(feeder.signal?.targetElement || "another signal")} (moves here)` : ""}</span></span>${checked ? '<span class="badge">Linked</span>' : ""}</label>`;
  }).join("");
  return aasItems.map((aas, aasIndex) => {
    const aasPrefix = `${encodeURIComponent(aas.id)}|`, aasSelected = selectedIds.some(id => id.startsWith(aasPrefix));
    return `<details ${aasSelected || (!selectedIds.length && aasIndex === 0) ? "open" : ""}><summary>${escapeHtml(aas.name || aas.id)} <span class="small">AAS</span></summary>${(aas.submodels || []).map(submodel => { const submodelToken = `|${encodeURIComponent(submodel.identifier || submodel.id)}|`; return `<details ${selectedIds.some(id => id.includes(submodelToken)) ? "open" : ""}><summary>${escapeHtml(submodel.id)} <span class="small">Submodel</span></summary>${renderElements(aas, submodel, submodel.elements || []) || '<div class="link-tree-empty">No Properties</div>'}</details>`; }).join("") || '<div class="link-tree-empty">No Submodels</div>'}</details>`;
  }).join("") || '<div class="link-tree-empty">No AAS Properties available.</div>';
}

// write: the link writes AAS → machine, which the Gateway supports only for writable OPC UA nodes.
function gatewaySignalTreeHtml(selectedId = "", valueType = "", { write = true } = {}) {
  const model = sharedModel.snapshot(), signals = model.signals.filter(signal => !signal.deleted);
  return model.connections.filter(connection => !connection.deleted).map((connection, index) => {
    const children = signals.filter(signal => signal.connectionId === connection.id);
    if (!children.length) return "";
    return `<details ${children.some(signal => signal.id === selectedId) || (!selectedId && index === 0) ? "open" : ""}><summary>${escapeHtml(connection.name || connection.machineId)} <span class="small">${escapeHtml(connection.protocol)}</span></summary>${children.map(signal => { const typeCompatible = !valueType || signal.valueType === valueType, opcua = connection.protocol === "OPC_UA", writable = !write || (opcua && signal.writable !== false), compatible = typeCompatible && writable; const reason = !typeCompatible ? `requires ${valueType}` : !write ? "" : !opcua ? `writes need an OPC UA node (${connection.protocol} is read-only)` : signal.writable === false ? "read-only node" : ""; return `<button type="button" class="link-tree-leaf${signal.id === selectedId ? " selected" : ""}${compatible ? "" : " incompatible"}" ${compatible ? `data-link-tree-value="${escapeHtml(signal.id)}"` : "disabled"}><span class="link-tree-leaf-copy"><strong>${escapeHtml(signal.idShort || signal.name)}</strong><span class="small">${escapeHtml(signal.targetElement)} · ${escapeHtml(signal.valueType)}${signal.unit ? ` · ${escapeHtml(signal.unit)}` : ""}${reason ? ` · ${escapeHtml(reason)}` : ""}</span></span>${gatewayAccessBadge(signal)}${signal.id === selectedId ? '<span class="badge">Linked</span>' : ""}</button>`; }).join("")}</details>`;
  }).join("") || '<div class="link-tree-empty">No Gateway signals found.</div>';
}

async function setDemoAasBindingValue(propertyId, value, options = {}) {
  const property = aasBindingProperties().find(item=>item.id===propertyId);
  let updated = false;
  const visit = (aas, submodel, elements, prefix = "") => (elements || []).forEach(element => {
    const path = prefix ? `${prefix}.${element.id}` : element.id;
    const id = `${encodeURIComponent(aas.id)}|${encodeURIComponent(submodel.identifier || submodel.id)}|${path}`;
    if (element.kind === "Property" && id === propertyId) { element.value = value; updated = true; }
    else if (Array.isArray(element.elements)) visit(aas, submodel, element.elements, path);
  });
  aasItems.forEach(aas => (aas.submodels || []).forEach(submodel => visit(aas, submodel, submodel.elements)));
  if (!updated) throw new Error("AAS Property is missing.");
  if (environment.isBackend) await window.gucBackendWorkspace.writeProperty(property, value);
  else await persistAas();
  renderAas(document.getElementById("aasSearch").value);
  if (!options.suppressServiceLinks) queueMicrotask(() => window.gucAasServiceLinks?.propertyChanged?.(propertyId));
}

async function rerenderAasDetail() { await persistAas(); renderAas(document.getElementById("aasSearch").value); }

function openAasElementModal(kind, submodelIndex, path = null, parentPath = null) {
  const item = selectedAas(); const submodel = item.submodels[submodelIndex];
  const existing = path === null ? null : elementAt(submodel, path).element;
  const existingPropertyId = existing?.kind === "Property" ? aasPropertyId(item, submodel, aasSemanticPath(submodel, path)) : "";
  openFormModal({
    title: existing ? `Edit ${existing.kind}` : `Add ${kind}`,
    submitLabel: existing ? "Save Element" : `Add ${kind}`,
    initial: existing || (kind === "Property" ? { id: "NewProperty", valueType: "xs:string", value: "", unit: "" } : { id: "NewCollection" }),
    fields: kind === "Property" ? [{ name: "id", label: "idShort" }, { name: "valueType", label: "Value Type", type: "select", options: ["xs:string", "xs:double", "xs:int", "xs:boolean"] }, { name: "value", label: "Value" }, { name: "unit", label: "Unit" }] : [{ name: "id", label: "idShort" }],
    onSubmit: async data => {
      data.id = data.id.trim();
      if (!validateRequiredId(data.id, "Element idShort")) return false;
      const destination = existing
        ? elementAt(submodel, path).list
        : parentPath !== null
          ? (elementAt(submodel, parentPath).element.elements ||= [])
          : submodel.elements;
      const existingIndex = existing ? elementAt(submodel, path).index : -1;
      if (destination.some((element, index) => index !== existingIndex && element.id === data.id)) {
        showToast(`Element idShort '${data.id}' already exists at this level.`);
        return false;
      }
      if (kind === "Property") data.value = GucMonitorHelpers.parseTyped(data.value, data.valueType);
      const next = kind === "Property" ? { ...(existing || {}), kind, ...data } : { ...(existing || {}), kind, id: data.id, elements: existing?.elements || [] };
      if (existingPropertyId && (existing.id !== next.id || existing.valueType !== next.valueType)) { await window.gucBindings?.removePropertyLinks?.(existingPropertyId); await window.gucAasServiceLinks?.removePropertyLinks?.(existingPropertyId); }
      if (existing) { const target = elementAt(submodel, path); target.list[target.index] = next; } else destination.push(next);
      await rerenderAasDetail(); showToast(`${kind} saved.`);
    }
  });
}

function openAasModal(item = null, index = -1) {
  openFormModal({
    title: item ? `Edit AAS: ${item.id}` : "Create AAS",
    submitLabel: item ? "Save AAS" : "Create AAS",
    initial: item || { id: `AAS_${String(aasItems.length + 1).padStart(4, "0")}`, name: "", type: "Asset", version: "3.0.1", status: "Draft" },
    fields: [
      { name: "id", label: "ID Short" },
      { name: "name", label: "Display Name" },
      { name: "type", label: "Type", type: "select", options: item ? ["Asset", "Submodel", "Concept Dict."] : ["Asset"] },
      { name: "version", label: "Version" },
      { name: "status", label: "Status", type: "select", options: ["Active", "Draft"] }
    ],
    onSubmit: async data => {
      data.id = data.id.trim(); data.name = data.name.trim(); data.version = data.version.trim();
      if (index < 0) data.type = "Asset";
      if (!validateRequiredId(data.id, "AAS ID") || !validateRequiredId(data.name, "Display Name")) return false;
      if (aasItems.some((entry, entryIndex) => entryIndex !== index && entry.id === data.id)) {
        showToast(`AAS ID '${data.id}' already exists.`);
        return false;
      }
      if (index >= 0) aasItems[index] = { ...aasItems[index], ...data };
      else aasItems.unshift({ ...data, identifier: `urn:guc:aas:${encodeURIComponent(data.id)}`, submodels: [] });
      selectedAasId = data.id;
      await persistAas();
      renderAas(document.getElementById("aasSearch").value);
      showToast(index >= 0 ? "AAS updated." : "AAS created.");
    }
  });
}
