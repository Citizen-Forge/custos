// Composition root: assembles every panel into #app, in display order,
// each wrapped in the collapsible-panel chrome.

import { $ } from "./dom.js";
import { makeCollapsible } from "./utils.js";
import { renderProvidersPanel } from "./panels/providers.js";
import { renderGlobalServicesPanel } from "./panels/global-services.js";
import { renderAllAgentsPanel } from "./panels/all-agents.js";
import { renderQueueActivityPanel } from "./panels/queue-activity.js";
import { renderFallbackSetsPanel } from "./panels/fallback-sets.js";
import { renderProjectsPanel } from "./panels/projects.js";
import { renderMcpPanel } from "./panels/mcp.js";
import { renderSlackPanel } from "./panels/slack.js";
import { renderSecurityPanel } from "./panels/security.js";

export function render() {
  const app = $("#app");
  app.innerHTML = "";
  app.appendChild(makeCollapsible(renderProvidersPanel(), "providers"));
  app.appendChild(makeCollapsible(renderGlobalServicesPanel(), "global-services"));
  app.appendChild(makeCollapsible(renderAllAgentsPanel(), "all-agents"));
  app.appendChild(makeCollapsible(renderQueueActivityPanel(), "queue-activity"));
  app.appendChild(makeCollapsible(renderFallbackSetsPanel(), "fallback-sets"));
  app.appendChild(makeCollapsible(renderProjectsPanel(), "projects"));
  app.appendChild(makeCollapsible(renderMcpPanel(), "mcp"));
  app.appendChild(makeCollapsible(renderSlackPanel(), "slack"));
  app.appendChild(makeCollapsible(renderSecurityPanel(), "security"));
}
