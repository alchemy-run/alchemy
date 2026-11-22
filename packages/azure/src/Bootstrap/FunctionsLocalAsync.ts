/**
 * Process entry for an async (non-Effect) `Azure.Functions.Function` under
 * `alchemy dev`: the handler file's `fetch` behind the local HTTP server
 * (see `./FunctionsLocalCore.ts`). `env` is decoded from the process env
 * exactly as on Azure (see `./FunctionsAsync.ts`).
 */
import { decode, type AsyncHandler } from "./FunctionsAsync.ts";
import { installStorageEmulator, listen } from "./FunctionsLocalCore.ts";

/** Serve `handler.fetch` on the local port. */
export const serve = async (handler: AsyncHandler, envKeys: readonly string[]): Promise<void> => {
  installStorageEmulator();
  const env: Record<string, unknown> = {};
  for (const key of envKeys) env[key] = decode(process.env[key]);
  const fetch = handler.fetch;
  await listen(
    fetch === undefined ? undefined : async (request) => fetch.call(handler, request, env),
  );
};
