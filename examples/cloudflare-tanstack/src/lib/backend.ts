// The shared backend client — the same file layout as the oRPC adapter's
// `lib/orpc.ts`: ONE module-scope client whose implementation is picked per
// world by `createIsomorphicFn`.
//
// - server (SSR loaders, server functions): the VALUE form dispatches the
//   backend method in-process — no HTTP hop. `getRequestHeaders` resolves
//   per call, so this module-scope client stays per-request-correct
//   (methods can read the caller's cookies via `HttpServerRequest`).
// - client (browser): the TYPE-ONLY form POSTs to `/api/__rpc/<method>` —
//   zero backend bytes in the client bundle (the `.server()` branch and
//   the Backend value import are compiled out).
import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { createClient, type RpcClient } from "alchemy/client";
import Backend from "../backend.ts";

const getBackend = createIsomorphicFn()
  .server(() =>
    createClient(Backend, {
      headers: () => {
        const headers: Record<string, string> = {};
        getRequestHeaders().forEach((value, key) => {
          headers[key] = value;
        });
        return headers;
      },
    }),
  )
  .client(() => createClient<typeof Backend>());

export const backend: RpcClient<typeof Backend> = getBackend();
