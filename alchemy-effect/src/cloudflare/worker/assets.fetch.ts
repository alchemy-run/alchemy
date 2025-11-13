import type * as runtime from "@cloudflare/workers-types";
import { Binding, declare, type Capability } from "alchemy-effect";
import * as Effect from "effect/Effect";
import { getCloudflareEnvKey } from "../context.ts";
import { Worker } from "./worker.ts";

export interface Fetch extends Capability<"Cloudflare.Assets.Fetch"> {}

export const Fetch = Binding<() => Binding<Worker, Fetch>>(
  Worker,
  "Cloudflare.Assets.Fetch",
);

export const fetch = Effect.fnUntraced(function* (
  input: RequestInfo | URL,
  init?: RequestInit,
) {
  yield* declare<Fetch>();
  const fetcher = yield* getCloudflareEnvKey<runtime.Fetcher>("ASSETS");
  return yield* Effect.promise(
    (): Promise<Response> =>
      fetcher.fetch(
        input as URL | runtime.RequestInfo,
        init as runtime.RequestInit<runtime.CfProperties<unknown>>,
      ) as any,
  );
});
