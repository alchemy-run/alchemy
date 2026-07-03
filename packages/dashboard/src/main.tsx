import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./index.css";
import { connect, loadDeployments } from "./ingest.ts";
import { ensureRegistryLoaded } from "./uiRegistry.ts";

// Boot sequence: open the live SSE document stream (snapshot-first), then
// fetch deployment history and the UIProvider registry in the background.
// All ingestion mutates the store OUTSIDE React; the app renders once the
// first snapshot lands (useHydrated).
connect();
void loadDeployments();
ensureRegistryLoaded();

createRoot(document.getElementById("root")!).render(<App />);
