import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./index.css";
import { connect, disconnect, loadDeployments } from "./ingest.ts";
import { setConnectionStatus } from "./store.ts";
import { initTakeover } from "./takeover.ts";
import { ensureRegistryLoaded } from "./uiRegistry.ts";

// Boot sequence: announce this tab (superseding any older dashboard tab),
// open the live SSE document stream (snapshot-first), then fetch
// deployment history and the UIProvider registry in the background. All
// ingestion mutates the store OUTSIDE React; the app renders once the
// first snapshot lands (useHydrated).
initTakeover(() => {
  disconnect();
  setConnectionStatus("superseded");
});
connect();
void loadDeployments();
ensureRegistryLoaded();

createRoot(document.getElementById("root")!).render(<App />);
