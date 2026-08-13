// The one HTTP client every panel calls through, and the toast it drives
// on error. No app state here -- see state.js for that.

import { $ } from "./dom.js";

export async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { "content-type": "application/json", ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) {
    location.href = "/login?next=" + encodeURIComponent(location.pathname);
    return new Promise(() => {}); // never resolves -- we're navigating away
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

export function showToast(message, isError = false) {
  const t = $("#toast");
  t.textContent = message;
  t.className = "toast show" + (isError ? " error" : "");
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => { t.className = "toast"; }, 3000);
}
