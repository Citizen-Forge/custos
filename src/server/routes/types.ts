import type { Runtime } from "../../runtime.js";
import type { MemoryStore } from "../../memory/store.js";
import type { RemoteSessionManager } from "../../remote/session-manager.js";

export interface RouteDeps {
  runtime: Runtime;
  memoryStore: MemoryStore;
  remoteSessionManager: RemoteSessionManager;
}
