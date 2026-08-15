// The SERVER-side backend client — for server functions and SSR loaders
// only (the value form dispatches backend methods in-process; browser code
// reaches the backend exclusively through TanStack server functions).
// `getRequestHeaders` resolves per call, so this module-scope client stays
// per-request-correct (methods can read the caller's cookies via
// `HttpServerRequest`).
import { getRequestHeaders } from "@tanstack/react-start/server";
import { createClient, type RpcClient } from "alchemy/Client";
import Backend from "../backend.ts";

export const backend: RpcClient<typeof Backend> = createClient(Backend, {
  headers: () => {
    const headers: Record<string, string> = {};
    getRequestHeaders().forEach((value, key) => {
      headers[key] = value;
    });
    return headers;
  },
});
