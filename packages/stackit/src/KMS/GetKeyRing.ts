import type * as kms from "@distilled.cloud/stackit/kms";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { KeyRing } from "./KeyRing.ts";

export interface GetKeyRingRequest extends Omit<
  kms.GetKeyRingRequest,
  "projectId" | "regionId" | "keyRingId"
> {}

/**
 * Runtime binding for KMS `getKeyRing`: read a key ring's name and state.
 *
 * Bind this operation to a {@link KeyRing} in a Function/Worker init phase and
 * provide {@link GetKeyRingHttp}. The ring's identifiers are injected into each
 * request. A foreign host signs with a service account key Alchemy creates for it.
 *
 * Access: the `kms.keyring.get` permission on the project holding the ring, the
 * narrowest scope STACKIT binds. That one permission also allows encrypt, decrypt,
 * sign, verify and every read, on every key in the project: splitting them into
 * bindings narrows what this code can call, not what its credential could do.
 * The permission name comes from the KMS spec. Alchemy grants it through a
 * custom role, one per project, so the deployer needs `iam.role.add`.
 *
 * ### Reading the Key Ring
 * **Example:** Report a ring's state from a Cloudflare Worker
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
 *     const call = yield* Stackit.KMS.GetKeyRing(yield* Ring);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const ring = yield* call();
 *         return yield* HttpServerResponse.json({ state: ring.state });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.KMS.GetKeyRingHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category KMS
 */
export interface GetKeyRing extends Binding.Service<
  GetKeyRing,
  "Stackit.KMS.GetKeyRing",
  (
    ring: KeyRing,
  ) => Effect.Effect<
    (request?: GetKeyRingRequest) => Effect.Effect<kms.KeyRing, kms.GetKeyRingError, RuntimeContext>
  >
> {}

export const GetKeyRing = Binding.Service<GetKeyRing>("Stackit.KMS.GetKeyRing");
