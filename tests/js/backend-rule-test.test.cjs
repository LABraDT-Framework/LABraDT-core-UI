const {test}=require('node:test');
const assert=require('node:assert/strict');
const {parseValues,buttons,reportHtml}=require('../../frontend/assets/js/backend/backend-rule-test.js');
test('test overrides accept only an object of non-null primitives',()=>{
  assert.deepEqual(parseValues('{}'),{});
  assert.deepEqual(parseValues('{"Temperature":95,"Flag":true,"Position":"0,0,0"}'),{Temperature:95,Flag:true,Position:'0,0,0'});
  for(const raw of ['[]','null','5','bad','{"Value":null}','{"Value":{}}','{"Value":[]}','{"Value":1e999}']) assert.throws(()=>parseValues(raw));
});
test('test controls and results escape untrusted model and Service content',()=>{
  assert.match(buttons('Rule_1'),/Dry-run/);assert.match(buttons('Rule_1'),/Test Trigger/);
  assert.doesNotMatch(buttons('<script>'),/<script>/);
  const html=reportHtml({ruleId:'<script>',conditionMet:false,writeBack:false,message:'<img>',inputs:{Temperature:70},inputSources:{Temperature:'test override'},executions:[{serviceId:'<script>',status:'FAILED',result:{outputData:'<img>'}}]});
  assert.doesNotMatch(html,/<script>|<img>/);assert.match(html,/Condition not matched/);assert.match(html,/No automatic retry or write-back/);
});
