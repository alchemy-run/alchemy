import * as Effect from "effect/Effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Credentials } from "../Credentials.ts";
import { isLocalId } from "../LocalRuntime.ts";
import { authorizeThroughLocalKVGateway } from "./LocalKVGateway.ts";
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
 * Under `alchemy dev` the namespace may be a local simulator row (a `dev:`
 * id). Each op then runs against an ephemeral workerd gateway that emulates
 * the KV REST API over the native binding (see `LocalKVGateway.ts`) — same
 * client, same ops, different origin. Real ids keep the cloud HTTP API.
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
    // The FULL ambient context, for the dev-mode gateway: booting an
    // ephemeral workerd needs the platform services and the Cloudflare
    // environment, all present during stack-eval but not statically
    // enumerable here.
    const ambient = yield* Effect.context<never>();

    return Effect.fn(function* (namespace: Namespace) {
      // Deferred accessor — resolves the namespaceId against the tracker at
      // apply time (in an Action, that's the engine's resolve context).
      const namespaceId = yield* namespace.namespaceId;
      const auth: KVAuth = {
        authorize: (eff) =>
          namespaceId.pipe(
            Effect.flatMap((id) =>
              isLocalId(id)
                ? authorizeThroughLocalKVGateway(id, eff, ambient)
                : eff.pipe(Effect.provideContext(context)),
            ),
          ),
        accountId: Effect.succeed(accountId),
      };
      return options.makeClient(auth, namespaceId);
    });
  });
