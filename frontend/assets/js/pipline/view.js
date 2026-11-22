(function () {
  "use strict";
  const D = window.PiplineData;
  const $ = id => document.getElementById(id);
  const svgNS = "http://www.w3.org/2000/svg";
  const status = { gateway: "checking", engine: "checking", services: "checking", aas: "checking" };
  const particles = [], activity = [], controllers = new Set(), busy = new Set();
  const pathInfo = Object.fromEntries(Object.keys(D.routes).map(route => {
    const path = $("route-" + route);
    return [route, { path, length: path.getTotalLength(), activeUntil: 0 }];
  }));
  // A quiet continuous track remains behind the moving dashes on active wires.
  const tracks = document.createElementNS(svgNS, "g");
  tracks.setAttribute("class", "route-tracks");
  tracks.setAttribute("fill", "none");
  tracks.setAttribute("aria-hidden", "true");
  for (const info of Object.values(pathInfo)) {
    const track = document.createElementNS(svgNS, "path");
    track.setAttribute("d", info.path.getAttribute("d"));
    tracks.appendChild(track);
  }
  const routeGroup = $("diagram").querySelector(".routes");
  routeGroup.before(tracks);
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  let mode = "backend", paused = false, generation = 0, stream = null, streamOpen = false;
  let samples = new Map(), executions = new Map(), executionBaseline = false, modelFingerprint = null;
  let registry = null, rules = null, runtime = null, history = [], running = [], gatewayHealth = null;
  let lastChecked = null, lastFrame = 0, frozenAt = 0, demoTick = 0, lastPacketAt = 0, animationPausedAt = 0;
  let nextStatus = 0, nextMetadata = 0, nextHistory = 0, nextSnapshot = 0, frameId = 0, destroyed = false;
  const text = (id, value) => { $(id).textContent = value; };
  const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const array = value => { if (!Array.isArray(value)) throw Error("Unexpected response format"); return value; };
  const object = value => { if (!isObject(value)) throw Error("Unexpected response format"); return value; };

  function setStatus(name, value, error = "") {
    status[name] = value;
    const node = $("node-" + name);
    node.dataset.status = value;
    node.title = error;
  }
  function clearParticles() {
    particles.splice(0).forEach(item => item.element.remove());
    for (const info of Object.values(pathInfo)) { info.activeUntil = 0; info.path.classList.remove("is-active"); }
    $("packetLabel").setAttribute("visibility", "hidden");
  }
  function observe(route, weight = 1, label = "", at = Date.now(), animate = true) {
    const second = Math.floor(at / 1000) * 1000;
    const existing = activity.findLast(item => item.at === second && item.route === route);
    if (existing) existing.weight += weight;
    else activity.push({ route, weight, at: second });
    if (activity.length > 1800) activity.splice(0, activity.length - 1800);
    if (!animate || paused) return;
    pathInfo[route].activeUntil = performance.now() + 2400;
    if (!reducedMotion.matches) {
      const count = Math.min(6, Math.max(1, weight));
      for (let i = 0; i < count; i++) {
        if (particles.length >= 72) particles.shift().element.remove();
        const element = document.createElementNS(svgNS, "circle");
        element.setAttribute("r", route === "telemetry" ? "3.8" : "3.3");
        element.setAttribute("fill", D.routes[route]);
        element.setAttribute("class", "particle");
        element.setAttribute("visibility", "hidden");
        $("particles").appendChild(element);
        particles.push({ route, element, progress: -i * .13 });
      }
    }
    if (route === "telemetry" && label) {
      text("packetText", label.length > 25 ? label.slice(0, 24) + "…" : label);
      $("packetLabel").setAttribute("visibility", "visible");
      lastPacketAt = performance.now();
    }
  }
  function acceptProperty(key, property, emit = true) {
    const sample = D.propertySample(property);
    if (!sample) return;
    const previous = samples.get(key);
    if (previous?.observedAt && sample.observedAt && Date.parse(sample.observedAt) < Date.parse(previous.observedAt)) return;
    samples.set(key, sample);
    if (emit && D.changedSample(previous, sample) && !/BAD|STALE|ERROR|DISCONNECT/i.test(sample.status)) {
      const name = String(key).split(/[/.]/).pop();
      const value = typeof sample.value === "object" ? "updated" : String(sample.value);
      observe("telemetry", 1, `${name} ${value} ${sample.unit}`.trim());
    }
  }
  async function read(path, active, validate = object) {
    const controller = new AbortController();
    controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), 6500);
    try {
      const response = await fetch(path, { method: "GET", cache: "no-store", credentials: "same-origin", signal: controller.signal });
      if (!response.ok) throw Error("Unavailable (HTTP " + response.status + ")");
      const payload = validate(await response.json());
      if (active !== generation) throw Error("Viewer source changed");
      return payload;
    } finally { clearTimeout(timer); controllers.delete(controller); }
  }
  async function task(name, load) {
    if (busy.has(name)) return;
    busy.add(name);
    const active = generation;
    try { await load(active); }
    finally { if (active === generation) { busy.delete(name); lastChecked = Date.now(); render(); } }
  }
  async function snapshot(active) {
    try {
      const payload = await read("/api/gateway/live/snapshot", active);
      for (const [key, property] of Object.entries(payload)) acceptProperty(key, property, samples.size > 0 && samples.has(key));
    } catch { /* Health reports availability; an old sample never generates activity. */ }
  }
  function openStream() {
    if (stream || mode !== "backend" || paused || !/^https?:$/.test(location.protocol)) return;
    const active = generation;
    stream = new EventSource("/api/gateway/live/stream");
    stream.onopen = () => { if (active === generation) streamOpen = true; };
    for (const eventName of ["snapshot", "update", "keyframe"]) {
      stream.addEventListener(eventName, event => {
        if (active !== generation || paused) return;
        try {
          const item = JSON.parse(event.data);
          if (typeof item.key === "string") acceptProperty(item.key, item.property, eventName !== "snapshot");
        } catch { /* Ignore malformed upstream events without interrupting the viewer. */ }
      });
    }
    stream.onerror = () => { if (active === generation) streamOpen = false; };
  }
  async function refreshStatus(active) {
    const results = await Promise.allSettled([
      read("/api/gateway/live/health", active), read("/api/engine/health", active),
      read("/api/backend/runtime", active), read("/api/services/health", active)
    ]);
    if (active !== generation) return;
    const [gateway, engine, engineRuntime, services] = results;
    gatewayHealth = gateway.status === "fulfilled" ? gateway.value : null;
    if (gatewayHealth?.status === "UP") {
      const adapters = Object.values(gatewayHealth.adapters || {});
      setStatus("gateway", adapters.some(state => state !== "CONNECTED") ? "degraded" : "online");
      openStream();
    } else { setStatus("gateway", "offline", "Gateway health unavailable"); stream?.close(); stream = null; streamOpen = false; }
    setStatus("engine", engine.status === "fulfilled" && engine.value.status === "UP" ? "online" : "offline", engine.status === "rejected" ? engine.reason.message : "");
    runtime = engineRuntime.status === "fulfilled" ? engineRuntime.value : null;
    setStatus("services", services.status === "fulfilled" && services.value.status === "UP" ? "online" : "offline", services.status === "rejected" ? services.reason.message : "");
    if (status.gateway === "offline" || status.engine === "offline") pathInfo.telemetry.activeUntil = 0;
  }
  async function refreshMetadata(active) {
    const results = await Promise.allSettled([
      read("/api/engine/rules", active, array), read("/api/services/registry", active, array), read("/api/aas/environment", active)
    ]);
    if (active !== generation) return;
    rules = results[0].status === "fulfilled" ? results[0].value : null;
    registry = results[1].status === "fulfilled" ? results[1].value : null;
    if (results[2].status === "fulfilled" && Array.isArray(results[2].value.assetAdministrationShells) && Array.isArray(results[2].value.submodels)) {
      const payload = results[2].value;
      const fingerprint = D.stable(payload);
      if (modelFingerprint !== null && fingerprint !== modelFingerprint) observe("model");
      modelFingerprint = fingerprint;
      setStatus("aas", "online");
      text("aasSummary", `${payload.assetAdministrationShells.length} shells · ${payload.submodels.length} submodels`);
      text("aasDetail", "Repository read successfully");
    } else {
      setStatus("aas", "offline", "Repository models unavailable");
      text("aasSummary", "Backend unavailable"); text("aasDetail", "Retrying automatically");
    }
  }
  async function refreshHistory(active) {
    const results = await Promise.allSettled([
      read("/api/services/history", active, array), read("/api/services/running", active, array)
    ]);
    if (active !== generation) return;
    history = results[0].status === "fulfilled" ? results[0].value : [];
    running = results[1].status === "fulfilled" ? results[1].value : null;
    if (results[0].status === "fulfilled") {
      const changes = D.executionChanges(executions, [...history, ...(running || [])], !executionBaseline);
      executions = changes.next; executionBaseline = true;
      for (const event of changes.activity) observe(event.route, 1, event.label);
    }
  }
  function cancelReads() {
    generation++;
    stream?.close(); stream = null; streamOpen = false;
    controllers.forEach(controller => controller.abort()); controllers.clear(); busy.clear();
  }
  function reset() {
    cancelReads(); clearParticles(); activity.length = 0;
    samples = new Map(); executions = new Map(); executionBaseline = false; modelFingerprint = null;
    registry = rules = runtime = gatewayHealth = null; history = []; running = [];
    lastChecked = null; demoTick = 0;
    nextStatus = nextMetadata = nextHistory = nextSnapshot = 0;
    for (const name of Object.keys(status)) setStatus(name, "checking");
    text("aasSummary", "Checking backend…"); text("aasDetail", "Waiting for models");
  }
  function startPreview() {
    registry = Array.from({ length: 6 }); rules = Array.from({ length: 8 });
    runtime = { state: "RUNNING", telemetryAgeMs: 240, inFlightExecutions: 1 };
    gatewayHealth = { adapters: { "sample-cnc": "CONNECTED", "sample-molder": "CONNECTED" }, storeSize: 18 };
    for (const name of Object.keys(status)) setStatus(name, "online");
    text("aasSummary", "2 shells · 6 submodels"); text("aasDetail", "Sample models · visual demo");
    const now = Date.now();
    for (let i = 59; i >= 1; i--) {
      observe("telemetry", 7 + Math.round(5 * Math.abs(Math.sin(i * 1.37))), "", now - i * 1000, false);
      if (i % 4 === 0) observe("model", 2, "", now - i * 1000, false);
      if (i % 11 === 0) observe("result", 1, "", now - i * 1000, false);
    }
    previewTick();
  }
  function previewTick() {
    demoTick++;
    observe("telemetry", 5, `Temperature ${(72 + Math.sin(demoTick / 4) * 1.7).toFixed(1)} °C`);
    if (demoTick % 2 === 0) observe("model", 2);
    if (demoTick % 6 === 1) { observe("invoke"); observe("result"); observe("command"); observe("sync"); }
    lastChecked = Date.now();
  }
  function render() {
    if (destroyed) return;
    const preview = mode === "preview";
    const online = Object.values(status).filter(value => value === "online" || value === "degraded").length;
    const healthy = Object.values(status).every(value => value === "online");
    const checking = Object.values(status).some(value => value === "checking");
    const live = $("liveState");
    live.dataset.status = paused ? "paused" : preview ? "preview" : online ? "live" : checking ? "checking" : "offline";
    live.querySelector("span").textContent = paused ? "PAUSED" : preview ? "DEMO" : online ? "LIVE" : checking ? "CONNECTING" : "OFFLINE";
    $("sourceNotice").hidden = !preview && /^https?:$/.test(location.protocol);
    if (!preview && !/^https?:$/.test(location.protocol)) text("sourceNotice", "Backend data requires the HTTP application. Choose Visual demo to preview this page locally.");
    else text("sourceNotice", "Visual demo · synthetic activity. No backend requests or device commands.");
    if (gatewayHealth) {
      const adapters = Object.values(gatewayHealth.adapters || {}), connected = adapters.filter(value => value === "CONNECTED").length;
      text("gatewaySummary", `${connected} / ${adapters.length} machines connected`);
      text("gatewayDetail", `${gatewayHealth.storeSize ?? samples.size} live values${status.gateway === "degraded" ? " · source quiet / disconnected" : ""}`);
    } else { text("gatewaySummary", status.gateway === "checking" ? "Checking backend…" : "Backend unavailable"); text("gatewayDetail", "Retrying automatically"); }
    const state = runtime?.state || (status.engine === "offline" ? "OFFLINE" : "CHECKING");
    text("engineState", state); $("engineState").dataset.state = state;
    text("engineSummary", rules ? `${rules.length} rules loaded` : "Rules unavailable");
    const age = runtime?.telemetryAgeMs;
    text("engineDetail", Number.isFinite(age) && age >= 0 ? `Telemetry age ${(age / 1000).toFixed(1)}s` : "No telemetry observed");
    text("servicesSummary", registry ? `${registry.length} registered · ${preview ? 1 : running ? running.length : "—"} active` : status.services === "checking" ? "Checking backend…" : "Registry unavailable");
    const latest = history.find(item => Number.isFinite(item.executionDurationMs));
    text("servicesDetail", preview ? "Sample execution · 12 ms" : latest ? `Last execution · ${latest.executionDurationMs} ms` : "No completed execution observed");
    const summary = $("connectionSummary");
    summary.dataset.status = healthy ? "online" : online ? "degraded" : checking ? "checking" : "offline";
    summary.querySelector("span").textContent = preview ? "Visual demo · sample data" : paused ? "View paused · backend unchanged" : healthy ? "All components connected" : checking ? "Checking backend components…" : online ? `${online} / 4 components reachable · retrying unavailable components` : "Backend components unavailable · retrying automatically";
    text("flowHint", paused ? "Visualization paused · backend unchanged" : preview ? "Synthetic activity for design preview" : streamOpen ? "Gateway event stream + backend observations" : "Read-only backend observations");
    text("checkedAt", lastChecked ? `${preview ? "Demo time" : "Last checked"} ${new Date(lastChecked).toLocaleTimeString()}` : "Not checked yet");
    drawChart();
  }
  function drawChart() {
    const canvas = $("activityChart"), bounds = canvas.getBoundingClientRect(), ratio = Math.min(devicePixelRatio || 1, 2);
    if (!bounds.width || !bounds.height) return;
    const width = Math.round(bounds.width * ratio), height = Math.round(bounds.height * ratio);
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0); ctx.clearRect(0, 0, bounds.width, bounds.height);
    const windowSeconds = Number($("timeWindow").value);
    const bins = D.activityBins(activity, paused ? frozenAt : Date.now(), windowSeconds);
    const maximum = Math.max(5, ...bins.map(bin => bin.total));
    const top = Math.ceil(maximum / 5) * 5, left = 34, chartWidth = bounds.width - left - 4, chartHeight = bounds.height - 8;
    ctx.font = '10px "Segoe UI", sans-serif'; ctx.fillStyle = "#7e95b3"; ctx.textAlign = "right";
    for (let i = 0; i <= 2; i++) {
      const y = 3 + chartHeight * i / 2;
      ctx.fillText(String(Math.round(top * (1 - i / 2))), left - 10, y + 3);
      ctx.beginPath(); ctx.strokeStyle = "#e4edf7"; ctx.setLineDash([3, 3]); ctx.moveTo(left, y); ctx.lineTo(bounds.width, y); ctx.stroke();
    }
    ctx.setLineDash([]);
    const step = chartWidth / bins.length;
    for (let index = 0; index < bins.length; index++) {
      let y = 3 + chartHeight;
      for (const [route, value] of Object.entries(bins[index].values)) {
        const h = value / top * chartHeight;
        ctx.fillStyle = D.routes[route]; ctx.fillRect(left + index * step + 1, y - h, Math.max(1, step - 2), h); y -= h;
      }
    }
    ctx.beginPath(); ctx.strokeStyle = "#243653"; ctx.lineWidth = 1.5; ctx.moveTo(bounds.width - 2, 0); ctx.lineTo(bounds.width - 2, bounds.height); ctx.stroke();
    const total = bins.reduce((sum, bin) => sum + bin.total, 0);
    $("emptyChart").hidden = total > 0;
    text("emptyChart", mode === "preview" ? "" : "No observed activity in this window");
    text("activityCount", `${total} ${mode === "preview" ? "sample" : "observed"} updates`);
    text("activityUnit", `${mode === "preview" ? "Sample" : "Observed"} updates per ${windowSeconds === 1 ? "second" : windowSeconds + "s"}`);
  }
  function tick() {
    if (destroyed || paused) return;
    if (mode === "preview") { previewTick(); render(); return; }
    if (!/^https?:$/.test(location.protocol)) { for (const name of Object.keys(status)) setStatus(name, "offline"); render(); return; }
    const now = Date.now();
    if (now >= nextStatus) { nextStatus = now + 5000; void task("status", refreshStatus); }
    if (now >= nextMetadata) { nextMetadata = now + 15000; void task("metadata", refreshMetadata); }
    if (now >= nextHistory) { nextHistory = now + 3000; void task("history", refreshHistory); }
    if (!streamOpen && now >= nextSnapshot) { nextSnapshot = now + 5000; void task("snapshot", snapshot); }
    drawChart();
  }
  function animate(now) {
    if (destroyed) return;
    const elapsed = lastFrame ? Math.min(now - lastFrame, 80) : 0;
    lastFrame = now;
    if (!paused) {
      for (let i = particles.length - 1; i >= 0; i--) {
        const item = particles[i]; item.progress += elapsed / 1900;
        if (item.progress > 1) { item.element.remove(); particles.splice(i, 1); continue; }
        if (item.progress < 0) continue;
        const info = pathInfo[item.route], point = info.path.getPointAtLength(info.length * item.progress);
        item.element.setAttribute("cx", point.x.toFixed(2)); item.element.setAttribute("cy", point.y.toFixed(2)); item.element.setAttribute("visibility", "visible");
      }
      for (const info of Object.values(pathInfo)) info.path.classList.toggle("is-active", info.activeUntil > now);
      if (lastPacketAt && now - lastPacketAt > 3000) $("packetLabel").setAttribute("visibility", "hidden");
    }
    frameId = requestAnimationFrame(animate);
  }
  $("dataSource").addEventListener("change", () => {
    mode = $("dataSource").value; reset();
    if (mode === "preview") startPreview();
    if (paused) frozenAt = Date.now();
    render(); if (!paused) tick();
  });
  $("pause").addEventListener("click", () => {
    paused = !paused; $("pause").setAttribute("aria-pressed", String(paused)); $("pause").querySelector("span").textContent = paused ? "Resume" : "Pause";
    $("diagram").dataset.paused = String(paused);
    $("pause").querySelector("path").setAttribute("d", paused ? "m6 4 9 6-9 6z" : "M6 4v12M14 4v12");
    if (paused) { animationPausedAt = performance.now(); frozenAt = Date.now(); cancelReads(); }
    else {
      const pauseDuration = performance.now() - animationPausedAt;
      for (const info of Object.values(pathInfo)) if (info.activeUntil > animationPausedAt) info.activeUntil += pauseDuration;
      if (lastPacketAt) lastPacketAt += pauseDuration;
      nextStatus = nextMetadata = nextHistory = nextSnapshot = 0; tick();
    }
    render();
  });
  $("timeWindow").addEventListener("change", drawChart);
  $("fitView").addEventListener("click", () => {
    const fit = $("diagramViewport").classList.toggle("is-fitted");
    $("fitView").setAttribute("aria-pressed", String(fit));
    $("fitView").setAttribute("aria-label", fit ? "Use readable diagram size" : "Fit diagram to view");
    $("diagramViewport").scrollLeft = 0;
  });
  const resize = new ResizeObserver(drawChart); resize.observe($("activityChart"));
  const timer = setInterval(tick, 1000);
  window.addEventListener("pagehide", () => { destroyed = true; cancelReads(); clearInterval(timer); cancelAnimationFrame(frameId); resize.disconnect(); }, { once: true });
  // Browser back/forward cache restores the document after pagehide.
  window.addEventListener("pageshow", event => { if (event.persisted) location.reload(); });
  if (new URLSearchParams(location.search).get("source") === "preview") { mode = "preview"; $("dataSource").value = mode; startPreview(); }
  render(); tick(); frameId = requestAnimationFrame(animate);
})();
