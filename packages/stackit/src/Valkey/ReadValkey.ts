import type { ReadClient } from "@alchemy.run/redis/Client";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { Credential } from "./Credential.ts";

/**
 * Bind a {@link Credential} to read keys on its instance through the shared
 * `@alchemy.run/redis` RESP client: read commands: `get`, `mget`, `hget`, `lrange` and so on. Provide {@link ReadValkeyHttp}.
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
 *     const cache = yield* Stackit.Valkey.ReadValkey(credential);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const value = yield* cache.get("marker");
 *         return yield* HttpServerResponse.json({ value });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Valkey.ReadValkeyHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Valkey
 */
export interface ReadValkey extends Binding.Service<
  ReadValkey,
  "Stackit.Valkey.ReadValkey",
  (credential: Credential) => Effect.Effect<ReadValkeyClient>
> {}

export const ReadValkey = Binding.Service<ReadValkey>("Stackit.Valkey.ReadValkey");

export type ReadValkeyClient = ReadClient;
