import type * as kms from "@distilled.cloud/stackit/kms";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { KeyRing } from "./KeyRing.ts";

export interface ListKeysRequest extends Omit<
  kms.ListKeysRequest,
  "projectId" | "regionId" | "keyRingId"
> {}

/**
 * Runtime binding for KMS `listKeys`: list every key of a key ring, including
 * keys pending deletion.
 *
 * Bind this operation to a {@link KeyRing} in a Function/Worker init phase and
 * provide {@link ListKeysHttp}. The ring's identifiers are injected into each
 * request. A foreign host signs with a service account key Alchemy creates for it.
 *
 * Access: the `kms.keyring.get` permission on the project holding the ring, the
 * narrowest scope STACKIT binds. That one permission also allows encrypt, decrypt,
 * sign, verify and every read, on every key in the project: splitting them into
 * bindings narrows what this code can call, not what its credential could do.
 * The permission name comes from the KMS spec. Alchemy grants it through a
 * custom role, one per project, so the deployer needs `iam.role.add`.
 *
 * ### Listing Keys
 * **Example:** List a ring's keys from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Ring = Stackit.KMS.KeyRing("Ring", {});
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const call = yield* Stackit.KMS.ListKeys(yield* Ring);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { keys } = yield* call();
 *         return yield* HttpServerResponse.json({
 *           keys: keys.map((key) => key.displayName),
 *         });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.KMS.ListKeysHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category KMS
 */
export interface ListKeys extends Binding.Service<
  ListKeys,
  "Stackit.KMS.ListKeys",
  (
    ring: KeyRing,
  ) => Effect.Effect<
    (request?: ListKeysRequest) => Effect.Effect<kms.KeyList, kms.ListKeysError, RuntimeContext>
  >
> {}

export const ListKeys = Binding.Service<ListKeys>("Stackit.KMS.ListKeys");
