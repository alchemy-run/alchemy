/**
 * Process bootstrap for Rivet **runner** containers. The generated entry is
 * a thin shim importing only `alchemy/Runtime/Bootstrap/RivetRunner` and
 * the user's `main` — see {@link ./Process.ts} for why the wiring lives in
 * a real module instead of an inline template string. The bridge itself
 * lives with the other Rivet bridges in `Rivet/WorkerBridge.ts`.
 */
export {
  bootstrap,
  type RivetRunnerOptions,
} from "../../Rivet/WorkerBridge.ts";
