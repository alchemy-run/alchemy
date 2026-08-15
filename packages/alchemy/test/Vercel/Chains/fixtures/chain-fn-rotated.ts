/**
 * Generation 2 of the chain Function — the SAME logical id ("ChainFn") and
 * binding set as `chain-fn.ts`, with the Redacted secret rotated to v2.
 * Deploying this generation over generation 1 is the chain's
 * secret-rotation cycle: the Function must redeploy while every binding
 * artifact (Edge Config token, store connection) stays stable.
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
    env: { CHAIN_SECRET: Redacted.make("chain-secret-v2") },
  },
  Effect.gen(function* () {
    const config = yield* Vercel.ReadEdgeConfig(ChainFlags);
    const blob = yield* Vercel.ReadWriteBlob(ChainStore);
    return { fetch: makeChainFetch(config, blob) };
  }).pipe(
    Effect.provide([Vercel.ReadEdgeConfigHttp, Vercel.ReadWriteBlobHttp]),
  ),
) {}
