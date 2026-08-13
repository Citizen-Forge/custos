// -- Fallback sets -------------------------------------------------------
//
// Named provider chains the Project Manager assigns to roles. This panel
// combines the live health table (what a request would actually dispatch
// to right now) with the add/edit form -- Edit scrolls into the same form
// rather than opening a separate panel.

import { el } from "../dom.js";
import { api, showToast } from "../api.js";
import { state, reloadAfter, notifyStateChanged } from "../state.js";

/** Known provider keys (anthropic + configured providers) */
function listProviderKeys() {
  return ['anthropic', ...Object.keys(state.providers || {})];
}

/** Model names for a given provider key. */
function modelsForProvider(providerKey) {
  if (providerKey === 'anthropic') {
    return ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'];
  }
  const prov = state.providers?.[providerKey];
  if (!prov || !prov.models) return [];
  return prov.models.map(m => m.name);
}

/** Build a provider select element. */
function buildProviderSelect(selected, onchange) {
  const sel = el('select', { onchange });
  sel.appendChild(el('option', { value: '', text: '(choose provider)', disabled: true, selected: !selected ? 'selected' : undefined }));
  for (const key of listProviderKeys()) {
    const opt = el('option', { value: key, text: key });
    if (key === selected) opt.setAttribute('selected', 'selected');
    sel.appendChild(opt);
  }
  return sel;
}

/** Build a model select element for a given provider. */
function buildModelSelect(providerKey, selected) {
  const sel = el('select');
  const models = modelsForProvider(providerKey);
  if (!models.length) {
    sel.appendChild(el('option', { value: '', text: '(no models)', disabled: true }));
  } else {
    sel.appendChild(el('option', { value: '', text: '(choose model)', disabled: true, selected: !selected ? 'selected' : undefined }));
    for (const name of models) {
      const opt = el('option', { value: name, text: name });
      if (name === selected) opt.setAttribute('selected', 'selected');
      sel.appendChild(opt);
    }
  }
  return sel;
}

/** Create a single provider entry row (drag handle + provider select +
 *  model select + remove button). Returns the row element and a getter
 *  for reading its current { provider, model } value. */
function createProviderEntryRow(initialProvider, initialModel, onRemove, onMoveUp, onMoveDown, index) {
  const row = el('div', {
    draggable: 'true',
    style: 'display: flex; align-items: center; gap: 6px; margin-bottom: 6px; padding: 6px 8px; background: var(--bg); border: 1px solid var(--border); border-radius: 6px;',
    class: 'fs-entry-row',
  });

  // Drag handle
  const handle = el('span', {
    style: 'cursor: grab; color: var(--muted); font-size: 16px; line-height: 1; user-select: none; flex-shrink: 0;',
    text: '⠿',
    title: 'Drag to reorder',
  });
  row.appendChild(handle);

  // Drag events
  row.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', '');
    row.classList.add('dragging');
    row.style.opacity = '0.5';
  });
  row.addEventListener('dragend', () => {
    row.classList.remove('dragging');
    row.style.opacity = '';
  });
  row.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const container = row.parentElement;
    if (!container) return;
    const dragEl = container.querySelector('.dragging');
    if (!dragEl || dragEl === row) return;
    const rect = row.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    if (e.clientY < midY) {
      container.insertBefore(dragEl, row);
    } else {
      container.insertBefore(dragEl, row.nextSibling);
    }
  });
  row.addEventListener('drop', (e) => {
    e.preventDefault();
    // Re-index all rows after the drop.
    const container = row.parentElement;
    if (container) reindexRows(container);
  });

  // Provider select
  const providerSelect = buildProviderSelect(initialProvider, () => {
    // Rebuild model select when provider changes.
    const newProvider = providerSelect.value;
    const newModelSelect = buildModelSelect(newProvider, '');
    modelSelect.parentNode.replaceChild(newModelSelect, modelSelect);
    modelSelect = newModelSelect;
  });
  providerSelect.style.flex = '0 0 140px';
  row.appendChild(providerSelect);

  // Model select
  let modelSelect = buildModelSelect(initialProvider || 'anthropic', initialModel);
  modelSelect.style.flex = '0 0 180px';
  row.appendChild(modelSelect);

  // Up button
  const upBtn = el('button', {
    style: 'font-size: 11px; padding: 2px 6px; line-height: 1;',
    text: '▲',
    title: 'Move up',
    onclick: () => onMoveUp?.(row),
  });
  row.appendChild(upBtn);

  // Down button
  const downBtn = el('button', {
    style: 'font-size: 11px; padding: 2px 6px; line-height: 1;',
    text: '▼',
    title: 'Move down',
    onclick: () => onMoveDown?.(row),
  });
  row.appendChild(downBtn);

  // Remove button
  const removeBtn = el('button', {
    style: 'font-size: 14px; padding: 2px 8px; line-height: 1; color: var(--danger);',
    text: '×',
    title: 'Remove this provider',
    onclick: () => onRemove?.(row),
  });
  row.appendChild(removeBtn);

  // Getter for current values
  row._getValue = () => ({
    provider: providerSelect.value,
    model: modelSelect.value,
  });

  return row;
}

/** Re-index all entry rows in a container (updates move up/down button
 *  visibility). */
function reindexRows(container) {
  const rows = container.querySelectorAll('.fs-entry-row');
  rows.forEach((row, i) => {
    const btns = row.querySelectorAll('button');
    // Up button visibility
    if (btns.length >= 3) {
      btns[0].style.visibility = i === 0 ? 'hidden' : '';
      btns[1].style.visibility = i === rows.length - 1 ? 'hidden' : '';
    }
  });
}

// Maps the runtime's per-entry `status` enum onto a colored badge with
// a hover-tooltip containing the specifics. Pulled out so the same
// vocabulary (color + suffix text) is used everywhere the chain is
// rendered -- not just the panel below, but any future surface
// (the agent card, the activity log, etc.) that wants to show
// "why isn't this entry being used".
function renderEntryStatusBadge(entry) {
  // Requests are spaced evenly (60s / rpmLimit apart), not drawn from a
  // bursty token bucket -- see provider-state.ts. rpmReadyAt is the ms
  // epoch of the next admissible request.
  const rpmSuffix = entry.rpmLimit
    ? ` · RPM: ${entry.rpmReadyAt && entry.rpmReadyAt > Date.now() ? `ready in ${Math.ceil((entry.rpmReadyAt - Date.now()) / 1000)}s` : "ready"} (limit ${entry.rpmLimit}/min)`
    : "";
  const labels = {
    available: { text: "available", cls: "ok", title: `Active: ${entry.active}${entry.maxConcurrent > 0 ? `/${entry.maxConcurrent}` : ""}${entry.queued > 0 ? ` (queued: ${entry.queued})` : ""}${rpmSuffix}` },
    cooldown: { text: "cooldown", cls: "warn", title: entry.coolingUntil ? `Cooling until ${new Date(entry.coolingUntil).toISOString()}` : "Cooldown active" },
    "circuit-broken": { text: "breaker", cls: "warn", title: entry.breakerUntil ? `Circuit-broken until ${new Date(entry.breakerUntil).toISOString()}` : "Circuit breaker open" },
    "at-capacity": { text: "at-capacity", cls: "warn", title: `Active: ${entry.active}/${entry.maxConcurrent}${entry.queued > 0 ? ` · queued: ${entry.queued}` : ""}` },
    "rpm-exhausted": { text: "rpm-spacing", cls: "warn", title: `Waiting for the next RPM slot (limit ${entry.rpmLimit}/min, requests spaced ${Math.round(60 / entry.rpmLimit)}s apart)${entry.rpmReadyAt ? ` -- ready in ${Math.ceil((entry.rpmReadyAt - Date.now()) / 1000)}s` : ""}.` },
    unregistered: { text: "missing", cls: "off", title: "Provider not registered — config drift, the named provider may have been removed." },
  };
  const def = labels[entry.status] || { text: entry.status, cls: "off", title: "" };
  const badge = el("span", {
    class: `badge ${def.cls}`,
    style: "font-size: 10.5px; padding: 2px 7px;",
    text: `${entry.provider}/${entry.model}`,
    title: `${def.text} — ${def.title}`,
  });
  return badge;
}

// Builds the health table + refresh button that used to live in its own
// "Fallback set health" panel, now embedded at the top of the combined
// Fallback sets panel (renderFallbackSetsPanel below) so an operator sees
// live chain status first and only reaches for the edit form when they
// actually need to change something.
function renderFallbackSetHealthSection(section) {
  section.appendChild(el("p", { class: "desc", text: "For each configured fallback set, the first available provider is the \"live pick\" — what an incoming request would dispatch to. A chain with no available entry is exhausted; requests pile up in the queue until a provider recovers." }));

  const health = state.fallbackSetHealth || {};
  const setNames = Object.keys(health);

  const refreshBtn = el("button", {
    style: "font-size: 11px; padding: 3px 8px;",
    text: "Refresh",
    onclick: async () => {
      refreshBtn.disabled = true;
      const original = refreshBtn.textContent;
      refreshBtn.textContent = "↻";
      try {
        const stats = await api("/admin/api/runtime/stats");
        state.fallbackSetHealth = stats.fallbackSets || {};
        state.fallbackSetHealthError = null;
        notifyStateChanged();
      } catch (err) {
        // Mirror the boot path's contract: a failed refresh has to
        // surface in the panel, not just in a toast that disappears
        // after 3s. Otherwise a successful boot with N sets followed
        // by a 5xx refresh leaves the panel rendering the stale
        // healthy table (setNames.length > 0, so the empty-branch
        // warning never shows) — the operator sees stale data with
        // no indication the fetch failed. Clearing both fields
        // together matches what `loadState()` does on boot failure.
        state.fallbackSetHealth = {};
        state.fallbackSetHealthError = err.message || "stats endpoint unreachable";
        notifyStateChanged();
        showToast(err.message, true);
      } finally {
        refreshBtn.disabled = false;
        refreshBtn.textContent = original;
      }
    },
  });
  const header = el("div", { class: "row", style: "margin-bottom: 12px;" });
  header.appendChild(el("span", { class: "small", text: `${setNames.length} fallback set(s) configured.` }));
  header.appendChild(refreshBtn);
  section.appendChild(header);

  if (!setNames.length) {
    // Two distinct empty cases: "stats endpoint unreachable" vs
    // "no fallback sets configured". The former means an operator
    // would otherwise conclude the chain is healthy when the panel
    // is actually blind -- surface the failure explicitly so the
    // operator knows to click Refresh or check the server logs.
    if (state.fallbackSetHealthError) {
      const warn = el("div", {
        style: "padding: 10px 12px; border: 1px solid var(--danger); border-radius: 6px; background: rgba(217,112,91,0.08); margin-bottom: 12px;",
      });
      warn.appendChild(el("strong", { style: "color: var(--danger);", text: "Stats unavailable" }));
      warn.appendChild(el("div", { class: "small", style: "margin-top: 4px;", text: state.fallbackSetHealthError }));
      warn.appendChild(el("div", { class: "small", style: "margin-top: 4px;", text: "Click Refresh to retry. The panel is currently blind to chain health." }));
      section.appendChild(warn);
    } else {
      section.appendChild(el("p", { class: "small", text: "No fallback sets configured. Add one below." }));
    }
    return;
  }

  // Stable display order: alphabetical by name so operators can scan
  // a long list quickly.
  setNames.sort();
  const table = el("table", { style: "width: 100%; border-collapse: collapse; margin-bottom: 12px;" });
  table.appendChild(el("colgroup", {}, [
    el("col", { style: "width: 16%;" }),
    el("col", { style: "width: 26%;" }),
    el("col", { style: "width: 14%;" }),
    el("col", { style: "width: 30%;" }),
    el("col", { style: "width: 14%;" }),
  ]));
  table.appendChild(el("tr", {}, [
    el("th", { text: "Set" }),
    el("th", { text: "Live pick" }),
    el("th", { text: "Chain length" }),
    el("th", { text: "Chain status" }),
    el("th", { text: "Actions" }),
  ]));

  for (const name of setNames) {
    const set = health[name];
    const livePick = set.livePick;
    const livePickCell = livePick
      ? el("td", {}, [
          el("strong", { text: `${livePick.provider}/${livePick.model}` }),
          el("br"),
          el("span", { class: "small", text: `entry [${livePick.index}] — would dispatch here` }),
        ])
      : el("td", {}, [
          el("span", { class: "badge warn", text: "EXHAUSTED" }),
          el("br"),
          el("span", { class: "small", text: set.chainLength === 0 ? "set is empty — no chain to walk" : "all entries currently unavailable" }),
        ]);
    const chainCell = el("td", {});
    if (set.entries.length === 0) {
      chainCell.appendChild(el("span", { class: "small", text: "—" }));
    } else {
      const row = el("div", { style: "display: flex; flex-wrap: wrap; gap: 4px; align-items: center;" });
      set.entries.forEach((entry, idx) => {
        const isLivePick = livePick && idx === livePick.index;
        const badge = renderEntryStatusBadge(entry);
        if (isLivePick) badge.style.boxShadow = "0 0 0 2px var(--accent)";
        row.appendChild(badge);
      });
      chainCell.appendChild(row);
    }
    const rawSet = (state.fallbackSets || {})[name];
    table.appendChild(el("tr", {}, [
      el("td", {}, [
        el("strong", { text: name }),
        el("br"),
        el("span", { class: "small", text: set.description }),
      ]),
      livePickCell,
      el("td", { class: set.exhausted ? "muted" : "", text: String(set.chainLength) }),
      chainCell,
      el("td", { class: "actions-cell" }, [
        el("button", { class: "row-btn", text: "Edit", onclick: () => enterFallbackSetEditRow(name, rawSet || { description: set.description, providers: set.entries.map((e) => ({ provider: e.provider, model: e.model })) }) }),
        el("button", { class: "row-btn danger", text: "Delete", onclick: () => reloadAfter(
          api(`/admin/api/fallback-sets/${encodeURIComponent(name)}`, { method: "DELETE" }), `Removed "${name}"`
        )}),
      ]),
    ]));
  }
  section.appendChild(table);
  section.appendChild(el("p", { class: "small", style: "margin-top: 4px;", text: "Bordered entry = current live pick. Hover an entry for the full status detail." }));
}

export function renderFallbackSetsPanel() {
  const section = el("section", { class: "panel" });
  section.appendChild(el("h2", { text: "Fallback sets" }));
  section.appendChild(el("p", { class: "desc", text: "Named groups of providers the Project Manager assigns to roles. A request with a fallback set tries each provider in order and falls through to the next if the current one is unavailable (cooldown, rate limit, concurrency cap)." }));

  // Health first (live pick, chain status, per-entry Edit/Delete), the
  // add/edit form below it -- Edit scrolls down into the same form
  // rather than opening a separate panel.
  renderFallbackSetHealthSection(section);

  // --- Add/edit form ---
  section.appendChild(el("hr", { class: "sep" }));
  section.appendChild(el("p", { class: "small", text: "Add or update a fallback set" }));

  const setNameInput = el("input", { type: "text", placeholder: "key (e.g. complex)", class: "fs-set-name", style: "max-width: 300px;" });
  const descInput = el("input", { type: "text", placeholder: "Description shown to the Project Manager", class: "fs-desc", style: "flex: 1;" });
  section.appendChild(el("div", { class: "row" }, [setNameInput, descInput]));

  // Provider entries container
  const entriesContainer = el("div", {
    style: "margin: 10px 0; min-height: 40px;",
    class: "fs-entries",
  });

  // Add entry button
  const addEntryBtn = el("button", {
    text: "+ Add provider",
    style: "font-size: 12px;",
    onclick: () => {
      const entry = createProviderEntryRow(
        '', '',
        (row) => { row.remove(); reindexRows(entriesContainer); },
        (row) => {
          const prev = row.previousElementSibling;
          if (prev && prev.classList.contains('fs-entry-row')) {
            entriesContainer.insertBefore(row, prev);
            reindexRows(entriesContainer);
          }
        },
        (row) => {
          const next = row.nextElementSibling;
          if (next && next.classList.contains('fs-entry-row')) {
            entriesContainer.insertBefore(next, row);
            reindexRows(entriesContainer);
          }
        },
        entriesContainer.querySelectorAll('.fs-entry-row').length
      );
      entriesContainer.appendChild(entry);
      reindexRows(entriesContainer);
    },
  });

  section.appendChild(entriesContainer);
  section.appendChild(el("div", { class: "row" }, [addEntryBtn]));

  // Save button
  section.appendChild(el("div", { class: "row", style: "margin-top: 8px;" }, [
    el("button", { class: "primary", text: "Save", onclick: () => {
      const name = setNameInput.value.trim();
      const desc = descInput.value.trim();
      const rows = entriesContainer.querySelectorAll('.fs-entry-row');
      if (!name) return showToast("Enter a set key", true);
      if (!rows.length) return showToast("Add at least one provider", true);
      const providers = [];
      for (const row of rows) {
        const val = row._getValue();
        if (!val.provider || !val.model) return showToast("Every provider entry needs a provider and model selected", true);
        providers.push(val);
      }
      reloadAfter(api(`/admin/api/fallback-sets/${encodeURIComponent(name)}`, {
        method: "PUT",
        body: { description: desc, providers },
      }), "Fallback set saved");
    }}),
  ]));

  return section;
}

// Opens the add/edit form with pre-filled values for an existing fallback set.
function enterFallbackSetEditRow(name, set) {
  // Fill name and description.
  const setNameInput = document.querySelector('.fs-set-name');
  const descInput = document.querySelector('.fs-desc');
  if (setNameInput && descInput) {
    setNameInput.value = name;
    descInput.value = set.description || '';
    setNameInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // Rebuild provider entries.
  const container = document.querySelector('.fs-entries');
  if (container) {
    container.innerHTML = '';
    for (const entry of (set.providers || [])) {
      const row = createProviderEntryRow(
        entry.provider, entry.model,
        (r) => { r.remove(); reindexRows(container); },
        (r) => {
          const prev = r.previousElementSibling;
          if (prev && prev.classList.contains('fs-entry-row')) {
            container.insertBefore(r, prev);
            reindexRows(container);
          }
        },
        (r) => {
          const next = r.nextElementSibling;
          if (next && next.classList.contains('fs-entry-row')) {
            container.insertBefore(next, r);
            reindexRows(container);
          }
        },
        Array.from(container.querySelectorAll('.fs-entry-row')).length
      );
      container.appendChild(row);
    }
    reindexRows(container);
  }
}
