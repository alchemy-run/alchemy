import * as Effect from "effect/Effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Credentials } from "../Credentials.ts";
import { isLocalId } from "../LocalRuntime.ts";
import type { Bucket } from "./Bucket.ts";
import type { R2Auth } from "./BucketHttp.ts";
import { authorizeThroughLocalR2Gateway } from "./LocalR2Gateway.ts";

/**
 * Shared scaffolding for the R2 `*Local` binding layers.
 *
 * Resolves the account + captures the ambient current-credentials context at
 * layer construction, then returns the deferred binding callable. The callable
 * reads the bucket name/jurisdiction as deferred accessors (resolved at apply
 * time) and builds the same HTTP-backed client the `*Http` variant uses, but
 * authorized with the current CLI credentials instead of a minted token.
 *
 * Under `alchemy dev` the bucket may be a local simulator row (a `dev:`
 * name). Each op then runs against an ephemeral workerd gateway that
 * emulates the R2 REST API over the native binding (see
 * `LocalR2Gateway.ts`) — same client, same ops, different origin. Real
 * names keep the cloud HTTP API.
 *
 * NOT exported from `index.ts`.
 */
export const makeLocalBucketBinding = <Client>(makeClient: {
  (
    auth: R2Auth,
    bucketName: Effect.Effect<string>,
    jurisdiction: Effect.Effect<string>,
  ): Client;
}) =>
  Effect.gen(function* () {
    // Account + credentials are ambient during stack-eval (the stack's
    // providers layer). Capture the full context so each op can be run with the
    // current credentials.
    const { accountId } = yield* yield* CloudflareEnvironment;
    const context = yield* Effect.context<
      Credentials | HttpClient.HttpClient
    >();
    // The FULL ambient context, for the dev-mode gateway: booting an
    // ephemeral workerd needs the platform services and the Cloudflare
    // environment, all present during stack-eval but not statically
    // enumerable here.
    const ambient = yield* Effect.context<never>();

    return Effect.fn(function* (bucket: Bucket) {
      // Deferred accessors — resolved against the tracker at apply time. No
      // `host.bind`: the local variant registers no binding.
      const bucketName = yield* bucket.bucketName;
      const jurisdiction = yield* bucket.jurisdiction;
      const auth: R2Auth = {
        authorize: (eff) =>
          bucketName.pipe(
            Effect.flatMap((name) =>
              isLocalId(name)
                ? authorizeThroughLocalR2Gateway(name, eff, ambient)
                : eff.pipe(Effect.provideContext(context)),
            ),
          ),
        accountId: Effect.succeed(accountId),
      };
      return makeClient(auth, bucketName, jurisdiction);
    });
  });
