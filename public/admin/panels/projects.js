// Projects panel: workspace roster, budget bars, per-agent badges,
// lifecycle controls (pause/resume/reset PM/re-assign/delete), the
// per-project Slack channel field, and lazy-loaded chat sessions.

import { el } from "../dom.js";
import { api, showToast } from "../api.js";
import { state, reloadAfter, loadState } from "../state.js";

function renderChat(chat) {
  const row = el("div", { style: "display: flex; align-items: center; gap: 6px; padding: 4px 8px; background: var(--bg); border: 1px solid var(--border); border-radius: 6px;" });
  row.appendChild(el("span", { style: "font-size: 12px; min-width: 80px;", text: chat.title }));
  row.appendChild(el("span", { class: `badge ${chat.active ? "ok" : "off"}`, style: "font-size: 10px; padding: 1px 6px;", text: chat.active ? `Active` : "Stopped" }));

  if (chat.active) {
    const urlInput = el("input", { type: "text", style: "flex: 1; font-size: 11px; padding: 3px 6px; background: var(--panel); border: 1px solid var(--border); color: var(--text); border-radius: 4px;", value: chat.connectUrl, readonly: "readonly" });
    row.appendChild(urlInput);
    row.appendChild(el("button", { style: "font-size: 11px; padding: 2px 6px;", text: "Copy", onclick: () => { navigator.clipboard.writeText(chat.connectUrl); showToast("Copied"); } }));
    row.appendChild(el("button", { style: "font-size: 11px; padding: 2px 6px;", text: "Open", onclick: () => window.open(chat.connectUrl, "_blank") }));
    row.appendChild(el("button", { style: "font-size: 11px; padding: 2px 6px; color: var(--danger);", text: "Stop", onclick: () => reloadAfter(
      api(`/admin/api/chats/${chat.id}/stop`, { method: "POST" }), "Chat stopped"
    )}));
  } else {
    row.appendChild(el("button", { class: "primary", style: "font-size: 11px; padding: 2px 6px;", text: "Reopen", onclick: () => reloadAfter(
      api(`/admin/api/chats/${chat.id}/reopen`, { method: "POST" }), "Chat reopened"
    )}));
    row.appendChild(el("button", { style: "font-size: 11px; padding: 2px 6px; color: var(--danger);", text: "Delete", onclick: () => {
      if (!confirm(`Delete chat "${chat.title}"?`)) return;
      reloadAfter(api(`/admin/api/chats/${chat.id}`, { method: "DELETE" }), "Chat deleted");
    }}));
  }
  return row;
}

export function renderProjectsPanel() {
  const section = el("section", { class: "panel" });
  section.appendChild(el("h2", { text: "Projects" }));
  section.appendChild(el("p", { class: "desc", text: "Each project is a workspace folder. A chat is a connectable session for that workspace -- open it from your phone, another computer, or the Custos desktop app to stream turns against the project's folder. The connect link is a bearer credential: anyone with it can type into that session. Don't share it, and don't expose this port past a network you trust." }));

  // New project button + Migrate now button
  section.appendChild(el("div", { class: "row" }, [
    el("button", { class: "primary", text: "New project", onclick: async () => {
      const name = prompt("Project name:");
      if (!name || !name.trim()) return;
      reloadAfter(api("/admin/api/projects", { method: "POST", body: { name: name.trim() } }), "Project created");
    }}),
    el("button", { text: "Migrate now", title: "Apply fallback-set defaults to any agents that still use direct model assignments; safe to call anytime, only touches agents without a fallbackSet", onclick: async () => {
      try {
        const result = await api("/admin/api/projects/migrate-fallback-sets", { method: "POST" });
        if (result.migrated > 0) {
          showToast(`Migrated ${result.migrated} agent(s) to fallback-set defaults — PM will re-evaluate on next tick`);
        } else {
          showToast("All agents already have a fallback set — nothing to migrate");
        }
        await loadState();
      } catch (err) {
        showToast(err.message, true);
      }
    }}),
  ]));

  const projects = state.projects || [];
  if (projects.length === 0) {
    section.appendChild(el("p", { class: "small", text: "No projects yet." }));
  } else {
    const table = el("table", { style: "table-layout: fixed;" });
    const colgroup = el("colgroup", {}, [
      el("col", { style: "width: 28%;" }),
      el("col", { style: "width: 26%;" }),
      el("col", { style: "width: 46%;" }),
    ]);
    table.appendChild(colgroup);

    // Compact header
    const thead = el("thead", {});
    thead.appendChild(el("tr", {}, [
      el("th", { text: "Project" }),
      el("th", { text: "Budget" }),
      el("th", { text: "Agents · Controls" }),
    ]));
    table.appendChild(thead);

    const tbody = el("tbody", {});

    for (const project of projects) {
      const tr = el("tr", {});
      const id = project.id;

      // --- Column 1: Name + workspace + chat toggle ---
      const nameCell = el("td", { style: "vertical-align: top;" });
      nameCell.appendChild(el("strong", { text: project.name }));
      nameCell.appendChild(el("br"));
      nameCell.appendChild(el("span", { class: "small", text: project.workspaceDir }));

      // Lazy-load toggle: fetches chats on first click, toggles detail row after.
      const chatToggle = el("span", {
        class: "small",
        style: "cursor: pointer; color: var(--accent); margin-left: 4px;",
        text: `► Chats`,
        onclick: async (ev) => {
          ev.stopPropagation();
          let detailRow = tr.nextElementSibling;
          if (!detailRow || !detailRow.classList.contains("chat-detail")) {
            // First click — fetch chats and build the detail row.
            chatToggle.textContent = "► Loading…";
            let chats;
            try {
              const resp = await api(`/admin/api/projects/${project.id}/chats`);
              chats = resp.chats || [];
            } catch {
              chats = [];
            }
            detailRow = el("tr", { class: "chat-detail" });
            const detailTd = el("td", { colspan: "3", style: "padding: 0; border: none;" });
            const chatWrap = el("div", { style: "margin: 0 0 8px 0; display: flex; flex-direction: column; gap: 4px;" });
            for (const chat of chats) {
              chatWrap.appendChild(renderChat(chat));
            }
            detailTd.appendChild(chatWrap);
            detailRow.appendChild(detailTd);
            tr.parentNode.insertBefore(detailRow, tr.nextSibling);
          }
          const hidden = detailRow.style.display === "none";
          detailRow.style.display = hidden ? "" : "none";
          chatToggle.textContent = hidden ? "▲ Chats" : "► Chats";
        },
      });
      nameCell.appendChild(chatToggle);
      tr.appendChild(nameCell);

      // --- Column 2: Budget bar (compact inline) ---
      const budgetCell = el("td", { style: "vertical-align: middle;" });
      const budget = project.budget;
      if (budget && budget.monthlyUsd != null) {
        const limit = budget.monthlyUsd;
        const spent = project.spentUsd ?? 0;
        const pct = Math.min(100, Math.round((spent / limit) * 100));
        let cls = "ok";
        if (pct >= 90) cls = "danger";
        else if (pct >= 70) cls = "warn";
        const now = new Date();
        const resetDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
        const resetStr = resetDate.toLocaleDateString(undefined, { month: "short", day: "numeric" });

        budgetCell.appendChild(el("div", { style: "display: flex; align-items: center; gap: 6px;" }, [
          el("span", { class: "budget-label", text: `$${spent.toFixed(0)}` }),
          el("div", { style: "flex: 1; background: var(--bg); border-radius: 999px; height: 6px; overflow: hidden; min-width: 60px;" }, [
            el("div", { class: `budget-bar-fill ${cls}`, style: `width: ${Math.max(2, pct)}%; height: 100%; border-radius: 999px;` }),
          ]),
          el("span", { class: "budget-label", text: `$${limit.toFixed(0)}` }),
          el("span", { class: "small", text: `↻${resetStr}` }),
        ]));
      } else {
        budgetCell.appendChild(el("span", { class: "small", text: "—" }));
      }
      tr.appendChild(budgetCell);

      // --- Column 3: Agent badges + action buttons ---
      const controlsCell = el("td", { style: "vertical-align: middle;" });

      // Agent roster (compact inline badges)
      const roster = project.agents || [];
      const roleLabels = { "product-owner": "PO", "engineering-manager": "EM", engineer: "Eng", qa: "QA", devops: "DevOps" };
      const roleOrder = ["product-owner", "engineering-manager", "engineer", "qa", "devops"];
      const byRole = new Map(roster.filter((a) => roleOrder.includes(a.role)).map((a) => [a.role, a]));
      const shown = roleOrder.map((r) => byRole.get(r)).filter(Boolean);

      if (shown.length || project.pmLastRunAt) {
        const badgesRow = el("div", { style: "display: flex; flex-wrap: wrap; gap: 3px; margin-bottom: 6px; align-items: center;" });
        for (const agent of shown) {
          // Compact badge: fallback set is the headline when assigned (the
          // runtime dispatches through `custos:fallback/<set-name>` when
          // fallbackSet is set, so the legacy providerKey/model is just
          // a "primary pick" hint for the human reading this card -- not
          // what the runtime actually uses). When no fallbackSet is set
          // we fall back to providerKey/model so the card still has a
          // informative label.
          // Tooltip carries the full providerKey/model, the fallback set
          // name (or a "no fallback set" note), the specialty, and the
          // QA stats so the operator can dig in without leaving the page.
          const tooltipLines = [`Provider/model: ${agent.providerKey}/${agent.model}`];
          if (agent.fallbackSet) {
            tooltipLines.push(`Fallback set: ${agent.fallbackSet} (runtime uses this for per-request failover)`);
          } else {
            tooltipLines.push("Fallback set: none (legacy pinned model)");
          }
          if (agent.specialty) tooltipLines.push(`Specialty: ${agent.specialty}`);
          const { assigned, completed, qaRejections } = agent.stats || {};
          const statsParts = [];
          if (assigned != null) statsParts.push(`Assigned: ${assigned}`);
          if (completed != null) statsParts.push(`Done: ${completed}`);
          if (qaRejections != null) statsParts.push(`QA ✘: ${qaRejections}`);
          if (statsParts.length) tooltipLines.push(statsParts.join(" | "));
          if (agent.notes?.length) {
            const lastNote = agent.notes[agent.notes.length - 1];
            tooltipLines.push(`Last note: ${lastNote.length > 80 ? lastNote.slice(0, 80) + "..." : lastNote}`);
          }
          // Headline: fallback set when set, otherwise the legacy model.
          // The ":" separator matches the previous style so a row of mixed
          // agents (some with fallbackSets, some without) still reads as
          // [role]: [what lives at that role].
          const label = agent.fallbackSet
            ? `${roleLabels[agent.role]}: ${agent.fallbackSet}`
            : `${roleLabels[agent.role]}:${agent.model.includes("/") ? agent.model.split("/").pop() : agent.model}`;
          badgesRow.appendChild(el("span", {
            class: `badge ${agent.role === "engineer" ? "warn" : "ok"}`,
            style: "font-size: 10px; padding: 1px 5px; cursor: help;",
            title: tooltipLines.join("\n"),
            text: label,
          }));
        }
      if (project.pmLastRunAt) {
        const pmDate = new Date(project.pmLastRunAt);
        // The footer label is the operator-facing hint: "Last PM run: <date>"
        // is the discoverable thing the original anonymous timestamp
        // wasn't. The status hint after the date says whether to expect
        // the PM to do anything more without intervention -- when
        // pmConfigured is true the assignments are stable until the
        // operator resets, and after a Reset the next tick will overwrite
        // both the assignments and pmLastRunAt. The two states are
        // legitimately different enough that hiding one as the other's
        // tooltip would be misleading.
        const stamp = `${pmDate.toLocaleDateString()} ${pmDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
        const hint = project.pmConfigured
          ? " — assignments are stable until you click Reset PM"
          : " — will re-run on next tick";
        badgesRow.appendChild(el("span", { class: "small", style: "font-size: 10px;", title: "Last PM run" + hint, text: `Last PM run: ${stamp}${hint}` }));
      }
        controlsCell.appendChild(badgesRow);
      }

      // Action buttons row
      const actions = el("div", { style: "display: flex; flex-wrap: wrap; gap: 4px; align-items: center;" });
      actions.appendChild(el("button", { style: "font-size: 11px; padding: 3px 8px;", text: "Chat", onclick: () => reloadAfter(
        api(`/admin/api/projects/${project.id}/chats`, { method: "POST", body: {} }), "Chat started"
      )}));
      actions.appendChild(el("button", { style: "font-size: 11px; padding: 3px 8px;", text: "Rename", onclick: () => {
        const name = prompt("Project name:", project.name);
        if (!name || !name.trim() || name.trim() === project.name) return;
        reloadAfter(api(`/admin/api/projects/${project.id}`, { method: "PATCH", body: { name: name.trim() } }), "Renamed");
      }}));
      if (project.paused) {
        actions.appendChild(el("button", { class: "primary", style: "font-size: 11px; padding: 3px 8px;", text: "Resume", onclick: () => reloadAfter(
          api(`/admin/api/projects/${project.id}/resume`, { method: "POST" }), "Project resumed"
        )}));
      } else {
        actions.appendChild(el("button", { style: "font-size: 11px; padding: 3px 8px;", text: "Pause", onclick: () => reloadAfter(
          api(`/admin/api/projects/${project.id}/pause`, { method: "POST" }), "Project paused"
        )}));
      }
      actions.appendChild(el("button", { style: "font-size: 11px; padding: 3px 8px;", text: "Reset PM", title: "Flip pmConfigured to false so the Project Manager re-evaluates on the next tick; doesn't run the PM now", onclick: () => reloadAfter(
        api(`/admin/api/projects/${project.id}/reset-pm`, { method: "POST" }), "PM reset — will re-run on next tick"
      )}));
      actions.appendChild(el("button", { style: "font-size: 11px; padding: 3px 8px;", text: "Re-assign", title: "Force the Project Manager to run now and overwrite current assignments", onclick: () => reloadAfter(
        api(`/admin/api/projects/${project.id}/reassign-models`, { method: "POST" }), "Project Manager re-assigning models"
      )}));
      actions.appendChild(el("button", { class: "danger", style: "font-size: 11px; padding: 3px 8px;", text: "Delete", onclick: () => {
        if (!confirm(`Delete "${project.name}"? This stops and removes all its chats -- the workspace folder and its files are left untouched.`)) return;
        reloadAfter(api(`/admin/api/projects/${project.id}`, { method: "DELETE" }), "Project deleted");
      }}));
      controlsCell.appendChild(actions);

      // Slack channel row -- which channel this project's agent activity
      // posts to and picks up dropped ideas from. Blank means this
      // project has no Slack channel wired up (independent of the global
      // Slack panel's Enabled toggle, which is a killswitch for the
      // whole integration regardless of which projects have a channel).
      const slackRow = el("div", { style: "display: flex; align-items: center; gap: 4px; margin-top: 4px;" });
      slackRow.appendChild(el("span", { class: "small", style: "min-width: 40px;", text: "Slack" }));
      const slackInput = el("input", { type: "text", value: project.slackChannelId || "", placeholder: "channel ID (e.g. C0123456)", style: "flex: 1; font-size: 11px; padding: 3px 6px;" });
      slackRow.appendChild(slackInput);
      slackRow.appendChild(el("button", { style: "font-size: 11px; padding: 2px 6px;", text: "Save", onclick: () => {
        const value = slackInput.value.trim();
        reloadAfter(
          api(`/admin/api/projects/${project.id}/settings`, { method: "PATCH", body: { slackChannelId: value || null } }),
          value ? "Slack channel saved" : "Slack channel cleared",
        );
      }}));
      controlsCell.appendChild(slackRow);

      tr.appendChild(controlsCell);
      tbody.appendChild(tr);

    }

    table.appendChild(tbody);
    section.appendChild(table);
  }

  return section;
}
