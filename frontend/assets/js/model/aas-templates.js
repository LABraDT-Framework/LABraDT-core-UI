(function (root) {
    "use strict";

    const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    const text = value => String(value ?? "").trim();

    function referenceValue(reference) {
        const keys = reference?.keys;
        return Array.isArray(keys) && keys.length ? text(keys.at(-1)?.value) : "";
    }

    function localizedText(value, fallback = "") {
        if (typeof value === "string") return value;
        if (!Array.isArray(value)) return fallback;
        const preferred = value.find(item => /^en(?:-|$)/i.test(item?.language || "")) || value[0];
        return text(preferred?.text) || fallback;
    }

    function modelTypeName(value) {
        if (typeof value === "string") return value;
        return text(value?.name);
    }

    const templateDefinitions = [
        {
            id: "IDTA-02003",
            name: "Generic Frame for Technical Data for Industrial Equipment in Manufacturing",
            shortName: "Technical Data",
            version: "2.0.1",
            description: "Representative demo profile for technical properties, dimensions and ratings.",
            semanticId: { type: "ExternalReference", keys: [{ type: "GlobalReference", value: "0173-1#01-AHX837#002" }] },
            submodel: {
                id: "TechnicalData",
                identifier: "https://example.org/guc/templates/idta-02003/2/0/1",
                elements: [
                    { kind: "Collection", id: "GeneralInformation", elements: [
                        { kind: "Property", id: "ManufacturerName", valueType: "xs:string", value: "", unit: "" },
                        { kind: "Property", id: "ManufacturerProductDesignation", valueType: "xs:string", value: "", unit: "" },
                        { kind: "Property", id: "ManufacturerOrderCode", valueType: "xs:string", value: "", unit: "" }
                    ] },
                    { kind: "Collection", id: "TechnicalProperties", elements: [
                        { kind: "Property", id: "RatedPower", valueType: "xs:double", value: "", unit: "kW" },
                        { kind: "Property", id: "NominalVoltage", valueType: "xs:double", value: "", unit: "V" },
                        { kind: "Property", id: "NominalFrequency", valueType: "xs:double", value: "", unit: "Hz" }
                    ] },
                    { kind: "Collection", id: "Dimensions", elements: [
                        { kind: "Property", id: "Height", valueType: "xs:double", value: "", unit: "mm" },
                        { kind: "Property", id: "Width", valueType: "xs:double", value: "", unit: "mm" },
                        { kind: "Property", id: "Depth", valueType: "xs:double", value: "", unit: "mm" }
                    ] }
                ]
            }
        },
        {
            id: "IDTA-02006",
            name: "Digital Nameplate for Industrial Equipment",
            shortName: "Digital Nameplate",
            version: "3.0.1",
            description: "Representative demo profile for manufacturer and product identification.",
            semanticId: { type: "ExternalReference", keys: [{ type: "GlobalReference", value: "https://admin-shell.io/idta/nameplate/3/0/Nameplate" }] },
            submodel: {
                id: "Nameplate",
                identifier: "https://example.org/guc/templates/idta-02006/3/0/1",
                elements: [
                    { kind: "Property", id: "ManufacturerName", valueType: "xs:string", value: "", unit: "" },
                    { kind: "Property", id: "ManufacturerProductDesignation", valueType: "xs:string", value: "", unit: "" },
                    { kind: "Property", id: "SerialNumber", valueType: "xs:string", value: "", unit: "" },
                    { kind: "Property", id: "YearOfConstruction", valueType: "xs:string", value: "", unit: "" },
                    { kind: "Collection", id: "ContactInformation", elements: [
                        { kind: "Property", id: "Street", valueType: "xs:string", value: "", unit: "" },
                        { kind: "Property", id: "ZipCode", valueType: "xs:string", value: "", unit: "" },
                        { kind: "Property", id: "CityTown", valueType: "xs:string", value: "", unit: "" },
                        { kind: "Property", id: "Country", valueType: "xs:string", value: "", unit: "" }
                    ] }
                ]
            }
        },
        {
            id: "IDTA-02002",
            name: "Contact Information",
            shortName: "Contact Information",
            version: "1.0.1",
            description: "Representative demo profile for company and contact-person details.",
            semanticId: { type: "ExternalReference", keys: [{ type: "GlobalReference", value: "https://admin-shell.io/zvei/nameplate/1/0/ContactInformations" }] },
            submodel: {
                id: "ContactInformation",
                identifier: "https://example.org/guc/templates/idta-02002/1/0/1",
                elements: [
                    { kind: "Collection", id: "ContactInformation", elements: [
                        { kind: "Property", id: "Company", valueType: "xs:string", value: "", unit: "" },
                        { kind: "Property", id: "Department", valueType: "xs:string", value: "", unit: "" },
                        { kind: "Property", id: "RoleOfContactPerson", valueType: "xs:string", value: "", unit: "" },
                        { kind: "Property", id: "Street", valueType: "xs:string", value: "", unit: "" },
                        { kind: "Property", id: "ZipCode", valueType: "xs:string", value: "", unit: "" },
                        { kind: "Property", id: "CityTown", valueType: "xs:string", value: "", unit: "" },
                        { kind: "Property", id: "Email", valueType: "xs:string", value: "", unit: "" },
                        { kind: "Property", id: "Phone", valueType: "xs:string", value: "", unit: "" }
                    ] }
                ]
            }
        }
    ];

    const templates = templateDefinitions.map(definition => Object.freeze(clone(definition)));

    function findTemplate(templateId) {
        return templates.find(item => item.id === templateId) || null;
    }

    function instantiate(templateId, idShort) {
        const template = findTemplate(templateId);
        if (!template) throw new Error("Template is unavailable.");
        const submodel = clone(template.submodel);
        submodel.id = text(idShort) || submodel.id;
        submodel.identifier = `urn:guc:submodel:${encodeURIComponent(submodel.id)}:${Date.now().toString(36)}`;
        submodel.semanticId = clone(template.semanticId);
        submodel.templateOrigin = {
            id: template.id,
            name: template.name,
            version: template.version,
            semanticId: clone(template.semanticId),
            source: "Bundled demo profile"
        };
        return submodel;
    }

    function elementChildren(element) {
        const type = modelTypeName(element?.modelType);
        if (type === "SubmodelElementCollection" || type === "SubmodelElementList") return Array.isArray(element.value) ? element.value : [];
        if (type === "Entity") return Array.isArray(element.statements) ? element.statements : [];
        if (Array.isArray(element?.submodelElements)) return element.submodelElements;
        return [];
    }

    function primitiveValue(value) {
        if (value === undefined || value === null) return "";
        if (typeof value === "object") {
            if (Array.isArray(value)) return localizedText(value, JSON.stringify(value));
            return JSON.stringify(value);
        }
        return String(value);
    }

    function normalizeElement(element, index = 0) {
        const modelType = modelTypeName(element?.modelType) || (Array.isArray(element?.elements) ? "SubmodelElementCollection" : "Property");
        const children = elementChildren(element);
        const isContainer = children.length > 0 || ["SubmodelElementCollection", "SubmodelElementList", "Entity"].includes(modelType);
        const id = text(element?.idShort || element?.id) || `${isContainer ? "Collection" : "Element"}${index + 1}`;
        const common = {
            _raw: clone(element?._raw || (element?.idShort ? element : {})),
            id,
            modelType,
            ...(element?.semanticId ? { semanticId: clone(element.semanticId) } : {}),
            ...(Array.isArray(element?.supplementalSemanticIds) ? { supplementalSemanticIds: clone(element.supplementalSemanticIds) } : {}),
            ...(Array.isArray(element?.qualifiers) ? { qualifiers: clone(element.qualifiers) } : {}),
            ...(element?.description ? { description: clone(element.description) } : {})
        };
        if (isContainer) return { ...common, kind: "Collection", elements: children.map(normalizeElement) };
        return {
            ...common,
            kind: "Property",
            valueType: text(element?.valueType) || "xs:string",
            value: primitiveValue(element?.value),
            unit: text(element?.unit) || text((element?.extensions || []).find(item=>item.name==='GucUnit')?.value)
        };
    }

    function normalizeSubmodel(submodel, index = 0) {
        const identifier = text(submodel?.identifier || submodel?.id) || `urn:guc:submodel:imported:${index + 1}`;
        const id = text(submodel?.idShort || submodel?.id) || `Submodel${index + 1}`;
        const rawElements = Array.isArray(submodel?.submodelElements) ? submodel.submodelElements : Array.isArray(submodel?.elements) ? submodel.elements : [];
        const extensionValue = name => text((submodel?.extensions || []).find(item => item?.name === name)?.value);
        const importedTemplateId = text(submodel?.templateOrigin?.id) || extensionValue("GucTemplateId");
        const knownTemplate = findTemplate(importedTemplateId);
        return {
            id,
            identifier,
            _raw: clone(submodel?._raw || (submodel?.modelType === 'Submodel' ? submodel : {})),
            ...(submodel?.semanticId ? { semanticId: clone(submodel.semanticId) } : {}),
            ...(submodel?.administration ? { administration: clone(submodel.administration) } : {}),
            ...(submodel?.templateOrigin ? { templateOrigin: clone(submodel.templateOrigin) } : importedTemplateId ? { templateOrigin: { id: importedTemplateId, name: extensionValue('GucTemplateName') || knownTemplate?.name || importedTemplateId, version: extensionValue("GucTemplateVersion") || knownTemplate?.version || 'uploaded', semanticId: clone(knownTemplate?.semanticId), source: extensionValue('GucTemplateSource') || "Imported AAS environment" } } : {}),
            elements: rawElements.map(normalizeElement)
        };
    }

    function fallbackId(value, prefix) {
        const normalized = text(value).split(/[\/#:]/).filter(Boolean).at(-1)?.replace(/[^A-Za-z0-9_-]/g, "-");
        return normalized || prefix;
    }

    function shellReferences(shell) {
        return (Array.isArray(shell?.submodels) ? shell.submodels : []).map(referenceValue).filter(Boolean);
    }

    function normalizeShell(shell, allSubmodels, fileName, index = 0) {
        const identifier = text(shell?.identifier || shell?.id) || `urn:guc:aas:imported:${index + 1}`;
        const id = text(shell?.idShort) || fallbackId(identifier, `ImportedAAS${index + 1}`);
        const references = shellReferences(shell);
        const selected = references.length
            ? references.map(reference => allSubmodels.find(item => text(item?.id || item?.identifier) === reference)).filter(Boolean)
            : (Array.isArray(shell?.submodels) && shell.submodels.some(item => item?.submodelElements || item?.elements) ? shell.submodels : []);
        return {
            id,
            identifier,
            _raw: clone(shell),
            name: localizedText(shell?.displayName, id),
            type: text((shell?.extensions || []).find(item=>item.name==='GucUiType')?.value) || "Asset",
            version: text(shell?.administration?.version) || "3.0.1",
            status: text((shell?.extensions || []).find(item=>item.name==='GucUiStatus')?.value) || "Draft",
            assetId: text(shell?.assetInformation?.globalAssetId),
            sourceFile: fileName,
            submodels: selected.map(normalizeSubmodel)
        };
    }

    function normalizeLegacy(item, fileName, index = 0) {
        const id = text(item?.idShort || item?.id) || `ImportedAAS${index + 1}`;
        return {
            ...clone(item),
            id,
            identifier: text(item?.identifier) || `urn:guc:aas:${encodeURIComponent(id)}`,
            name: localizedText(item?.displayName, text(item?.name) || id),
            type: text(item?.type) || "Asset",
            version: text(item?.version) || "3.0.1",
            status: text(item?.status) || "Draft",
            sourceFile: fileName,
            submodels: (Array.isArray(item?.submodels) ? item.submodels : []).map(normalizeSubmodel)
        };
    }

    function normalizeImport(input, fileName = "import.json") {
        const parsed = input?.environment || input?.aasEnvironment || input;
        if (!parsed || typeof parsed !== "object") throw new Error("The file does not contain a JSON object.");
        const modelType = modelTypeName(parsed.modelType);
        if (modelType === "Submodel") {
            const submodel = normalizeSubmodel(parsed);
            return [{ id: fallbackId(submodel.id, "ImportedSubmodel"), identifier: `urn:guc:aas:wrapper:${encodeURIComponent(submodel.identifier)}`, name: localizedText(parsed.displayName, submodel.id), type: "Asset", version: text(parsed?.administration?.version) || "3.0.1", status: "Draft", sourceFile: fileName, submodels: [submodel] }];
        }
        if (modelType === "AssetAdministrationShell") return [normalizeShell(parsed, [], fileName)];
        const submodels = Array.isArray(parsed.submodels) ? parsed.submodels : [];
        const shells = Array.isArray(parsed.assetAdministrationShells) ? parsed.assetAdministrationShells : [];
        if (shells.length) return shells.map((shell, index) => normalizeShell(shell, submodels, fileName, index));
        if (submodels.some(item => modelTypeName(item?.modelType) === "Submodel" || item?.submodelElements)) {
            const base = fallbackId(fileName.replace(/\.json$/i, ""), "ImportedEnvironment");
            return [{ id: base, identifier: `urn:guc:aas:wrapper:${encodeURIComponent(base)}`, name: base.replaceAll("-", " "), type: "Asset", version: "3.0.1", status: "Draft", sourceFile: fileName, submodels: submodels.map(normalizeSubmodel) }];
        }
        const legacy = Array.isArray(parsed) ? parsed : Array.isArray(parsed.aasItems) ? parsed.aasItems : [parsed];
        const result = legacy.filter(item => item && (item.id || item.idShort)).map((item, index) => normalizeLegacy(item, fileName, index));
        if (!result.length) throw new Error("No AAS or Submodel definitions were found.");
        return result;
    }

    function structuralElement(element) {
        return {
            id: text(element?.id),
            kind: element?.kind === "Collection" ? "Collection" : "Property",
            modelType: text(element?.modelType) || (element?.kind === "Collection" ? "SubmodelElementCollection" : "Property"),
            valueType: text(element?.valueType),
            semanticId: referenceValue(element?.semanticId),
            elements: (Array.isArray(element?.elements) ? element.elements : []).map(structuralElement)
        };
    }

    function templateStatus(submodel) {
        if (!submodel?.templateOrigin?.id) return { label: "Custom", modified: false, known: false };
        const template = findTemplate(submodel.templateOrigin.id);
        if (!template) return { label: "Template unavailable", modified: true, known: false };
        const actual = JSON.stringify((submodel.elements || []).map(structuralElement));
        const expected = JSON.stringify((template.submodel.elements || []).map(structuralElement));
        return { label: actual === expected ? "Unmodified" : "Modified", modified: actual !== expected, known: true };
    }

    function extension(name, value) {
        return { name, valueType: "xs:string", value: text(value) };
    }

    function exportElement(element) {
        const common = {
            ...clone(element?._raw || {}),
            modelType: text(element?.modelType) || (element?.kind === "Collection" ? "SubmodelElementCollection" : "Property"),
            idShort: text(element?.id),
            ...(element?.unit ? {extensions:[...(element?._raw?.extensions || []).filter(item=>item.name!=='GucUnit'),extension('GucUnit',element.unit)]} : element?._raw?.extensions?.some(item=>item.name==='GucUnit') ? {extensions:element._raw.extensions.filter(item=>item.name!=='GucUnit')} : {}),
            ...(element?.semanticId ? { semanticId: clone(element.semanticId) } : {}),
            ...(Array.isArray(element?.qualifiers) ? { qualifiers: clone(element.qualifiers) } : {})
        };
        if (element?.kind === "Collection") return { ...common, [common.modelType === 'Entity' ? 'statements' : 'value']: (element.elements || []).map(exportElement) };
        if (!['Property'].includes(common.modelType)) return common;
        return { ...common, valueType: text(element?.valueType) || "xs:string", value: text(element?.value) };
    }

    function toAasEnvironment(item) {
        const aasIdentifier = text(item?.identifier) || `urn:guc:aas:${encodeURIComponent(item?.id || "aas")}`;
        const submodels = (item?.submodels || []).map((submodel, index) => {
            const identifier = text(submodel.identifier) || `urn:guc:submodel:${encodeURIComponent(item.id)}:${index + 1}`;
            const extensions = submodel.templateOrigin ? [extension("GucTemplateId", submodel.templateOrigin.id), extension("GucTemplateVersion", submodel.templateOrigin.version),extension('GucTemplateName',submodel.templateOrigin.name),extension('GucTemplateSource',submodel.templateOrigin.source)] : [];
            return {
                ...clone(submodel._raw || {}),
                modelType: "Submodel",
                id: identifier,
                idShort: text(submodel.id) || `Submodel${index + 1}`,
                ...(submodel.semanticId ? { semanticId: clone(submodel.semanticId) } : {}),
                ...(extensions.length ? { extensions: [...(submodel._raw?.extensions || []).filter(item => !['GucTemplateId','GucTemplateVersion','GucTemplateName','GucTemplateSource'].includes(item.name)), ...extensions] } : {}),
                submodelElements: (submodel.elements || []).map(exportElement)
            };
        });
        return {
            assetAdministrationShells: [{
                ...clone(item?._raw || {}),
                modelType: "AssetAdministrationShell",
                id: aasIdentifier,
                idShort: text(item?.id),
                displayName: [...(item?._raw?.displayName || []).filter(item=>item.language!=='en'),{ language: "en", text: text(item?.name) || text(item?.id) }],
                extensions: [...(item?._raw?.extensions || []).filter(item=>!['GucUiType','GucUiStatus'].includes(item.name)),extension('GucUiType',item?.type || 'Asset'),extension('GucUiStatus',item?.status || 'Draft')],
                assetInformation: { assetKind: "Instance", ...clone(item?._raw?.assetInformation || {}), ...(item?.assetId ? { globalAssetId: text(item.assetId) } : {}) },
                administration: {...clone(item?._raw?.administration || {}), version: text(item?.version) || '3.0.1'},
                submodels: submodels.map(submodel => clone(item?._raw?.submodels?.find(ref=>(ref.keys||[]).some(key=>key.type==='Submodel'&&key.value===submodel.id))) || ({ type: "ModelReference", keys: [{ type: "Submodel", value: submodel.id }] }))
            }],
            submodels,
            conceptDescriptions: []
        };
    }

    root.GucAasTemplates = {
        catalog: () => clone(templates),
        find: templateId => clone(findTemplate(templateId)),
        instantiate,
        normalizeImport,
        normalizeElement,
        normalizeSubmodel,
        referenceValue,
        templateStatus,
        toAasEnvironment
    };
})(typeof window !== "undefined" ? window : globalThis);
