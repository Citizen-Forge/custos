import { JsonCollection, pmPath } from "./store.js";
import { defaultProjectSettings, type ProjectSettings } from "./types.js";

const settings = new JsonCollection<ProjectSettings>(pmPath("project-settings.json"));

/** Always returns something -- a project with no persisted row yet reads
 * back the defaults, so callers never have to special-case "not configured
 * yet" and the row only gets written once something is actually changed. */
export async function getSettings(projectId: string): Promise<ProjectSettings> {
  const stored = await settings.get(projectId);
  if (!stored) return defaultProjectSettings(projectId);
  // Rows written before a field existed read back undefined, which silently
  // becomes the most conservative possible value at the use site -- a
  // project saved before maxConcurrentEngineers existed was being clamped to
  // one engineer rather than picking up the new default. Merge over the
  // defaults so a new setting reaches existing projects.
  const defaults = defaultProjectSettings(projectId);
  return {
    ...defaults,
    ...stored,
    budget: { ...defaults.budget, ...stored.budget },
    autonomy: { ...defaults.autonomy, ...stored.autonomy },
  };
}

export async function updateSettings(projectId: string, patch: Partial<Omit<ProjectSettings, "id">>): Promise<ProjectSettings> {
  const existing = await settings.get(projectId);
  if (!existing) {
    const created = { ...defaultProjectSettings(projectId), ...patch, id: projectId, updatedAt: Date.now() };
    return settings.insert(created);
  }
  const updated = await settings.update(projectId, (row) => {
    Object.assign(row, patch, { id: projectId, updatedAt: Date.now() });
  });
  return updated ?? existing;
}

export async function deleteSettings(projectId: string): Promise<boolean> {
  return settings.remove(projectId);
}
