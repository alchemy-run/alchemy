/**
 * Generation 1 of the chain Function: binds BOTH the Edge Config
 * (`ReadEdgeConfig`) and the blob store (`ReadWriteBlob`), carries the v1
 * Redacted secret.
 */
import * as Vercel from "@/Vercel/index.ts";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { ChainFlags } from "./chain-flags.ts";
import { makeChainFetch } from "./chain-routes.ts";
import { ChainStore } from "./chain-store.ts";

export default class ChainFn extends Vercel.Function<ChainFn>()(
  "ChainFn",
  {
    main: import.meta.url,
    env: { CHAIN_SECRET: Redacted.make("chain-secret-v1") },
  },
  Effect.gen(function* () {
    const config = yield* Vercel.ReadEdgeConfig(ChainFlags);
    const blob = yield* Vercel.ReadWriteBlob(ChainStore);
    return { fetch: makeChainFetch(config, blob) };
  }).pipe(
    Effect.provide([Vercel.ReadEdgeConfigHttp, Vercel.ReadWriteBlobHttp]),
  ),
) {}
