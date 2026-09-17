/**
 * TYPESAFE — the org's System One credentials, provided ONCE.
 *
 * TypeSafe's Jev answers typed questions about a state (Choice /
 * Score / Noul) in ~100 ms with calibrated probabilities — the
 * REFLEX layer in front of the LLM agents: judgment call sites
 * (`TS.query({...questions}, { state })`) stay pure and just require
 * `TS.Credentials` + an ambient `HttpClient`, both satisfied inside
 * the Worker.
 *
 * The key rides `TYPESAFE_API_KEY` like the model keys do
 * (alchemy.run.ts: the operator's shell env in dev — Doppler
 * alchemy-v2 carries it — and a Worker secret at deploy). Missing
 * key = the resolving fiber dies; every judgment call site wraps
 * with a fallback to the status-quo path, so TypeSafe can only add
 * signal, never break the loop.
 */
import * as TS from "@distilled.cloud/typesafe-ai";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export const TypeSafeLive: Layer.Layer<TS.Credentials> = Layer.succeed(
  TS.Credentials,
  Effect.gen(function* () {
    const apiKey = yield* Config.Redacted("TYPESAFE_API_KEY");
    return {
      apiKey,
      apiBaseUrl: TS.DEFAULT_API_BASE_URL,
      defaultModel: TS.DEFAULT_MODEL,
    };
  }).pipe(Effect.orDie),
);
