// MCP server panel: endpoint + bearer key lifecycle for external Claude
// Code sessions driving custos through src/mcp/pm-tools.ts.

import { $, el } from "../dom.js";
import { api, showToast } from "../api.js";
import { state, reloadAfter, loadState } from "../state.js";

// Shows a freshly generated key exactly once -- there is no "reveal"
// endpoint (auth/mcp-key.ts only ever persists a hash), so this is the
// only moment the operator can copy it.
function showKeyOnce(key) {
  const target = $("#mcp-key-reveal");
  if (!target) return;
  target.innerHTML = "";
  target.appendChild(el("div", { style: "margin-top: 8px; padding: 8px 10px; background: var(--bg); border: 1px solid var(--danger); border-radius: 6px;" }, [
    el("div", { style: "font-size: 11px; color: var(--danger); margin-bottom: 4px;", text: "Copy this now -- it won't be shown again." }),
    el("input", { type: "text", readonly: true, value: key, style: "width: 100%; font-size: 12px; padding: 4px 7px; font-family: monospace;", onclick: (e) => e.target.select() }),
  ]));
}

export function renderMcpPanel() {
  const section = el("section", { class: "panel" });
  section.appendChild(el("h2", { text: "MCP server" }));
  section.appendChild(el("p", { class: "desc", text: "Lets an external Claude Code session create projects, submit ideas to the roadmap, and claim/submit tickets for human-driven work -- as if it came through custos's own UI. Point your MCP client at the URL below with an Authorization: Bearer <key> header." }));

  const { mcp } = state;
  const urlRow = el("div", { class: "row", style: "margin-bottom: 6px;" });
  urlRow.appendChild(el("span", { style: "font-size: 12px; color: var(--muted); min-width: 70px;", text: "Endpoint" }));
  urlRow.appendChild(el("input", { type: "text", readonly: true, value: mcp.url, style: "flex: 1; font-size: 12px; padding: 4px 7px; font-family: monospace;", onclick: (e) => e.target.select() }));
  section.appendChild(urlRow);

  const statusRow = el("div", { class: "row", style: "margin-bottom: 6px;" });
  statusRow.appendChild(mcp.configured
    ? el("span", { class: "badge ok", style: "font-size: 11px;", text: "Key configured" })
    : el("span", { class: "badge off", style: "font-size: 11px;", text: "No key generated" }));
  statusRow.appendChild(el("button", {
    style: "font-size: 11px; padding: 3px 8px;",
    text: mcp.configured ? "Regenerate key" : "Generate key",
    onclick: async () => {
      if (mcp.configured && !confirm("Regenerating invalidates the current key -- any MCP client using it will need the new one. Continue?")) return;
      try {
        const { key } = await api("/admin/api/mcp/generate-key", { method: "POST" });
        // loadState() ends by notifying the render callback, which wipes
        // and rebuilds #app -- including a fresh, empty #mcp-key-reveal
        // div. Calling showKeyOnce() before that reload used to inject
        // the key into the OLD div a moment before it got discarded, so
        // the one and only chance to see/copy this key was a flash the
        // operator could easily miss. Reload first so the re-render has
        // already happened, then reveal into the div that's actually
        // staying.
        await loadState();
        showKeyOnce(key);
      } catch (err) {
        showToast(err.message, true);
      }
    },
  }));
  if (mcp.configured) {
    statusRow.appendChild(el("button", {
      style: "font-size: 11px; padding: 3px 8px; color: var(--danger);",
      text: "Revoke",
      onclick: () => {
        if (!confirm("Revoke the MCP key? Every MCP client loses access until a new key is generated.")) return;
        reloadAfter(api("/admin/api/mcp/revoke-key", { method: "POST" }), "MCP key revoked");
      },
    }));
  }
  section.appendChild(statusRow);
  section.appendChild(el("div", { id: "mcp-key-reveal" }));

  return section;
}
