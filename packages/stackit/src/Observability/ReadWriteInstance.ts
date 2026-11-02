import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";
import type { ReadInstanceClient } from "./ReadInstance.ts";
import type { WriteInstanceClient } from "./WriteInstance.ts";

/** Every read and write operation on a bound instance. Its project and id are injected. */
export interface ReadWriteInstanceClient extends ReadInstanceClient, WriteInstanceClient {}

/**
 * Read and change an {@link Instance}'s configuration from a Function/Worker, with one
 * client.
 *
 * Bind it in the init phase and provide {@link ReadWriteInstanceHttp}. A foreign host
 * signs with a service account key Alchemy creates for it.
 *
 * Access: a custom role with `argus.instance.get` and `argus.instance.update`, the
 * permissions the API's `x-stackit-authorization` names for these operations, bound on
 * the project holding the instance. `argus.instance.update` is the only write
 * permission this API has, and STACKIT binds roles on projects at the narrowest, so
 * the host can read and change the whole configuration of every Observability instance
 * in that project. A resource that declares what this client changes overwrites it on
 * its next reconcile.
 *
 * ### Reading and Changing an Instance
 * **Example:** From a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Metrics = Stackit.Observability.Instance("Metrics", {});
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const metrics = yield* Metrics;
 *     const client = yield* Stackit.Observability.ReadWriteInstance(metrics);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* client.deleteAlertGroup({ groupName: "orders" });
 *         const { data } = yield* client.listAlertGroups();
 *         return yield* HttpServerResponse.json({ groups: data.map((group) => group.name) });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Observability.ReadWriteInstanceHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Observability
 */
export interface ReadWriteInstance extends Binding.Service<
  ReadWriteInstance,
  "Stackit.Observability.ReadWriteInstance",
  (instance: Instance) => Effect.Effect<ReadWriteInstanceClient>
> {}

export const ReadWriteInstance = Binding.Service<ReadWriteInstance>(
  "Stackit.Observability.ReadWriteInstance",
);
