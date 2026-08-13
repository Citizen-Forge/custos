// Global services panel: memory curator, permission classifier, embeddings.
// Each is an AgentDef with kind="global" dispatched via a fallback set,
// same as any project agent — see global-agent-routes.ts's EDITABLE_FIELDS.

import { el } from "../dom.js";
import { api } from "../api.js";
import { state, reloadAfter } from "../state.js";
import { labelForRole } from "../utils.js";

export function renderGlobalServicesPanel() {
  const section = el("section", { class: "panel" });
  section.appendChild(el("h2", { text: "Global services" }));
  section.appendChild(el("p", { class: "desc", text: "Project-orthogonal services the gateway runs in the background: memory curator (extracts facts from sessions), permission classifier (gates tool calls), embeddings (powers memory search). " }));

  const agents = (state.globalAgents || []).slice();
  if (!agents.length) {
    section.appendChild(el("p", { class: "small", text: "No global agents configured. Restart the gateway to seed the defaults." }));
    return section;
  }

  // Stable display order so the curator sits next to its closest consumer
  // (memory search), and embeddings — which already runs in
  // /admin/api/state — stays at the bottom by convention.
  const order = ["memoryCurator", "permissionClassifier", "embeddings"];
  agents.sort((a, b) => order.indexOf(a.systemRole || "") - order.indexOf(b.systemRole || ""));

  const fallbackSetNames = Object.keys(state.fallbackSets || {});

  const table = el("table", { class: "providers-table" });
  table.appendChild(el("colgroup", {}, [
    el("col", { style: "width: 20%;" }),
    el("col", { style: "width: 20%;" }),
    el("col", { style: "width: 22%;" }),
    el("col", { style: "width: 28%;" }),
    el("col", { style: "width: 10%;" }),
  ]));
  table.appendChild(el("tr", {}, [
    el("th", { text: "Service" }),
    el("th", { text: "Fallback set" }),
    el("th", { text: "Resolves to" }),
    el("th", { text: "Endpoint" }),
    el("th", { text: "Actions" }),
  ]));

  for (const agent of agents) {
    const fallbackSetSelect = el("select", {});
    for (const name of fallbackSetNames) {
      const opt = el("option", { value: name, text: name });
      if (name === agent.fallbackSet) opt.setAttribute("selected", "selected");
      fallbackSetSelect.appendChild(opt);
    }
    if (!fallbackSetNames.includes(agent.fallbackSet || "")) {
      // Current value points at a set that no longer exists (deleted
      // out from under it) — surface it rather than silently switching
      // the select to whatever option happens to be first.
      const opt = el("option", { value: agent.fallbackSet || "", text: `${agent.fallbackSet || "<unset>"} (missing!)` });
      opt.setAttribute("selected", "selected");
      fallbackSetSelect.appendChild(opt);
    }
    const resolvesToText = agent.providerKey ? `${agent.providerKey} / ${agent.model}` : "—";
    const endpointInput = el("input", {
      type: "text",
      value: agent.embeddingBaseUrl || "",
      placeholder: agent.systemRole === "embeddings" ? "default: derived from provider host" : "(only for embeddings)",
      disabled: agent.systemRole !== "embeddings" ? "disabled" : undefined,
    });
    const saveBtn = el("button", { class: "row-btn primary", text: "Save", onclick: () => {
      const patch = {
        fallbackSet: fallbackSetSelect.value,
        embeddingBaseUrl: agent.systemRole === "embeddings" ? (endpointInput.value || null) : undefined,
      };
      reloadAfter(api(`/admin/api/global-agents/${encodeURIComponent(agent.systemRole)}`, {
        method: "PATCH",
        body: patch,
      }), `${labelForRole(agent.systemRole)} updated`);
    }});
    const row = el("tr", {}, [
      el("td", {}, [
        el("strong", { text: labelForRole(agent.systemRole) }),
        el("br"),
        el("span", { class: "small", text: agent.name }),
      ]),
      el("td", {}, [fallbackSetSelect]),
      el("td", { class: "small", style: "font-family: monospace; font-size: 11px;", text: resolvesToText }),
      el("td", { class: "url-cell" }, [
        endpointInput,
      ]),
      el("td", { class: "actions-cell" }, [saveBtn]),
    ]);
    table.appendChild(row);
  }
  section.appendChild(table);
  section.appendChild(el("p", { class: "small", style: "margin-top: 8px;", text: "The endpoint field is only meaningful for embeddings — Ollama exposes them at a different path than /v1/chat/completions, so the runtime either derives the URL from the named provider or uses the explicit host here." }));
  return section;
}
