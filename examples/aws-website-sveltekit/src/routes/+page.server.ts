// SSR seam: VALUE import + `createClient(Backend)` — the backend method
// dispatches directly in-process (no HTTP hop) inside the same Lambda
// that renders this page (and in `vite dev` alike).
import { createClient } from "alchemy/Client";
import Backend from "../backend.ts";

const backend = createClient(Backend);

export const load = async () => ({
  visits: await backend.visits(),
  processed: await backend.processed(),
});
