import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./index.css";
import { connect, disconnect, loadDeployments, loadStacks } from "./ingest.ts";
import { setConnectionStatus, setTargetSlice } from "./store.ts";
import { targetFromLocation } from "./target.ts";
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
// `?stack=`/`?stage=` in the URL pin the target (hosted viewer, shared
// links, reloads); a bare `/` leaves both undefined so the server picks.
const target = targetFromLocation();
setTargetSlice(target);
connect(target);
void loadDeployments(target);
void loadStacks();
ensureRegistryLoaded();

createRoot(document.getElementById("root")!).render(<App />);
