// Small formatting/parsing/layout helpers shared across two or more panels.
// Panel-private helpers (used by exactly one panel) live in that panel's
// own module instead of here.

import { el } from "./dom.js";
import { showToast } from "./api.js";

export function formatBytes(n) {
  if (n == null) return "—";
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(n % (1024 * 1024) === 0 ? 0 : 1) + " MB";
  if (n >= 1024) return (n / 1024).toFixed(n % 1024 === 0 ? 0 : 1) + " KB";
  return n + " B";
}

// Reads a throttle input element. Returns:
//   - undefined when the value is invalid (toast already shown) -- caller should bail
//   - null when the field is blank (== "unlimited", wire-serialized as null)
//   - a positive integer otherwise (== "throttle on, capped at N")
// `null` on the wire maps to an omitted `maxConcurrent` on config.json, so an
// unlimited instance round-trips cleanly through saveConfig -> loadConfig.
export function parseThrottle(input) {
  const raw = input.value.trim();
  const value = raw ? Number(raw) : null;
  if (value !== null && (!Number.isInteger(value) || value < 1)) {
    showToast("Max concurrent must be a positive integer (or blank for unlimited)", true);
    return undefined;
  }
  return value;
}

export function formatTimeAgo(ts, nowMs = Date.now()) {
  const diff = Math.max(0, nowMs - ts);
  if (diff < 5_000) return "just now";
  if (diff < 60_000) return Math.floor(diff / 1000) + "s ago";
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + "m ago";
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + "h ago";
  return Math.floor(diff / 86_400_000) + "d ago";
}

export function labelForRole(systemRole) {
  switch (systemRole) {
    case "memoryCurator": return "Memory curator";
    case "permissionClassifier": return "Permission classifier";
    case "embeddings": return "Embeddings";
    default: return systemRole || "(unknown)";
  }
}

// Wrap a panel so the header is a click toggle that hides the body.
// State is persisted per panel id in localStorage; default is collapsed
// so a fresh visit doesn't show every table at once. The header
// retains the original <h2> (and any leading <p class="desc"> the panel
// put there) so the section's identity is unchanged when expanded.
export function makeCollapsible(panel, panelId) {
  if (!panel || !panel.querySelector) return panel;
  const h2 = panel.querySelector("h2");
  if (!h2) return panel;
  // Wrap every child except h2 in a single panel-body div so we can
  // hide them with one CSS rule. We deliberately re-use the existing
  // header-level elements (h2 + .desc) -- they're the panel's identity
  // and belong outside the toggle.
  const headerKids = [h2];
  const desc = panel.querySelector("p.desc");
  if (desc && desc.parentNode === panel) headerKids.push(desc);
  const body = el("div", { class: "panel-body" });
  for (const child of Array.from(panel.children)) {
    if (headerKids.includes(child)) continue;
    body.appendChild(child);
  }
  const header = el("div", { class: "panel-header" });
  for (const k of headerKids) header.appendChild(k);
  const toggle = el("span", { class: "panel-toggle", text: "▾", title: "Click to collapse" });
  header.appendChild(toggle);
  panel.innerHTML = "";
  panel.appendChild(header);
  panel.appendChild(body);

  const storageKey = `custos.collapsed.${panelId}`;
  // Default = collapsed. Only flip to expanded if the operator has
  // explicitly expanded this panel before (any stored truthy value).
  const wasExpanded = localStorage.getItem(storageKey) === "false";
  if (!wasExpanded) panel.classList.add("collapsed");
  toggle.textContent = panel.classList.contains("collapsed") ? "▸" : "▾";
  header.addEventListener("click", () => {
    const collapsed = panel.classList.toggle("collapsed");
    toggle.textContent = collapsed ? "▸" : "▾";
    try { localStorage.setItem(storageKey, collapsed ? "true" : "false"); } catch { /* private mode etc. */ }
  });
  return panel;
}
