// The SERVER-side backend client — for server functions and SSR loaders
// only: the VALUE form dispatches backend methods in-process, and browser
// code reaches the backend exclusively through the TanStack server
// functions in src/server/visits.ts. `getRequestHeaders` is a thunk
// resolved fresh per call, so this module-scope client stays
// per-request-correct (methods can read the caller's cookies via
// `HttpServerRequest`).
import { getRequestHeaders } from "@tanstack/react-start/server";
import { createClient } from "alchemy/Client";
import Backend from "../backend.ts";

export const backend = createClient(Backend, {
  headers: getRequestHeaders,
});
