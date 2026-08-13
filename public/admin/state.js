// The one mutable blob of app state every panel reads from, plus the two
// functions that keep it fresh. `state` is a live binding: importers see
// updates made here without re-importing.
//
// state.js deliberately does NOT import render.js to render itself after a
// reload -- that would cycle with render.js -> panels/*.js -> state.js.
// Instead main.js registers the real render function via
// setOnStateChanged() once, at startup.

import { api, showToast } from "./api.js";

export let state = null;

let onStateChanged = () => {};

export function setOnStateChanged(fn) {
  onStateChanged = fn;
}

// Re-render without a network round-trip -- for callers that mutated
// `state` locally (e.g. the fallback-set health refresh, which re-fetches
// just /admin/api/runtime/stats) and need the DOM to reflect it.
export function notifyStateChanged() {
  onStateChanged();
}

export async function loadState() {
  state = await api("/admin/api/state");
  // Fetch version (commit hash) and display in header.
  api("/admin/api/version").then((v) => {
    const el = document.getElementById("commit-hash");
    if (el && v.commit) {
      el.textContent = v.commit;
      el.title = `Deployed commit: ${v.commit}`;
    }
  }).catch(() => {/* version endpoint is informational only */});
  // Global services (memory curator, permission classifier, embeddings)
  // share their own panel. Pre-load so render() can show them without
  // a follow-up fetch.
  try {
    state.globalAgents = (await api("/admin/api/global-agents")).agents || [];
  } catch {
    state.globalAgents = [];
  }
  state.projects = (await api("/admin/api/projects")).projects;
  for (const project of state.projects) {
    // Chats are lazy-loaded on first click of the chat toggle — no pre-fetch.
    project.chats = null;
    // Fetch per-project settings which include budget + spend data AND agent roster.
    const settingsResp = await api(`/admin/api/projects/${project.id}/settings`);
    project.budget = settingsResp.settings.budget;
    project.spentUsd = settingsResp.spentUsd ?? 0;
    project.subscriptionUsd = settingsResp.subscriptionUsd ?? 0;
    project.agents = settingsResp.agents ?? [];
    project.pmLastRunAt = settingsResp.settings.pmLastRunAt ?? null;
    project.pmConfigured = settingsResp.settings.pmConfigured ?? false;
    project.paused = settingsResp.settings.paused ?? false;
    project.slackChannelId = settingsResp.settings.slackChannelId ?? null;
  }
  // Per-fallback-set health snapshot. Refreshed on demand via the
  // panel's "Refresh" button; the boot-time fetch gives operators
  // an immediate signal whether any chain is currently exhausted.
  // The panel distinguishes "no fallback sets configured" from
  // "stats endpoint unreachable" so a 5xx on /admin/api/runtime/stats
  // doesn't read as a healthy chain to the operator.
  try {
    const stats = await api("/admin/api/runtime/stats");
    state.fallbackSetHealth = stats.fallbackSets || {};
    state.fallbackSetHealthError = null;
  } catch (err) {
    state.fallbackSetHealth = {};
    state.fallbackSetHealthError = err.message || "stats endpoint unreachable";
  }
  onStateChanged();
}

export async function reloadAfter(promise, successMessage) {
  try {
    await promise;
    showToast(successMessage);
    await loadState();
  } catch (err) {
    showToast(err.message, true);
  }
}
