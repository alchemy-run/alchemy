import { createClient } from "alchemy/Client";
import Backend from "../backend.ts";

/**
 * The SSR seam: a VALUE import of the backend + `createClient(Backend)`
 * dispatches the method in-process inside the Worker — no HTTP hop. The
 * incoming request's headers are threaded so backend methods can
 * self-authorize (cookies/authorization via `HttpServerRequest`).
 *
 * `+page.server.ts` never ships to the browser, so the value import is
 * safe here — client-side code uses the type-only form instead (see
 * `+page.svelte`).
 */
export const load = async ({ request }: { request: Request }) => {
  const backend = createClient(Backend, { headers: request.headers });
  return {
    visits: await backend.visits(),
    processed: await backend.processed(),
  };
};
