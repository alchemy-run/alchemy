// TanStack server functions ARE the site's public API: the browser
// reaches these over Start's own transport (POST /_serverFn/<id>), and
// each handler dispatches the backend method in-process through the
// VALUE form of `createClient` — trusted server code, no extra HTTP hop.
// Schema-less RPC never crosses the trust boundary itself.
import { createServerFn } from "@tanstack/react-start";
import { backend } from "../lib/backend.ts";

/** Read the KV-backed visit counter. */
export const getVisits = createServerFn().handler(() => backend.visits());

/** Increment the KV-backed visit counter and return the new count. */
export const bumpVisits = createServerFn({ method: "POST" }).handler(() =>
  backend.bump(),
);

/** Send a message to the Jobs queue — the consumer catches up async. */
export const enqueueJob = createServerFn({ method: "POST" })
  .validator((message: string) => message)
  .handler(({ data }) => backend.enqueue(data));

/** Read the queue consumer's processed state. */
export const getProcessed = createServerFn().handler(() => backend.processed());
