// Generic address-space explorer for Gateway plugins: one tree UI for every protocol.
// The controller (/api/stack/explore) delivers the tree: MQTT topics split at "/" and kept live,
// OPC UA nodes below the Objects folder. Leaves (nodes with an address) can be picked as signals.
(function (root) {
  "use strict";
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const ago = seconds => seconds < 2 ? "now" : seconds < 60 ? Math.round(seconds) + " s ago" : seconds < 3600 ? Math.round(seconds / 60) + " min ago" : "earlier";

  async function call(path, method = "GET", body) {
    const response = await fetch(path, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    const payload = (response.headers.get("content-type") || "").includes("application/json") ? await response.json() : await response.text();
    if (!response.ok) throw new Error(typeof payload?.detail === "string" ? payload.detail : payload?.detail?.message || String(payload));
    return payload;
  }

  function open({ protocol, payload, title, tracked = new Set(), onAdd }) {
    const modal = document.querySelector("#modalBackdrop .modal");
    let sid = null, snapshot = null, timer = null, closed = false, first = true;
    const expanded = new Set(), selected = new Map(), leaves = new Map();

    modalTitle.textContent = title || "Explore Address Space";
    modalCancel.style.display = "";
    modalSubmit.className = "btn primary";
    modal.classList.add("stack-wide");
    modalBody.innerHTML = `
      <div class="explorer-status" id="explorerStatus"><span class="explorer-dot"></span><span>Connecting to ${esc(payload.endpoint)} …</span></div>
      <div class="explorer-toolbar">
        <input id="explorerSearch" placeholder="Filter by name or address" autocomplete="off" aria-label="Filter the address space" />
        <button type="button" class="btn ghost" id="explorerExpand">Expand all</button>
        <button type="button" class="btn ghost" id="explorerCollapse">Collapse all</button>
        <button type="button" class="btn ghost" id="explorerRefresh">${protocol === "MQTT" ? "Restart listening" : "Browse again"}</button>
      </div>
      <div class="explorer-tree" id="explorerTree" role="tree"><div class="empty-note">Waiting for the first answer …</div></div>
      <p class="small" id="explorerHint">${protocol === "MQTT" ? "The explorer stays subscribed and adds topics as messages arrive (retained topics appear at once). Pick topics to add them as Signal Mappings." : "Variables below the Objects folder. Pick nodes to add them as Signal Mappings."}</p>`;
    const tree = document.getElementById("explorerTree"), search = document.getElementById("explorerSearch"), status = document.getElementById("explorerStatus");

    const updateSubmit = () => { modalSubmit.textContent = selected.size ? `Add ${selected.size} signal${selected.size === 1 ? "" : "s"}` : "Add selected"; };
    const query = () => search.value.trim().toLowerCase();
    const matches = (node, q) => !q || `${node.name} ${node.address || ""}`.toLowerCase().includes(q);
    const visible = (node, q) => matches(node, q) || (node.children || []).some(child => visible(child, q));
    const leafIds = node => [...(node.address ? [node.id] : []), ...(node.children || []).flatMap(leafIds)];

    function index(nodes) { for (const node of nodes) { if (node.address) leaves.set(node.id, node); index(node.children || []); } }

    function rows(nodes, depth, q) {
      return nodes.filter(node => visible(node, q)).map(node => {
        const kids = node.children || [], open = q ? true : expanded.has(node.id), leaf = Boolean(node.address);
        const isTracked = leaf && tracked.has(node.address), picked = leaf && (selected.has(node.id) || isTracked);
        const pickable = leafIds(node).filter(id => !tracked.has(leaves.get(id)?.address));
        const age = node.updatedAt && snapshot ? ago(snapshot.updatedAt - node.updatedAt) : "";
        return `<li role="treeitem" aria-expanded="${kids.length ? open : ""}">
          <div class="tree-row${leaf ? " leaf" : ""}" style="--depth:${depth}">
            ${kids.length ? `<button type="button" class="tree-toggle" data-tree-toggle="${esc(node.id)}" aria-label="${open ? "Collapse" : "Expand"} ${esc(node.name)}">${open ? "▾" : "▸"}</button>` : '<span class="tree-toggle"></span>'}
            ${leaf ? `<input type="checkbox" data-tree-pick="${esc(node.id)}" ${picked ? "checked" : ""} ${isTracked ? "disabled title=\"Already mapped\"" : ""} aria-label="Pick ${esc(node.name)}" />` : '<span class="tree-check"></span>'}
            <span class="tree-name">${esc(node.name)}${kids.length && !leaf ? ` <span class="small">(${leafIds(node).length})</span>` : ""}</span>
            ${leaf ? `<span class="tree-address small">${esc(node.address)}</span><span class="badge draft">${esc(node.valueType || "")}</span><span class="tree-value">${esc(node.value ?? "")}</span><span class="small">${esc(age)}${node.writable === true ? " · writable" : ""}${isTracked ? " · mapped" : ""}</span>` : ""}
            ${kids.length && pickable.length ? `<button type="button" class="link-btn" data-tree-all="${esc(node.id)}">Select all</button>` : ""}
          </div>
          ${kids.length && open ? `<ul role="group">${rows(kids, depth + 1, q)}</ul>` : ""}
        </li>`;
      }).join("");
    }

    function render() {
      if (!snapshot) return;
      leaves.clear(); index(snapshot.tree || []);
      if (first && snapshot.tree?.length) { first = false; const expand = (nodes, depth) => nodes.forEach(node => { if (depth < 2) { expanded.add(node.id); expand(node.children || [], depth + 1); } }); expand(snapshot.tree, 0); }
      const live = snapshot.live && ["listening", "connecting"].includes(snapshot.state);
      const stateText = snapshot.error ? snapshot.error
        : protocol === "MQTT" ? `${snapshot.state === "listening" ? "Listening" : snapshot.state} · ${payload.endpoint} · ${payload.topicFilter || "#"} · ${snapshot.count} topic${snapshot.count === 1 ? "" : "s"} · updated ${new Date(snapshot.updatedAt * 1000).toLocaleTimeString()}`
        : snapshot.state === "done" ? `${payload.endpoint} · ${snapshot.message}` : `Browsing ${payload.endpoint} … ${snapshot.count} variables so far`;
      status.className = "explorer-status " + (snapshot.error ? "error" : live ? "live" : snapshot.state === "done" ? "done" : "busy");
      status.innerHTML = `<span class="explorer-dot"></span><span>${esc(stateText)}</span>`;
      const scroll = tree.scrollTop;
      tree.innerHTML = snapshot.tree?.length ? `<ul role="group">${rows(snapshot.tree, 0, query())}</ul>` : `<div class="empty-note">${snapshot.error ? "Nothing to show." : protocol === "MQTT" ? "No messages yet – is a publisher running? Retained topics appear at once." : "No variables found yet."}</div>`;
      tree.scrollTop = scroll;
      updateSubmit();
    }

    async function poll() {
      if (closed || !sid) return;
      try { snapshot = await call("/api/stack/explore/" + encodeURIComponent(sid)); render(); }
      catch (error) { status.className = "explorer-status error"; status.innerHTML = `<span class="explorer-dot"></span><span>${esc(error.message)}</span>`; clearInterval(timer); timer = null; return; }
      const finished = !snapshot.live && ["done", "failed"].includes(snapshot.state);
      if (finished || snapshot.state === "failed") { clearInterval(timer); timer = null; }
    }

    async function start() {
      clearInterval(timer); timer = null;
      if (sid) { call("/api/stack/explore/" + encodeURIComponent(sid), "DELETE").catch(() => {}); sid = null; }
      try {
        const session = await call("/api/stack/explore", "POST", { ...payload, protocol });
        if (closed) { call("/api/stack/explore/" + encodeURIComponent(session.id), "DELETE").catch(() => {}); return; }
        sid = session.id; await poll(); if (!timer && !(snapshot && !snapshot.live && ["done", "failed"].includes(snapshot.state))) timer = setInterval(poll, 1500);
      } catch (error) {
        status.className = "explorer-status error"; status.innerHTML = `<span class="explorer-dot"></span><span>${esc(error.message)}</span>`;
        tree.innerHTML = '<div class="empty-note">Check the endpoint, credentials and that the plugin\'s machine is reachable.</div>';
      }
    }

    function stop() {
      if (closed) return; closed = true; clearInterval(timer);
      if (sid) call("/api/stack/explore/" + encodeURIComponent(sid), "DELETE").catch(() => {});
      observer.disconnect();
    }
    const observer = new MutationObserver(() => { if (!modalBackdrop.classList.contains("open")) stop(); });
    observer.observe(modalBackdrop, { attributes: true, attributeFilter: ["class"] });

    tree.addEventListener("click", event => {
      const toggle = event.target.closest("[data-tree-toggle]"), all = event.target.closest("[data-tree-all]");
      if (toggle) { const id = toggle.dataset.treeToggle; expanded.has(id) ? expanded.delete(id) : expanded.add(id); render(); }
      if (all) {
        const find = nodes => { for (const node of nodes) { if (node.id === all.dataset.treeAll) return node; const hit = find(node.children || []); if (hit) return hit; } return null; };
        const node = find(snapshot?.tree || []);
        for (const id of node ? leafIds(node) : []) { const leaf = leaves.get(id); if (leaf && !tracked.has(leaf.address)) selected.set(id, leaf); }
        render();
      }
    });
    tree.addEventListener("change", event => {
      const id = event.target.dataset.treePick; if (!id) return;
      if (event.target.checked) selected.set(id, leaves.get(id)); else selected.delete(id);
      updateSubmit();
    });
    search.addEventListener("input", render);
    document.getElementById("explorerExpand").addEventListener("click", () => { const all = nodes => nodes.forEach(n => { if ((n.children || []).length) { expanded.add(n.id); all(n.children); } }); all(snapshot?.tree || []); render(); });
    document.getElementById("explorerCollapse").addEventListener("click", () => { expanded.clear(); render(); });
    document.getElementById("explorerRefresh").addEventListener("click", () => { snapshot = null; first = true; tree.innerHTML = '<div class="empty-note">Connecting …</div>'; start(); });

    modalSubmitHandler = () => {
      const picked = [...selected.values()].filter(Boolean);
      if (!picked.length) { root.showToast?.("Pick at least one signal, or Cancel."); return; }
      onAdd(picked); stop(); closeModal();
    };
    updateSubmit();
    modalBackdrop.classList.add("open"); modalBackdrop.setAttribute("aria-hidden", "false");
    search.focus();
    start();
  }

  root.GucExplorer = { open };
})(window);
