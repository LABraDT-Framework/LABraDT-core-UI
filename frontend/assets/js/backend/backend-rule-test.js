(function (root) {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function parseValues(raw) {
    let values; try {values = JSON.parse(raw || '{}');} catch {throw Error('Enter a JSON object, e.g. {"Temperature":95}.');}
    if (!values || Array.isArray(values) || typeof values !== 'object') throw Error('Test values must be a JSON object.');
    for (const value of Object.values(values)) if (value === null || !['string','number','boolean'].includes(typeof value) || typeof value === 'number' && !Number.isFinite(value))
      throw Error('Test values must be non-null, finite JSON primitives.');
    return values;
  }
  function buttons(id) {
    return `<button class="btn ghost" data-rule-test="dry-run" data-rule-test-id="${esc(id)}">Dry-run</button><button class="btn blue" data-rule-test="test-trigger" data-rule-test-id="${esc(id)}">Test Trigger</button>`;
  }
  function reportHtml(report) {
    const executions = report.executions || [];
    return `<h3>Rule Test · ${esc(report.ruleId)}</h3><p><span class="badge">${esc(report.status || 'DRY_RUN')}</span> · Condition ${report.conditionMet ? 'matched' : 'not matched'} · Automatic eligibility: ${report.wouldAutoTrigger ? 'yes' : 'no'} · Cooldown remaining: ${esc(report.cooldownRemainingMs)} ms</p>
      <p>${esc(report.message)}</p><p class="small">Input overrides affect this test's condition and explicitly mapped Service parameters, never live telemetry. No automatic retry or write-back. Test history is temporary and disappears on Engine restart.</p>
      <h4>Inputs and sources</h4><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(JSON.stringify({values:report.inputs,sources:report.inputSources},null,2))}</pre>
      <details><summary>Saved rule and Service trigger parameters</summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(JSON.stringify({rule:report.rule,serviceIds:report.serviceIds,dynamicArgs:report.dynamicArgs,effectiveServiceArgs:report.effectiveServiceArgs},null,2))}</pre></details>
      ${report.error ? `<p role="alert" style="color:var(--danger)">${esc(report.error)}</p>` : ''}
      ${executions.map(item => `<article style="border:1px solid var(--line);border-radius:8px;padding:12px;margin-top:10px"><strong>${esc(item.serviceId)}</strong> · ${esc(item.status)}<p class="small">Execution: ${esc(item.executionId)}</p><p>${esc(item.outputValidation || 'Waiting for Service result…')}</p>${item.pollError ? `<p role="alert">${esc(item.pollError)}</p>` : ''}${item.result ? `<pre style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(JSON.stringify(item.result,null,2))}</pre>` : ''}</article>`).join('')}`;
  }
  function init({openFormModal,request,toast}) {
    const panel = document.createElement('section'); panel.className = 'section'; panel.id = 'backendRuleTestPanel'; panel.hidden = true;
    document.getElementById('rulesWorkflows').after(panel);
    let report = null, timer = null, generation = 0, refreshing = false;
    function render(error = '') {
      panel.hidden = !report && !error;
      panel.innerHTML = (report ? reportHtml(report) : '') + (error ? `<p role="alert" style="color:var(--danger)">${esc(error)}</p>` : '')
        + (report?.testId ? '<button class="btn ghost" id="backendRuleTestRefresh">Refresh Test Result</button>' : '');
      const button = panel.querySelector('#backendRuleTestRefresh'); if (button) {button.disabled=refreshing; button.onclick=refresh;}
    }
    async function refresh() {
      if (!report?.testId) return;
      if (refreshing) {root.clearTimeout(timer);timer=root.setTimeout(refresh,1000);return;}
      const token = generation, id = report.testId; refreshing = true;
      try {
        const next = await request('/api/engine/rule-tests/' + encodeURIComponent(id));
        if (token !== generation) return;
        report = next; render();
        if (report.status !== 'RUNNING') toast(`Rule Test: ${report.status}. No write-back.`);
        if (report.status === 'RUNNING') timer = root.setTimeout(refresh,1000);
      } catch (error) {if (token === generation) render(error.message + ' · Refresh Test Result to retry reading; no Service is retriggered.');}
      finally {refreshing=false; const button=panel.querySelector('#backendRuleTestRefresh'); if (button) button.disabled=false;}
    }
    function open(id, mode) {
      if (root.gucBackendLifecycle?.isLocked()) throw Error('Stop Backend before testing a Rule.');
      const trigger = mode === 'test-trigger';
      openFormModal({title:`${trigger ? 'Test Trigger' : 'Dry-run'}: ${id}`,submitLabel:trigger ? 'Execute One Test' : 'Evaluate Without Execution',
        initial:{values:'{}',confirm:'No'},fields:[
          {name:'values',label:'Optional test inputs JSON: {} uses fresh live values. Overrides affect conditions and declared parameter mappings, never live values.',type:'textarea',full:true,rows:5},
          ...(trigger ? [{name:'confirm',label:'Execute real Services? Side effects are possible. Enabled/cooldown are ignored for this manual test. No retry or write-back.',type:'select',options:['No','Yes — execute real Services'],full:true}] : [])
        ],onSubmit:async data => {
          const values = parseValues(data.values);
          if (trigger && data.confirm !== 'Yes — execute real Services') throw Error('Explicitly confirm real Service execution, or use Dry-run.');
          // Server repeats STOPPED validation and evaluates the saved rule at submission time.
          const next = await request('/api/engine/rules/' + encodeURIComponent(id) + '/' + mode,'POST',{values,writeBack:false,...(trigger ? {confirm:true} : {})});
          generation++; root.clearTimeout(timer); report=next; render(); panel.scrollIntoView({block:'nearest'});
          toast(trigger ? `Rule Test: ${next.status}. No write-back.` : `Dry-run: condition ${next.conditionMet ? 'matched' : 'not matched'}; no execution.`);
          if (report.status === 'RUNNING') timer=root.setTimeout(refresh,500);
        }});
    }
    root.addEventListener('pagehide',() => {generation++;root.clearTimeout(timer);},{once:true});
    return {open};
  }
  const api={parseValues,buttons,reportHtml,init};
  if (typeof module !== 'undefined' && module.exports) module.exports=api;
  else root.GucBackendRuleTest=api;
})(typeof window !== 'undefined' ? window : globalThis);
