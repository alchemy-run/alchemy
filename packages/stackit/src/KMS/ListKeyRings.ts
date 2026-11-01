import type * as kms from "@distilled.cloud/stackit/kms";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { KeyRing } from "./KeyRing.ts";

export interface ListKeyRingsRequest extends Omit<
  kms.ListKeyRingsRequest,
  "projectId" | "regionId"
> {}

/**
 * Runtime binding for KMS `listKeyRings`: list every key ring in the bound
 * ring's project and region.
 *
 * Bind this operation to a {@link KeyRing} in a Function/Worker init phase and
 * provide {@link ListKeyRingsHttp}. The ring's identifiers are injected into each
 * request. A foreign host signs with a service account key Alchemy creates for it.
 *
 * Access: the `kms.keyring.list` permission on the project holding the ring, the
 * narrowest scope STACKIT binds. It lists every ring in that project.
 * The permission name comes from the KMS spec. Alchemy grants it through a
 * custom role, one per project, so the deployer needs `iam.role.add`.
 *
 * ### Listing Key Rings
 * **Example:** List key rings from a Cloudflare Worker
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
 *     const call = yield* Stackit.KMS.ListKeyRings(yield* Ring);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { keyRings } = yield* call();
 *         return yield* HttpServerResponse.json({
 *           keyRings: keyRings.map((ring) => ring.displayName),
 *         });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.KMS.ListKeyRingsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category KMS
 */
export interface ListKeyRings extends Binding.Service<
  ListKeyRings,
  "Stackit.KMS.ListKeyRings",
  (
    ring: KeyRing,
  ) => Effect.Effect<
    (
      request?: ListKeyRingsRequest,
    ) => Effect.Effect<kms.KeyRingList, kms.ListKeyRingsError, RuntimeContext>
  >
> {}

export const ListKeyRings = Binding.Service<ListKeyRings>("Stackit.KMS.ListKeyRings");
