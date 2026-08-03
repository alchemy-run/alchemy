import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./index.css";
import {
  connect,
  disconnect,
  loadDeployments,
  loadStacks,
  type Target,
} from "./ingest.ts";
import {
  currentRoute,
  parseRoute,
  pathOf,
  replaceRoute,
  subscribeRoute,
} from "./route.ts";
import {
  dashboardStore,
  setConnectionStatus,
  setTargetSlice,
} from "./store.ts";
import { initTakeover } from "./takeover.ts";
import { ensureRegistryLoaded } from "./uiRegistry.ts";

// Boot: announce this tab (superseding any older dashboard tab), resolve
// which target the URL asks for, then open the live SSE document stream
// (snapshot-first) and fetch deployment history + the UIProvider registry
// in the background. All ingestion mutates the store OUTSIDE React; the
// app renders once the first snapshot lands (useHydrated).
initTakeover(() => {
  disconnect();
  setConnectionStatus("superseded");
});

const start = (target: Target): void => {
  setTargetSlice(target);
  connect(target);
  void loadDeployments(target);
};

const route = currentRoute();
if (route.kind === "target") {
  // A pinned target connects immediately — no need to wait on the
  // catalog. Canonicalize a legacy `?stack=` link to its path form.
  const canonical = pathOf(route);
  if (window.location.pathname !== canonical) {
    replaceRoute(canonical);
  }
  start({ stack: route.stack, stage: route.stage });
  void loadStacks();
} else {
  // `/` cannot decide until it knows whether an index is even possible,
  // so the catalog gates the first connect here. The CLI dashboard serves
  // no /api/stacks, so this resolves to [] almost immediately and behaves
  // exactly as before: connect to the server's default target.
  void loadStacks().then((stacks) => {
    const only = stacks.length === 1 ? stacks[0] : undefined;
    if (only !== undefined) {
      // an index of one is just a redirect
      replaceRoute(pathOf({ stack: only.stack }));
      start({ stack: only.stack, stage: undefined });
      return;
    }
    if (stacks.length > 1) {
      // stay on the index — nothing connects until a stack is chosen
      return;
    }
    start({ stack: undefined, stage: undefined });
  });
}

ensureRegistryLoaded();

createRoot(document.getElementById("root")!).render(<App />);

// Every route change re-points the transport — in-app navigation AND
// back/forward. `subscribeRoute` covers both (pushState notifies its own
// listeners; popstate is wired inside). Reconnecting is guarded on the
// target actually differing, so the boot canonicalization and any
// same-target navigation stay no-ops.
subscribeRoute(() => {
  const next = parseRoute(window.location.pathname, window.location.search);
  const live = dashboardStore.getState().connection;
  if (next.kind !== "target") {
    disconnect();
    return;
  }
  if (next.stack === live.stack && next.stage === live.stage) {
    return;
  }
  start({ stack: next.stack, stage: next.stage });
});
