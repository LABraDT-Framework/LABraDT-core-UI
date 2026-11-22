// Classic script: function definitions only; shared state is initialized in app/state.js.

function showToast(text) {
  toast.textContent = text;
  toast.classList.add("show");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("show"), 1700);
}

function badge(status) {
  const cls = status === "Draft" ? "badge draft" : status === "Warning" ? "badge warning" : "badge";
  return `<span class="${cls}">${status}</span>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function fieldHtml(field, value) {
  const id = `modal-${field.name}`;
  const safeValue = escapeHtml(value ?? "");
  if (field.type === "file") {
    return `<label class="field ${field.full ? "full" : ""}" for="${id}">${field.label}<input id="${id}" name="${field.name}" type="file" accept="${escapeHtml(field.accept || '')}" /></label>`;
  }
  if (field.type === "select") {
    return `
      <label class="field ${field.full ? "full" : ""}" for="${id}">${field.label}
        <select id="${id}" name="${field.name}">
          ${field.options.map(option => { const optionValue = typeof option === "object" ? option.value : option, optionLabel = typeof option === "object" ? option.label : option; return `<option value="${escapeHtml(optionValue)}" ${optionValue === value ? "selected" : ""}>${escapeHtml(optionLabel)}</option>`; }).join("")}
        </select>
      </label>
    `;
  }
  if (field.type === "textarea") {
    return `
      <label class="field ${field.full ? "full" : ""}" for="${id}">${field.label}
        <textarea id="${id}" name="${field.name}" rows="${field.rows || 4}">${safeValue}</textarea>
      </label>
    `;
  }
  return `
    <label class="field ${field.full ? "full" : ""}" for="${id}">${field.label}
      <input id="${id}" name="${field.name}" type="${escapeHtml(field.type || 'text')}" value="${safeValue}" placeholder="${escapeHtml(field.placeholder || '')}" autocomplete="${escapeHtml(field.autocomplete || 'off')}" />
      ${field.hint ? `<span class="small">${escapeHtml(field.hint)}</span>` : ''}
    </label>
  `;
}

function showModalError(error, fallback) {
  const message = error.message || fallback;
  let notice = modalBody.querySelector("#modalError");
  if (!notice) {
    notice = document.createElement("p");
    notice.id = "modalError";
    notice.setAttribute("role", "alert");
    notice.style.cssText = "color:var(--danger);border:1px solid var(--danger);border-radius:8px;padding:12px;margin:16px 0 0;overflow-wrap:anywhere";
    modalBody.appendChild(notice);
  }
  notice.textContent = message;
  showToast(message);
}

function openFormModal({ title, fields, initial = {}, submitLabel = "Save", onSubmit }) {
  modalCancel.style.display = "";
  modalTitle.textContent = title;
  modalSubmit.textContent = submitLabel;
  modalSubmit.className = "btn primary";
  modalBody.innerHTML = `<div class="form-grid">${fields.map(field => fieldHtml(field, initial[field.name])).join("")}</div>`;
  modalSubmitHandler = async () => {
    modalBody.querySelector("#modalError")?.remove();
    const data = {};
    new FormData(modalForm).forEach((value, key) => data[key] = String(value));
    modalSubmit.disabled = true;
    try {
      const accepted = await onSubmit(data);
      if (accepted !== false) closeModal();
    } catch (error) { showModalError(error, "Save failed."); }
    finally { modalSubmit.disabled = false; }
  };
  modalBackdrop.classList.add("open");
  modalBackdrop.setAttribute("aria-hidden", "false");
  const firstInput = modalBody.querySelector("input, select, textarea");
  if (firstInput) firstInput.focus();
}

function openConfirmModal({ title, message, submitLabel = "Delete", onSubmit }) {
  modalCancel.style.display = "";
  modalTitle.textContent = title;
  modalSubmit.textContent = submitLabel;
  modalSubmit.className = "btn fill-danger";
  modalBody.innerHTML = `<div class="modal-message">${message}</div>`;
  modalSubmitHandler = async () => {
    modalBody.querySelector("#modalError")?.remove();
    modalSubmit.disabled = true;
    try { if (await onSubmit() !== false) closeModal(); }
    catch (error) { showModalError(error, "Delete failed."); }
    finally { modalSubmit.disabled = false; }
  };
  modalBackdrop.classList.add("open");
  modalBackdrop.setAttribute("aria-hidden", "false");
}

function closeModal() {
  modalBackdrop.classList.remove("open");
  modalBackdrop.setAttribute("aria-hidden", "true");
  modalSubmitHandler = null;
}

async function apiRequest(path, options = {}) {
  if (!apiBase && location.protocol === "file:") {
    throw new Error("UI controller is offline. Start _UI/app.py to control the real Gateway.");
  }
  const response = await environment.fetch(path, options);
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) {
    const detail = typeof payload?.detail === "string" ? payload.detail : payload?.detail?.message || payload?.detail?.error;
    const message = typeof payload === "string" ? payload : detail || payload.error || payload.message || "Request failed";
    throw new Error(message);
  }
  return payload;
}

function openLinkTreeModal({ title, help, treeHtml, currentId = "", submitLabel = "Save Link", onSubmit }) {
  modalTitle.textContent = title;
  modalCancel.style.display = "";
  modalSubmit.textContent = submitLabel;
  modalSubmit.className = "btn primary";
  modalBody.innerHTML = `<p class="small">${escapeHtml(help)}</p><div class="link-tree"><button type="button" class="link-tree-leaf${currentId ? "" : " selected"}" data-link-tree-value=""><span class="link-tree-leaf-copy"><strong>No link</strong><span class="small">Remove the current one-way link</span></span></button>${treeHtml}</div>`;
  let selectedId = currentId;
  modalBody.addEventListener("click", event => {
    const leaf = event.target.closest("[data-link-tree-value]"); if (!leaf) return;
    selectedId = leaf.dataset.linkTreeValue;
    modalBody.querySelectorAll("[data-link-tree-value]").forEach(item => item.classList.toggle("selected", item === leaf));
  });
  modalSubmitHandler = async () => { const accepted = await onSubmit(selectedId); if (accepted !== false) closeModal(); };
  modalBackdrop.classList.add("open"); modalBackdrop.setAttribute("aria-hidden", "false");
}

function openMultiLinkTreeModal({ title, help, treeHtml, currentIds = [], submitLabel = "Save Links", onSubmit }) {
  modalTitle.textContent = title;
  modalCancel.style.display = "";
  modalSubmit.textContent = submitLabel;
  modalSubmit.className = "btn primary";
  modalBody.innerHTML = `<p class="small">${escapeHtml(help)}</p><div class="link-tree">${treeHtml}</div>`;
  const selected = new Set(currentIds);
  modalBody.addEventListener("change", event => {
    const input = event.target.closest("[data-link-tree-multi-value]"); if (!input) return;
    if (input.checked) selected.add(input.dataset.linkTreeMultiValue); else selected.delete(input.dataset.linkTreeMultiValue);
    input.closest(".link-tree-leaf")?.classList.toggle("selected", input.checked);
    const badge = input.closest(".link-tree-leaf")?.querySelector(".badge");
    if (input.checked && !badge) input.closest(".link-tree-leaf")?.insertAdjacentHTML("beforeend", '<span class="badge">Selected</span>');
    if (!input.checked) badge?.remove();
    modalSubmit.textContent = selected.size ? `Save ${selected.size} link${selected.size === 1 ? "" : "s"}` : "Remove all links";
  });
  modalSubmit.textContent = selected.size ? `Save ${selected.size} link${selected.size === 1 ? "" : "s"}` : "Remove all links";
  modalSubmitHandler = async () => { const accepted = await onSubmit([...selected]); if (accepted !== false) closeModal(); };
  modalBackdrop.classList.add("open"); modalBackdrop.setAttribute("aria-hidden", "false");
}

function downloadJson(filename, value) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 0);
}

function validateRequiredId(value, label) {
  if (!String(value || "").trim()) { showToast(`${label} is required.`); return false; }
  return true;
}
