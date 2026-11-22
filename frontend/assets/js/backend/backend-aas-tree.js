(function (root) {
  'use strict';
  const copy = value => JSON.parse(JSON.stringify(value));
  const types = ['xs:string', 'xs:boolean', 'xs:int', 'xs:integer', 'xs:long', 'xs:float', 'xs:double', 'xs:decimal'];
  function children(model, indexes, create = false) {
    let node = model, key = 'submodelElements';
    for (const index of indexes) {
      node = node[key]?.[index];
      if (!node || node.modelType !== 'SubmodelElementCollection') throw Error('The selected Collection no longer exists. Refresh Repository.');
      key = 'value';
    }
    if (node[key] === undefined && create) node[key] = [];
    if (node[key] !== undefined && !Array.isArray(node[key])) throw Error('Invalid element array; use Inspect JSON.');
    return node[key] || [];
  }
  function at(model, indexes) {
    const node = children(model, indexes.slice(0, -1))[indexes.at(-1)];
    if (!indexes.length || !node) throw Error('The selected element no longer exists. Refresh Repository.');
    return node;
  }
  function validateValue(type, value) {
    if (!types.includes(type)) throw Error('This valueType requires the advanced JSON editor.');
    if (type === 'xs:string') return;
    if (type === 'xs:boolean') {
      if (!/^(true|false|1|0)$/.test(value)) throw Error('Boolean values must be true, false, 1 or 0.');
      return;
    }
    if (['xs:int', 'xs:integer', 'xs:long'].includes(type)) {
      if (!/^[+-]?\d+$/.test(value)) throw Error('Enter an integer without a decimal point.');
      const integer = BigInt(value);
      if (type === 'xs:int' && (integer < -2147483648n || integer > 2147483647n) || type === 'xs:long' && (integer < -9223372036854775808n || integer > 9223372036854775807n)) throw Error('Integer is outside the declared valueType range.');
      return;
    }
    const numeric = type === 'xs:decimal' ? /^[+-]?(\d+(\.\d*)?|\.\d+)$/ : /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
    if (!numeric.test(value) || !Number.isFinite(Number(value)) || type === 'xs:float' && !Number.isFinite(Math.fround(Number(value)))) throw Error('Enter a finite number compatible with valueType.');
  }
  function mutate(model, {action, indexes = [], type, data = {}}) {
    if (model.modelType !== 'Submodel' || ['Rules_SM', 'StateChart_SM', 'CPS_SM'].includes(model.idShort)) throw Error('Engine-owned or non-Submodel structures cannot be edited here.');
    const result = copy(model), editing = action !== 'add';
    if (!['add', 'edit', 'delete'].includes(action)) throw Error('Unknown tree operation.');
    const siblings = children(result, editing ? indexes.slice(0, -1) : indexes, true);
    const existing = editing ? at(result, indexes) : null;
    type = existing?.modelType || type;
    if (!['Property', 'SubmodelElementCollection'].includes(type)) throw Error('This element type requires the advanced JSON editor.');
    if (action === 'delete') {siblings.splice(indexes.at(-1), 1); return result;}
    const idShort = data.idShort?.trim();
    if (!/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(idShort || '')) throw Error('idShort must start with a letter and contain only letters, digits or underscores (max 128).');
    if (siblings.some((node, index) => node.idShort === idShort && (!editing || index !== indexes.at(-1)))) throw Error('A sibling already has this idShort.');
    const next = existing || {modelType:type};
    next.idShort = idShort;
    if (type === 'Property') {
      const value = String(data.value ?? '');
      validateValue(data.valueType, value);
      next.valueType = data.valueType; next.value = value;
    } else if (!editing) next.value = [];
    if (!editing) siblings.push(next);
    return result;
  }
  const api = {types, children, at, mutate, validateValue};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GucBackendAasTree = api;
})(typeof window !== 'undefined' ? window : globalThis);
