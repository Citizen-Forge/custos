// -- Slack integration -----------------------------------------------------
//
// One bot token for the whole gateway -- individual roles don't get their
// own Slack login/email. Outgoing activity currently posts under one
// shared "Custos" identity (src/slack/activity.ts); every activity line
// already names the agent that produced it in its own text. Per-role
// name/icon via chat.postMessage's override is wired in src/slack/personas.ts
// but not yet plumbed through every emit call site -- a future pass, not
// required for the integration to work. The same channel doubles as an
// idea inbox: any plain message posted there becomes an inbox idea
// (src/pm/orchestrator.ts's pollSlackIdeas). Per-project channel routing
// lives on each project's own settings (see panels/projects.js), not here
// -- this panel only owns the token and the global killswitch.

import { el } from "../dom.js";
import { api, showToast } from "../api.js";
import { state, reloadAfter } from "../state.js";

export function renderSlackPanel() {
  const section = el("section", { class: "panel" });
  section.appendChild(el("h2", { text: "Slack" }));
  section.appendChild(el("p", { class: "desc", text: "One Slack app/bot token for the whole gateway. Agents post updates (ticket ready, blocked, merged, deployed) to each project's channel, and any plain message posted back in that channel becomes an inbox idea for the project -- @-mention the bot instead (\"@custos what's in progress?\") to get an immediate status reply in-thread rather than filing an idea. Requires the chat:write, chat:write.customize, channels:history (or groups:history for a private channel), and channels:read scopes on the bot token; users:read is optional and only improves idea attribution. Set each project's Slack channel from its own settings." }));

  const { slack } = state;

  const enabledRow = el("div", { class: "row", style: "margin-bottom: 8px;" });
  const enabledLabel = el("label", { style: "display: inline-flex; align-items: center; gap: 6px; font-size: 12px; cursor: pointer;" });
  const enabledCb = el("input", { type: "checkbox", checked: slack.enabled !== false ? "checked" : undefined, style: "cursor: pointer;" });
  enabledCb.onchange = () => {
    const enabled = enabledCb.checked;
    reloadAfter(api("/admin/api/slack", { method: "PUT", body: { enabled } }), `Slack integration ${enabled ? "enabled" : "disabled"}`);
  };
  enabledLabel.appendChild(enabledCb);
  enabledLabel.appendChild(document.createTextNode("Enabled"));
  enabledRow.appendChild(enabledLabel);
  section.appendChild(enabledRow);

  const tokenRow = el("div", { class: "row", style: "margin-bottom: 0;" });
  const tokenInput = el("input", { type: "password", style: "flex: 0 0 260px; font-size: 12px; padding: 4px 7px;", placeholder: slack.botTokenMasked || "Bot token (xoxb-...)" });
  tokenRow.appendChild(el("span", { style: "font-size: 12px; color: var(--muted); min-width: 70px;", text: "Bot token" }));
  tokenRow.appendChild(tokenInput);
  tokenRow.appendChild(el("button", { style: "font-size: 11px; padding: 3px 8px;", class: "primary", text: "Save", onclick: () => {
    if (!tokenInput.value) return showToast("Enter a token first", true);
    reloadAfter(api("/admin/api/slack", { method: "PUT", body: { botToken: tokenInput.value } }), "Slack bot token saved");
  }}));
  if (slack.botTokenConfigured) {
    tokenRow.appendChild(el("button", { style: "font-size: 11px; padding: 3px 8px;", text: "Clear", onclick: () => reloadAfter(api("/admin/api/slack", { method: "PUT", body: { botToken: null } }), "Slack bot token cleared") }));
  }
  section.appendChild(tokenRow);
  section.appendChild(el("p", { style: "font-size: 11px; color: var(--muted); margin: 4px 0 0;", text: slack.botTokenConfigured ? `configured (${slack.botTokenMasked})` : "not configured -- the integration stays inactive regardless of the Enabled toggle until a token is set" }));

  return section;
}
