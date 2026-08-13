// All agents panel: fleet-wide view of every agent across every project,
// polled every 5s, with a lifecycle filter that persists in localStorage.

import { el } from "../dom.js";
import { api } from "../api.js";
import { formatTimeAgo } from "../utils.js";

// Mirrors TeamTab.tsx's TAG_LABELS. Ticket/idea-scoped tags aren't
// listed since workItemTitle already covers them -- this only backs the
// "no ticket" fallback in renderRow below.
//
// Module-level (not a local inside renderAllAgentsPanel): the original
// inline version was declared as a `const` textually AFTER that
// function's unconditional `return section;`, making it unreachable --
// any row that fell through to the tag-label fallback would throw
// "Cannot access 'TAG_LABELS' before initialization" instead of
// rendering. Hoisting it here (and renderRow below) fixes that.
const TAG_LABELS = {
  "custos-groom": "Grooming backlog",
  "custos-assign": "Assigning ready work",
  "custos-survey": "Surveying codebase",
  "custos-assign-models": "Assigning models",
  "custos-provision": "Provisioning repository",
};

export function renderAllAgentsPanel() {
  const section = el("section", { class: "panel" });
  section.appendChild(el("h2", { text: "All agents" }));
  section.appendChild(el("p", { class: "desc", text: "Every agent across every project — what they're doing right now, last moved, and current work item. Auto-refreshes every 5 seconds." }));

  const filterSelect = el("select", {}, [
    el("option", { value: "all", text: "All" }),
    el("option", { value: "active", text: "Running + waiting + stalled" }),
    el("option", { value: "stalled", text: "Stalled only" }),
    el("option", { value: "failed", text: "Recent failures" }),
    el("option", { value: "idle", text: "Idle" }),
  ]);
  // Default to "All" so first-time visitors see idle agents too -- in
  // particular "the devops agent hasn't run in 2 hours" is exactly an
  // idle row, and a default of "active" hides it. The filter choice
  // persists in localStorage so an operator who tunes to "stalled
  // only" keeps that view across reloads.
  try {
    const stored = localStorage.getItem("custos.allAgents.filter");
    filterSelect.value = stored || "all";
  } catch { filterSelect.value = "all"; }
  section.appendChild(el("div", { class: "row" }, [
    el("label", { text: "Show" }),
    filterSelect,
    el("span", { class: "small", text: "Filter by lifecycle state across the fleet" }),
  ]));

  const statusLine = el("div", { class: "small", style: "margin-bottom: 8px;" });
  section.appendChild(statusLine);

  const tableWrap = el("div", {});
  section.appendChild(tableWrap);

  // Relative-time labels tick forward independently of the data
  // refresh so "last moved 12s" doesn't sit stale while a long run
  // is mid-flight (matches the per-project TeamTab pattern).
  let now = Date.now();
  const nowTick = setInterval(() => { now = Date.now(); refreshTable(); }, 10_000);

  function rowMatchesFilter(row) {
    const s = row.summary.status;
    switch (filterSelect.value) {
      case "all": return true;
      case "active": return s === "running";
      case "stalled": return s === "running" && row.summary.isStalled;
      case "failed": return s === "failed";
      case "idle": return s === "idle";
      default: return true;
    }
  }

  function renderRow(project, agent) {
    const summary = agent.summary;
    const stateBadge = (() => {
      switch (summary.status) {
        case "running": {
          if (summary.isStalled) return el("span", { class: "badge stalled", text: "stalled" });
          const t = summary.lastEventAt ? now - summary.lastEventAt : 0;
          if (t > 120_000) return el("span", { class: "badge warn", text: "waiting" });
          return el("span", { class: "badge working", text: "running" });
        }
        case "succeeded": return el("span", { class: "badge succeeded", text: "succeeded" });
        case "failed": return el("span", { class: "badge failed", text: "failed" });
        case "idle": return el("span", { class: "badge off", text: "idle" });
        default: return el("span", { class: "badge off", text: summary.status });
      }
    })();
    const workingOn = summary.workItemTitle
      || (summary.currentAction ? summary.currentAction.slice(0, 60) : null)
      || (summary.status === "idle" ? "—" : (TAG_LABELS[summary.tag] || "Project duties"));

    let lastMovedCell;
    if (summary.lastEventAt) lastMovedCell = formatTimeAgo(summary.lastEventAt, now);
    else if (summary.endedAt) lastMovedCell = formatTimeAgo(summary.endedAt, now);
    else if (summary.status === "idle") lastMovedCell = "never";
    else lastMovedCell = "—";

    return el("tr", {}, [
      el("td", { text: project.name }),
      el("td", {}, [el("strong", { text: agent.agentName || agent.agentId })]),
      el("td", { text: agent.role || "—" }),
      el("td", {}, [stateBadge]),
      el("td", { text: workingOn, title: summary.currentAction || summary.summary || summary.error || "" }),
      el("td", { class: "small", text: lastMovedCell }),
    ]);
  }

  function renderRows(projects) {
    const rows = [];
    for (const project of projects) {
      for (const agent of project.agents) {
        if (rowMatchesFilter(agent)) rows.push({ project, agent });
      }
    }
    // Sort: running (most recently active first) → recent failures →
    // idle/succeeded, then by project name + agent name for stable
    // secondary ordering.
    rows.sort((a, b) => {
      const order = { running: 0, failed: 1, succeeded: 2, idle: 3 };
      const sa = order[a.agent.summary.status] ?? 99;
      const sb = order[b.agent.summary.status] ?? 99;
      if (sa !== sb) return sa - sb;
      if (sa === 0) {
        const la = a.agent.summary.lastEventAt || 0;
        const lb = b.agent.summary.lastEventAt || 0;
        if (la !== lb) return lb - la;
      }
      return a.project.name.localeCompare(b.project.name) || a.agent.agentName.localeCompare(b.agent.agentName);
    });
    tableWrap.innerHTML = "";
    if (rows.length === 0) {
      tableWrap.appendChild(el("p", { class: "small", text: "Nothing matches the current filter." }));
      return;
    }
    const tbody = el("tbody");
    for (const { project, agent } of rows) tbody.appendChild(renderRow(project, agent));
    const table = el("table", { class: "all-agents-table" }, [
      el("thead", {}, [el("tr", {}, [
        el("th", { text: "Project" }),
        el("th", { text: "Agent" }),
        el("th", { text: "Role" }),
        el("th", { text: "State" }),
        el("th", { text: "Working on" }),
        el("th", { text: "Last moved" }),
      ])]),
      tbody,
    ]);
    tableWrap.appendChild(table);
  }

  async function refreshTable() {
    try {
      const resp = await api("/admin/api/now-working");
      renderRows(resp.projects || []);
      statusLine.textContent = `${(resp.projects || []).length} project(s), ${(resp.projects || []).reduce((n, p) => n + p.agents.length, 0)} agent(s) at scan-time ${formatTimeAgo(resp.generatedAt || Date.now())}`;
    } catch (err) {
      statusLine.textContent = `Failed to load: ${err.message}`;
      tableWrap.innerHTML = "";
    }
  }

  filterSelect.addEventListener("change", () => {
    // Persist the operator's preferred filter so the panel state
    // survives page reloads (matches the collapsible-panel pattern).
    try { localStorage.setItem("custos.allAgents.filter", filterSelect.value); } catch { /* private mode */ }
    // Force a refresh on filter change so the table reflects the new
    // state without waiting for the next poll cycle.
    void refreshTable();
  });

  // Tear down the live-tick interval when the panel is removed (e.g.
  // loadState() re-renders the page). Without this, two intervals
  // would tick forever on every loadState() call.
  const observer = new MutationObserver(() => {
    if (!document.body.contains(section)) {
      clearInterval(nowTick);
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  void refreshTable();
  return section;
}
