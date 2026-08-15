"use server";

// Next server actions ARE the site's public API: the browser reaches
// these over Next's own action transport, and each one dispatches the
// backend method in-process through the VALUE form of `createClient` —
// trusted server code, no extra HTTP hop. Schema-less RPC never crosses
// the trust boundary itself.
import { createClient } from "alchemy/Client";
import { headers } from "next/headers";
import Backend from "./backend";

// `headers` is a thunk resolved fresh per call, so the module-scope
// client stays per-request-correct.
const backend = createClient(Backend, { headers });

/** Increment the KV-backed visit counter and return the new count. */
export async function bumpVisits(): Promise<number> {
  return backend.bump();
}

/** Send a message to the Jobs queue — the consumer catches up async. */
export async function enqueueJob(message: string): Promise<void> {
  await backend.enqueue(message);
}

/** Read the queue consumer's processed state. */
export async function getProcessed(): Promise<{
  count: number;
  last: string | null;
}> {
  return backend.processed();
}
