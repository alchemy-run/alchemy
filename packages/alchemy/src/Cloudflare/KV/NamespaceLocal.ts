import * as Effect from "effect/Effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Credentials } from "../Credentials.ts";
import type { Namespace } from "./Namespace.ts";
import type { KVAuth } from "./NamespaceHttp.ts";

/**
 * Shared scaffolding for the `*Local` KV services.
 *
 * Instead of minting a scoped {@link AccountApiToken} (the `*Http` path) or
 * resolving a native Worker binding (the `*Binding` path), it captures the
 * ambient current-credentials context available during stack-eval and builds
 * a {@link KVAuth} that provides those credentials directly to the KV HTTP
 * ops. It then delegates to the same client builders the `*Http` variant uses.
 *
 * NOT exported from `index.ts` — this is internal scaffolding shared by the
 * three access-level Local layers.
 */
export const makeLocalKVNamespaceBinding = <Client>(options: {
  makeClient: (auth: KVAuth, namespaceId: Effect.Effect<string>) => Client;
}) =>
  Effect.gen(function* () {
    // Account + credentials are ambient during stack-eval (the stack's
    // providers layer). Capture the full context so KV HTTP ops can run with
    // the current credentials — no `host.bind`, no minted token.
    const { accountId } = yield* yield* CloudflareEnvironment;
    const context = yield* Effect.context<
      Credentials | HttpClient.HttpClient
    >();

    return Effect.fn(function* (namespace: Namespace) {
      // Deferred accessor — resolves the namespaceId against the tracker at
      // apply time (in an Action, that's the engine's resolve context).
      const namespaceId = yield* namespace.namespaceId;
      const auth: KVAuth = {
        authorize: (eff) => eff.pipe(Effect.provideContext(context)),
        accountId: Effect.succeed(accountId),
      };
      return options.makeClient(
        auth,
        // A `dev:` id belongs to a locally-emulated namespace — the cloud
        // HTTP API this client speaks has no such namespace, so fail with
        // guidance instead of a baffling 404. (Follow-up: tunnel into the
        // local simulator through a workerd gateway, as D1's
        // `QueryDatabaseLocal` does.)
        Effect.flatMap(namespaceId, (id) =>
          id.startsWith("dev:")
            ? Effect.die(
                `KV namespace "${id}" is locally emulated (alchemy dev) — the *Local KV capability layers query the cloud HTTP API and cannot reach it. ` +
                  "Opt the namespace out of emulation with Alchemy.live(), or drive it through a Worker binding.",
              )
            : Effect.succeed(id),
        ),
      );
    });
  });
