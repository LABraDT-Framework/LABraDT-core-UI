// Classic script: function definitions only; shared state is initialized in app/state.js.

async function handleAction(action, index) {
  const trigger = window.lastActionTrigger;
  if (action === "add-submodel") openAddSubmodelModal();
  if (action === "delete-aas-submodel") openDeleteSubmodelModal(Number(trigger.dataset.submodel));
  if (action === "preview-template") openTemplatePreview(trigger.dataset.templateId);
  if (action === "use-template") openAddSubmodelModal(trigger.dataset.templateId);
  if (action === "template-info") openTemplateInfo(selectedAas().submodels[Number(trigger.dataset.submodel)]);
  if (action === "add-property" || action === "add-collection") openAasElementModal(action === "add-property" ? "Property" : "Collection", Number(trigger.dataset.submodel));
  if (action === "add-child-property" || action === "add-child-collection") openAasElementModal(action === "add-child-property" ? "Property" : "Collection", Number(trigger.dataset.submodel), null, trigger.dataset.path);
  if (action === "edit-aas-element") openAasElementModal(elementAt(selectedAas().submodels[Number(trigger.dataset.submodel)], trigger.dataset.path).element.kind, Number(trigger.dataset.submodel), trigger.dataset.path);
  if (action === "delete-aas-element") { const aas = selectedAas(), submodel = aas.submodels[Number(trigger.dataset.submodel)], target = elementAt(submodel, trigger.dataset.path), semanticPath = aasSemanticPath(submodel, trigger.dataset.path); for (const propertyId of aasElementPropertyIds(aas, submodel, target.element, semanticPath)) { await window.gucBindings?.removePropertyLinks?.(propertyId); await window.gucAasServiceLinks?.removePropertyLinks?.(propertyId); } target.list.splice(target.index, 1); await rerenderAasDetail(); showToast("AAS element deleted."); }
  if (action === "link-aas-gateway") openAasGatewayLinkModal(trigger.dataset.propertyId);
  if (action === "sync-aas-link") { const result = await window.gucBindings?.syncAasLink?.(trigger.dataset.propertyId); showToast(result.ok ? "AAS value written to the linked Gateway signal." : result.message); }
  if (action === "unlink-aas-link") { await window.gucBindings?.removeAasLink?.(trigger.dataset.propertyId); renderAas(document.getElementById("aasSearch").value); renderMappings(); showToast("AAS → Gateway link removed."); }
  if (action === "view-aas") { selectedAasId = aasItems[index]?.id || selectedAasId; renderAas(document.getElementById("aasSearch").value); }
  if (action === "edit-aas") openAasModal(aasItems[index], index);
  if (action === "export-selected-aas") { const item = selectedAas(); if (item) { downloadJson(`${item.id}.json`, GucAasTemplates.toAasEnvironment(item)); showToast(`${item.id}.json exported as an AAS environment.`); } }
  if (action === "delete-aas") openConfirmModal({
    title: "Delete AAS",
    message: `Delete <strong>${escapeHtml(aasItems[index].name)}</strong> from this repository?`,
    onSubmit: async () => {
      for (const submodel of aasItems[index].submodels || []) for (const element of submodel.elements || []) for (const propertyId of aasElementPropertyIds(aasItems[index], submodel, element, element.id)) { await window.gucAasServiceLinks?.removePropertyLinks?.(propertyId); await window.gucBindings?.removePropertyLinks?.(propertyId); }
      const deletedId = aasItems[index].id;
      aasItems.splice(index, 1);
      if (selectedAasId === deletedId) selectedAasId = aasItems[Math.min(index, aasItems.length - 1)]?.id || null;
      await persistAas();
      renderAas(document.getElementById("aasSearch").value);
      showToast("AAS deleted.");
    }
  });
  if (action === "edit-selected-aas") {
    const idx = selectedAasIndex();
    openAasModal(aasItems[idx], idx);
  }
  if (action === "delete-selected-aas") {
    const idx = selectedAasIndex();
    handleAction("delete-aas", idx);
  }
  if (action === "edit-mapping") openMappingModal(mappings[index], index);
  if (action === "limits-mapping") openMappingLimitsModal(mappings[index], index);
  if (action === "link-mapping") openMappingLinkModal(mappings[index]);

  if (action === "sync-mapping-link") { const result = await window.gucBindings?.syncGatewayLink?.(mappingSignalId(mappings[index])); showToast(result.ok ? `Gateway value written to ${result.count} linked AAS Properties.` : result.message); }
  if (action === "unlink-mapping-link") { await window.gucBindings?.removeGatewayLink?.(mappingSignalId(mappings[index])); renderMappings(); renderAas(document.getElementById("aasSearch").value); showToast("All Gateway → AAS links removed."); }
  if (action === "delete-mapping") openConfirmModal({
    title: "Delete Mapping",
    message: `Delete mapping <strong>${escapeHtml(mappings[index].idShort)}</strong>?`,
    onSubmit: async () => {
      await window.gucBindings?.removeGatewayLink?.(mappingSignalId(mappings[index]));
      mappings.splice(index, 1);
      renderMappings(); markGatewayDirty();
      showToast("Mapping deleted.");
    }
  });
  if (action === "edit-service") openServiceModal(services[index], index);
  if (action === "trigger-service") triggerService(index);
  if (action === "delete-service") openConfirmModal({
    title: "Delete Service",
    message: `Delete service <strong>${escapeHtml(services[index].id)}</strong>?`,
    onSubmit: async () => {
      const deletedId = services[index].id;
      const removedLinks = await window.gucAasServiceLinks?.removeServiceLinks?.(deletedId) || 0;
      services.splice(index, 1);
      if (selectedServiceId === deletedId) selectedServiceId = services[Math.min(index, services.length - 1)]?.id || null;
      await persistServices();
      renderServices();
      showToast(`Service deleted.${removedLinks ? ` ${removedLinks} dependent AAS Service Link(s) were removed.` : ""}`);
    }
  });
}
