/**
 * Generation 3 of the chain Function — the SAME logical id ("ChainFn"),
 * with the blob binding REMOVED (only `ReadEdgeConfig` remains). Deploying
 * this generation is the chain's unbinding cycle: the store's reconciler
 * must disconnect the project (removing the platform-injected
 * `BLOB_READ_WRITE_TOKEN`) and the Function's env must drop the store
 * captures, while the Edge Config path keeps serving.
 */
import * as Vercel from "@/Vercel/index.ts";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { ChainFlags } from "./chain-flags.ts";
import { makeChainFetch } from "./chain-routes.ts";

export default class ChainFn extends Vercel.Function<ChainFn>()(
  "ChainFn",
  {
    main: import.meta.url,
    env: { CHAIN_SECRET: Redacted.make("chain-secret-v2") },
  },
  Effect.gen(function* () {
    const config = yield* Vercel.ReadEdgeConfig(ChainFlags);
    return { fetch: makeChainFetch(config, undefined) };
  }).pipe(Effect.provide(Vercel.ReadEdgeConfigHttp)),
) {}
