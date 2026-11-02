import type * as iaas from "@distilled.cloud/stackit/iaas";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { PublicIp } from "./PublicIp.ts";

export interface AssociatePublicIpRequest extends Pick<
  iaas.UpdatePublicIPRequest,
  "networkInterface"
> {}

/**
 * Runtime binding for IaaS `UpdatePublicIP`, narrowed to the association:
 * point a public IP at another network interface, such as moving it to a
 * standby from a health check, or pass `null` to detach it.
 *
 * A `PublicIp` with `networkInterfaceId` set moves back on its next deploy.
 * Leave the prop unset on an address this binding manages.
 *
 * Bind this operation to a {@link PublicIp} in a Function/Worker init phase
 * and provide {@link AssociatePublicIpHttp}. It works on any host. A foreign
 * host signs with a service account key Alchemy creates for it.
 *
 * Access: a custom role holding only `iaas.public-ip.update` on the project
 * holding the address, so it reaches every public IP in that project: STACKIT
 * binds roles on projects, folders and organizations, not on a single public
 * IP. The permission also allows changing the labels of those addresses, which
 * this binding's request doesn't expose. The deployer needs `iam.role.add` on
 * that scope to define the role.
 *
 * ### Failing Over a Public IP
 * **Example:** Move an address to a standby interface
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Ingress = Stackit.IaaS.PublicIp("Ingress", {});
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const associate = yield* Stackit.IaaS.AssociatePublicIp(yield* Ingress);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const ip = yield* associate({
 *           networkInterface: "00000000-0000-0000-0000-000000000000",
 *         });
 *         return yield* HttpServerResponse.json({ ip: ip.ip });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.IaaS.AssociatePublicIpHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Public IP
 * @category IaaS
 */
export interface AssociatePublicIp extends Binding.Service<
  AssociatePublicIp,
  "Stackit.IaaS.AssociatePublicIp",
  (
    publicIp: PublicIp,
  ) => Effect.Effect<
    (
      request: AssociatePublicIpRequest,
    ) => Effect.Effect<iaas.PublicIp, iaas.UpdatePublicIPError, RuntimeContext>
  >
> {}

export const AssociatePublicIp = Binding.Service<AssociatePublicIp>(
  "Stackit.IaaS.AssociatePublicIp",
);
