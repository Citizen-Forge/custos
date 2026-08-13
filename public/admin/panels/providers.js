// Model providers panel: the Anthropic OAuth/API-key block, the provider
// table (with inline model sub-rows), the edit-in-place row, and the
// add-provider form. Everything here is private to this panel except the
// exported renderProvidersPanel().

import { $, el } from "../dom.js";
import { api, showToast } from "../api.js";
import { state, loadState, reloadAfter } from "../state.js";
import { formatBytes, parseThrottle } from "../utils.js";

// Renders a set of model checkboxes inside `container`. `models` is an
// array of { id, owned_by?, created?, inferred? } from the probe endpoint.
// `enabledSet` is a Set of model names that should be pre-checked. Each
// model gets a checkbox + label + optional inferred-capacity hint. New
// models (not in enabledSet) start unchecked.
// The checkboxes are stored on `container.checkboxes` as a Map<name, input>
// and the inferred metadata is stored on `container.modelMeta` as a Map<name, object>.
function renderModelCheckboxes(container, models, enabledSet) {
  container.innerHTML = "";
  container.checkboxes = new Map();
  container.modelMeta = new Map();
  if (!models || !models.length) {
    container.appendChild(el("div", { class: "small", text: "No models found. Enter model names manually or scan again." }));
    return;
  }
  const grid = el("div", { style: "display: flex; flex-wrap: wrap; gap: 6px; margin: 6px 0;" });
  for (const model of models) {
    const id = model.id || model;
    const checked = enabledSet.has(id);
    const label = el("label", {
      style: "display: inline-flex; align-items: center; gap: 4px; background: var(--bg); border: 1px solid var(--border); border-radius: 4px; padding: 4px 8px; font-size: 12px; cursor: pointer;",
    });
    const cb = el("input", { type: "checkbox", checked: checked ? "checked" : undefined });
    label.appendChild(cb);
    // Show model name
    label.appendChild(el("span", { text: id }));
    // Show inferred capacity hint as a muted badge, with a tooltip
    // so the operator can see what values will auto-populate.
    const inf = model.inferred;
    if (inf && (inf.maxOutputTokens || inf.maxContextWindow)) {
      const parts = [];
      if (inf.maxOutputTokens) parts.push(`out:${inf.maxOutputTokens}`);
      if (inf.maxContextWindow) parts.push(`ctx:${inf.maxContextWindow}`);
      const chip = el("span", {
        style: "font-size: 10px; color: var(--accent); opacity: 0.7; margin-left: 3px;",
        text: parts.join(" "),
        title: `Auto-detected: maxOutputTokens=${inf.maxOutputTokens ?? "?"}, maxContextWindow=${inf.maxContextWindow ?? "?"}. Adjust after save in the model sub-rows.`,
      });
      label.appendChild(chip);
    }
    // Store inferred metadata so readModelCheckboxes can include it.
    container.modelMeta.set(id, { maxOutputTokens: inf?.maxOutputTokens, maxContextWindow: inf?.maxContextWindow });
    container.checkboxes.set(id, cb);
    grid.appendChild(label);
  }
  container.appendChild(grid);
}

// Reads model checkboxes from a container rendered by renderModelCheckboxes.
// Returns an array of { name, enabled, maxOutputTokens?, maxContextWindow? }
// objects for the provider PUT body. Inferred metadata from the probe
// endpoint is included when present so the backend auto-populates the
// per-model capacity fields without the operator having to type them.
function readModelCheckboxes(container, pricing) {
  if (!container.checkboxes || container.checkboxes.size === 0) return [];
  const models = [];
  let first = true;
  for (const [name, cb] of container.checkboxes) {
    const meta = container.modelMeta?.get(name);
    models.push({
      name,
      enabled: cb.checked,
      ...(meta?.maxOutputTokens != null ? { maxOutputTokens: meta.maxOutputTokens } : {}),
      ...(meta?.maxContextWindow != null ? { maxContextWindow: meta.maxContextWindow } : {}),
      ...(first && pricing ? { pricing } : {}),
    });
    first = false;
  }
  return models;
}

async function startOAuthFlow(area) {
  const mode = confirm("Use your Claude Pro/Max subscription? Cancel to create an API key instead (Console mode).") ? "max" : "console";
  try {
    const { flowId, authorizationUrl } = await api("/admin/api/oauth/start", { method: "POST", body: { mode } });
    window.open(authorizationUrl, "_blank");
    area.innerHTML = "";
    const row = el("div", { class: "row" });
    row.appendChild(el("label", { text: "Code" }));
    const input = el("input", { type: "text", placeholder: "paste the code#state shown on the page you just opened" });
    row.appendChild(input);
    row.appendChild(el("button", { class: "primary", text: "Complete", onclick: () => reloadAfter(
      api("/admin/api/oauth/complete", { method: "POST", body: { flowId, code: input.value } }),
      "OAuth connected"
    )}));
    area.appendChild(row);
  } catch (err) {
    showToast(err.message, true);
  }
}

  // -- Model provider instances (new providers shape) ------------------

function enterEditRow(row, name, prov) {
  const wrapper = el("td", { colspan: "8" });
  const form = el("div");

  const urlInput = el("input", { type: "text", value: prov.baseUrl });
  const keyInput = el("input", { type: "password", placeholder: prov.apiKeyConfigured ? "(set -- enter to replace)" : "API key (blank = none)" });

  // --- Cost type selector ---
  const costTypeSelect = el("select", {}, [
    el("option", { value: "free", text: "Free" }),
    el("option", { value: "subscription", text: "Subscription" }),
    el("option", { value: "metered", text: "Metered (pay per token)" }),
  ]);
  costTypeSelect.value = prov.costType || "free";

  // --- Model checkboxes ---
  const modelCheckboxContainer = el("div", {});
  const enabledSet = new Set((prov.models || []).filter(m => m.enabled).map(m => m.name));
  const allModelNames = (prov.models || []).map(m => m.name);
  renderModelCheckboxes(modelCheckboxContainer, allModelNames.map(name => ({ id: name })), enabledSet);
  const modelsHint = el("div", { class: "small", text: `Currently ${(prov.models || []).length} model(s).` });

  // --- Re-scan button for edit form ---
  const rescanBtn = el("button", { text: "Re-scan models", onclick: async () => {
    rescanBtn.disabled = true;
    rescanBtn.textContent = "Scanning...";
    try {
      const result = await api("/admin/api/instances/probe-models", { method: "POST", body: { baseUrl: urlInput.value, apiKey: keyInput.value || undefined } });
      const discovered = result.models || [];
      const currentEnabled = new Set();
      if (modelCheckboxContainer.checkboxes) {
        for (const [name, cb] of modelCheckboxContainer.checkboxes) {
          if (cb.checked) currentEnabled.add(name);
        }
      }
      renderModelCheckboxes(modelCheckboxContainer, discovered, currentEnabled);
      modelsHint.textContent = `Found ${discovered.length} model(s). Check the ones you want enabled.`;
    } catch (err) {
      showToast(err.message, true);
    } finally {
      rescanBtn.disabled = false;
      rescanBtn.textContent = "Re-scan models";
    }
  }});

  // --- Throttle (maxConcurrent) ---
  const throttleInput = el("input", { type: "number", min: "1", step: "1", value: prov.maxConcurrent ?? "", placeholder: "Unlimited" });

  // --- RPM limit ---
  const rpmInput = el("input", { type: "number", min: "1", step: "1", value: prov.rpmLimit ?? "", placeholder: "Unlimited" });

  // --- Max request bytes (Groq-style upstream caps, etc.) ---
  const maxRequestBytesInput = el("input", { type: "number", min: "1024", step: "1", value: prov.maxRequestBytes ?? "", placeholder: "Unlimited (bytes)" });
  maxRequestBytesInput.title = "Hard cap on serialized request body. Set to 33554432 for Groq (32MB).";

  // --- Priority selector ---
  const prioritySelect = el("select", {}, [
    el("option", { value: "interactive", text: "Interactive" }),
    el("option", { value: "background", text: "Background" }),
  ]);
  prioritySelect.value = prov.priority ?? "interactive";

  form.appendChild(el("div", { class: "row" }, [urlInput]));
  form.appendChild(el("div", { class: "row" }, [keyInput]));
  form.appendChild(el("div", { class: "row" }, [
    el("label", { text: "Cost type" }),
    costTypeSelect,
  ]));
  form.appendChild(el("div", { class: "row" }, [
    el("label", { text: "Models" }),
    rescanBtn,
  ]));
  form.appendChild(modelCheckboxContainer);
  form.appendChild(modelsHint);
  form.appendChild(el("div", { class: "row" }, [
    el("label", { text: "Throttle" }),
    throttleInput,
    el("span", { class: "small", text: "max concurrent" }),
    el("label", { text: "RPM limit" }),
    rpmInput,
    el("span", { class: "small", text: "requests/min (set to 10 for Gemini Free)" }),
    el("label", { text: "Max bytes" }),
    maxRequestBytesInput,
    el("span", { class: "small", text: "request body cap (Groq = 33554432 = 32MB, blank = unlimited)" }),
  ]));
  form.appendChild(el("div", { class: "row" }, [
    el("label", { text: "Priority" }),
    prioritySelect,
    el("span", { class: "small", text: "interactive preempts background" }),
  ]));

  // --- Embeddings URL (optional override) ---
  // The runtime derives embeddings.baseUrl from this provider's
  // baseUrl via a port/hostname heuristic (Ollama: strips /v1 and
  // POSTs to /api/embeddings; everything else: keeps the base and
  // POSTs to /embeddings). The override below wins outright — use it
  // when the named provider is OpenAI-compat, when embeddings live
  // on a separate host, or when the heuristic misfires for a custom
  // server bolted onto the 11430-11440 port range. Test button
  // confirms the runtime's effective URL responds to a real POST.
  const embeddingUrlInput = el("input", { type: "text", value: prov.embeddingUrl ?? "", placeholder: "Auto-derived from base URL" });
  const embedProbeBtn = el("button", { style: "font-size: 11px; padding: 3px 8px;", text: "Test embeddings", onclick: async () => {
    embedProbeBtn.disabled = true;
    const originalText = embedProbeBtn.textContent;
    embedProbeBtn.textContent = "↻";
    try {
      // Save the override first so the probe endpoint sees it on
      // runtime.config.providers -- otherwise a probe without Save
      // is testing the OLD config, which is misleading UX. Reload
      // happens after the probe so the user sees the current state.
      await api(`/admin/api/providers/${encodeURIComponent(name)}`, {
        method: "PUT",
        body: {
          baseUrl: urlInput.value,
          costType: costTypeSelect.value,
          models: (prov.models || []).map((m) => ({ name: m.name, enabled: m.enabled })),
          embeddingUrl: embeddingUrlInput.value || null,
        },
      });
      const result = await api(`/admin/api/providers/${encodeURIComponent(name)}/probe-embeddings`, { method: "POST" });
      if (result.ok) {
        embedProbeBtn.textContent = "✓ responding";
        embedProbeBtn.style.color = "var(--ok)";
        embedProbeBtn.title = `resolved to ${result.host}${result.picked ?? ""} via ${result.plan.reason}`;
      } else {
        embedProbeBtn.textContent = "✕ failed";
        embedProbeBtn.style.color = "var(--danger)";
        const errs = (result.tried || []).map((t) => `HTTP ${t.status} ${t.statusText} @${t.path}`).join(", ");
        embedProbeBtn.title = `tried ${result.host}: ${errs}`;
      }
    } catch (err) {
      embedProbeBtn.textContent = "✕";
      embedProbeBtn.style.color = "var(--danger)";
      embedProbeBtn.title = err.message;
    }
    setTimeout(() => {
      embedProbeBtn.disabled = false;
      embedProbeBtn.textContent = originalText;
      embedProbeBtn.style.color = "";
      embedProbeBtn.title = "";
    }, 4000);
  }});
  form.appendChild(el("div", { class: "row" }, [
    el("label", { text: "Embeddings URL" }),
    embeddingUrlInput,
    embedProbeBtn,
    el("span", { class: "small", text: "blank = auto-derived (Ollama: /api/embeddings, others: /embeddings at base); tested against the configured embeddings global agent's per-agent override" }),
  ]));

  form.appendChild(el("p", { class: "small", text: "Per-model pricing (for metered providers, so per-token cost can be recorded against the project budget)." }));
  const inputPriceInput = el("input", { type: "text", placeholder: "$ per 1M input tokens", value: prov.pricing ? String(prov.pricing.inputPerMillion) : "" });
  const outputPriceInput = el("input", { type: "text", placeholder: "$ per 1M output tokens", value: prov.pricing ? String(prov.pricing.outputPerMillion) : "" });
  form.appendChild(el("div", { class: "row" }, [inputPriceInput, outputPriceInput]));

  const saveBtn = el("button", { class: "primary", text: "Save" });
  const cancelBtn = el("button", { text: "Cancel" });
  form.appendChild(el("div", { class: "row" }, [saveBtn, cancelBtn]));

  wrapper.appendChild(form);
  while (row.firstChild) row.removeChild(row.firstChild);
  row.appendChild(wrapper);

  saveBtn.onclick = () => {
    const throttle = parseThrottle(throttleInput);
    if (throttle === undefined) return;
    const rpmRaw = rpmInput.value.trim();
    const rpmVal = rpmRaw ? Number(rpmRaw) : null;
    if (rpmVal !== null && (!Number.isInteger(rpmVal) || rpmVal < 1)) {
      showToast("RPM limit must be a positive integer (or blank for unlimited)", true);
      return;
    }
    const maxBytesRaw = maxRequestBytesInput.value.trim();
    const maxBytesVal = maxBytesRaw ? Number(maxBytesRaw) : null;
    if (maxBytesVal !== null && (!Number.isInteger(maxBytesVal) || maxBytesVal < 1024)) {
      showToast("Max bytes must be a positive integer >= 1024 (or blank for unlimited)", true);
      return;
    }
    const hasPricing = inputPriceInput.value || outputPriceInput.value;
    const pricing = hasPricing ? { inputPerMillion: Number(inputPriceInput.value) || 0, outputPerMillion: Number(outputPriceInput.value) || 0 } : null;
    const models = readModelCheckboxes(modelCheckboxContainer, pricing);
    if (!models.length) {
      showToast("Enable at least one model", true);
      return;
    }
    reloadAfter(api(`/admin/api/providers/${encodeURIComponent(name)}`, {
      method: "PUT",
      body: {
        baseUrl: urlInput.value,
        costType: costTypeSelect.value,
        models,
        apiKey: keyInput.value || null,
        maxConcurrent: throttle,
        rpmLimit: rpmVal,
        maxRequestBytes: maxBytesVal,
        priority: prioritySelect.value,
        embeddingUrl: embeddingUrlInput.value || null,
      },
    }), "Provider saved");
  };
  cancelBtn.onclick = () => loadState();
}

export function renderProvidersPanel() {
  const section = el("section", { class: "panel" });
  section.appendChild(el("h2", { text: "Model providers" }));
  section.appendChild(el("p", { class: "desc", text: "Anthropic (Claude) is built-in with OAuth support. OpenAI-compatible providers — Ollama, OpenAI, DeepSeek, Gemini, Groq, Mistral, xAI, OpenRouter — share a standard API pattern. Each provider can serve multiple models." }));

  // --- Anthropic section (embedded inside Model providers panel) ---
  const { anthropic } = state;
  const anthEnabled = anthropic.enabled !== false;
  const anthSection = el("div", { style: `background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; margin-bottom: 16px;${anthEnabled ? "" : " opacity: 0.55;"}` });
  const anthTitleRow = el("div", { class: "row", style: "align-items: center; margin-bottom: 4px;" });
  anthTitleRow.appendChild(el("strong", { style: "font-size: 13px;", text: "Anthropic (Claude)" }));
  const anthEnabledLabel = el("label", { style: "display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: var(--muted); cursor: pointer; margin-left: auto;" });
  const anthEnabledCb = el("input", { type: "checkbox", checked: anthEnabled ? "checked" : undefined, style: "cursor: pointer;" });
  anthEnabledCb.onchange = () => {
    const enabled = anthEnabledCb.checked;
    reloadAfter(api("/admin/api/anthropic", { method: "PUT", body: { enabled } }), `Anthropic ${enabled ? "enabled" : "disabled"}`);
  };
  anthEnabledLabel.appendChild(anthEnabledCb);
  anthEnabledLabel.appendChild(document.createTextNode("Enabled"));
  anthTitleRow.appendChild(anthEnabledLabel);
  anthSection.appendChild(anthTitleRow);

  // OAuth row
  const oauthRow = el("div", { class: "row", style: "margin-bottom: 6px;" });
  const oauthBadge = anthropic.oauth.connected
    ? el("span", {
        class: "badge ok",
        style: "font-size: 11px;",
        text: "OAuth: Connected",
        title: anthropic.oauth.source === "claude-code"
          ? "Token is reused from an existing local OAuth login (skipped Custos's own OAuth flow)."
          : "Token was issued through Custos's own OAuth flow -- valid until expiry.",
      })
    : el("span", { class: "badge off", style: "font-size: 11px;", text: "OAuth: Not connected" });
  oauthRow.appendChild(oauthBadge);
  if (anthropic.oauth.connected) {
    oauthRow.appendChild(el("button", { style: "font-size: 11px; padding: 3px 8px; color: var(--danger);", text: "Disconnect OAuth", onclick: () => reloadAfter(api("/admin/api/oauth/disconnect", { method: "POST" }), "OAuth disconnected") }));
  } else {
    oauthRow.appendChild(el("button", { style: "font-size: 11px; padding: 3px 8px;", text: "Connect OAuth", onclick: () => startOAuthFlow($("#oauth-flow-area")) }));
  }
  // Probe button — test Anthropic connectivity with the configured auth.
  const anthProbeBtn = el("button", { style: "font-size: 11px; padding: 3px 8px;", text: "Test", onclick: async () => {
    anthProbeBtn.disabled = true;
    anthProbeBtn.textContent = "↻";
    try {
      const result = await api("/admin/api/anthropic/probe", { method: "POST" });
      if (result.ok) {
        anthProbeBtn.textContent = "✓";
        anthProbeBtn.style.color = "var(--ok)";
        anthProbeBtn.title = `HTTP ${result.status}${result.statusText ? ` — ${result.statusText}` : ""}`;
        showToast(`Anthropic probe succeeded (HTTP ${result.status})`);
      } else {
        anthProbeBtn.textContent = "✕";
        anthProbeBtn.style.color = "var(--danger)";
        anthProbeBtn.title = result.error || "Probe failed";
        showToast(result.error || "Anthropic probe failed", true);
      }
    } catch (err) {
      anthProbeBtn.textContent = "✕";
      anthProbeBtn.style.color = "var(--danger)";
      anthProbeBtn.title = err.message;
      showToast(err.message, true);
    }
    setTimeout(() => {
      anthProbeBtn.disabled = false;
      anthProbeBtn.textContent = "Test";
      anthProbeBtn.style.color = "";
      anthProbeBtn.title = "";
    }, 3000);
  }});
  oauthRow.appendChild(anthProbeBtn);
  anthSection.appendChild(oauthRow);
  anthSection.appendChild(el("div", { id: "oauth-flow-area", style: "margin-top: 4px;" }));

  // API key row
  const anthKeyRow = el("div", { class: "row", style: "margin-bottom: 0;" });
  const anthKeyInput = el("input", { type: "password", style: "flex: 0 0 200px; font-size: 12px; padding: 4px 7px;", placeholder: anthropic.apiKeyMasked || "Fallback API key (sk-ant-...)" });
  anthKeyRow.appendChild(el("span", { style: "font-size: 12px; color: var(--muted); min-width: 50px;", text: "API key" }));
  anthKeyRow.appendChild(anthKeyInput);
  anthKeyRow.appendChild(el("button", { style: "font-size: 11px; padding: 3px 8px;", class: "primary", text: "Save", onclick: () => {
    if (!anthKeyInput.value) return showToast("Enter a key first", true);
    reloadAfter(api("/admin/api/anthropic", { method: "PUT", body: { apiKey: anthKeyInput.value } }), "API key saved");
  }}));
  if (anthropic.apiKeySource !== "none") {
    anthKeyRow.appendChild(el("button", { style: "font-size: 11px; padding: 3px 8px;", text: "Clear", onclick: () => reloadAfter(api("/admin/api/anthropic", { method: "PUT", body: { apiKey: null } }), "API key cleared") }));
  }
  anthSection.appendChild(anthKeyRow);
  const sourceNote = anthropic.apiKeySource === "env" ? "using ANTHROPIC_API_KEY from the environment — OAuth is tried first" :
    anthropic.apiKeySource === "file" ? `configured (${anthropic.apiKeyMasked})` : "not configured — used as fallback when OAuth is unavailable";
  anthSection.appendChild(el("p", { style: "font-size: 11px; color: var(--muted); margin: 2px 0 0;", text: sourceNote }));

  // Throttle + RPM row
  const anthThrottleRow = el("div", { class: "row", style: "margin-top: 8px; margin-bottom: 0;" });
  const anthThrottleInput = el("input", { type: "number", min: "1", step: "1", style: "flex: 0 0 80px; font-size: 12px; padding: 4px 7px;", value: anthropic.maxConcurrent ?? "", placeholder: "Unlimited" });
  const anthRpmInput = el("input", { type: "number", min: "1", step: "1", style: "flex: 0 0 80px; font-size: 12px; padding: 4px 7px;", value: anthropic.rpmLimit ?? "", placeholder: "Unlimited" });
  anthThrottleRow.appendChild(el("span", { style: "font-size: 12px; color: var(--muted); min-width: 50px;", text: "Throttle" }));
  anthThrottleRow.appendChild(anthThrottleInput);
  anthThrottleRow.appendChild(el("span", { class: "small", text: "max concurrent" }));
  anthThrottleRow.appendChild(el("span", { style: "font-size: 12px; color: var(--muted); margin-left: 12px;", text: "RPM" }));
  anthThrottleRow.appendChild(anthRpmInput);
  anthThrottleRow.appendChild(el("span", { class: "small", text: "requests/min" }));
  anthThrottleRow.appendChild(el("button", { style: "font-size: 11px; padding: 3px 8px;", text: "Save", onclick: () => {
    const maxC = parseThrottle(anthThrottleInput);
    if (maxC === undefined) return;
    const rpmRaw = anthRpmInput.value.trim();
    const rpmVal = rpmRaw ? Number(rpmRaw) : null;
    if (rpmVal !== null && (!Number.isInteger(rpmVal) || rpmVal < 1)) {
      showToast("RPM limit must be a positive integer (or blank for unlimited)", true);
      return;
    }
    reloadAfter(api("/admin/api/anthropic", { method: "PUT", body: { maxConcurrent: maxC, rpmLimit: rpmVal } }), "Throttle settings saved");
  }}));
  anthSection.appendChild(anthThrottleRow);

  section.appendChild(anthSection);

  // --- Bulk re-scan button ---
  const rescanAllBtn = el("button", {
    style: "font-size: 12px; padding: 5px 10px; margin-bottom: 10px;",
    text: "⟳ Re-scan all providers",
    title: "Probe every provider's /v1/models endpoint and auto-populate any missing maxOutputTokens / maxContextWindow via per-model PATCH calls.",
    onclick: async () => {
      rescanAllBtn.disabled = true;
      rescanAllBtn.textContent = "↻ Scanning...";
      let succeeded = 0;
      let failed = 0;
      let patched = 0;
      for (const [name, prov] of Object.entries(state.providers)) {
        try {
          const result = await api(`/admin/api/providers/${encodeURIComponent(name)}/probe-models`, { method: "POST" });
          succeeded++;
          // PATCH any model whose inferred metadata is present but the
          // stored config has no maxOutputTokens or maxContextWindow set.
          for (const m of result.models || []) {
            if (!m.inferred) continue;
            const stored = (prov.models || []).find((sm) => sm.name === m.id);
            if (!stored) continue;
            const patchBody = {};
            if (m.inferred.maxOutputTokens != null && stored.maxOutputTokens == null) {
              patchBody.maxOutputTokens = m.inferred.maxOutputTokens;
            }
            if (m.inferred.maxContextWindow != null && stored.maxContextWindow == null) {
              patchBody.maxContextWindow = m.inferred.maxContextWindow;
            }
            if (Object.keys(patchBody).length > 0) {
              try {
                await api(`/admin/api/providers/${encodeURIComponent(name)}/models/${encodeURIComponent(m.id)}`, {
                  method: "PATCH",
                  body: patchBody,
                });
                patched++;
              } catch {
                // Per-model PATCH failure shouldn't abort the whole scan.
              }
            }
          }
        } catch {
          failed++;
        }
      }
      const msg = patched > 0
        ? `Re-scanned ${succeeded} provider(s), ${failed} failed, auto-populated ${patched} model capacity value(s)`
        : `Re-scanned ${succeeded} provider(s), ${failed} failed (no new model capacities detected)`;
      showToast(msg);
      rescanAllBtn.disabled = false;
      rescanAllBtn.textContent = "⟳ Re-scan all providers";
      await loadState();
    },
  });
  section.appendChild(rescanAllBtn);

  const table = el("table", { class: "providers-table" });
  table.appendChild(el("colgroup", {}, [
    el("col", { style: "width: 19%;" }),
    el("col", { style: "width: 23%;" }),
    el("col", { style: "width: 8%;" }),
    el("col", { style: "width: 14%;" }),
    el("col", { style: "width: 8%;" }),
    el("col", { style: "width: 7%;" }),
    el("col", { style: "width: 9%;" }),
    el("col", { style: "width: 12%;" }),
  ]));
  table.appendChild(el("tr", {}, [
    el("th", { text: "Provider" }), el("th", { text: "Base URL" }), el("th", { text: "Cost" }), el("th", { text: "API key" }), el("th", { text: "Throttle" }), el("th", { text: "RPM" }), el("th", { text: "Max bytes" }), el("th", { text: "Priority" }), el("th", { text: "Actions" }),
  ]));
  for (const [name, prov] of Object.entries(state.providers)) {
    const throttleText = prov.maxConcurrent == null ? "—" : String(prov.maxConcurrent);
    const rpmText = prov.rpmLimit == null ? "—" : String(prov.rpmLimit);
    const maxBytesText = prov.maxRequestBytes == null ? "—" : formatBytes(prov.maxRequestBytes);
    const priorityText = prov.priority == null ? "—" : (prov.priority === "interactive" ? "Interactive" : "Background");
    const costType = prov.costType || "free";
    const costText = { free: "Free", subscription: "Sub", metered: "Metered" }[costType] || costType;
    const expanded = false; // start collapsed -- individual providers were never actually wired to this before, so they always rendered fully expanded regardless of the flag's value
    const providerEnabled = prov.enabled !== false;
    const enabledToggle = el("input", {
      type: "checkbox",
      checked: providerEnabled ? "checked" : undefined,
      title: providerEnabled ? "Disable this provider (removed from dispatch until re-enabled; every fallback set that references it falls through to its next entry)" : "Enable this provider",
      style: "margin-right: 6px; cursor: pointer; vertical-align: middle;",
      // Sits inside the name cell, which has its own onclick for the
      // expand/collapse toggle -- without stopping propagation, clicking
      // the checkbox would also toggle the model-row visibility.
      onclick: (ev) => ev.stopPropagation(),
    });
    enabledToggle.onchange = async () => {
      const enabled = enabledToggle.checked;
      try {
        await api(`/admin/api/providers/${encodeURIComponent(name)}`, { method: "PATCH", body: { enabled } });
        showToast(`${name} ${enabled ? "enabled" : "disabled"}`);
        await loadState();
      } catch (err) {
        enabledToggle.checked = !enabled;
        showToast(err.message, true);
      }
    };
    const dataRow = el("tr", { class: "provider-row", style: providerEnabled ? "" : "opacity: 0.55;" }, [
      el("td", {
        class: "provider-name-cell",
        onclick: () => {
          // Toggle visibility of model detail rows beneath this provider.
          let sib = dataRow.nextElementSibling;
          while (sib && sib.classList.contains("model-detail")) {
            const hidden = sib.style.display === "none";
            sib.style.display = hidden ? "" : "none";
            sib = sib.nextElementSibling;
          }
          const toggleSpan = dataRow.querySelector(".provider-toggle");
          if (toggleSpan) toggleSpan.textContent = toggleSpan.textContent === "▾" ? "▸" : "▾";
        },
      }, [
        enabledToggle,
        el("span", { class: "provider-toggle", text: expanded ? "▾" : "▸" }),
        el("strong", { text: name }),
      ]),
      el("td", { class: "url-cell", text: prov.baseUrl }),
      el("td", {}, [el("span", { class: `cost-chip ${costType}`, text: costText })]),
      el("td", { class: prov.apiKeyConfigured ? "" : "muted", text: prov.apiKeyConfigured ? prov.apiKeyMasked : "—" }),
      el("td", { class: prov.maxConcurrent == null ? "muted" : "", text: throttleText }),
      el("td", { class: prov.rpmLimit == null ? "muted" : "", text: rpmText }),
      el("td", { class: prov.maxRequestBytes == null ? "muted" : "", text: maxBytesText, title: prov.maxRequestBytes == null ? "" : `${prov.maxRequestBytes} bytes` }),
      el("td", { class: prov.priority == null ? "muted" : "", text: priorityText }),
      el("td", { class: "actions-cell" }, [
        el("button", { class: "row-btn", text: "Test", onclick: async (ev) => {
          const btn = ev.currentTarget;
          btn.disabled = true;
          btn.textContent = "↻";
          try {
            const result = await api(`/admin/api/providers/${encodeURIComponent(name)}/probe`, { method: "POST" });
            if (result.ok) {
              btn.textContent = "✓";
              btn.style.color = "var(--ok)";
              btn.title = `HTTP ${result.status}${result.statusText ? ` — ${result.statusText}` : ""}`;
            } else {
              btn.textContent = "✕";
              btn.style.color = "var(--danger)";
              btn.title = result.error || "Probe failed";
            }
          } catch (err) {
            btn.textContent = "✕";
            btn.style.color = "var(--danger)";
            btn.title = err.message;
          }
          setTimeout(() => {
            btn.disabled = false;
            btn.textContent = "Test";
            btn.style.color = "";
            btn.title = "";
          }, 3000);
        }}),
        el("button", { class: "row-btn", text: "Edit", onclick: () => enterEditRow(dataRow, name, prov) }),
        el("button", { class: "row-btn danger", text: "Delete", onclick: () => reloadAfter(
          api(`/admin/api/providers/${encodeURIComponent(name)}`, { method: "DELETE" }), `Removed "${name}"`
        )}),
      ]),
    ]);
    table.appendChild(dataRow);

    // Model sub-rows — visible by default, toggled by clicking the provider name.
    const models = prov.models || [];
    for (const model of models) {
      const modelRow = el("tr", { class: "model-detail" });
      const modelTd = el("td", { colspan: "8" });
      // Inline toggle to enable/disable a model without opening the edit form.
      const toggleLabel = el("label", {
        style: "display: inline-flex; align-items: center; gap: 3px; margin-right: 6px; cursor: pointer; font-size: 11px;",
        title: model.enabled ? "Disable this model" : "Enable this model",
      });
      const toggleCb = el("input", { type: "checkbox", checked: model.enabled ? "checked" : undefined, style: "margin: 0;" });
      const toggleBadge = el("span", { text: model.enabled ? "✓" : "✕", style: model.enabled ? "color: var(--ok);" : "color: var(--muted);" });
      toggleCb.onchange = async () => {
        const enabled = toggleCb.checked;
        try {
          await api(`/admin/api/providers/${encodeURIComponent(name)}/models/${encodeURIComponent(model.name)}`, {
            method: "PATCH",
            body: { enabled },
          });
          toggleLabel.title = enabled ? "Disable this model" : "Enable this model";
          toggleBadge.textContent = enabled ? "✓" : "✕";
          toggleBadge.style.color = enabled ? "var(--ok)" : "var(--muted)";
        } catch (err) {
          // Revert the checkbox on failure.
          toggleCb.checked = !enabled;
          showToast(err.message, true);
        }
      };
      toggleLabel.appendChild(toggleCb);
      toggleLabel.appendChild(toggleBadge);
      modelTd.appendChild(toggleLabel);
      modelTd.appendChild(el("code", { style: "font-size: 12px;", text: model.name }));
      if (model.pricing) {
        modelTd.appendChild(el("span", { class: "small", style: "margin-left: 12px;", text: `In: $${model.pricing.inputPerMillion}/1M  Out: $${model.pricing.outputPerMillion}/1M` }));
      } else {
        modelTd.appendChild(el("span", { class: "small", style: "margin-left: 12px;", text: "—" }));
      }
      // Inline maxOutputTokens input — saved via PATCH on blur so the
      // operator doesn't need to open the full Edit form just to tune
      // a single model's output-token cap against a provider where
      // different models have different limits (e.g. Groq's per-model
      // 16384 vs 8192).
      modelTd.appendChild(el("span", { class: "small", style: "margin-left: 12px; font-size: 11px;", text: "max_tokens:" }));
      const maxTokenInput = el("input", {
        type: "number",
        min: "1",
        step: "1",
        style: "width: 70px; font-size: 11px; padding: 2px 5px; margin-left: 3px;",
        value: model.maxOutputTokens ?? "",
        placeholder: "unlimited",
        title: "Maximum output tokens this model supports. Blank = allow any value the caller sends (upstream may reject).",
      });
      let saveTimeout = null;
      maxTokenInput.oninput = () => {
        if (saveTimeout) clearTimeout(saveTimeout);
        saveTimeout = setTimeout(async () => {
          const raw = maxTokenInput.value.trim();
          const val = raw ? Number(raw) : null;
          if (val !== null && (!Number.isInteger(val) || val < 1)) {
            showToast("max tokens must be a positive integer (or blank for unlimited)", true);
            return;
          }
          try {
            await api(`/admin/api/providers/${encodeURIComponent(name)}/models/${encodeURIComponent(model.name)}`, {
              method: "PATCH",
              body: { maxOutputTokens: val },
            });
          } catch (err) {
            showToast(err.message, true);
          }
        }, 800);
      };
      modelTd.appendChild(maxTokenInput);
      // Inline maxContextWindow input — warns when the estimated
      // token count (bytes / 3) exceeds this value. Advisory only;
      // the request is still sent. Different models on the same
      // provider (e.g. Groq's various models with 16384 vs 8192
      // context windows) have different limits.
      modelTd.appendChild(el("span", { class: "small", style: "margin-left: 8px; font-size: 11px;", text: "ctx:" }));
      const ctxWindowInput = el("input", {
        type: "number",
        min: "1",
        step: "1",
        style: "width: 70px; font-size: 11px; padding: 2px 5px; margin-left: 3px;",
        value: model.maxContextWindow ?? "",
        placeholder: "unlimited",
        title: "Maximum total context (input + output) tokens this model supports. Estimated from serialized body bytes / 3. Blank = skip check.",
      });
      let ctxSaveTimeout = null;
      ctxWindowInput.oninput = () => {
        if (ctxSaveTimeout) clearTimeout(ctxSaveTimeout);
        ctxSaveTimeout = setTimeout(async () => {
          const raw = ctxWindowInput.value.trim();
          const val = raw ? Number(raw) : null;
          if (val !== null && (!Number.isInteger(val) || val < 1)) {
            showToast("context window must be a positive integer (or blank for unlimited)", true);
            return;
          }
          try {
            await api(`/admin/api/providers/${encodeURIComponent(name)}/models/${encodeURIComponent(model.name)}`, {
              method: "PATCH",
              body: { maxContextWindow: val },
            });
          } catch (err) {
            showToast(err.message, true);
          }
        }, 800);
      };
      modelTd.appendChild(ctxWindowInput);
      modelRow.appendChild(modelTd);
      if (!expanded) modelRow.style.display = "none";
      table.appendChild(modelRow);
    }
    // Separator row between providers
    table.appendChild(el("tr", { class: "separator" }, [
      el("td", { colspan: "8" }),
    ]));
  }
  section.appendChild(table);

  section.appendChild(el("hr", { class: "sep" }));
  section.appendChild(el("p", { class: "small", text: "Add or update a provider" }));

  const nameInput = el("input", { type: "text", placeholder: "name (e.g. gemini-free)" });
  const urlInput = el("input", { type: "text", placeholder: "base URL" });
  const keyInput = el("input", { type: "password", placeholder: "API key (leave blank if none)" });

  // --- Cost type selector for new providers ---
  const costTypeSelect = el("select", {}, [
    el("option", { value: "free", text: "Free (no cost, rate-limited)" }),
    el("option", { value: "subscription", text: "Subscription (flat fee)" }),
    el("option", { value: "metered", text: "Metered (pay per token)" }),
  ]);

  // --- Model checkboxes (populated by Scan) ---
  const modelCheckboxContainer = el("div", {});
  const modelsHint = el("div", { class: "small" });

  // --- Throttle (maxConcurrent) ---
  const throttleInput = el("input", { type: "number", min: "1", step: "1", placeholder: "Unlimited" });

  // --- RPM limit (new!) ---
  const rpmInput = el("input", { type: "number", min: "1", step: "1", value: "", placeholder: "RPM limit" });
  // Max request bytes cap (e.g. Groq hard-caps at 32 MB). Blank = unlimited.
  const maxRequestBytesInput = el("input", { type: "number", min: "1", step: "1", value: "", placeholder: "Unlimited (bytes)" });
  maxRequestBytesInput.title = "Hard cap on serialized request body. Set to 33554432 for Groq (32MB).";
  // Apply a preset's defaults to every corresponding field on a single
  // helper, so adding a new preset default doesn't require touching
  // multiple hand-rolled auto-fill switches. Each preset declares its
  // own field set under PROVIDER_PRESETS[i].defaults (server-side).
  function autoFillFromPreset(presetId) {
    const preset = state.providerPresets.find((p) => p.id === presetId);
    const defaults = preset?.defaults ?? {};
    rpmInput.value = defaults.rpmLimit ?? "";
    maxRequestBytesInput.value = defaults.maxRequestBytes ?? "";
    if (typeof defaults.maxConcurrent === "number") {
      throttleInput.value = String(defaults.maxConcurrent);
      throttleInput.placeholder = `${defaults.maxConcurrent} (preset default)`;
    } else {
      throttleInput.value = "";
      throttleInput.placeholder = "Unlimited";
    }
    prioritySelect.value = defaults.priority ?? "interactive";
  }

  // --- Priority selector ---
  const prioritySelect = el("select", {}, [
    el("option", { value: "interactive", text: "Interactive" }),
    el("option", { value: "background", text: "Background" }),
  ]);

  async function autoScanModels() {
    if (!urlInput.value) return;
    try {
      const result = await api("/admin/api/instances/probe-models", { method: "POST", body: { baseUrl: urlInput.value, apiKey: keyInput.value || undefined } });
      const discovered = result.models || [];
      const enableAll = new Set(discovered.map(m => m.id));
      renderModelCheckboxes(modelCheckboxContainer, discovered, enableAll);
      modelsHint.textContent = `Found ${discovered.length} model(s). Uncheck any you don't want enabled.`;
    } catch {
      // Auto-scan failed; user can click "Scan models" manually.
    }
  }

  const presetSelect = el("select", { onchange: (ev) => {
    const preset = state.providerPresets.find((p) => p.id === ev.target.value);
    if (preset && preset.id !== "custom") urlInput.value = preset.baseUrl;
    if (preset && !nameInput.value) nameInput.value = preset.id;
    autoFillFromPreset(preset ? preset.id : "");
    // Auto-scan models for known presets so models appear immediately.
    autoScanModels();
  }});
  for (const preset of state.providerPresets) {
    presetSelect.appendChild(el("option", { value: preset.id, text: preset.label }));
  }

  // --- Embeddings URL (optional override for the add form) ---
  // Declared here alongside the other add-form rows because the Save
  // handler reads `embeddingUrlInput.value` from the same closure. The
  // Test button lives in the edit form (enterEditRow), which requires
  // the provider to already be saved before a live probe makes sense.
  // This input is the post-save equivalent for newly-created providers:
  // an explicit override for OpenAI-compat /v1/embeddings hosts, plus
  // any custom embedding service the URL-shape heuristic can't reach.
  const embeddingUrlInput = el("input", { type: "text", placeholder: "Auto-derived from base URL" });
  const rowEmbedding = el("div", { class: "row" }, [
    el("label", { text: "Embeddings URL" }),
    embeddingUrlInput,
    el("span", { class: "small", text: "optional — blank = auto-derived (Ollama: /api/embeddings, others: /embeddings at base)" }),
  ]);

  const row0 = el("div", { class: "row" }, [el("label", { text: "Preset" }), presetSelect]);
  const row1 = el("div", { class: "row" }, [nameInput, urlInput]);
  const row2 = el("div", { class: "row" }, [el("label", { text: "Cost" }), costTypeSelect, keyInput]);
  const rowModels = el("div", { class: "row" }, [el("label", { text: "Models" }), el("span", { class: "small", text: "Scan a provider URL to discover available models" })]);

  const rowThrottle = el("div", { class: "row" }, [
    el("label", { text: "Throttle" }),
    throttleInput,
    el("span", { class: "small", text: "max concurrent" }),
    el("label", { text: "RPM" }),
    rpmInput,
    el("span", { class: "small", text: "req/min (Gemini Free = 10, blank = unlimited)" }),
    el("label", { text: "Max bytes" }),
    maxRequestBytesInput,
    el("span", { class: "small", text: "request body cap (Groq = 33554432 = 32MB, blank = unlimited)" }),
  ]);

  const rowPriority = el("div", { class: "row" }, [
    el("label", { text: "Priority" }),
    prioritySelect,
    el("span", { class: "small", text: "interactive preempts background" }),
  ]);

  const rowProbe = el("div", { class: "row" }, [
    el("button", { text: "Scan models", onclick: async () => {
      if (!urlInput.value) return showToast("Enter a base URL first", true);
      try {
        const result = await api("/admin/api/instances/probe-models", { method: "POST", body: { baseUrl: urlInput.value, apiKey: keyInput.value || undefined } });
        const discovered = result.models || [];
        // All newly discovered models start enabled.
        const enableAll = new Set(discovered.map(m => m.id));
        renderModelCheckboxes(modelCheckboxContainer, discovered, enableAll);
        modelsHint.textContent = `Found ${discovered.length} model(s). Uncheck any you don't want enabled.`;
      } catch (err) {
        modelsHint.textContent = err.message;
      }
    }}),
  ]);

  section.appendChild(el("p", { class: "small", text: "Per-model pricing (for metered providers, so per-token cost can be recorded against the project budget)." }));
  const inputPriceInput = el("input", { type: "text", placeholder: "$ per 1M input tokens" });
  const outputPriceInput = el("input", { type: "text", placeholder: "$ per 1M output tokens" });
  const row4 = el("div", { class: "row" }, [inputPriceInput, outputPriceInput]);

  const row5 = el("div", { class: "row" }, [
    el("button", { class: "primary", text: "Save", onclick: () => {
      if (!nameInput.value || !urlInput.value) return showToast("Fill in name and base URL", true);
      if (!modelCheckboxContainer.checkboxes || !modelCheckboxContainer.checkboxes.size) {
        return showToast("Click 'Scan models' first, then enable at least one model", true);
      }
      const throttle = parseThrottle(throttleInput);
      if (throttle === undefined) return;
      const rpmRaw = rpmInput.value.trim();
      const rpmVal = rpmRaw ? Number(rpmRaw) : null;
      if (rpmVal !== null && (!Number.isInteger(rpmVal) || rpmVal < 1)) {
        showToast("RPM limit must be a positive integer (or blank for unlimited)", true);
        return;
      }
      const hasPricing = inputPriceInput.value || outputPriceInput.value;
      const pricing = hasPricing ? { inputPerMillion: Number(inputPriceInput.value) || 0, outputPerMillion: Number(outputPriceInput.value) || 0 } : null;
      const models = readModelCheckboxes(modelCheckboxContainer, pricing);
      if (!models.length) return showToast("Enable at least one model", true);
      const maxBytesRaw = maxRequestBytesInput.value.trim();
      const maxBytesVal = maxBytesRaw ? Number(maxBytesRaw) : null;
      if (maxBytesVal !== null && (!Number.isInteger(maxBytesVal) || maxBytesVal < 1)) {
        showToast("Max request bytes must be a positive integer (or blank for unlimited)", true);
        return;
      }
      reloadAfter(api(`/admin/api/providers/${encodeURIComponent(nameInput.value)}`, {
        method: "PUT",
        body: {
          baseUrl: urlInput.value,
          costType: costTypeSelect.value,
          models,
          apiKey: keyInput.value || undefined,
          maxConcurrent: throttle,
          rpmLimit: rpmVal,
          priority: prioritySelect.value,
          embeddingUrl: embeddingUrlInput.value || null,
          maxRequestBytes: maxBytesVal,
        },
      }), "Provider saved");
    }}),
  ]);
  section.appendChild(row0);
  section.appendChild(row1);
  section.appendChild(row2);
  section.appendChild(rowModels);
  section.appendChild(rowThrottle);
  section.appendChild(rowPriority);
  section.appendChild(rowEmbedding);
  section.appendChild(rowProbe);
  section.appendChild(modelsHint);
  // The checkboxes populated by renderModelCheckboxes() live on this
  // div. The auto-scan (preset switch) and manual Scan models button
  // both call renderModelCheckboxes(modelCheckboxContainer, ...) which
  // mutates its innerHTML — but until this div is attached to the
  // section those mutations happen off-DOM and remain invisible. The
  // count hint above is set via textContent on a real DOM node, which
  // is why a scan visibly reports the right number but never shows the
  // selector itself.
  section.appendChild(modelCheckboxContainer);
  section.appendChild(row4);
  section.appendChild(row5);

  return section;
}
