/* Pure observation helpers. No access to the existing app's state or storage. */
(function (root) {
  "use strict";
  const routes = Object.freeze({ telemetry: "#009f98", command: "#ee9700", invoke: "#076df0", result: "#9153ef", model: "#076df0", sync: "#009f98" });
  function stable(value) {
    if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
    if (value && typeof value === "object") return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + stable(value[key])).join(",") + "}";
    return JSON.stringify(value);
  }
  function propertySample(property) {
    if (!property || typeof property !== "object" || Array.isArray(property) || !("value" in property)) return null;
    const qualifiers = {};
    for (const item of Array.isArray(property.qualifiers) ? property.qualifiers : []) {
      if (item && typeof item.type === "string") qualifiers[item.type] = item.value;
    }
    return {
      value: property.value,
      unit: String(qualifiers.Unit || ""),
      status: String(qualifiers.StatusCode || "OK"),
      observedAt: qualifiers.ObservedAt || qualifiers.Timestamp || null
    };
  }
  function changedSample(previous, next) {
    if (previous?.observedAt && next?.observedAt && Date.parse(next.observedAt) < Date.parse(previous.observedAt)) return false;
    return Boolean(next && (!previous || stable(previous) !== stable(next)));
  }
  function executionChanges(previous, records, baseline = false) {
    const next = new Map(previous), activity = [];
    for (const item of records) {
      const id = item?.executionId;
      if (typeof id !== "string" || !id) continue;
      const status = String(item.status || "UNKNOWN").toUpperCase();
      const before = next.get(id);
      if (["COMPLETED", "SUCCESS", "SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT", "TIMEOUT"].includes(before)) continue;
      if (!baseline && before !== status) {
        if (before === undefined) activity.push({ route: "invoke", label: String(item.serviceId || "Service execution") });
        if (["COMPLETED", "SUCCESS", "SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT", "TIMEOUT"].includes(status)) activity.push({ route: "result", label: String(item.serviceId || "Service result") });
      }
      next.set(id, status);
    }
    // Backend histories are bounded; retaining a bounded ID cache also prevents replay.
    while (next.size > 2000) next.delete(next.keys().next().value);
    return { next, activity };
  }
  function activityBins(events, now, windowSeconds = 1) {
    const width = Math.max(1, Math.min(10, Number(windowSeconds) || 1)) * 1000;
    const count = Math.ceil(60000 / width);
    const end = Math.floor(now / width) * width;
    const start = end - (count - 1) * width;
    const bins = Array.from({ length: count }, (_, index) => ({ at: start + index * width, values: {}, total: 0 }));
    for (const event of events) {
      if (!Object.hasOwn(routes, event.route) || !Number.isFinite(event.at) || event.at > now) continue;
      const index = Math.floor((event.at - start) / width);
      if (index < 0 || index >= count) continue;
      const weight = Math.max(0, Number(event.weight) || 0);
      bins[index].values[event.route] = (bins[index].values[event.route] || 0) + weight;
      bins[index].total += weight;
    }
    return bins;
  }
  const api = { routes, stable, propertySample, changedSample, executionChanges, activityBins };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PiplineData = Object.freeze(api);
})(typeof window === "undefined" ? globalThis : window);
