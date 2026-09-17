import * as TS from "@distilled.cloud/typesafe-ai";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { SystemOne } from "./SystemOne.ts";

/**
 * {@link SystemOne} over TypeSafe's HTTP API, keyed by `TYPESAFE_API_KEY`
 * and sampling `jev-latest` unless a call names another model.
 *
 * The key is read with `Config` while the layer builds. On a host that
 * builds its layers in the Construction phase — a Worker, a Lambda — that
 * read is what binds the key onto the deployed environment, and the same
 * `Config` resolves it back from the binding at runtime
 * ([Secrets & Config](/environments/secrets)). The credentials and the
 * HTTP client are captured there too, so the client the binding hands back
 * needs nothing provided per call.
 *
 * ### Providing the binding
 * **Example:** Provide it on the host, judge at runtime
 * ```typescript
 * Effect.gen(function* () {
 *   const query = yield* TypeSafe.SystemOne;
 *   return { fetch };
 * }).pipe(Effect.provide(TypeSafe.SystemOneHttp));
 * ```
 *
 * @layer
 * @provides TypeSafe.SystemOne
 * @peer @distilled.cloud/typesafe-ai
 * @product TypeSafe
 */
export const SystemOneHttp: Layer.Layer<
  SystemOne,
  never,
  HttpClient.HttpClient
> = Layer.effect(
  SystemOne,
  Effect.gen(function* () {
    const apiKey = yield* Config.Redacted("TYPESAFE_API_KEY");
    const client = yield* HttpClient.HttpClient;

    // The SDK mints its own `Redacted` from the plain key. A `Redacted`
    // built here would travel as an opaque handle, and its value lives in
    // a registry private to the `effect` instance that created it — the
    // SDK resolves its own copy, whose registry has never seen ours, and
    // unwrapping the bearer token throws.
    const physics = Layer.mergeAll(
      TS.fromApiKey({ apiKey: Redacted.value(apiKey) }),
      Layer.succeed(HttpClient.HttpClient, client),
    );

    return Effect.fn("TypeSafe.SystemOne")(function* (questions, options) {
      return yield* TS.query(questions, options).pipe(Effect.provide(physics));
    });
  }),
).pipe(Layer.orDie);
