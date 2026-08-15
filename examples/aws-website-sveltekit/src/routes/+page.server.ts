// The trusted seam: a VALUE import of the backend + `createClient(Backend)`
// dispatches methods directly in-process (no HTTP hop) inside the same
// Lambda that renders this page (and in `vite dev` alike). SvelteKit's load
// + form actions ARE the public API the browser talks to; the schema-less
// client never leaves server code.
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
