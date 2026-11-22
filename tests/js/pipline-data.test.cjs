"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { stable, propertySample, changedSample, executionChanges, activityBins } = require("../../frontend/assets/js/pipline/data.js");

test("gateway keyframes do not count the same observation twice; a new timestamp does", () => {
  const raw = { value: "72.4", qualifiers: [{type:"ObservedAt",value:"2026-10-20T10:00:00Z"},{type:"Unit",value:"°C"}] };
  const before = propertySample(raw);
  assert.equal(changedSample(before, propertySample({...raw, qualifiers:[...raw.qualifiers].reverse()})), false);
  const next = propertySample({...raw, qualifiers:[{type:"ObservedAt",value:"2026-10-20T10:00:01Z"},{type:"Unit",value:"°C"}]});
  assert.equal(changedSample(before, next), true);
  assert.equal(changedSample(next, before), false);
  assert.equal(propertySample(null), null);
  assert.equal(propertySample({}), null);
});

test("existing completed executions are a baseline, then only new execution transitions animate", () => {
  const old = {executionId:"old",serviceId:"cooling",status:"COMPLETED"};
  const initial = executionChanges(new Map(), [old], true);
  assert.deepEqual(initial.activity, []);
  const started = executionChanges(initial.next, [old,{executionId:"new",serviceId:"cooling",status:"RUNNING"}]);
  assert.deepEqual(started.activity.map(item=>item.route), ["invoke"]);
  const completed = executionChanges(started.next, [old,{executionId:"new",serviceId:"cooling",status:"COMPLETED"}]);
  assert.deepEqual(completed.activity.map(item=>item.route), ["result"]);
  assert.deepEqual(executionChanges(completed.next, [old,{executionId:"new",status:"COMPLETED"}]).activity, []);
  assert.deepEqual(executionChanges(completed.next, [old]).activity, []);
  const staleRunning = executionChanges(completed.next, [{executionId:"new",status:"RUNNING"}]);
  assert.equal(staleRunning.next.get("new"), "COMPLETED");
  assert.deepEqual(executionChanges(staleRunning.next, [{executionId:"new",status:"COMPLETED"}]).activity, []);
});

test("a short execution first seen completed reports its invocation and result once", () => {
  const result = executionChanges(new Map(), [{executionId:"quick",status:"FAILED"}, {executionId:"quick",status:"FAILED"}, {}]);
  assert.deepEqual(result.activity.map(item=>item.route), ["invoke", "result"]);
});

test("activity windows aggregate observed weights and ignore future, expired and unknown events", () => {
  const now = 120000;
  const events = [{at:119000,route:"telemetry",weight:7},{at:118000,route:"result",weight:1},{at:1000,route:"invoke",weight:99},{at:130000,route:"model",weight:99},{at:119000,route:"unknown",weight:99}];
  for (const width of [1,5,10]) assert.equal(activityBins(events,now,width).reduce((n,bin)=>n+bin.total,0),8);
  assert.equal(activityBins(events,now,5).length,12);
  assert.equal(stable({b:2,a:{y:4,x:3}}),stable({a:{x:3,y:4},b:2}));
});
