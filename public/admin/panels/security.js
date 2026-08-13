// Security panel: admin password change.

import { el } from "../dom.js";
import { api, showToast } from "../api.js";
import { reloadAfter } from "../state.js";

export function renderSecurityPanel() {
  const section = el("section", { class: "panel" });
  section.appendChild(el("h2", { text: "Security" }));
  section.appendChild(el("p", { class: "desc", text: "Change the admin password used to sign in here and access remote control." }));

  const current = el("input", { type: "password", placeholder: "Current password" });
  const next = el("input", { type: "password", placeholder: "New password (min 8 chars)" });
  section.appendChild(el("div", { class: "row" }, [current, next, el("button", { class: "primary", text: "Change password", onclick: () => {
    if (!current.value || !next.value) return showToast("Fill in both fields", true);
    reloadAfter(api("/admin/api/change-password", { method: "POST", body: { currentPassword: current.value, newPassword: next.value } }), "Password changed");
  }})]));

  return section;
}
