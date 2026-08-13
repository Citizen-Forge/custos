// -- Queue activity log --------------------------------------------------
//
// Surfaces the global queue's recent dispatch events so an operator can
// see, at a glance, what work is flowing through which provider — without
// having to trawl server logs. Each row is one event (queued / dispatched
// / fallback / succeeded / failed); a single logical request shows up as
// multiple rows in sequence, linked by requestId on the wire but
// recognisable in the table by identical project/agent/provider. The
// auto-poll fires every 5 seconds so a stalled chain is visible while the
// operator is staring at the page; the manual Refresh button forces an
// immediate re-fetch after a config change.

import { el } from "../dom.js";
import { api } from "../api.js";

let queueActivityPollHandle = null;

export function renderQueueActivityPanel() {
  const section = el("section", { class: "panel" });
  section.appendChild(el("h2", { text: "Queue activity" }));
  section.appendChild(el("p", { class: "desc", text: "Recent work dispatched through the global queue, oldest at the bottom. Rows tagged with the same project + agent came from one logical request; a request that walked the chain shows queued → dispatched → fallback → succeeded across multiple rows. Auto-refreshes every 5s." }));

  const body = el("div", { class: "panel-body" });

  // Outcome filter state: null = show all, otherwise a string matching ev.outcome.
  let filterOutcome = null;
  const OUTCOME_FILTERS = [
    { value: null, label: "All", color: "var(--muted)" },
    { value: "succeeded", label: "✓ succeeded", color: "var(--ok)" },
    { value: "failed", label: "✕ failed", color: "var(--danger)" },
    { value: "fallback", label: "↪ fallback", color: "var(--warn)" },
    { value: "stuck-request", label: "⏱ stuck", color: "var(--warn)" },
    { value: "dispatched", label: "→ dispatched", color: "var(--accent)" },
    { value: "queued", label: "queued", color: "var(--muted)" },
    { value: "compact", label: "📦 compact", color: "var(--accent)" },
  ];

  const filterRow = el("div", { class: "row", style: "margin-bottom: 10px; gap: 5px;" });
  filterRow.appendChild(el("span", { class: "small", text: "Filter:" }));
  let activeFilterBtn = null;
  function setActiveFilter(btn) {
    if (activeFilterBtn) {
      activeFilterBtn.style.background = "";
      activeFilterBtn.style.color = "";
    }
    activeFilterBtn = btn;
    if (btn) {
      btn.style.background = "var(--accent)";
      btn.style.color = "#0d1117";
    }
  }
  for (const f of OUTCOME_FILTERS) {
    const btn = el("button", {
      style: `font-size: 11px; padding: 3px 9px; border-radius: 999px; color: ${f.color};`,
      text: f.label,
    });
    if (f.value === null) setActiveFilter(btn);
    btn.onclick = () => {
      filterOutcome = f.value;
      setActiveFilter(btn);
      void refreshQueueActivity();
    };
    filterRow.appendChild(btn);
  }
  body.appendChild(filterRow);

  const tbody = el("tbody");
  const table = el("table", { class: "activity-table" });
  table.appendChild(el("thead", {}, [el("tr", {}, [
    el("th", { text: "Time" }),
    el("th", { text: "Project" }),
    el("th", { text: "Agent" }),
    el("th", { text: "Role" }),
    el("th", { text: "Set" }),
    el("th", { text: "Provider" }),
    el("th", { text: "Model" }),
    el("th", { text: "Outcome" }),
    el("th", { text: "Duration" }),
  ])]));
  table.appendChild(tbody);
  body.appendChild(table);

  const statusLine = el("div", { class: "small", style: "margin-top: 6px;" });
  body.appendChild(statusLine);

  const refreshBtn = el("button", { style: "font-size: 11px; padding: 3px 8px;", text: "Refresh", onclick: async () => {
    refreshBtn.disabled = true;
    refreshBtn.textContent = "↻";
    try {
      await refreshQueueActivity();
    } finally {
      refreshBtn.disabled = false;
      refreshBtn.textContent = "Refresh";
    }
  }});
  const controls = el("div", { class: "row", style: "margin-top: 8px;" });
  controls.appendChild(refreshBtn);
  body.appendChild(controls);

  section.appendChild(body);

  async function refreshQueueActivity() {
    try {
      const resp = await api("/admin/api/queue/activity?limit=100");
      let events = resp.events || [];
      if (filterOutcome !== null) {
        events = events.filter((ev) => ev.outcome === filterOutcome);
      }
      tbody.innerHTML = "";
      if (events.length === 0) {
        tbody.appendChild(el("tr", {}, [el("td", { colspan: "9", class: "muted", text: "No queue activity yet — dispatch an agent or trigger the chat to see events stream in." })]));
      } else {
        for (const ev of events) tbody.appendChild(renderQueueActivityRow(ev));
      }
      const cap = resp.capacity ?? (resp.events || []).length;
      const filteredNote = filterOutcome !== null ? ` (filtered to ${events.length})` : "";
      statusLine.textContent = `Showing ${events.length} of last ${cap} events (newest first).${filteredNote}`;
    } catch (err) {
      statusLine.textContent = `Failed to load: ${err.message}`;
    }
  }

  // Kick off the first fetch and start the 5s auto-poll. The poll
  // survives across renders via the closure on `tbody` and `statusLine`
  // — when render() runs again it replaces the DOM nodes, but the
  // previous interval keeps firing harmlessly (its writes land in
  // detached nodes that get GC'd). Clearing the handle on render()
  // exit avoids the leak entirely.
  refreshQueueActivity();
  if (queueActivityPollHandle) clearInterval(queueActivityPollHandle);
  queueActivityPollHandle = setInterval(() => { void refreshQueueActivity(); }, 5000);

  return section;
}

function renderQueueActivityRow(ev) {
  const time = new Date(ev.timestamp).toISOString().substr(11, 8);
  const outcomeLabel = {
    queued: "queued",
    dispatched: "→ dispatched",
    fallback: "↪ fallback",
    succeeded: "✓ succeeded",
    failed: "✕ failed",
    compact: "📦 compact",
  }[ev.outcome] || ev.outcome;
  const duration = ev.durationMs != null ? `${ev.durationMs}ms` : (ev.queuedAt != null ? `…${Date.now() - ev.queuedAt}ms` : "—");
  const tr = el("tr", { class: `outcome-${ev.outcome}` });
  tr.appendChild(el("td", { class: "time-cell", title: new Date(ev.timestamp).toISOString(), text: time }));
  tr.appendChild(el("td", { class: "project-cell", text: ev.projectName || ev.projectId || "—" }));
  tr.appendChild(el("td", {}, [
    el("span", { text: ev.agentName || ev.agentId || "—" }),
    ev.agentId && ev.agentName ? el("br") : null,
    ev.agentId && ev.agentName ? el("span", { class: "muted", style: "font-size: 10px;", text: ev.agentId }) : null,
  ].filter(Boolean)));
  tr.appendChild(el("td", { class: "muted", text: ev.role || "—" }));
  tr.appendChild(el("td", { class: "muted", text: ev.fallbackSet || "—" }));
  tr.appendChild(el("td", { class: "muted", text: ev.provider || "—" }));
  tr.appendChild(el("td", { class: "muted", text: ev.model || "—" }));
  const outcomeTd = el("td", { class: `outcome-cell outcome-${ev.outcome}`, text: outcomeLabel });
  if (ev.errorMessage) outcomeTd.title = ev.errorMessage;
  tr.appendChild(outcomeTd);
  tr.appendChild(el("td", { class: "duration-cell", text: duration }));
  return tr;
}
