import type { ReadWriteClient } from "@alchemy.run/redis/Client";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { Credential } from "./Credential.ts";

/**
 * Bind a {@link Credential} to read and write keys on its instance through the shared
 * `@alchemy.run/redis` RESP client: every command, plus `send` and `pipeline` for those the client has no method for. Provide {@link ReadWriteValkeyHttp}.
 *
 * STACKIT's API exposes no Valkey ACLs, so a credential can do everything on the
 * server. The limit here is the client's surface, not a permission.
 *
 * Commands authenticate with the credential, so this grants no STACKIT role. The host's
 * egress IP has to be in the instance's `acl`, or it can't connect. Each command opens
 * a connection and closes it.
 *
 * ### Running Commands
 * **Example:** From a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Cache = Stackit.Valkey.Instance("Cache", {
 *   version: "x",
 *   planName: "stackit-keyvalue-1.2.10-replica",
 *   acl: ["203.0.113.7/32"],
 * });
 * export const App = Cache.pipe(
 *   Effect.flatMap((cache) => Stackit.Valkey.Credential("App", { instanceId: cache.instanceId })),
 * );
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const credential = yield* App;
 *     const cache = yield* Stackit.Valkey.ReadWriteValkey(credential);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* cache.set("marker", "hello");
 *         const value = yield* cache.get("marker");
 *         return yield* HttpServerResponse.json({ value });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Valkey.ReadWriteValkeyHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Valkey
 */
export interface ReadWriteValkey extends Binding.Service<
  ReadWriteValkey,
  "Stackit.Valkey.ReadWriteValkey",
  (credential: Credential) => Effect.Effect<ReadWriteValkeyClient>
> {}

export const ReadWriteValkey = Binding.Service<ReadWriteValkey>("Stackit.Valkey.ReadWriteValkey");

export type ReadWriteValkeyClient = ReadWriteClient;
