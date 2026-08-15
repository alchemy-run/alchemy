// The trusted seam: a VALUE import of the backend + `createClient(Backend)`
// dispatches methods in-process inside the Worker — no HTTP hop, no schema.
// SvelteKit's load + form actions ARE the public API the browser talks to;
// the schema-less client never leaves server code. The incoming request's
// headers are threaded so backend methods can self-authorize
// (cookies/authorization via `HttpServerRequest`).
//
// `+page.server.ts` never ships to the browser, so the value import is safe
// here — `+page.svelte` only submits forms and fetches framework routes.
import { createClient } from "alchemy/Client";
import Backend from "../backend.ts";

export const load = async ({ request }: { request: Request }) => {
  const backend = createClient(Backend, { headers: request.headers });
  return {
    visits: await backend.visits(),
    processed: await backend.processed(),
  };
};

export const actions = {
  bump: async ({ request }: { request: Request }) => {
    const backend = createClient(Backend, { headers: request.headers });
    return { bumped: await backend.bump() };
  },
  enqueue: async ({ request }: { request: Request }) => {
    const backend = createClient(Backend, { headers: request.headers });
    const form = await request.formData();
    const message = String(form.get("message") || "hello queue");
    await backend.enqueue(message);
    return { enqueued: message };
  },
};
